'use strict';
// 採用担当者名プローブ②：Webのインタビュー記事・採用ブログ・プレスリリースからの氏名抽出。
// =====================================================================
// ユーザー方針: Wantedly に頼らず、マイナビ/リクナビ/WEBインタビュー記事/地方系媒体 から
//   採用担当者名を取る。複数ページ・リンククリック後まで入念に探索して取得確率を上げる。
//
// 経路（discovery-first）:
//   1. 検索エンジン(Bing, search.js)に「氏名が載りやすい」クエリを複数投げる
//      （"社名" 採用担当 インタビュー / 人事 新卒 さん / 採用 責任者 メッセージ …）。
//   2. 結果を絞り込み（Wantedly除外・求人媒体除外・社名トークンが題名/抜粋に出る面のみ）。
//   3. 候補ページを politeGet(static) で取得 → 採用文脈の氏名抽出（recruit-page の正規表現）
//      → 取れなければ Gemini で1回だけ抽出（レイアウト非依存）。
//   4. 一覧/インデックス面なら、インタビュー/担当/メンバー系の内部リンクを1段だけ辿って再探索
//      （「リンククリック後まで」の要件）。
//   5. 社名がページ本文に出ることを必須化（集約サイトでの他社氏名の誤採用を防ぐ）。
//
// 戻り値は共通プローブ形 { name, role, department, confidence, evidence, sourceUrl, source, engine } or null。
const cheerio = require('cheerio');
const { politeGet } = require('./polite');
const { runSearch, companyCore, nameTokens, isExcludedDomain, pageMatchesCompany, rootDomain } = require('./search');
const { pageCorpus, extractFromRecruitText, visibleText } = require('./probe-recruit-page');
const { extractRecruiterFromText } = require('./recruiter');
const { geminiAvailable } = require('./gemini');
const { isPlausiblePersonName } = require('./jp-names');
const cfg = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wantedly は方針で除外。求人媒体（マイナビ/リクナビ等）は専用スクレイパに任せここでは拾わない。
// SNS/動画/EC/百科は氏名の誤抽出源になりやすいので除外。
const SKIP_DOMAINS = [
  'wantedly.com',
  'rikunabi.com', 'mynavi.jp', 'job.mynavi.jp', 'job.rikunabi.com',
  'en-japan.com', 'doda.jp', 'type.jp', 'green-japan.com', 'onecareer.jp',
  'career-tasu.jp', 'job.career-tasu.jp', 'baitoru.com', 'townwork.net',
  'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'youtube.com',
  'amazon.co.jp', 'wikipedia.org', 'weblio.jp', 'indeed.com',
  'job-medley.com', 'mynavi-agent.jp',
];
function skipDomain(host) {
  const h = rootDomain(host);
  return SKIP_DOMAINS.some((d) => h === d || h.endsWith('.' + d));
}

// 氏名が載りやすい記事を狙うクエリ群（上ほど採用担当者名に直結しやすい）。
function buildQueries(name) {
  return [
    `${name} 採用担当 インタビュー`,
    `${name} 新卒採用 担当者 メッセージ`,
    `${name} 人事 採用 ブログ 担当`,
    `${name} 採用 責任者 紹介`,
  ];
}

// 採用/人事の文脈らしさ（このどれかが本文にあれば氏名抽出を試す価値がある面）。
const RECRUIT_CONTEXT = /(採用担当|人事担当|採用責任者|人事部|採用部|新卒採用|採用チーム|採用メンバー|採用スタッフ|リクルーター|人材開発|人材戦略|採用ブログ|社員インタビュー)/;

// インデックス/一覧面から1段辿る価値のある内部リンク（インタビュー詳細・採用担当紹介へ）。
function followLinks(baseUrl, html) {
  let base; try { base = new URL(baseUrl); } catch { return []; }
  const $ = cheerio.load(html);
  const out = []; const seen = new Set();
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href'); if (!href) return;
    let u; try { u = new URL(href, base); } catch { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    if (u.host !== base.host) return;            // 同一サイト内のみ辿る（他社・媒体に飛ばない）
    u.hash = '';
    const key = u.toString(); if (seen.has(key) || key === baseUrl) return; seen.add(key);
    const hay = (decodeURIComponent(u.pathname) + ' ' + ($(a).text() || '')).toLowerCase();
    let score = 0;
    if (/interview|インタビュー|対談|社員紹介|メンバー|member|people|staff|採用担当|人事/i.test(hay)) score += 2;
    if (/message|メッセージ|recruit|採用/i.test(hay)) score += 1;
    if (score > 0) out.push({ url: key, score });
  });
  out.sort((a, b) => b.score - a.score);
  return out.map((x) => x.url);
}

