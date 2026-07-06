'use strict';
/**
 * 採用担当者名プローブ③：SNS/オウンドメディア/代表メッセージ（求人媒体・Wantedly以外）
 * ============================================================================
 * ユーザー方針(2026-07-05): Wantedly以外のWeb探索ノウハウを厚くする。求人媒体を使わず
 *   「公式HP・企業のインタビュー記事・SNS発信内容」から担当者名/発信者名を取る。
 *
 * probe-interview.js（インタビュー記事狙い）を補完する“発信者・オウンドメディア”特化探索。
 *   狙う面: note / アメブロ / はてなブログ等のオウンドメディア記事、代表メッセージ、
 *            スタッフ紹介、SNSプロフィール（社名を含む個人発信）。
 *   ※X/Facebookは無料自動取得がJS/ログイン壁で不安定 → 静的取得を試みるが期待値は低い。
 *     検索スニペット中の「氏名＋社名」も候補化してカバーする。
 *
 * 抽出は既存資産を再利用（extractFromRecruitText＝採用/人事アンカー、＋本モジュールの代表者名パターン）。
 *   社名がページ/スニペットに出ることを必須化（他社発信の誤採用防止）。
 *
 * 戻り値は候補“配列”（融合器 name-fusion.js に渡す前提。0..n件）。
 *   candidate = { name, role, department, confidence, evidence, sourceUrl, source, engine }
 */
const cheerio = require('cheerio');
const { politeGet } = require('./polite');
const { runSearch, companyCore, nameTokens, rootDomain, isExcludedDomain, pageMatchesCompany } = require('./search');
const { extractFromRecruitText, visibleText, pageCorpus } = require('./probe-recruit-page');
const { isPlausiblePersonName, splitName } = require('./jp-names');
const { canonName } = require('./name-fusion');
const cfg = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 求人媒体・Wantedlyは方針で使わない。百科/EC/動画は誤抽出源なので除外。
const SKIP_DOMAINS = [
  'wantedly.com', 'rikunabi.com', 'mynavi.jp', 'job.mynavi.jp', 'job.rikunabi.com',
  'en-japan.com', 'doda.jp', 'type.jp', 'green-japan.com', 'onecareer.jp',
  'career-tasu.jp', 'baitoru.com', 'townwork.net', 'indeed.com', 'job-medley.com',
  'amazon.co.jp', 'wikipedia.org', 'weblio.jp', 'youtube.com', 'instagram.com',
];
// オウンドメディア/SNS系（氏名が発信者として載りやすい面）。社名ゲートは別途必須。
const SOCIAL_HINT = /(note\.com|note\.mu|ameblo\.jp|hatenablog|hatena\.ne\.jp|prtimes\.jp|twitter\.com|x\.com|facebook\.com|linkedin\.com|blog|オウンドメディア|note|ブログ)/i;

function skipDomain(host) {
  const h = rootDomain(host);
  return SKIP_DOMAINS.some((d) => h === d || h.endsWith('.' + d));
}
function sourceLabelFor(host) {
  const h = rootDomain(host || '');
  if (/note\.(com|mu)/.test(h)) return 'note/オウンドメディア';
  if (/ameblo\.jp|hatenablog|hatena\.ne\.jp/.test(h)) return 'ブログ/オウンドメディア';
  if (/twitter\.com|x\.com/.test(h)) return 'SNS(X)';
  if (/facebook\.com/.test(h)) return 'SNS(Facebook)';
  if (/linkedin\.com/.test(h)) return 'SNS(LinkedIn)';
  if (/prtimes\.jp/.test(h)) return 'PR TIMES/オウンドメディア';
  return 'SNS/オウンドメディア';
}

// SNS/オウンドメディア/代表メッセージを狙うクエリ群（interview系とは別角度）。
function buildQueries(name) {
  return [
    `${name} note 採用`,
    `${name} 採用担当 note`,
    `${name} 代表取締役 メッセージ`,
    `${name} 社長 ブログ`,
    `${name} 人事 スタッフ 紹介`,
    `${name} 採用 責任者 note`,
  ];
}

