'use strict';
// マイナビ掲載企業を「検索で列挙 → 静的取得で採用担当者メッセージから氏名抽出」する高速ハーベスタ。
// =====================================================================
// 発見（2026-07-01）: マイナビの「採用担当者メッセージ」(会社概要outline / 前年採用データemployment)は
//   **静的HTMLに含まれる**（例: 中島商会 outline静的に「採用担当の山本です」）。ログイン不要・公開。
//   掲載企業での氏名歩留りは約11-17%。母集団を「マイナビ掲載企業」に寄せれば1000件が射程。
//
// 方式（Wantedly sitemap方式のマイナビ版・discovery-first）:
//   1. searchCorpListByGenCond?srchWord=KW で掲載企業のcorpID＋社名を列挙（1KW≈100社・掲載100%）。
//      業界×地域×職種のKW行列で数千社を集める。
//   2. 各corpの outline.html / employment.html を静的取得し、extractFromRecruitText で
//      「採用担当の○○です」型の個人名を抽出（姓辞書＋人名ゲートで誤抽出排除）。
//   3. 再開可・アトミック書込・target到達で打ち切り。
//
//   node src/build-mynavi-enum.js --out sources/mynavi-enum-names.csv --target 1000 --grad 28
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { politeGet } = require('./polite');
const { toCsv, readCsv, normCompanyName } = require('./csv');
const { extractFromRecruitText } = require('./probe-recruit-page');
const { isPlausiblePersonName } = require('./jp-names');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
const OUT = getArg('out', path.join('sources', 'mynavi-enum-names.csv'));
const TARGET = parseInt(getArg('target', '1000'), 10) || 1000;
const GRAD = getArg('grad', '28');

// 列挙キーワード（業界・職種・地域）。掲載企業を広く拾うための行列。SMEが多い語を重視。
const KEYWORDS = [
  '製造', '建設', '設備', '機械', '電気工事', '金属', '化学', '食品', '印刷', '包装', '産業',
  '商社', '卸売', '小売', '販売', '専門商社', '住宅', '不動産', '建材', '工務店', 'リフォーム',
  '運輸', '物流', '倉庫', '運送', '介護', '福祉', '医療', '調剤', '保育', '教育', '塾',
  'システム', 'ソフト', '情報', 'IT', 'Web', '通信', '電子', '半導体', '精密', '自動車',
  'サービス', '外食', '飲食', 'ホテル', '旅行', '警備', '清掃', '人材', '広告', '出版',
  '銀行', '信用金庫', '保険', '証券', 'リース', '農業', '水産', '林業', '環境', 'エネルギー',
  '石油', 'ガス', '鉄鋼', '繊維', 'アパレル', '化粧品', '医薬', '銀行', '不動産', '設計',
  '東京', '大阪', '愛知', '福岡', '北海道', '宮城', '広島', '静岡', '新潟', '長野', '岡山',
  '群馬', '栃木', '茨城', '福島', '岐阜', '三重', '滋賀', '京都', '兵庫', '香川', '愛媛', '熊本',
];

const CONTACT_URL = (gy, id, pg) => `https://job.mynavi.jp/${gy}/pc/search/corp${id}/${pg}.html`;
const SEARCH_URL = (gy, kw, pg) => `https://job.mynavi.jp/${gy}/pc/corpinfo/searchCorpListByGenCond/index?actionMode=searchFw&srchWord=${encodeURIComponent(kw)}` + (pg > 1 ? `&page=${pg}` : '');

function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 検索結果HTMLから {corpId, 企業名} を抽出（outline.htmlリンクのテキスト）。
function parseSearchList(html) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('a[href*="outline.html"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const m = href.match(/corp(\d+)\/outline\.html/);
    if (!m) return;
    const id = m[1];
    if (seen.has(id)) return; seen.add(id);
    const name = ($(a).text() || '').replace(/\s+/g, ' ').trim();
    if (name && name.length >= 2 && name.length < 40) out.push({ corpId: id, 企業名: name });
  });
  return out;
}

