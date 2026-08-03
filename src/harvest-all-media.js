'use strict';
/**
 * 全媒体オーケストレータ: マイナビ依存を脱した採用担当者名ハーベスト
 * =====================================================================
 * 背景（実測で確定した事実）:
 *   media-catalog.json の106媒体を live 実測した結果、媒体ページ自体に採用担当者の
 *   個人名が露出するのは 1〜2媒体のみ（マイナビ=構造化問合せ先, Wantedly=投稿者名,
 *   チアキャリア=一部）。残る ~100媒体では、名前は媒体がリンクする「企業サイト側」にある。
 *   → よってマイナビだけに頼らず、【各媒体を企業母集団の入口として使い、企業サイトへ
 *      hop して氏名抽出する】のが正しい一般化。マイナビは"数ある feeder の一つ"に降格する。
 *
 * 動作: カタログの runnable 媒体ごとに
 *   1. 媒体を浅く巡回し、外部の企業公式URL（母集団）を収集（media-crawl）。
 *   2. 各企業サイトへ hop し probeRecruitDeep で採用担当者名を抽出。
 *   3. 媒体横断で登録ドメイン重複排除。取得元媒体・媒体戦略を付与。
 * 出力: data/recruiter-all-media.csv（企業名,公式URL,採用担当者名,役職,部署,確度,取得元,根拠URL,根拠,取得元媒体,媒体戦略）
 *       data/recruiter-all-media.by-media.csv（媒体別: 企業数/氏名取得/yield）
 * 中断/再開: 媒体単位で journal、CSVアトミック書込。robots/レート/キャッシュは polite.js。
 *
 *   node src/harvest-all-media.js [--media-limit 999] [--per-media-companies 25]
 *        [--media-max-pages 12] [--cats "逆求人|IT特化|理系"] [--deep] [--target 1000]
 */
const fs = require('fs');
const path = require('path');
const { probeRecruitPage } = require('./probe-recruit-page');
const { probeRecruitDeep } = require('./probe-recruit-deep');
const { crawlMedia, LISTING_HINT } = require('./media-crawl');
const { readCsv, toCsv, normCompanyName } = require('./csv');
const { getArg, getIntArg, log, atomicWrite, loadJson } = require('./cli-util');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const CATALOG = path.join(DATA, 'media-catalog.json');

const OUT = path.join(DATA, 'recruiter-all-media.csv');
const BYMEDIA = path.join(DATA, 'recruiter-all-media.by-media.csv');
const JOURNAL = path.join(DATA, 'harvest-all-media.journal.json');
const HEAD = ['企業名', '公式URL', '採用担当者名', '役職', '部署', '確度', '取得元', '根拠URL', '根拠', '取得元媒体', '媒体戦略'];
const BYMEDIA_HEAD = ['媒体', 'カテゴリ', '戦略', '母集団企業', '氏名取得', 'yield'];

// 企業名らしさ（法人格）と、母集団抽出のCTA除外（harvest-catalog と同方針）
const CTA_WORDS = /^(詳細|もっと|一覧|エントリー|応募|もっと見る|続きを読む|see ?more|view|detail|map|地図|アクセス|もっとみる|お気に入り|ブックマーク|シェア|次へ|前へ|top|ホーム|ログイン|登録|会員)/i;
const COMPANY_NAME_RE = /(株式会社|有限会社|合同会社|合資会社|合名会社|（株）|\(株\)|㈱|㈲|医療法人|社会福祉法人|学校法人|協同組合|一般社団法人|一般財団法人|Inc\.?|Co\.,?\s?Ltd|Corp(?:oration)?\b|Ltd\.?)/;

/**
 * アンカーテキストが企業名として使えるか判定する（2ティア）。
 *   strong = 法人格つき（株式会社◯◯）＝高確度
 *   weak   = 企業名らしい短い文字列。逆求人/スカウト媒体は企業名を「株式会社」抜きで載せる
 *            （例: サイバーエージェント）ため、法人格必須だと母集団がほぼ0になる。
 *            弱ティアで拾い、下流の氏名抽出が自然にフィルタする。
 * @returns {'strong'|'weak'|null}
 */
function companyNameTier(text) {
  if (COMPANY_NAME_RE.test(text)) return 'strong';
  const weak = text.length >= 2 && text.length <= 30 && !CTA_WORDS.test(text) && !/^https?:|@|^\d+$|^[A-Za-z]{1,3}$/.test(text);
  return weak ? 'weak' : null;
}

/** 媒体を浅く巡回し、外部の企業公式URL（母集団）を登録ドメイン単位で収集。 */
async function collectCompanies(media, maxPages) {
  const found = new Map(); // registrableDomain -> { name, url, conf }
  await crawlMedia(media.url, {
    maxPages,
    internalHint: LISTING_HINT,
    onCompany({ url, reg, text }) {
      if (!reg || found.has(reg)) return;
      const tier = companyNameTier(text);
      if (!tier) return;
      found.set(reg, { name: text, url: url.replace(/\/$/, '') + '/', conf: tier });
    },
  });
  return found;
}