const K = '一-龥々〆ヶ';
const KN = `[${K}]{1,4}[ 　]?[${K}ぁ-んァ-ヶー]{1,5}`;
// 肩書きチェーン（代表取締役社長／代表取締役会長／代表取締役CEO 兼… 等）をまるごと消費する。
// これが無いと「代表取締役社長　山田太郎」で “社長” を氏名と誤認して本体を逃す（実験3で判明）。
const TITLE_CHAIN = `代表取締役(?:社長|会長|副社長|専務|常務|CEO|COO|CFO|執行役員|兼[${K}]{0,8})*`;
// 代表者名パターン（会社概要/代表メッセージ面で頻出）。ラベル付き＝人名確定に近い。捕捉名は canonName で二次検証。
// 肩書きと氏名の区切り。実ページは改行で分離する（「代表取締役社長\n西井 希伊」）ため
// 空白・改行(\s)を1〜4字許容して橋渡しする。広げ過ぎると別要素へ飛ぶので上限を付ける。
const SEP = `[\\s　:：・/／]{0,4}`;
const REP_PATTERNS = [
  // 会社概要テーブル:「代表者　代表取締役社長　山田 太郎」ラベル＋肩書きチェーン＋氏名
  new RegExp(`代表者(?:名)?${SEP}(?:${TITLE_CHAIN})?${SEP}(${KN})(?![${K}])`, 'g'),
  // 肩書きチェーン直後の氏名（改行分離も可）:「代表取締役社長\n西井 希伊」
  new RegExp(`${TITLE_CHAIN}${SEP}(${KN})(?![${K}])`, 'g'),
  // 氏名＋（肩書き）逆順:「山田 太郎（代表取締役）」
  new RegExp(`(${KN})[ 　]*(?:／|/|（|\\()?[ 　]*代表取締役`, 'g'),
];
// 発信者/著者アンカー（note等の署名・プロフィール）。
// ※「(名詞)です」の単独マッチは「必要です/制作です」等を人名化する誤検出源なので採らない。
//   自己名乗り「と申します」＋明示ラベル（文/著/執筆）のみ。しかも辞書姓必須で厳格化。
const AUTHOR_PATTERNS = [
  new RegExp(`(?:文|著|執筆|取材・?文|ライター|writer|author)[ 　:：・]*(${KN})`, 'gi'),
  new RegExp(`(${KN})[ 　]*と申します`, 'g'),
];

/**
 * パターン群から最初の妥当な人名を返す。
 * @param {boolean} strict true なら姓辞書一致(splitName)を必須にする（弱アンカー用）。
 */
// 社名（コア語）と一致/内包する氏名候補は誤検出（社名を人名化）として弾く。
function looksLikeCompany(name, companyName) {
  const core = (companyCore(companyName) || '').replace(/[ 　]/g, '');
  const n = String(name || '').replace(/[ 　]/g, '');
  if (!core || core.length < 2 || !n) return false;
  return n === core || n.includes(core) || core.includes(n);
}

function firstPlausible(patterns, text, roleGuess, strict = false) {
  for (const re of patterns) {
    re.lastIndex = 0; let m;
    while ((m = re.exec(text)) !== null) {
      const raw = (m[1] || '').replace(/[ 　]+/g, ' ').trim();
      if (!raw) { re.lastIndex = m.index + 1; continue; }
      const sp = splitName(raw.replace(/\s/g, ''));
      // ページに姓名境界（空白）があればそれを尊重（辞書が2字姓「西井」を「西|井」に誤分割するのを防ぐ）。
      const disp = /[ 　]/.test(raw) ? raw : (sp && sp.mei ? `${sp.sei} ${sp.mei}` : raw);
      // strict: 辞書姓（splitName成立）を必須。非strictでも isPlausiblePersonName を要求。
      const ok = strict ? !!(sp && sp.mei) : isPlausiblePersonName(disp);
      if (ok) return { name: disp, evidence: m[0].trim().slice(0, 80), role: roleGuess };
      re.lastIndex = m.index + 1;
    }
  }
  return null;
}

// 1ページから候補を抽出（社名ゲート → 採用/人事アンカー → 代表者名 → 発信者）。
// opts.trustDomain: 公式ドメイン内部の深掘り等、面が当該企業のものと確定している場合は社名ゲートを免除。
function extractCandidatesFromPage(html, companyName, host, opts = {}) {
  if (!html) return [];
  const text = visibleText(html);
  const corpus = pageCorpus(html);
  if (!opts.trustDomain && !pageMatchesCompany(companyName, '', text)) return [];  // 社名が面に無ければ捨てる
  const out = [];
  const src = sourceLabelFor(host);
  // 社名の人名化＋役職語/UI断片（canonName=null）を弾く。regex経路もcanonNameゲートを通す。
  const reject = (nm) => !nm || looksLikeCompany(nm, companyName) || !canonName(nm);

  // ① 採用/人事アンカー（最優先・既存の採用ページ用抽出器を流用）
  const hit = extractFromRecruitText(corpus);
  if (hit && hit.name && isPlausiblePersonName(hit.name) && !reject(hit.name)) {
    out.push({ name: hit.name, role: hit.role || '採用/人事', department: hit.department || '',
      confidence: Math.min(0.8, (hit.confidence || 0.6)), evidence: hit.evidence || '', source: src, engine: 'regex' });
  }
  // ② 代表者名（オウンドメディア/代表メッセージ）。代表取締役ラベルは強い構造アンカー＝確度高め(0.7)。
  const rep = firstPlausible(REP_PATTERNS, text, '代表');
  if (rep && !reject(rep.name)) out.push({ name: rep.name, role: '代表', department: '', confidence: 0.7,
    evidence: rep.evidence, source: src + '(代表)', engine: 'regex' });
  // ③ 発信者/著者（note署名等）。弱アンカーなので辞書姓必須(strict)＋低確度。
  const au = firstPlausible(AUTHOR_PATTERNS, text, '発信者', true);
  if (au && !reject(au.name) && !out.some((o) => o.name === au.name)) out.push({ name: au.name, role: au.role, department: '',
    confidence: 0.55, evidence: au.evidence, source: src + '(発信者)', engine: 'regex' });

  return out;
}

