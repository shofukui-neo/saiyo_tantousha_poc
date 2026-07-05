'use strict';
/**
 * 採用担当者名プローブ④：公式HP 深掘りクロール（検索非依存・求人媒体/Wantedly不使用）
 * ============================================================================
 * ユーザー方針(2026-07-05): Wantedly以外のWeb探索を厚くする＝公式HP・インタビュー記事・SNS発信。
 *
 * 実測で判明した環境事実:
 *   - Bing/DDGのHTMLスクレイピングは無関係な結果を返す事があり“検索起点の発見”は不安定。
 *   - 一方、URL直fetchは堅牢（robots遵守で公式HPは普通に取れる）。
 *   → よって本プローブは「公式URLを起点に、同一ドメインを深掘り」＝検索非依存で確実に回す。
 *
 * 集める面（すべてオウンドメディア＝社名ゲートを自然に満たす）:
 *   ・採用/recruit … 採用担当・人事の氏名
 *   ・会社概要/company/about … 代表者名
 *   ・代表メッセージ/message/greeting/president … 代表者名（自己名乗り）
 *   ・社員紹介/member/people/staff/team … スタッフ実名
 *   ・インタビュー/interview/story/voice/culture/blog/note … 発信者・登場社員名
 *   ・サイト内の外部SNSリンク（note/X/Facebook）… 発信者アカウントの表示名
 *
 * 抽出は probe-social.extractCandidatesFromPage（採用/人事→代表→発信者）を再利用し、
 *   役割(採用/代表/役員/発信者)を“正直に”ラベルして候補配列で返す（融合器 name-fusion に渡す）。
 *
 *   node src/probe-site-deep.js "会社名" "https://公式URL/"
 */
const cheerio = require('cheerio');
const { politeGet } = require('./polite');
const { rootDomain } = require('./search');
const { extractCandidatesFromPage, looksLikeCompany } = require('./probe-social');
const { canonName } = require('./name-fusion');
const { visibleText, pageCorpus } = require('./probe-recruit-page');
const { extractRecruiterFromText } = require('./recruiter');
const { isPlausiblePersonName } = require('./jp-names');
const { geminiAvailable } = require('./gemini');
const cfg = require('./config');

// Geminiを呼ぶ価値のある面か（人物が実名で載る兆候）。無料枠RPMが厳しいので絞る。
const GEMINI_WORTH = /(採用担当|人事|代表|社長|会長|役員|メッセージ|社員|メンバー|スタッフ|インタビュー|紹介|プロフィール|profile|message|member|people|interview)/;

// 深掘り対象の内部リンク（パス/アンカーテキストのヒント）。強パスは加点。
const SECTION_HINTS = [
  { re: /recruit|採用|saiyo|join|careers?|entry/i,               role: '採用', w: 3 },
  { re: /message|greeting|president|代表挨拶|top-?message|ごあいさつ/i, role: '代表', w: 3 },
  // 会社概要の本命パス（代表者名がほぼ必ず載る表）。generic about/index より高く（実験3の取りこぼし対策）。
  { re: /outline|profile|会社概要|企業概要|会社案内|gaiyo|kaisha|overview|corporate-?info/i, role: '代表', w: 3 },
  { re: /member|people|staff|team|社員|メンバー|スタッフ/i,       role: '社員', w: 2 },
  { re: /interview|story|stories|voice|culture|人を知る|社員紹介/i, role: '発信者', w: 2 },
  { re: /blog|note|magazine|media|journal|owned/i,               role: '発信者', w: 1 },
  { re: /company|about|corporate|企業情報|会社/i,                 role: '代表', w: 1 },
];
// サイト内に載る外部SNSリンク（発信アカウント）。noteは静的取得が効く。
const SNS_RE = /(note\.com\/[a-zA-Z0-9_\-]+|twitter\.com\/[a-zA-Z0-9_]+|x\.com\/[a-zA-Z0-9_]+|facebook\.com\/[a-zA-Z0-9.\-]+)/i;

function sectionRole(hay) {
  let best = null;
  for (const s of SECTION_HINTS) if (s.re.test(hay)) { if (!best || s.w > best.w) best = s; }
  return best; // {role,w} or null
}

