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
 *   1. 媒体を浅く巡回し、外部の企業公式URL（母集団）を収集（crawlMediaForCompanies）。
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
const cheerio = require('cheerio');
const { politeGet } = require('./polite');
const { probeRecruitPage } = require('./probe-recruit-page');
const { probeRecruitDeep } = require('./probe-recruit-deep');
const { registrableDomain } = require('./fetch');
const { readCsv, toCsv, normCompanyName } = require('./csv');
const cfg = require('./config');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const CATALOG = path.join(DATA, 'media-catalog.json');
const getArg = (n, d) => { const i = process.argv.indexOf('--' + n); if (i < 0) return d; const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; };
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const atomic = (p, t) => { const tmp = p + '.tmp'; fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(tmp, t); fs.renameSync(tmp, p); };
const loadJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

const OUT = path.join(DATA, 'recruiter-all-media.csv');
const BYMEDIA = path.join(DATA, 'recruiter-all-media.by-media.csv');
const JOURNAL = path.join(DATA, 'harvest-all-media.journal.json');
const HEAD = ['企業名', '公式URL', '採用担当者名', '役職', '部署', '確度', '取得元', '根拠URL', '根拠', '取得元媒体', '媒体戦略'];

// 企業名らしさ（法人格）と、母集団抽出のヒント/CTA除外（harvest-catalog と同方針）
const LISTING_HINT = /(company|companies|corp|kigyo|kaisha|会社|企業|一覧|list|search|result|area|pref|地域|業種|category|page=|recruit|job|member|参加|掲載|scout|offer|detail|show)/i;
const CTA_WORDS = /^(詳細|もっと|一覧|エントリー|応募|もっと見る|続きを読む|see ?more|view|detail|map|地図|アクセス|もっとみる|お気に入り|ブックマーク|シェア|次へ|前へ|top|ホーム|ログイン|登録|会員)/i;
const COMPANY_NAME_RE = /(株式会社|有限会社|合同会社|合資会社|合名会社|（株）|\(株\)|㈱|㈲|医療法人|社会福祉法人|学校法人|協同組合|一般社団法人|一般財団法人|Inc\.?|Co\.,?\s?Ltd|Corp(?:oration)?\b|Ltd\.?)/;

