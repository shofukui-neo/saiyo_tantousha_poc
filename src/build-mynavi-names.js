'use strict';
// マイナビ新卒から中堅大手の「採用担当者名＋到達性」を一括取得するドライバ（再開可能・Playwright）。
// ------------------------------------------------------------------
// ユーザー指定の方針: ナビ系Playwrightで中堅大手の担当者名を取得する。
//   実走で判明: 問合せ先の個人名は大半が非公開だが、(a)野崎瑠美型で載る社 と
//   (b)採用メールのローカル部が人名の社（Tsagara@→相良）で担当者名が取れる。
//   併せて 部署/メール/電話/採用予定人数/卒年/掲載確認 という到達性データも持ち帰る。
//
//   build-names.js と同形: 再開（既存出力をスキップ）/ アトミック書込 / 1社タイムアウト。
//   Playwright はブラウザを1つ起動して直列に回す（並列はメモリ/検知の都合で避ける）。
//
//   node src/build-mynavi-names.js --in leads-daihyou-1000.csv --out sources/A-mynavi-names.csv --limit 60
//   MYNAVI_GRAD_YEAR=27 を推奨（シーズンで更新）。
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, mergeKey } = require('./csv');
const { MynaviScraper } = require('./scrape-mynavi');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
const IN = getArg('in', 'leads-daihyou-1000.csv');
const OUT = getArg('out', path.join('sources', 'A-mynavi-names.csv'));
const LIMIT = parseInt(getArg('limit', '0'), 10) || 0;            // 0=全件
const PER_COMPANY_MS = parseInt(getArg('company-timeout', '90000'), 10) || 90000;

function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }
function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(onTimeout()), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(onTimeout()); });
  });
}

async function run() {
  const text = fs.readFileSync(path.resolve(IN), 'utf8');
  let { records } = readCsv(text);
  if (LIMIT) records = records.slice(0, LIMIT);

  const headers = ['企業名', '法人番号', 'マイナビ掲載', '採用担当者名', '担当者確度', '担当者根拠',
    '部署', 'メール', '電話番号', '採用予定人数', '卒年', '採用ページURL', '取得日'];
  const OUTABS = path.resolve(OUT);
  fs.mkdirSync(path.dirname(OUTABS), { recursive: true });

  // 再開: 既存出力の処理済みキーをスキップ
  const out = [];
  const doneKeys = new Set();
  if (!process.argv.includes('--fresh') && fs.existsSync(OUTABS)) {
    try {
      for (const r of readCsv(fs.readFileSync(OUTABS, 'utf8')).records) {
        const k = mergeKey(r); if (k) { doneKeys.add(k); out.push(r); }
      }
      if (doneKeys.size) log(`再開: 既存 ${doneKeys.size}社をスキップ`);
    } catch (_) {}
  }
  const todo = records.filter((r) => { const k = mergeKey(r); return !k || !doneKeys.has(k); });
  log(`マイナビ担当者名取得: 未処理 ${todo.length}社（全 ${records.length}）`);

  // アトミック書込。Windowsでは対象ファイルが他プロセスに開かれているとrenameがEPERM/EBUSYになるため、
  // rename失敗時は直接writeFileSyncにフォールバック（グラインドを止めない）。
  const flush = () => {
    const tmp = OUTABS + '.tmp';
    try { fs.writeFileSync(tmp, toCsv(headers, out)); fs.renameSync(tmp, OUTABS); }
    catch (_) { try { fs.writeFileSync(OUTABS, toCsv(headers, out)); } catch (__) {} }
  };
  const sc = new MynaviScraper();
  await sc.launch();
  let done = 0;
  try {
    for (const rec of todo) {
      const name = rec['企業名'] || rec['company_name'] || '';
      const row = { 企業名: name, 法人番号: rec['法人番号'] || '', マイナビ掲載: '', 採用担当者名: '',
        担当者確度: '', 担当者根拠: '', 部署: '', メール: '', 電話番号: '', 採用予定人数: '', 卒年: '',
        採用ページURL: '', 取得日: new Date().toISOString().slice(0, 10) };
      const r = await withTimeout(sc.scrapeCompany(name), PER_COMPANY_MS, () => ({ 根拠: 'timeout' }));
      Object.assign(row, {
        マイナビ掲載: r.マイナビ掲載 || '', 採用担当者名: r.採用担当者名 || '', 担当者確度: r.担当者確度 || '',
        担当者根拠: r.根拠 || '', 部署: r.部署 || '', メール: r.メール || '', 電話番号: r.電話番号 || '',
        採用予定人数: r.採用予定人数 || '', 卒年: r.卒年 || '', 採用ページURL: r.採用ページURL || '',
      });
      out.push(row);
      if (++done % 5 === 0) {
        flush();
        const named = out.filter((x) => x['採用担当者名']).length;
        const listed = out.filter((x) => x['マイナビ掲載'] === '○').length;
        log(`  ${done}/${todo.length}（掲載 ${listed} / 担当者名 ${named}）`);
      }
    }
  } finally {
    flush();
    await sc.close().catch(() => {});
  }
  const named = out.filter((x) => x['採用担当者名']).length;
  const listed = out.filter((x) => x['マイナビ掲載'] === '○').length;
  log(`完了: ${out.length}社 ｜ マイナビ掲載 ${listed} ｜ 担当者名 ${named}（${(100 * named / Math.max(1, out.length)).toFixed(1)}%）`);
  log(`出力: ${OUTABS}`);
}

run().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