/** カタログから巡回対象の媒体を選ぶ（到達可・ログイン壁でない・専用経路がある媒体は既定で除外）。 */
function selectTargets(catalog, { includeStructured, catRe, limit }) {
  let targets = (catalog.media || []).filter((m) => m.url
    && (!m.probe || (m.probe.reachable !== 'no' && m.probe.loginWall !== 'likely'))
    && m.strategy !== 'blocked-or-login'
    // マイナビ/Wantedlyは専用経路があるので既定は除外（--include-structured で含める）
    && (includeStructured || (m.strategy !== 'sitemap-discovery' && !/マイナビ$|Wantedly/i.test(m.name))));
  if (catRe) targets = targets.filter((m) => catRe.test(m.cat));
  return targets.slice(0, limit);
}

async function main() {
  const catalog = loadJson(CATALOG);
  if (!catalog || !Array.isArray(catalog.media)) {
    console.error(`媒体カタログが読めません: ${CATALOG}`);
    process.exit(1);
  }
  const perMedia = getIntArg('per-media-companies', 25);
  const mediaMaxPages = getIntArg('media-max-pages', 12);
  const deep = !!getArg('deep', false);
  const target = getIntArg('target', Infinity);
  const catFilter = getArg('cats', '');
  const prober = deep
    ? (u, o) => probeRecruitDeep(u, { ...o, maxPages: 6 })
    : (u, o) => probeRecruitPage(u, { ...o, maxPages: 3 });

  const targets = selectTargets(catalog, {
    includeStructured: !!getArg('include-structured', false),
    catRe: catFilter && catFilter !== true ? new RegExp(String(catFilter)) : null,
    limit: getIntArg('media-limit', 999),
  });

  // 再開: 既存CSVの企業を「済」として引き継ぐ
  const out = [];
  const doneCompany = new Set();
  if (fs.existsSync(OUT)) {
    for (const r of readCsv(fs.readFileSync(OUT, 'utf8')).records) {
      out.push(r);
      doneCompany.add(normCompanyName(r['企業名'] || ''));
    }
  }
  const doneMedia = new Set((loadJson(JOURNAL) || {}).doneMedia || []);
  const byMedia = [];

  log(`全媒体ハーベスト開始: 対象${targets.length}媒体（各企業母集団 最大${perMedia}社 hop, ${deep ? 'deep' : 'shallow'}抽出）`);
  const flush = () => {
    atomicWrite(OUT, toCsv(HEAD, out));
    atomicWrite(JOURNAL, JSON.stringify({ doneMedia: [...doneMedia] }, null, 2));
    atomicWrite(BYMEDIA, toCsv(BYMEDIA_HEAD, byMedia));
  };

  let mi = 0;
  for (const m of targets) {
    mi++;
    if (doneMedia.has(m.name)) { log(`  [${mi}/${targets.length}] ${m.name}: 済（skip）`); continue; }
    if (out.length >= target) { log(`target ${target} 到達、終了`); break; }

    // 1. 母集団抽出
    let pool = new Map();
    try { pool = await collectCompanies(m, mediaMaxPages); } catch { pool = new Map(); }
    const companies = [...pool.values()].filter((c) => !doneCompany.has(normCompanyName(c.name || ''))).slice(0, perMedia);

    // 2. 各企業サイトへ hop して氏名抽出
    let got = 0;
    for (const c of companies) {
      doneCompany.add(normCompanyName(c.name || ''));
      let hit = null;
      try { hit = await prober(c.url, { companyName: c.name }); } catch { hit = null; }
      if (!hit || !hit.name) continue;
      out.push({
        企業名: c.name, 公式URL: c.url, 採用担当者名: hit.name,
        役職: hit.role || '', 部署: hit.department || '', 確度: hit.confidence || '',
        取得元: hit.source || '企業サイト', 根拠URL: hit.sourceUrl || '', 根拠: hit.evidence || '',
        取得元媒体: m.name, 媒体戦略: m.strategy,
      });
      got++;
    }

    doneMedia.add(m.name);
    byMedia.push({
      媒体: m.name, カテゴリ: m.cat, 戦略: m.strategy,
      母集団企業: companies.length, 氏名取得: got, yield: pct(got, companies.length),
    });
    flush();
    log(`  [${mi}/${targets.length}] ${m.name}: 母集団${companies.length}社 → 氏名${got} (yield ${pct(got, companies.length)}) | 累計${out.length}`);
  }

  printSummary(byMedia, out.length);
}

function pct(n, total) { return total ? Math.round((n / total) * 100) + '%' : '-'; }

function printSummary(byMedia, nameCount) {
  const totalCompanies = byMedia.reduce((s, r) => s + r.母集団企業, 0);
  const withNames = byMedia.filter((r) => r.氏名取得 > 0);
  const L = '──────────────────────────────────────────────';
  console.log('\n' + L);
  console.log('  全媒体ハーベスト サマリ（マイナビ非依存の company-site hop 経路）');
  console.log(L);
  console.log(`  対象媒体            : ${byMedia.length}`);
  console.log(`  hopした企業(uniq)   : ${totalCompanies}`);
  console.log(`  採用担当者名 取得   : ${nameCount}（全体yield ${pct(nameCount, totalCompanies)}）`);
  console.log(`  氏名>0の媒体        : ${withNames.length}/${byMedia.length}`);
  withNames.sort((a, b) => b.氏名取得 - a.氏名取得)
    .forEach((r) => console.log(`     - ${r.媒体}(${r.カテゴリ}): ${r.氏名取得}/${r.母集団企業} ${r.yield}`));
  console.log(L);
  console.log(`  出力: ${OUT}`);
  console.log(`        ${BYMEDIA}\n`);
}

module.exports = { companyNameTier, selectTargets, collectCompanies };

if (require.main === module) {
  main().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
}
