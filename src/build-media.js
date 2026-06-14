'use strict';
// 採用媒体ソースのビルダー。既存の「ソースCSV」を生成して manifest 経由で統合パイプラインに接続する。
//
// 2モード:
//  (1) 既存企業リストを濃縮（既定）：入力CSV(企業名/法人番号/公式URL)の各社について
//      ・公式URLから採用ページ有無を判定（recruit-page.js, 公開情報）
//      ・マイナビ/リクナビ/ワンキャリアの掲載有無を判定（scrape-media.js）
//      → sources/A-media.csv（A-mynavi.csv と同スキーマ＋採用ページ列）
//
//  (2) 発見モード（--discover "介護 東京;新卒 エンジニア 大阪"）：
//      求人ボックス/Indeed から採用中企業を抽出 → sources/E-hiring.csv
//
//   node src/build-media.js --in leads-daihyou-1000.csv --out sources/A-media.csv --limit 200 --concurrency 3
//   node src/build-media.js --discover "介護 東京;新卒 営業 大阪" --out sources/E-hiring.csv
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, truthy, mergeKey } = require('./csv');
const { checkRecruitPage } = require('./recruit-page');
const { checkMediaListing, discoverHiringCompanies } = require('./scrape-media');
const { closeBrowser } = require('./fetch');

// ---- 堅牢化: undici(組み込みfetch)の keep-alive 接続終了アサーション対策 ----
// 接続再利用を抑え、特定サーバでの `assert(!this.paused)` 致命例外の発生を減らす。
try {
  const undici = require('undici');
  undici.setGlobalDispatcher(new undici.Agent({ pipelining: 0, keepAliveTimeout: 1000, keepAliveMaxTimeout: 1000 }));
} catch (_) { /* undici非公開ビルドなら無視 */ }
// それでも稀に非同期で投げられる致命例外でプロセスごと落ちないよう、ログして継続する。
// （該当fetchのpromiseは解決しないため、各社処理は下の withTimeout で必ず打ち切る）
process.on('uncaughtException', (e) => { console.error('[uncaught]', String(e && e.message || e).slice(0, 120)); });

// 指定msで必ず解決するタイムアウトラッパ（ワーカーが未解決promiseで無限待ちになるのを防ぐ）
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
const OUT = getArg('out', path.join('sources', 'A-media.csv'));
const LIMIT = parseInt(getArg('limit', '0'), 10) || 0;        // 0=全件
const CONC = parseInt(getArg('concurrency', '3'), 10) || 3;   // 同一媒体ホストは polite が直列化
const DISCOVER = getArg('discover', '');
const DO_MEDIA = !process.argv.includes('--no-media');        // 媒体掲載チェックをスキップ
const DO_RECRUIT = !process.argv.includes('--no-recruit');    // 採用ページチェックをスキップ

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }

async function pool(items, n, worker) {
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; await worker(items[i], i); }
  }));
}

// ---- モード(2): 採用中企業の発見 ----
async function runDiscover() {
  const queries = DISCOVER.split(/[;；]/).map((s) => s.trim()).filter(Boolean);
  log(`発見モード: ${queries.length}クエリ → 求人ボックス/Indeed`);
  const acc = await discoverHiringCompanies(queries, { maxPagesPerQuery: parseInt(getArg('pages', '1'), 10) || 1 });
  const records = [...acc.values()].map((e) => ({
    '企業名': e.企業名, '法人番号': '',
    '採用中': '○', '発見媒体': [...e.媒体].join('/'), '求人件数': e.件数,
    'ヒットクエリ': [...e.クエリ].join('|'), '取得日': new Date().toISOString().slice(0, 10),
  }));
  const headers = ['企業名', '法人番号', '採用中', '発見媒体', '求人件数', 'ヒットクエリ', '取得日'];
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, toCsv(headers, records));
  log(`発見完了: ${records.length}社 → ${path.resolve(OUT)}`);
}

