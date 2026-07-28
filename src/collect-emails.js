'use strict';
// 企業名（またはCSV一覧）から公開メールアドレスを収集するCLI。
//  robots遵守・increment flush・並列。email-harvest.js のコアを使用（外部AI API不要）。
//
//  単体:   node src/collect-emails.js --company "株式会社ネオキャリア"
//  URL指定: node src/collect-emails.js --company "X社" --url https://example.co.jp
//  一括:   node src/collect-emails.js --in data/leads-mochica-target.csv --out data/leads-emails.csv
//
//  採用リスト出力（スプレッドシート用・企業名,メールアドレスの2列）:
//    --simple          確度しきい値以上のメールのみ・企業ごと最上位1件を「企業名,メールアドレス」で出力
//                      （--out 未指定ならダウンロードフォルダへ保存）
//    --min-conf 0.7    採用する確度の下限（既定0.7）
//
//  一括の高速化フラグ（既定は 5000件/1時間 を狙う設定）:
//    --conc 24        企業をまたいだ並列度（別ホストなので各サイトへの負荷は増えない）
//    --max-pages 3    1社あたりの最大取得ページ数
//    --delay 1200     同一サイト内ページの取得間隔ms（ホスト別・setScrapeDelay）
//    --render auto     SPAをレンダリング（既定 static＝高速）
//    --verify          URL発見時にページ検証を行う（既定 off＝高速）
//    --no-guess        役割アドレス推測を無効化（実在メールのみ）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readCsv, toCsv } = require('./csv');
const { collectEmailsForCompany, harvestMany, estimateThroughput, bestQualifiedEmail, MIN_CONFIDENCE } = require('./email-harvest');
const { setScrapeDelay } = require('./polite');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
function intArg(name, def) { const v = getArg(name, null); const n = parseInt(v, 10); return Number.isFinite(n) ? n : def; }