// 検索スニペットからの氏名候補（本文取得が壁のX/FB用の保険）。社名がスニペットに出る面のみ。
function candidateFromSnippet(r, companyName, tokens, core) {
  const hay = `${r.title || ''} ${r.snippet || ''}`;
  const nameHit = tokens.some((t) => t.length >= 2 && hay.includes(t)) || (core && hay.includes(core));
  if (!nameHit) return null;
  const rep = firstPlausible(REP_PATTERNS, hay, '代表') || firstPlausible(AUTHOR_PATTERNS, hay, '発信者');
  if (!rep) return null;
  return { name: rep.name, role: rep.role || '', department: '', confidence: 0.5,
    evidence: hay.slice(0, 80), source: sourceLabelFor(r.host) + '(スニペット)', engine: 'snippet' };
}

/**
 * SNS/オウンドメディア/代表メッセージから採用担当者名/発信者名の候補を集める。
 * @param {string} companyName
 * @param {{maxPerQuery?:number, maxFetch?:number}} [opts]
 * @returns {Promise<Array<object>>} 候補配列（0..n・融合器に渡す）
 */
async function probeSocial(companyName, opts = {}) {
  if (!companyName || !companyName.trim()) return [];
  const maxPerQuery = opts.maxPerQuery || 3;
  const maxFetch = opts.maxFetch || 6;
  const core = (companyCore(companyName) || '').toLowerCase();
  const tokens = nameTokens(companyName);

  const seen = new Set();
  const candidates = [];   // {url, host, strong, snippetCand}
  for (const q of buildQueries(companyName)) {
    let results = [];
    try { results = await runSearch(q); } catch (_) { results = []; }
    let picked = 0;
    for (const r of results) {
      if (picked >= maxPerQuery) break;
      if (!r.url || skipDomain(r.host) || isExcludedDomain(r.host)) continue;
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      const hay = ((r.title || '') + ' ' + (r.snippet || '')).toLowerCase();
      const nameHit = tokens.some((t) => t.length >= 2 && hay.includes(t)) || (core && hay.includes(core));
      const social = SOCIAL_HINT.test(r.host + ' ' + r.url);
      candidates.push({ url: r.url, host: r.host, strong: nameHit, social,
        snippetCand: candidateFromSnippet(r, companyName, tokens, core) });
      picked++;
    }
    await sleep(cfg.SEARCH_DELAY_MS || 1200);
  }
  // 社名一致かつSNS/オウンドメディアの面を優先
  candidates.sort((a, b) => (b.strong ? 1 : 0) - (a.strong ? 1 : 0) || (b.social ? 1 : 0) - (a.social ? 1 : 0));

  const out = [];
  let fetched = 0;
  for (const c of candidates) {
    if (fetched >= maxFetch) {
      if (c.snippetCand) out.push({ ...c.snippetCand, sourceUrl: c.url });
      continue;
    }
    const page = await politeGet(c.url, { render: 'static' }).catch(() => null);
    fetched++;
    if (!page || page.blocked || page.error || !page.html) {
      if (c.snippetCand) out.push({ ...c.snippetCand, sourceUrl: c.url });   // 本文取れずでもスニペット候補は残す
      continue;
    }
    const cands = extractCandidatesFromPage(page.html, companyName, c.host);
    for (const cand of cands) out.push({ ...cand, sourceUrl: page.finalUrl || c.url });
  }
  // 氏名でユニーク化（同名は最高確度を残す）
  const byName = new Map();
  for (const o of out) {
    const k = o.name.replace(/\s/g, '');
    if (!byName.has(k) || byName.get(k).confidence < o.confidence) byName.set(k, o);
  }
  return [...byName.values()];
}

// ── CLI（単体確認）─────────────────────────────────────────────────
async function main() {
  const names = process.argv.slice(2);
  if (!names.length) { console.error('使い方: node src/probe-social.js "会社名1" ...'); process.exit(1); }
  for (const nm of names) {
    process.stdout.write(`\n[SNS/オウンドメディア探索] ${nm} …\n`);
    const cands = await probeSocial(nm);
    if (!cands.length) { console.log('  —（候補なし）'); continue; }
    for (const c of cands) console.log(`  ★ ${c.name}｜${c.role}｜確度${c.confidence}｜${c.source}｜${c.sourceUrl}`);
  }
}
if (require.main === module) main().catch((e) => { console.error('FATAL', e); process.exit(1); });

module.exports = { probeSocial, extractCandidatesFromPage, buildQueries, sourceLabelFor, skipDomain, looksLikeCompany };