function isCompanyLink(href, mediaHost) {
  let u; try { u = new URL(href); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const h = u.host.replace(/^www\./, '');
  if (mediaHost && (h === mediaHost || h.endsWith('.' + mediaHost) || mediaHost.endsWith('.' + h))) return false;
  if (cfg.EXCLUDE_DOMAINS.some((d) => h === d || h.endsWith('.' + d))) return false;
  return true;
}

// 媒体を浅く巡回し、外部の企業公式URL（母集団）を収集
async function crawlMediaForCompanies(media, maxPages) {
  const found = new Map(); // regDomain -> {name,url}
  let host = ''; try { host = new URL(media.url).host.replace(/^www\./, ''); } catch { return found; }
  const visited = new Set(); const queue = [media.url]; let fetched = 0;
  while (queue.length && fetched < maxPages) {
    const u = queue.shift(); if (visited.has(u)) continue; visited.add(u);
    let r; try { r = await politeGet(u, { render: 'static' }); } catch { continue; }
    fetched++;
    if (!r || r.blocked || r.error || !r.html) continue;
    const $ = cheerio.load(r.html);
    $('a[href]').each((_, a) => {
      const href = $(a).attr('href'); if (!href) return;
      let abs; try { abs = new URL(href, r.finalUrl || u).href; } catch { return; }
      const clean = abs.replace(/[#?].*$/, '');
      if (isCompanyLink(abs, host)) {
        const reg = registrableDomain(new URL(abs).host);
        const txt = ($(a).text() || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        // 2ティア: (強)法人格つきアンカー=高確度。(弱)企業名らしい短いアンカー=較正緩め
        //   逆求人/スカウト媒体は企業名を「株式会社」抜きで載せる（例: サイバーエージェント）ため
        //   法人格必須だと母集団がほぼ0になる。弱ティアで拾い、下流の氏名抽出が自然にフィルタする。
        const strong = COMPANY_NAME_RE.test(txt);
        const weak = txt.length >= 2 && txt.length <= 30 && !CTA_WORDS.test(txt) && !/^https?:|@|^\d+$|^[A-Za-z]{1,3}$/.test(txt);
        if (reg && !found.has(reg) && (strong || weak)) {
          found.set(reg, { name: txt, url: clean.replace(/\/$/, '') + '/', conf: strong ? 'strong' : 'weak' });
        }
      } else {
        let lu; try { lu = new URL(abs); } catch { return; }
        if (lu.host === new URL(media.url).host && LISTING_HINT.test(lu.pathname + lu.search) && !visited.has(clean) && queue.length < maxPages * 4) queue.push(clean);
      }
    });
  }
  return found;
}

async function main() {
  const cat = loadJson(CATALOG);
  const mediaLimit = parseInt(getArg('media-limit', '999'), 10);
  const perMedia = parseInt(getArg('per-media-companies', '25'), 10);
  const mediaMaxPages = parseInt(getArg('media-max-pages', '12'), 10);
  const deep = !!getArg('deep', false);
  const target = parseInt(getArg('target', '999999'), 10);
  const catFilter = getArg('cats', ''); const catRe = catFilter ? new RegExp(String(catFilter)) : null;
  const prober = deep ? (u, o) => probeRecruitDeep(u, { ...o, maxPages: 6 }) : (u, o) => probeRecruitPage(u, { ...o, maxPages: 3 });

  // runnable: 到達可・ログイン壁でない・blocked-or-login でない。マイナビ/Wantedlyは専用経路があるので既定は除外（--include-structured で含める）。
  const includeStructured = !!getArg('include-structured', false);
  let targets = cat.media.filter((m) => m.url
    && (!m.probe || (m.probe.reachable !== 'no' && m.probe.loginWall !== 'likely'))
    && m.strategy !== 'blocked-or-login'
    && (includeStructured || (m.strategy !== 'sitemap-discovery' && !/マイナビ$|Wantedly/i.test(m.name))));
  if (catRe) targets = targets.filter((m) => catRe.test(m.cat));
  targets = targets.slice(0, mediaLimit);

  // 再開
  const out = []; const doneCompany = new Set();
  if (fs.existsSync(OUT)) for (const r of readCsv(fs.readFileSync(OUT, 'utf8')).records) { out.push(r); doneCompany.add(normCompanyName(r['企業名'] || '')); }
  const journal = loadJson(JOURNAL) || { doneMedia: [] };
  const doneMedia = new Set(journal.doneMedia);
  const byMedia = [];

  log(`全媒体ハーベスト開始: 対象${targets.length}媒体（各企業母集団 最大${perMedia}社 hop, ${deep ? 'deep' : 'shallow'}抽出）`);
  const flush = () => { atomic(OUT, toCsv(HEAD, out)); atomic(JOURNAL, JSON.stringify({ doneMedia: [...doneMedia] }, null, 2)); };

  let mi = 0;
  for (const m of targets) {
    mi++;
    if (doneMedia.has(m.name)) { log(`  [${mi}/${targets.length}] ${m.name}: 済（skip）`); continue; }
    if (out.length >= target) { log(`target ${target} 到達、終了`); break; }
    // 1. 母集団抽出
    let pool = new Map();
    try { pool = await crawlMediaForCompanies(m, mediaMaxPages); } catch (e) { pool = new Map(); }
    const companies = [...pool.values()].filter((c) => !doneCompany.has(normCompanyName(c.name || ''))).slice(0, perMedia);
    // 2. 各企業サイトへ hop して氏名抽出
    let got = 0;
    for (const c of companies) {
      doneCompany.add(normCompanyName(c.name || ''));
      let hit = null;
      try { hit = await prober(c.url, { companyName: c.name }); } catch { hit = null; }
      if (hit && hit.name) {
        out.push({ 企業名: c.name, 公式URL: c.url, 採用担当者名: hit.name, 役職: hit.role || '', 部署: hit.department || '', 確度: hit.confidence || '', 取得元: hit.source || '企業サイト', 根拠URL: hit.sourceUrl || '', 根拠: hit.evidence || '', 取得元媒体: m.name, 媒体戦略: m.strategy });
        got++;
      }
    }
    doneMedia.add(m.name);
    byMedia.push({ 媒体: m.name, カテゴリ: m.cat, 戦略: m.strategy, 母集団企業: companies.length, 氏名取得: got, yield: companies.length ? Math.round((got / companies.length) * 100) + '%' : '-' });
    flush();
    atomic(BYMEDIA, toCsv(['媒体', 'カテゴリ', '戦略', '母集団企業', '氏名取得', 'yield'], byMedia));
    log(`  [${mi}/${targets.length}] ${m.name}: 母集団${companies.length}社 → 氏名${got} (yield ${companies.length ? Math.round((got / companies.length) * 100) : 0}%) | 累計${out.length}`);
  }

  const totalCompanies = byMedia.reduce((s, r) => s + r.母集団企業, 0);
  const L = '──────────────────────────────────────────────';
  console.log('\n' + L);
  console.log('  全媒体ハーベスト サマリ（マイナビ非依存の company-site hop 経路）');
  console.log(L);
  console.log(`  対象媒体            : ${byMedia.length}`);
  console.log(`  hopした企業(uniq)   : ${totalCompanies}`);
  console.log(`  採用担当者名 取得   : ${out.length}（全体yield ${totalCompanies ? Math.round((out.length / totalCompanies) * 100) : 0}%）`);
  console.log(`  氏名>0の媒体        : ${byMedia.filter((r) => r.氏名取得 > 0).length}/${byMedia.length}`);
  byMedia.filter((r) => r.氏名取得 > 0).sort((a, b) => b.氏名取得 - a.氏名取得).forEach((r) => console.log(`     - ${r.媒体}(${r.カテゴリ}): ${r.氏名取得}/${r.母集団企業} ${r.yield}`));
  console.log(L);
  console.log(`  出力: ${OUT}`);
  console.log(`        ${BYMEDIA}\n`);
}

main().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
