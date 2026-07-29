'use strict';
// 系統D（ネットワーク/既存資産）ビルダー: 対象リスト各社を Gmail/Drive で名寄せし、
// 社内に既にある採用担当者名・メール・役職を sources/D-google-names.csv に出力する。
// build-names.js と同形（再開・アトミック書込・1社タイムアウト）。
//
//   npm run google:auth          # 初回だけ本人同意（OAuth2）
//   npm run names:google         # 既定: leads-mochica-target.csv → sources/D-google-names.csv
//   node src/build-google-names.js --in <list.csv> --out <out.csv> --limit 100
//
// 設定が無ければ何もせず明示スキップ（プロジェクトの設計思想: 鍵無しでも全体は止めない）。
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, mergeKey } = require('./csv');
const { authorize, configured, CLIENT_PATH } = require('./google-auth');
const { findContactInWorkspace } = require('./google-contacts');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
const IN = getArg('in', 'leads-mochica-target.csv');
const OUT = getArg('out', path.join('sources', 'D-google-names.csv'));
const LIMIT = parseInt(getArg('limit', '0'), 10) || 0;
const PER_COMPANY_MS = parseInt(getArg('company-timeout', '60000'), 10) || 60000;

function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }
function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(typeof onTimeout === 'function' ? onTimeout() : onTimeout), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(onTimeout && onTimeout()); });
  });
}

async function run() {
  if (!configured()) {
    log(`スキップ: OAuthクライアント未設定（${CLIENT_PATH}）。手順は src/google-auth.js 冒頭を参照。`);
    return;
  }
  let auth;
  try { auth = await authorize({ interactive: false }); }
  catch (e) { log('スキップ: ' + e.message); return; }

  const text = fs.readFileSync(path.resolve(IN), 'utf8');
  let { records } = readCsv(text);
  if (LIMIT) records = records.slice(0, LIMIT);
  log(`社内資産(Gmail/Drive)名寄せ: ${records.length}社`);

  const headers = ['企業名', '法人番号', '採用担当者名', '役職', '部署', 'メール',
    '取得元媒体', 'チャネル', '根拠URL', '担当者確度', '探索結果', '取得日'];
  const OUTABS = path.resolve(OUT);
  fs.mkdirSync(path.dirname(OUTABS), { recursive: true });

  // 再開
  const out = [];
  const doneKeys = new Set();
  if (!process.argv.includes('--fresh') && fs.existsSync(OUTABS)) {
    try {
      for (const r of readCsv(fs.readFileSync(OUTABS, 'utf8')).records) { const k = mergeKey(r); if (k) { doneKeys.add(k); out.push(r); } }
      if (doneKeys.size) log(`再開: 既存 ${doneKeys.size}社をスキップ`);
    } catch (_) {}
  }
  const todo = records.filter((r) => { const k = mergeKey(r); return !k || !doneKeys.has(k); });

  let done = 0;
  const flush = () => { const tmp = OUTABS + '.tmp'; fs.writeFileSync(tmp, toCsv(headers, out)); fs.renameSync(tmp, OUTABS); };

  for (const rec of todo) {
    const name = rec['企業名'] || rec['company_name'] || '';
    const row = {
      '企業名': name, '法人番号': rec['法人番号'] || '',
      '採用担当者名': '', '役職': '', '部署': '', 'メール': '',
      '取得元媒体': '', 'チャネル': '', '根拠URL': '', '担当者確度': '', '探索結果': '',
      '取得日': new Date().toISOString().slice(0, 10),
    };
    await withTimeout((async () => {
      try {
        const r = await findContactInWorkspace(auth, name, { maxMessages: 8, maxFiles: 3 });
        Object.assign(row, {
          '採用担当者名': r.採用担当者名, '役職': r.役職, '部署': r.部署, 'メール': r.メール || '',
          '取得元媒体': r.取得元媒体, 'チャネル': r.チャネル || '', '根拠URL': r.根拠URL,
          '担当者確度': r.採用担当者名 ? r.確度 : '',
          '探索結果': Object.entries(r.詳細 || {}).map(([k, v]) => `${k}:${v}`).join(' / '),
        });
      } catch (e) { row['探索結果'] = 'err:' + String(e && e.message || e).slice(0, 40); }
    })(), PER_COMPANY_MS, () => { row['探索結果'] = 'timeout'; });
    out.push(row);
    if (++done % 10 === 0) { flush(); log(`  ${done}/${todo.length}（HIT累計 ${out.filter((r) => r['採用担当者名']).length}）`); }
  }
  flush();
  const hit = out.filter((r) => r['採用担当者名']).length;
  log(`完了: ${out.length}社 ｜ 担当者HIT ${hit}（${(100 * hit / Math.max(1, out.length)).toFixed(1)}%）`);
  log(`出力: ${OUTABS}`);
}

(async () => {
  try { await run(); }
  catch (e) { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; }
})();