// 1社: outline/employment を静的取得し採用担当者メッセージから氏名抽出。
async function extractName(gy, id) {
  for (const pg of ['outline', 'employment']) {
    const r = await politeGet(CONTACT_URL(gy, id, pg), { render: 'static' }).catch(() => null);
    if (!r || r.blocked || r.error || !r.html) continue;
    const text = r.html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ');
    const hit = extractFromRecruitText(text);
    if (hit && hit.name && isPlausiblePersonName(hit.name)) {
      return { name: hit.name, role: hit.role || '', 根拠: `採用担当者メッセージ(${pg}.html)` };
    }
    await sleep(300);
  }
  return null;
}

async function run() {
  const OUTABS = path.resolve(OUT);
  fs.mkdirSync(path.dirname(OUTABS), { recursive: true });
  const out = [];
  const doneCorp = new Set();
  if (!process.argv.includes('--fresh') && fs.existsSync(OUTABS)) {
    try { for (const r of readCsv(fs.readFileSync(OUTABS, 'utf8')).records) { if (r['corpId']) doneCorp.add(r['corpId']); out.push(r); } } catch (_) {}
    if (doneCorp.size) log(`再開: 既存 ${doneCorp.size}社`);
  }
  const headers = ['企業名', '採用担当者名', '役職', 'corpId', '根拠', '取得元', '取得日'];
  const flush = () => { try { const tmp = OUTABS + '.tmp'; fs.writeFileSync(tmp, toCsv(headers, out)); fs.renameSync(tmp, OUTABS); } catch (_) { try { fs.writeFileSync(OUTABS, toCsv(headers, out)); } catch (__) {} } };
  let named = out.filter((r) => r['採用担当者名']).length;

  // 1) 列挙: KW行列で corpId+社名 を収集（掲載企業）
  log(`マイナビ掲載企業を列挙（グラフ年 ${GRAD}）…`);
  const corps = new Map(); // corpId -> 企業名
  for (const kw of KEYWORDS) {
    if (corps.size >= TARGET * 8) break;    // 歩留り~15%想定で target*7 くらい集める
    for (let pg = 1; pg <= 3; pg++) {
      const r = await politeGet(SEARCH_URL(GRAD, kw, pg), { render: 'static' }).catch(() => null);
      if (!r || r.blocked || !r.html) break;
      const list = parseSearchList(r.html);
      let added = 0;
      for (const c of list) { if (!corps.has(c.corpId) && !doneCorp.has(c.corpId)) { corps.set(c.corpId, c.企業名); added++; } }
      if (added === 0 && pg > 1) break;      // ページング打ち止め
      await sleep(700);
    }
    log(`  KW「${kw}」まで 列挙 ${corps.size}社（未処理）`);
  }
  const todo = [...corps.entries()].map(([corpId, 企業名]) => ({ corpId, 企業名 }));
  log(`列挙完了 ${todo.length}社 → 採用担当者メッセージ抽出（目標 ${TARGET}名）`);

  // 2) 各社: 静的取得で氏名抽出
  const today = new Date().toISOString().slice(0, 10);
  let processed = 0;
  for (const c of todo) {
    if (named >= TARGET) break;
    const hit = await extractName(GRAD, c.corpId).catch(() => null);
    out.push({ 企業名: c.企業名, 採用担当者名: hit ? hit.name : '', 役職: hit ? hit.role : '',
      corpId: c.corpId, 根拠: hit ? hit.根拠 : '', 取得元: 'マイナビ列挙', 取得日: today });
    if (hit) named++;
    if (++processed % 20 === 0) { flush(); log(`  ${processed}/${todo.length}（採用担当者名 ${named}/${TARGET}）`); }
  }
  flush();
  log(`完了: 処理 ${processed}社 ｜ 採用担当者名 ${named}名（${(100 * named / Math.max(1, processed)).toFixed(1)}%）`);
  log(`出力: ${OUTABS}`);
}

run().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
