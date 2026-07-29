'use strict';
// 能動採用中SMEの母集団生成（求人ボックス静的スクレイプ・Bing不要）。
// =====================================================================
// ユーザー方針: Wantedly不使用で1000件。母集団は「能動的に新卒採用中のSME」に絞る。
//   求人ボックス(xn--pckua2a7gp15o89zb.com)は静的HTMLで掲載企業名を返す＝Bingの律速を回避できる
//   唯一の量産可能な能動採用企業ソース。新卒×職種×地域のクエリ行列で数千社を収集する。
//
//   node src/gen-active-recruiters.js --out sources/active-recruiters.csv --pages 2 --target 3000
const fs = require('fs');
const path = require('path');
const { toCsv, readCsv, normCompanyName } = require('./csv');
const { discoverHiringCompanies } = require('./scrape-media');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
const OUT = getArg('out', path.join('sources', 'active-recruiters.csv'));
const PAGES = parseInt(getArg('pages', '2'), 10) || 2;
const TARGET = parseInt(getArg('target', '3000'), 10) || 3000;

// 新卒採用の職種×地域クエリ行列（求人ボックスは「<q>の仕事」で検索）。
const ROLES = ['新卒 営業', '新卒 エンジニア', '新卒 企画', '新卒 総合職', '新卒 事務',
  '新卒 販売', '新卒 マーケティング', '新卒 デザイナー', '新卒 コンサル', '新卒 技術職',
  '新卒 システムエンジニア', '新卒 制作', '新卒 広報', '新卒 人事', '新卒 経理',
  '新卒 施工管理', '新卒 生産管理', '新卒 研究開発', '新卒 サービス', '新卒 IT'];
const REGIONS = ['東京', '大阪', '愛知', '神奈川', '福岡', '北海道', '埼玉', '兵庫', '京都', '宮城', ''];

function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }

async function run() {
  const OUTABS = path.resolve(OUT);
  fs.mkdirSync(path.dirname(OUTABS), { recursive: true });
  // 再開: 既存出力を読み込む
  const seen = new Map();
  if (!process.argv.includes('--fresh') && fs.existsSync(OUTABS)) {
    try { for (const r of readCsv(fs.readFileSync(OUTABS, 'utf8')).records) { const k = normCompanyName(r['企業名']); if (k) seen.set(k, r); } } catch (_) {}
    if (seen.size) log(`再開: 既存 ${seen.size}社`);
  }
  const headers = ['企業名', '発見媒体', '発見クエリ', '掲載件数'];
  const flush = () => { const tmp = OUTABS + '.tmp'; fs.writeFileSync(tmp, toCsv(headers, [...seen.values()])); fs.renameSync(tmp, OUTABS); };

  // クエリ行列を地域→職種の順で（地域広めから）。target到達で打ち切り。
  outer:
  for (const region of REGIONS) {
    for (const role of ROLES) {
      const q = region ? `${role} ${region}` : role;
      let acc;
      try { acc = await discoverHiringCompanies([q], { maxPagesPerQuery: PAGES }); }
      catch (e) { log(`  クエリ失敗 "${q}": ${String(e.message || e).slice(0, 50)}`); continue; }
      let added = 0;
      for (const v of acc.values()) {
        const k = normCompanyName(v['企業名']); if (!k) continue;
        if (!seen.has(k)) {
          seen.set(k, { 企業名: v['企業名'], 発見媒体: [...v.媒体].join('/'), 発見クエリ: q, 掲載件数: String(v.件数 || 1) });
          added++;
        }
      }
      log(`"${q}" → 新規 ${added}（累計 ${seen.size}/${TARGET}）`);
      flush();
      if (seen.size >= TARGET) break outer;
    }
  }
  flush();
  log(`完了: 能動採用企業 ${seen.size}社 → ${OUTABS}`);
}

run().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