// トップHTMLから、深掘りすべき内部URL（役割つき）と外部SNS URLを収集。
function collectLinks(baseUrl, html) {
  let base; try { base = new URL(baseUrl); } catch { return { internal: [], sns: [] }; }
  const $ = cheerio.load(html);
  const internal = []; const sns = new Set(); const seen = new Set();
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href'); if (!href) return;
    let u; try { u = new URL(href, base); } catch { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    const full = u.toString();
    const m = full.match(SNS_RE);
    if (m) { sns.add('https://' + m[1].replace(/^https?:\/\//, '')); return; }
    if (rootDomain(u.host) !== rootDomain(base.host)) return;  // 内部のみ深掘り
    u.hash = '';
    const key = u.toString(); if (seen.has(key) || key === baseUrl) return; seen.add(key);
    const hay = (decodeURIComponent(u.pathname) + ' ' + ($(a).text() || '')).toLowerCase();
    const sr = sectionRole(hay);
    if (sr) internal.push({ url: key, role: sr.role, score: sr.w });
  });
  internal.sort((a, b) => b.score - a.score);
  return { internal, sns: [...sns] };
}

// 役割ヒントで候補のroleを補正（面のセクション種別を尊重）。
function relabel(cands, pageRole, sourceTag) {
  return cands.map((c) => {
    const role = c.role && c.role !== '採用/人事' ? c.role : (pageRole || c.role || '');
    return { ...c, role, source: sourceTag || c.source };
  });
}

/**
 * 公式URL起点で同一ドメインを深掘りし、担当者/代表/発信者の氏名候補を集める。
 * @param {string} companyName
 * @param {string} officialUrl
 * @param {{maxPages?:number}} [opts]
 * @returns {Promise<Array<object>>} 候補配列（0..n）
 */
async function probeSiteDeep(companyName, officialUrl, opts = {}) {
  if (!companyName || !officialUrl) return [];
  const maxPages = opts.maxPages || 8;
  const useGemini = opts.gemini != null ? opts.gemini : geminiAvailable(cfg);
  // 社あたりGemini呼出上限。無料枠が極端にタイト(実測: 数社で429枯渇)なので既定2に絞り、
  // かつ「採用担当個人名が載る面」にだけ投じる（代表者名はregexで足りる＝Geminiを浪費しない）。
  const geminiBudget = opts.geminiBudget != null ? opts.geminiBudget : 2;
  const out = [];
  // Gemini呼出は無料枠(RPM)が極端にタイト。ページ毎に呼ぶ代わりに、regex空振りのHR面テキストを
  // バッファに溜め、ループ後に「1社=1呼出」で連結送信する（同じ枠でカバー社数を2-3倍化）。
  const hrBuf = [];   // {corpus, role, url}
  const MAXC = cfg.MAX_TEXT_CHARS || 8000;
  const collectHrPage = (html, pageRole, url) => {
    if (!useGemini) return;
    const corpus = pageCorpus(html);
    if (!GEMINI_WORTH.test(corpus)) return;
    hrBuf.push({ corpus, role: pageRole, url });
  };
  // バッファを連結して1回だけGeminiに投げ、HR個人名を1件取る。
  const geminiBatch = async () => {
    if (!useGemini || !hrBuf.length) return;
    // 面ごとにマーカーを付けて連結（役割/URLを手掛かりに）。全体をMAXC字に収める。
    let combined = '';
    for (const pg of hrBuf) {
      const head = `\n【${pg.role}面: ${pg.url}】\n`;
      const remain = MAXC - combined.length - head.length;
      if (remain <= 200) break;
      combined += head + pg.corpus.slice(0, remain);
    }
    const leadRole = (hrBuf.find((p) => p.role === '採用') || hrBuf[0]).role;
    const leadUrl = (hrBuf.find((p) => p.role === '採用') || hrBuf[0]).url;
    try {
      // Gemini(throttle+429リトライ)が遅延すると呼び出し側のcompany-timeoutに巻き込まれ、
      // 既にregexで取れた代表者名ごと破棄される。内部で短くタイムアウトしregex結果を守る。
      const g = await Promise.race([
        extractRecruiterFromText(combined, { name: companyName }, cfg),
        new Promise((r) => setTimeout(() => r(null), opts.geminiTimeoutMs || 12000)),
      ]);
      if (g && g.name && isPlausiblePersonName(g.name) && canonName(g.name) && !looksLikeCompany(g.name, companyName)) {
        out.push({ name: g.name, role: g.role || leadRole || '', department: g.department || '',
          confidence: Math.min(0.82, g.confidence || 0.7), evidence: g.evidence || '',
          source: `公式HP/${g.role || leadRole || '採用'}(AIバッチ)`, engine: g.engine || 'gemini', sourceUrl: leadUrl });
      }
    } catch (_) {}
  };
  void geminiBudget;

  const top = await politeGet(officialUrl, { render: 'static' }).catch(() => null);
  if (!top || !top.html) return out;
  const baseUrl = top.finalUrl || officialUrl;

  // トップ自体からも拾う（代表メッセージがトップにある小規模サイト対策）
  const topCands = extractCandidatesFromPage(top.html, companyName, rootDomain(baseUrl), { trustDomain: true });
  for (const c of topCands) out.push({ ...c, source: '公式HP', sourceUrl: baseUrl });

  const { internal, sns } = collectLinks(baseUrl, top.html);

  // 内部の各セクションを深掘り（役割の強い順）。regex→取れなければGemini。
  let fetched = 0;
  for (const link of internal) {
    if (fetched >= maxPages) break;
    const p = await politeGet(link.url, { render: 'static' }).catch(() => null);
    fetched++;
    if (!p || p.blocked || !p.html) continue;
    const url = p.finalUrl || link.url;
    const cands = extractCandidatesFromPage(p.html, companyName, rootDomain(url), { trustDomain: true });
    if (cands.length) { for (const c of relabel(cands, link.role, `公式HP/${link.role}`)) out.push({ ...c, sourceUrl: url }); }
    // regex空振り面はバッファに溜める（後で1回だけGeminiにまとめ送り）。バッチは1呼出＝枠コスト不変なので
    // 役割で絞らずHR信号(GEMINI_WORTH)のある面は全部入れる。HR個人名は「代表」分類の面(書籍/インタビュー)にも居るため。
    else { collectHrPage(p.html, link.role, url); }
  }
  // 溜めたHR面をまとめて1回だけGeminiに投げる（regexで代表者名も採用担当も取れなかった時の切り札）
  if (!out.some((c) => /採用|人事/.test(c.role || ''))) await geminiBatch();

  // サイトが公開している外部SNS（noteが最も取れる）を数件だけ辿る。
  let snsFetched = 0;
  for (const su of sns) {
    if (snsFetched >= 2) break;
    if (!/note\.(com|mu)/.test(su)) continue;   // X/FBは静的取得が壁 → noteに限定
    const p = await politeGet(su, { render: 'static' }).catch(() => null);
    snsFetched++;
    if (!p || p.blocked || !p.html) continue;
    // note個人/企業ページ: 表示名 h1/title を発信者候補に、本文からも抽出
    const $ = cheerio.load(p.html);
    const disp = ($('h1').first().text() || '').trim();
    const cands = extractCandidatesFromPage(p.html, companyName, 'note.com');
    for (const c of cands) out.push({ ...c, source: 'note/オウンドメディア', sourceUrl: p.finalUrl || su });
    void disp;
  }

  // 氏名でユニーク化（同名は最高確度）。
  const byName = new Map();
  for (const o of out) {
    if (!o.name) continue;
    const k = o.name.replace(/\s/g, '');
    if (!byName.has(k) || byName.get(k).confidence < o.confidence) byName.set(k, o);
  }
  return [...byName.values()];
}

async function main() {
  const [name, url] = process.argv.slice(2);
  if (!name || !url) { console.error('使い方: node src/probe-site-deep.js "会社名" "https://公式URL/"'); process.exit(1); }
  console.log(`[公式HP深掘り] ${name} <${url}>`);
  const cands = await probeSiteDeep(name, url);
  if (!cands.length) { console.log('  —（候補なし）'); return; }
  for (const c of cands.sort((a, b) => b.confidence - a.confidence))
    console.log(`  ★ ${c.name}｜役割:${c.role || '-'}｜確度${c.confidence}｜${c.source}｜${c.sourceUrl}`);
}
if (require.main === module) main().catch((e) => { console.error('FATAL', e); process.exit(1); });

module.exports = { probeSiteDeep, collectLinks, sectionRole };