const IN = getArg('in', '');
const OUT = getArg('out', path.join('data', 'leads-emails.csv'));
const COMPANY = getArg('company', '');
const KNOWN_URL = getArg('url', '');
const LIMIT = intArg('limit', 0) || 0;
const NO_GUESS = process.argv.includes('--no-guess');
const COMPANY_COL = getArg('company-col', '');
const RENDER_ARG = getArg('render', '');          // 'auto' | 'static' | ''(=モード既定)
const VERIFY_FLAG = process.argv.includes('--verify');
const SIMPLE = process.argv.includes('--simple'); // 2列（企業名,メールアドレス）の採用リストを出力
const MIN_CONF = (() => { const v = parseFloat(getArg('min-conf', String(MIN_CONFIDENCE))); return Number.isFinite(v) ? v : MIN_CONFIDENCE; })();
function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }
function fmtDur(sec) { sec = Math.max(0, Math.round(sec)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return (h ? h + '時間' : '') + (h || m ? m + '分' : '') + s + '秒'; }

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
  // 単体は精度重視（多めのページ・レンダリング・URL検証）
  const maxPages = intArg('max-pages', 5);
  log(`単体収集: ${COMPANY}${KNOWN_URL ? ' (' + KNOWN_URL + ')' : ''}`);
  const res = await collectEmailsForCompany(COMPANY, {
    url: KNOWN_URL || '', maxPages, guess: !NO_GUESS,
    render: RENDER_ARG || 'auto', verify: RENDER_ARG === 'static' ? VERIFY_FLAG : true,
  });
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
  // 一括は 5000件/1時間 を狙う高速既定
  const CONC = Math.max(1, intArg('conc', 24));
  const MAX_PAGES = Math.max(1, intArg('max-pages', 3));
  const DELAY = Math.max(0, intArg('delay', 1200));
  const RENDER = RENDER_ARG || 'static';
  const VERIFY = VERIFY_FLAG; // 既定 off
  setScrapeDelay(DELAY); // ホスト別間隔を実行時に調整

  const parsed = readCsv(fs.readFileSync(path.resolve(IN), 'utf8'));
  const nameCol = pickCol(parsed.headers, COMPANY_COL, NAME_COLS);
  const urlCol = pickCol(parsed.headers, '', URL_COLS);
  if (!nameCol) { console.error('企業名列が見つかりません。--company-col で指定してください。ヘッダ:', parsed.headers.join(', ')); process.exitCode = 1; return; }
  let recs = parsed.records.filter((r) => String(r[nameCol] || '').trim());
  if (LIMIT) recs = recs.slice(0, LIMIT);

  const items = recs.map((r) => ({ company: String(r[nameCol]).trim(), url: urlCol ? String(r[urlCol] || '').trim() : '' }));
  const withUrl = items.filter((it) => it.url).length;
  const needDiscovery = items.length - withUrl;
  const est = estimateThroughput({ count: items.length, concurrency: CONC, maxPages: MAX_PAGES, delayMs: DELAY, discovery: needDiscovery > 0, static: RENDER !== 'auto' });

  log(`一括収集 ${items.length}社（企業名列=${nameCol}${urlCol ? ' / URL列=' + urlCol : ''}）`);
  log(`設定: 並列${CONC} / 最大${MAX_PAGES}ページ / 間隔${DELAY}ms / ${RENDER === 'auto' ? 'レンダリング有' : '静的取得'} / URL検証${VERIFY ? '有' : '無'} / 推測${NO_GUESS ? '無' : '有'}`);
  log(`URL既知 ${withUrl}社 / 発見必要 ${needDiscovery}社`);
  log(`推定: 約 ${est.perMin} 社/分（≒${fmtDur(est.totalSec)}で完了・1社${est.perCompanySec}秒）`);
  if (needDiscovery > 0) log(`※ URL未指定の${needDiscovery}社は検索エンジン経由の発見が必要で、レート制限により大量時は遅く/失敗しやすくなります（URL列付きの入力を推奨）。`);
  if (est.perMin < 83 && items.length >= 1000) log(`※ 現設定では 5000件/1時間(83社/分) に届きません。--conc を上げる/--max-pages を下げる/URL付き入力 を検討してください。`);

  // 出力先: --simple かつ --out 未指定なら成果物としてダウンロードフォルダへ（[[deliverables-to-downloads]]）
  let outPath = OUT;
  if (SIMPLE && !getArg('out', '')) {
    const dl = path.join(os.homedir(), 'Downloads');
    outPath = path.join(fs.existsSync(dl) ? dl : process.cwd(), `company-emails-採用リスト-${new Date().toISOString().slice(0, 10)}.csv`);
  }
  const OUTABS = path.resolve(outPath);
  fs.mkdirSync(path.dirname(OUTABS), { recursive: true });

  // simple: 2列（企業名,メールアドレス）確度しきい値以上・企業ごとに最上位1件。それ以外は詳細列。
  const raw = new Array(items.length);
  const buildRows = () => {
    if (!SIMPLE) return { headers: HEADERS, records: raw.filter(Boolean).map((r) => r.row) };
    const recs = [];
    for (const r of raw) { if (r && r.email) recs.push({ 企業名: r.company, メールアドレス: r.email }); }
    return { headers: ['企業名', 'メールアドレス'], records: recs };
  };
  const flush = () => { const { headers, records } = buildRows(); const t = OUTABS + '.tmp'; fs.writeFileSync(t, '﻿' + toCsv(headers, records)); fs.renameSync(t, OUTABS); };

  const t0 = Date.now();
  let hit = 0, adopted = 0;
  await harvestMany(items, {
    concurrency: CONC, maxPages: MAX_PAGES, guess: !NO_GUESS, render: RENDER, verify: VERIFY,
    onResult(i, item, res, done) {
      if (res && res.best) hit++;
      const email = bestQualifiedEmail(res, MIN_CONF); // 確度しきい値以上の採用1件
      if (email) adopted++;
      raw[i] = { company: item.company, email, row: toRow(item.company, res) };
      if (done % 25 === 0 || done === items.length) {
        flush();
        const elapsed = (Date.now() - t0) / 1000;
        const rate = done / Math.max(0.001, elapsed);         // 社/秒
        const eta = (items.length - done) / Math.max(0.0001, rate);
        log(`  ${done}/${items.length}（採用 ${adopted}社 / メール検出 ${hit}社）｜ ${(rate * 60).toFixed(0)}社/分 ｜ 残り ${fmtDur(eta)}`);
      }
    },
  });
  flush();
  const total = (Date.now() - t0) / 1000;
  log(`完了: ${items.length}社処理 ｜ 採用(確度${MIN_CONF}以上) ${adopted}社（${(100 * adopted / Math.max(1, items.length)).toFixed(0)}%）｜ メール検出 ${hit}社 ｜ 所要 ${fmtDur(total)}（${(items.length / Math.max(0.001, total) * 60).toFixed(0)}社/分）`);
  log(`出力: ${OUTABS}${SIMPLE ? '（企業名,メールアドレス・確度' + MIN_CONF + '以上）' : ''}`);
}

async function run() {
  if (COMPANY) return runSingle();
  if (IN) return runBatch();
  console.error('使い方: --company "企業名" [--url https://...]  または  --in <一覧.csv> --out <出力.csv>');
  process.exitCode = 1;
}

if (require.main === module) run().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
module.exports = { run, toRow, HEADERS };
