'use strict';
// 採用担当者「個人名」ソースのビルダー。
//   入力リスト（leads-daihyou-1000.csv 等）の各社を Wantedly/ハローワークで社名検索し、
//   投稿者/担当者の個人名を取得して sources/A-names.csv を生成 → manifest 経由で統合パイプラインへ。
//
//   node src/build-names.js --in leads-daihyou-1000.csv --out sources/A-names.csv --limit 200 --concurrency 2
//   node src/build-names.js --include-experimental        # ハローワーク等の枠も試す（要較正）
//
// build-media.js と同形（再開・アトミック書込・1社タイムアウト・undici致命例外の握り潰し）。
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, mergeKey } = require('./csv');
const { findRecruiterName } = require('./scrape-names');
const { closeBrowser } = require('./fetch');

// 接続再利用を抑え、特定サーバでの undici 致命アサーションを減らす（build-media と同じ堅牢化）。
try {
  const undici = require('undici');
  undici.setGlobalDispatcher(new undici.Agent({ pipelining: 0, keepAliveTimeout: 1000, keepAliveMaxTimeout: 1000 }));
} catch (_) { /* 無視 */ }
process.on('uncaughtException', (e) => { console.error('[uncaught]', String(e && e.message || e).slice(0, 120)); });

function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(typeof onTimeout === 'function' ? onTimeout() : onTimeout), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(onTimeout && onTimeout()); });
  });
}

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
const IN = getArg('in', 'leads-daihyou-1000.csv');
const OUT = getArg('out', path.join('sources', 'A-names.csv'));
const LIMIT = parseInt(getArg('limit', '0'), 10) || 0;          // 0=全件
const CONC = parseInt(getArg('concurrency', '2'), 10) || 2;     // 媒体は polite が直列化。低めが安全
const INCLUDE_EXPERIMENTAL = process.argv.includes('--include-experimental');

function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }

async function pool(items, n, worker) {
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; await worker(items[i], i); }
  }));
}

async function run() {
  const text = fs.readFileSync(path.resolve(IN), 'utf8');
  let { records } = readCsv(text);
  if (LIMIT) records = records.slice(0, LIMIT);
  log(`個人名取得: ${records.length}社（experimental=${INCLUDE_EXPERIMENTAL}, 並列${CONC}）`);

  const headers = ['企業名', '法人番号', '採用担当者名', '役職', '部署',
    '取得元媒体', '根拠URL', '担当者確度', '探索結果', '取得日'];
  const out = [];
  const OUTABS = path.resolve(OUT);
  fs.mkdirSync(path.dirname(OUTABS), { recursive: true });

  // 再開: 既存出力の処理済みキーをスキップ
  const doneKeys = new Set();
  if (!process.argv.includes('--fresh') && fs.existsSync(OUTABS)) {
    try {
      const prev = readCsv(fs.readFileSync(OUTABS, 'utf8')).records;
      for (const r of prev) { const k = mergeKey(r); if (k) { doneKeys.add(k); out.push(r); } }
      if (doneKeys.size) log(`再開: 既存 ${doneKeys.size}社をスキップ`);
    } catch (_) {}
  }
  const todo = records.filter((r) => { const k = mergeKey(r); return !k || !doneKeys.has(k); });
  log(`未処理 ${todo.length}社を処理`);

  let done = 0;
  const flush = () => { const tmp = OUTABS + '.tmp'; fs.writeFileSync(tmp, toCsv(headers, out)); fs.renameSync(tmp, OUTABS); };
  const PER_COMPANY_MS = parseInt(getArg('company-timeout', '90000'), 10) || 90000;

  await pool(todo, CONC, async (rec) => {
    const name = rec['企業名'] || rec['company_name'] || '';
    const row = {
      '企業名': name, '法人番号': rec['法人番号'] || '',
      '採用担当者名': '', '役職': '', '部署': '',
      '取得元媒体': '', '根拠URL': '', '担当者確度': '', '探索結果': '',
      '取得日': new Date().toISOString().slice(0, 10),
    };
    await withTimeout((async () => {
      try {
        const r = await findRecruiterName(name, { includeExperimental: INCLUDE_EXPERIMENTAL });
        Object.assign(row, {
          '採用担当者名': r.採用担当者名, '役職': r.役職, '部署': r.部署,
          '取得元媒体': r.取得元媒体, '根拠URL': r.根拠URL,
          '担当者確度': r.採用担当者名 ? r.確度 : '',
          '探索結果': Object.entries(r.詳細 || {}).map(([k, v]) => `${k}:${v}`).join(' / '),
        });
      } catch (e) {
        row['探索結果'] = 'err:' + String(e && e.message || e).slice(0, 40);
      }
    })(), PER_COMPANY_MS, () => { row['探索結果'] = 'timeout'; });
    out.push(row);
    if (++done % 10 === 0) { flush(); log(`  ${done}/${todo.length}（個人名HIT 累計 ${out.filter((r) => r['採用担当者名']).length}）`); }
  });
  flush();
  const hit = out.filter((r) => r['採用担当者名']).length;
  log(`完了: ${out.length}社 ｜ 個人名HIT ${hit}（${(100 * hit / Math.max(1, out.length)).toFixed(1)}%）`);
  log(`出力: ${OUTABS}`);
}

(async () => {
  try { await run(); }
  catch (e) { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; }
  finally { await closeBrowser().catch(() => {}); }
})();