// 1ページのHTMLから採用担当者名を抽出（正規表現 → Gemini フォールバック）。
//  社名がページに出ることを確認してから抽出する（他社氏名の誤採用防止）。
async function extractFromPage(html, companyName, useGemini) {
  if (!html) return null;
  const corpus = pageCorpus(html);
  const text = visibleText(html);
  // 社名照合（題名・本文に社名トークンが出るか）
  if (!pageMatchesCompany(companyName, '', text)) return { _noCompany: true };
  // 採用文脈が無い面はスキップ（誤抽出抑制）
  if (!RECRUIT_CONTEXT.test(corpus)) return { _noContext: true };

  // 1) 正規表現（採用ページ特化パターン・jp-names検証つき）＋最終人名ゲート
  const hit = extractFromRecruitText(corpus);
  if (hit && hit.name && isPlausiblePersonName(hit.name)) {
    return { name: hit.name, role: hit.role || '', department: hit.department || '',
      confidence: hit.confidence, evidence: hit.evidence, engine: 'regex' };
  }
  // 2) Gemini（採用/人事ロール必須・検証ゲートつき）
  if (useGemini) {
    try {
      const g = await extractRecruiterFromText(corpus.slice(0, cfg.MAX_TEXT_CHARS || 8000), { name: companyName }, cfg);
      if (g && g.name && isPlausiblePersonName(g.name)) {
        return { name: g.name, role: g.role || '', department: g.department || '',
          confidence: g.confidence || 0.7, evidence: g.evidence || '', engine: g.engine || 'gemini' };
      }
    } catch (_) {}
  }
  return null;
}

/**
 * 企業名（＋任意の所在地ヒント）から、Webのインタビュー記事等で採用担当者名を探す。
 * @param {string} companyName
 * @param {{maxResultsPerQuery?:number, maxFetch?:number, follow?:boolean, gemini?:boolean}} opts
 * @returns 共通プローブ形 or null
 */
async function probeInterview(companyName, opts = {}) {
  if (!companyName || !companyName.trim()) return null;
  const maxPerQuery = opts.maxResultsPerQuery || 4;
  const maxFetch = opts.maxFetch || 8;          // 1社あたり実取得ページ数の上限（礼儀＋速度）
  const doFollow = opts.follow !== false;
  const useGemini = opts.gemini != null ? opts.gemini : geminiAvailable(cfg);
  const core = companyCore(companyName);
  const tokens = nameTokens(companyName);

  // 1) クエリを順に実行して候補URLを集約（社名トークンが題名/抜粋に出るものを優先）
  const seenUrl = new Set();
  const candidates = [];
  for (const q of buildQueries(companyName)) {
    let results = [];
    try { results = await runSearch(q); } catch (_) { results = []; }
    let picked = 0;
    for (const r of results) {
      if (picked >= maxPerQuery) break;
      if (!r.url || skipDomain(r.host) || isExcludedDomain(r.host)) continue;
      if (seenUrl.has(r.url)) continue;
      // 題名/抜粋に社名トークンが出るものを優先（出ないものは弱い候補として後段に回す）
      const hay = ((r.title || '') + ' ' + (r.snippet || '')).toLowerCase();
      const nameHit = tokens.some((t) => t.length >= 2 && hay.includes(t)) || (core && hay.includes(core.toLowerCase()));
      seenUrl.add(r.url);
      candidates.push({ url: r.url, host: r.host, strong: nameHit });
      picked++;
    }
    await sleep(cfg.SEARCH_DELAY_MS || 1200);
  }
  // 社名一致の強い候補を先に試す
  candidates.sort((a, b) => (b.strong ? 1 : 0) - (a.strong ? 1 : 0));

  // 2) 候補ページを取得して氏名抽出。一覧面なら内部リンクを1段辿る。
  let fetched = 0;
  for (const c of candidates) {
    if (fetched >= maxFetch) break;
    const page = await politeGet(c.url, { render: 'static' });
    fetched++;
    if (!page || page.blocked || page.error || !page.html) continue;
    const res = await extractFromPage(page.html, companyName, useGemini);
    if (res && res.name) {
      return { name: res.name, role: res.role, department: res.department,
        confidence: res.confidence, evidence: res.evidence,
        sourceUrl: page.finalUrl || c.url, source: 'インタビュー記事/採用ブログ', engine: res.engine };
    }
    // 一覧/インデックス面：内部のインタビュー/担当紹介リンクを1段だけ辿る
    if (doFollow && res && (res._noContext || res._noCompany || !res.name)) {
      const links = followLinks(page.finalUrl || c.url, page.html).slice(0, 2);
      for (const lk of links) {
        if (fetched >= maxFetch) break;
        const sub = await politeGet(lk, { render: 'static' });
        fetched++;
        if (!sub || sub.blocked || sub.error || !sub.html) continue;
        const r2 = await extractFromPage(sub.html, companyName, useGemini);
        if (r2 && r2.name) {
          return { name: r2.name, role: r2.role, department: r2.department,
            confidence: r2.confidence, evidence: r2.evidence,
            sourceUrl: sub.finalUrl || lk, source: 'インタビュー記事/採用ブログ(リンク先)', engine: r2.engine };
        }
      }
    }
  }
  return null;
}

// ── CLI（単体・動作確認用）─────────────────────────────────────────
async function main() {
  const names = process.argv.slice(2);
  if (!names.length) {
    console.error('使い方: node src/probe-interview.js "会社名1" "会社名2" ...');
    process.exit(1);
  }
  for (const nm of names) {
    process.stdout.write(`\n[インタビュー探索] ${nm} … `);
    const r = await probeInterview(nm);
    console.log(r ? JSON.stringify({ 担当者: r.name, 役職: r.role, 部署: r.department,
      確度: r.confidence, engine: r.engine, src: r.sourceUrl, 根拠: r.evidence }, null, 0) : '—（未取得）');
  }
}
if (require.main === module) main().catch((e) => { console.error('FATAL', e); process.exit(1); });

module.exports = { probeInterview, extractFromPage, followLinks, buildQueries, skipDomain };
