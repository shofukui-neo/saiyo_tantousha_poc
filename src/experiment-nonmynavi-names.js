'use strict';
/**
 * 実験: 非マイナビ媒体から採用担当者「個人名」が本当に取れるかの実測プローブ
 * =====================================================================
 * 目的（ユーザー要件）: マイナビ依存を脱し、他媒体でも担当者名を取れるか試行錯誤する。
 * カタログの promising 非マイナビ媒体（逆求人/IT/理系/インターン等）を対象に、
 * トップ→媒体内の詳細/企業/スカウト系ページを浅く巡回し、
 *   (a) 媒体ページ自体に個人名が露出するか（extractFromRecruitText）
 *   (b) 外部の企業公式リンク数（company-site hop の見込み）
 * を媒体ごとに実測して言い切れる材料を出す。
 *
 * 出力: data/experiment-nonmynavi.csv / data/experiment-nonmynavi.json
 * robots/レート/キャッシュは polite.js。中断耐性: 媒体ごとに逐次flush。
 */
const path = require('path');
const { pageCorpus, extractFromRecruitText } = require('./probe-recruit-page');
const { crawlMedia, DETAIL_HINT } = require('./media-crawl');
const { toCsv } = require('./csv');
const { getArg, getIntArg, log, atomicWrite, loadJson } = require('./cli-util');

const ROOT = path.resolve(__dirname, '..');
const CATALOG = path.join(ROOT, 'data', 'media-catalog.json');
const OUT_CSV = path.join(ROOT, 'data', 'experiment-nonmynavi.csv');
const OUT_JSON = path.join(ROOT, 'data', 'experiment-nonmynavi.json');
const HEAD = ['name', 'cat', 'strategy', 'reachable', 'pagesFetched', 'detailPages', 'onPageNames', 'sampleNames', 'companyLinks', 'note'];
const DEFAULT_CATS = '逆求人|IT特化|理系|インターン|マスコミ|グローバル|外資';

/** 1媒体を巡回し、(a)ページ上の個人名 と (b)外部企業リンク数 を実測する。 */
async function probeMedia(m, maxPages) {
  const companyDomains = new Set();
  const names = new Set();

  const r = await crawlMedia(m.url, {
    maxPages,
    internalHint: DETAIL_HINT,
    onPage({ html }) {
      // (a) このページに採用担当者名が露出するか
      try {
        const hit = extractFromRecruitText(pageCorpus(html));
        if (hit && hit.name) names.add(hit.name);
      } catch { /* 個別ページの抽出失敗は無視（巡回は続ける） */ }
    },
    onCompany({ reg }) { if (reg) companyDomains.add(reg); },
  });

  return {
    name: m.name, cat: m.cat, strategy: m.strategy, url: m.url,
    reachable: r.reachable, pagesFetched: r.pagesFetched, detailPages: r.internalFound,
    onPageNames: names.size, sampleNames: [...names].slice(0, 5),
    companyLinks: companyDomains.size, note: r.note,
  };
}

function errorRow(m, e) {
  return {
    name: m.name, cat: m.cat, strategy: m.strategy, url: m.url,
    reachable: 'err', pagesFetched: 0, detailPages: 0,
    onPageNames: 0, sampleNames: [], companyLinks: 0,
    note: String((e && e.message) || e).slice(0, 40),
  };
}

async function main() {
  const catalog = loadJson(CATALOG);
  if (!catalog || !Array.isArray(catalog.media)) {
    console.error(`媒体カタログが読めません: ${CATALOG}`);
    process.exit(1);
  }
  const maxPages = getIntArg('max-pages', 10);
  const catsArg = getArg('cats', DEFAULT_CATS);
  const filter = (catsArg === true || !catsArg) ? DEFAULT_CATS : String(catsArg);
  const re = new RegExp(filter);
  const targets = catalog.media.filter((m) => m.url && re.test(m.cat)
    && m.strategy !== 'blocked-or-login'
    && (!m.probe || m.probe.reachable !== 'no'));
  log(`実験対象: ${targets.length}媒体（cats=${filter}, 各最大${maxPages}p）`);

  const rows = [];
  let i = 0;
  for (const m of targets) {
    i++;
    const r = await probeMedia(m, maxPages).catch((e) => errorRow(m, e));
    rows.push(r);
    const sample = r.sampleNames && r.sampleNames.length ? ` (${r.sampleNames.join('/')})` : '';
    log(`  [${i}/${targets.length}] ${r.name}: 到達${r.reachable} p${r.pagesFetched} 詳細${r.detailPages} 名前${r.onPageNames}${sample} 企業リンク${r.companyLinks} ${r.note || ''}`);
    atomicWrite(OUT_CSV, toCsv(HEAD, rows.map((x) => ({ ...x, sampleNames: (x.sampleNames || []).join(' / ') }))));
    atomicWrite(OUT_JSON, JSON.stringify(rows, null, 2));
  }

  printSummary(rows);
}

function printSummary(rows) {
  const withNames = rows.filter((r) => r.onPageNames > 0);
  const L = '──────────────────────────────────────────────';
  console.log('\n' + L);
  console.log('  非マイナビ媒体 氏名露出 実測サマリ');
  console.log(L);
  console.log(`  対象媒体            : ${rows.length}`);
  console.log(`  到達OK              : ${rows.filter((r) => r.reachable === 'yes').length}`);
  console.log(`  媒体ページに個人名  : ${withNames.length}媒体`);
  withNames.forEach((r) => console.log(`     - ${r.name} (${r.cat}): ${r.sampleNames.join(' / ')}`));
  console.log(`  企業リンク10+保持   : ${rows.filter((r) => (r.companyLinks || 0) >= 10).length}媒体（company-site hop 見込み）`);
  console.log(L);
  console.log(`  出力: ${OUT_CSV}`);
  console.log(`        ${OUT_JSON}\n`);
}

module.exports = { probeMedia };

if (require.main === module) {
  main().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
}
