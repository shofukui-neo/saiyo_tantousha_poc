'use strict';
// 企業名（またはCSV一覧）から公開メールアドレスを収集するCLI。
//  robots遵守・increment flush・並列。email-harvest.js のコアを使用（外部AI API不要）。
//
//  単体:   node src/collect-emails.js --company "株式会社ネオキャリア"
//  URL指定: node src/collect-emails.js --company "X社" --url https://example.co.jp
//  一括:   node src/collect-emails.js --in data/leads-mochica-target.csv --out data/leads-emails.csv [--limit N] [--conc 3]
//  役割推測を無効化（実在メールのみ）: --no-guess
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv } = require('./csv');
const { collectEmailsForCompany } = require('./email-harvest');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
const IN = getArg('in', '');
const OUT = getArg('out', path.join('data', 'leads-emails.csv'));
const COMPANY = getArg('company', '');
const KNOWN_URL = getArg('url', '');
const LIMIT = parseInt(getArg('limit', '0'), 10) || 0;
const CONC = Math.max(1, parseInt(getArg('conc', '3'), 10) || 3);
const MAX_PAGES = parseInt(getArg('max-pages', '5'), 10) || 5;
const NO_GUESS = process.argv.includes('--no-guess');
const COMPANY_COL = getArg('company-col', '');
function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }

// 一覧CSVの列名を賢く推定（企業名／既知URL・ドメイン）
const NAME_COLS = ['企業名', '会社名', 'company_name', 'company', 'name', '法人名', '社名'];
const URL_COLS = ['公式URL', 'websiteUrl', 'website', 'URL', 'url', 'ドメイン', 'domain', 'HP', 'ホームページ'];
function pickCol(headers, prefer, fallbacks) {
  if (prefer && headers.includes(prefer)) return prefer;
  for (const c of fallbacks) if (headers.includes(c)) return c;
  return '';
}

// 収集結果 → 出力レコード（1社1行、複数メールは候補列に; 連結）
function toRow(name, res) {
  const top = res.emails[0] || null;
  const others = res.emails.slice(1).map((e) => e.email).join(' ; ');
  return {
    企業名: name,
    公式URL: res.url || '',
    メール: res.best || '',
    メール種別: top ? top.roleLabel : '',
    確度: top ? top.confidence : '',
    取得方法: top ? (top.source === 'guess' ? '推測(MX)' : (top.source === 'mailto' ? 'mailto' : '本文')) : '',
    取得元ページ: top ? (top.foundOn || '') : '',
    メール候補: others,
    件数: String(res.emails.length),
    備考: res.note || '',
  };
}
const HEADERS = ['企業名', '公式URL', 'メール', 'メール種別', '確度', '取得方法', '取得元ページ', 'メール候補', '件数', '備考'];

async function runSingle() {
  log(`単体収集: ${COMPANY}${KNOWN_URL ? ' (' + KNOWN_URL + ')' : ''}`);
  const res = await collectEmailsForCompany(COMPANY, { url: KNOWN_URL || '', maxPages: MAX_PAGES, guess: !NO_GUESS });
  console.log('');
  console.log('企業名  :', res.company);
  console.log('公式URL :', res.url || '(不明)');
  if (res.emails.length) {
    console.log(`メール  : ${res.emails.length}件`);
    for (const e of res.emails) {
      console.log(`  - ${e.email}  [${e.roleLabel}] 確度${e.confidence} ` +
        `(${e.source === 'guess' ? '推測' : e.source}${e.ownDomain ? '/自社' : e.freemail ? '/フリー' : ''})` +
        `${e.foundOn ? '  ← ' + e.foundOn : ''}`);
    }
  } else {
    console.log('メール  : 検出なし');
  }
  if (res.note) console.log('備考    :', res.note);
}

async function runBatch() {
  const parsed = readCsv(fs.readFileSync(path.resolve(IN), 'utf8'));
  const nameCol = pickCol(parsed.headers, COMPANY_COL, NAME_COLS);
  const urlCol = pickCol(parsed.headers, '', URL_COLS);
  if (!nameCol) { console.error('企業名列が見つかりません。--company-col で指定してください。ヘッダ:', parsed.headers.join(', ')); process.exitCode = 1; return; }
  let recs = parsed.records.filter((r) => String(r[nameCol] || '').trim());
  if (LIMIT) recs = recs.slice(0, LIMIT);
  log(`一括収集 ${recs.length}社（企業名列=${nameCol}${urlCol ? ' / URL列=' + urlCol : ''} / 並列${CONC} / 最大${MAX_PAGES}ページ）`);

  const OUTABS = path.resolve(OUT);
  fs.mkdirSync(path.dirname(OUTABS), { recursive: true });
  const out = new Array(recs.length);
  const flush = () => { const t = OUTABS + '.tmp'; fs.writeFileSync(t, toCsv(HEADERS, out.filter(Boolean))); fs.renameSync(t, OUTABS); };

  let idx = 0, done = 0, hit = 0;
  async function worker() {
    while (true) {
      const my = idx++; if (my >= recs.length) return;
      const r = recs[my];
      const name = String(r[nameCol]).trim();
      const knownUrl = urlCol ? String(r[urlCol] || '').trim() : '';
      let res;
      try {
        res = await collectEmailsForCompany(name, { url: knownUrl, maxPages: MAX_PAGES, guess: !NO_GUESS });
      } catch (e) {
        res = { company: name, url: knownUrl, emails: [], best: '', note: 'ERROR: ' + String(e && e.message || e) };
      }
      if (res.best) hit++;
      out[my] = toRow(name, res);
      if (++done % 10 === 0) { flush(); log(`  ${done}/${recs.length}（メール取得 ${hit}社）`); }
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));
  flush();
  log(`完了: ${done}社処理 ｜ メール取得 ${hit}社（${(100 * hit / Math.max(1, done)).toFixed(0)}%）｜出力 ${OUTABS}`);
}

async function run() {
  if (COMPANY) return runSingle();
  if (IN) return runBatch();
  console.error('使い方: --company "企業名" [--url https://...]  または  --in <一覧.csv> --out <出力.csv>');
  process.exitCode = 1;
}

if (require.main === module) run().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
module.exports = { run, toRow, HEADERS };