// ---- モード(1): 既存リストの濃縮 ----
async function runEnrich() {
  const text = fs.readFileSync(path.resolve(IN), 'utf8');
  let { records } = readCsv(text);
  if (LIMIT) records = records.slice(0, LIMIT);
  log(`濃縮モード: ${records.length}社（media=${DO_MEDIA}, recruit=${DO_RECRUIT}, 並列${CONC}）`);

  const headers = ['企業名', '法人番号', '新卒フラグ', '掲載媒体', '掲載媒体数', '採用予定人数', '取得日',
    '採用ページ有無', '採用ページURL', '新卒言及', '職種', '外部採用媒体', '根拠'];
  const out = [];
  const OUTABS = path.resolve(OUT);
  fs.mkdirSync(path.dirname(OUTABS), { recursive: true });

  // ---- 再開: 既存出力を読み込み、処理済みキーをスキップ ----
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
  // アトミック書き込み（クラッシュ時の途中切れ防止: tmp に書いて rename）
  const flush = () => { const tmp = OUTABS + '.tmp'; fs.writeFileSync(tmp, toCsv(headers, out)); fs.renameSync(tmp, OUTABS); };
  const PER_COMPANY_MS = parseInt(getArg('company-timeout', '90000'), 10) || 90000;

  await pool(todo, CONC, async (rec) => {
    const name = rec['企業名'] || rec['company_name'] || '';
    const url = rec['公式URL'] || rec['url'] || '';
    const row = {
      '企業名': name, '法人番号': rec['法人番号'] || '',
      '新卒フラグ': '', '掲載媒体': '', '掲載媒体数': 0, '採用予定人数': '',
      '取得日': new Date().toISOString().slice(0, 10),
      '採用ページ有無': '', '採用ページURL': '', '新卒言及': '', '職種': '', '外部採用媒体': '', '根拠': '',
    };
    // 1社分の処理を timeout で必ず打ち切る（undici致命例外で未解決のまま固まるのを防ぐ）
    await withTimeout((async () => {
      try {
        if (DO_RECRUIT && url) {
          const rp = await checkRecruitPage(url);
          Object.assign(row, {
            '採用ページ有無': rp['採用ページ有無'], '採用ページURL': rp['採用ページURL'],
            '新卒言及': rp['新卒言及'], '職種': rp['職種'], '外部採用媒体': rp['外部採用媒体'], '根拠': rp['根拠'],
          });
          if (truthy(rp['新卒言及'])) row['新卒フラグ'] = '○';
        }
        if (DO_MEDIA && name) {
          const m = await checkMediaListing(name);
          row['掲載媒体'] = m.掲載媒体.join('/');
          row['掲載媒体数'] = m.掲載媒体数;
          // 外部採用媒体に新卒媒体が出ていれば新卒フラグを補強
          if (/リクナビ|マイナビ|ワンキャリア/.test(row['外部採用媒体'] || '') || m.掲載媒体数 > 0) {
            if (!row['新卒フラグ']) row['新卒フラグ'] = m.掲載媒体.length ? '○' : '';
          }
        }
      } catch (e) {
        row['根拠'] = (row['根拠'] ? row['根拠'] + ';' : '') + 'err:' + String(e && e.message || e).slice(0, 40);
      }
    })(), PER_COMPANY_MS, () => { row['根拠'] = (row['根拠'] ? row['根拠'] + ';' : '') + 'timeout'; });
    out.push(row);
    if (++done % 10 === 0) { flush(); log(`  ${done}/${todo.length}（採用ページ有 累計 ${out.filter((r) => truthy(r['採用ページ有無'])).length}）`); }
  });
  flush();
  const withRecruit = out.filter((r) => truthy(r['採用ページ有無'])).length;
  const withMedia = out.filter((r) => r.掲載媒体数 > 0).length;
  const withShinsotsu = out.filter((r) => truthy(r['新卒フラグ'])).length;
  log(`完了: ${out.length}社 ｜ 採用ページ有 ${withRecruit} ｜ 媒体掲載 ${withMedia} ｜ 新卒 ${withShinsotsu}`);
  log(`出力: ${OUTABS}`);
}

(async () => {
  try {
    if (DISCOVER) await runDiscover();
    else await runEnrich();
  } catch (e) {
    console.error('FATAL', e && e.stack ? e.stack : e);
    process.exitCode = 1;
  } finally {
    await closeBrowser().catch(() => {});
  }
})();
