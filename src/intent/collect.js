'use strict';
/**
 * インテント・エビデンス収集層（層2の一次情報を集める）
 * ============================================================================
 * 3系統を独立に叩き、取れたものだけで判定する（1系統が死んでも他は動く）。
 *   ① csv     … 入力リストが既に持っている事実（採用実績の3年系列・メール・卒年）＝ネットワーク0
 *   ② mynavi  … 会社概要/インターン/説明会の各面を素のHTTPで取得（実測0.3秒・Playwright不要）
 *                → 最終更新日・二次募集/秋採用の文言・インターン件数・合説出展・採用実績
 *   ③ site    … 自社サイト（公式URL → 採用ページ）を polite 経由で取得
 *                → 採用専用メール・採用用LINE・採用ページの指紋（次回の差分用）
 *   ④ jobs    … 求人検索エンジン（求人ボックス）に「社名 + 人事/採用担当」を投げ、中途求人カードを拾う
 *                → 最強シグナル①。ホスト単位で直列化されるため、絞ったリストに使う
 *
 * 取得マナー: 自社サイト/求人検索は polite.js（robots遵守・ホスト別レート制限・キャッシュ）。
 * マイナビは既存ハーベスタ（harvest-icp-wide.js）と同じ素のHTTP＋自前ディレイで揃える。
 */
const https = require('https');
const cheerio = require('cheerio');
const { politeGet } = require('../polite');
const { extractEmailsFromPage } = require('../email-harvest');
const { detectLineOnPage, summarizeLine } = require('../line-official');
const { extractHireRecord } = require('../enrich-hire-record');
const { registrableDomain } = require('../fetch');
const { normCompanyName } = require('../csv');
const { fingerprint } = require('./store');
const { INTERN_WORDS, EXPO_WORDS, countOccurrences } = require('./signals');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 素のHTTP取得（マイナビ用。harvest-icp-wide.js と同じ実装で挙動を揃える）----
function fetchUrl(url, redirects = 3) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (_) { return resolve(''); }
    const req = https.get(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8' }, timeout: 20000 }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects > 0) {
        r.resume(); return resolve(fetchUrl(new URL(r.headers.location, u).href, redirects - 1));
      }
      if (r.statusCode !== 200) { r.resume(); return resolve(''); }
      let b = ''; r.setEncoding('utf8');
      r.on('data', (c) => { b += c; if (b.length > 3e6) { req.destroy(); resolve(b); } });
      r.on('end', () => resolve(b));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}
const ent = (s) => String(s || '')
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d))
  .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"');
function toText(h) {
  let t = String(h || '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '\n');
  t = ent(t).replace(/\n\s*\n+/g, '\n');
  return t.replace(/(\d)\s*名/g, '$1名').replace(/(\d)\s*%/g, '$1%');
}

// =====================================================================
// ① 入力CSVが持っている事実（ネットワーク0）
// =====================================================================
function fromRow(rec) {
  const 卒年 = String(rec['卒年'] || '').trim();
  const 実績 = String(rec['採用実績(直近3年)'] || rec['採用実績3年'] || rec['採用実績'] || '').trim();
  const mail = String(rec['メール'] || '').trim().toLowerCase();
  const page = String(rec['採用ページURL'] || '').trim();
  const ev = {
    企業名: String(rec['企業名'] || '').trim(),
    corpID: String(rec.corpID || '').trim(),
    卒年,
    採用実績系列: 実績,
    採用予定人数: String(rec['採用予定人数'] || rec['年間新卒採用人数'] || '').replace(/[^0-9]/g, '') || '',
    メール: [],
    掲載本文: '', インターン本文: '', インターン件数: null, 合説出展: null,
    LINE: null, 採用ページ: null,
    公式URL: String(rec['公式URL'] || '').trim(),
    掲載URL: page,
    取得ソース: ['csv'], エラー: [],
  };
  if (mail && /@/.test(mail)) {
    const dom = ev.公式URL ? registrableDomain(safeHost(ev.公式URL)) : '';
    ev.メール.push({ email: mail, ownDomain: dom ? registrableDomain(mail.split('@')[1] || '') === dom : false });
  }
  return ev;
}
function safeHost(u) { try { return new URL(u).hostname; } catch (_) { return ''; } }

// =====================================================================
// ② マイナビ（会社概要 / インターン / 説明会）
// =====================================================================
const MYNAVI_YEAR_RE = /job\.mynavi\.jp\/(\d{2})\//;
function mynaviBase(rec, ev) {
  const url = String(rec['採用ページURL'] || '').trim();
  const id = ev.corpID || (url.match(/corp(\d+)/) || [])[1] || '';
  if (!id) return null;
  const gy = (url.match(MYNAVI_YEAR_RE) || [])[1] || defaultGradYear();
  return { id, gy, base: `https://job.mynavi.jp/${gy}/pc/search/corp${id}/` };
}
// 現行の卒年面（2026-09 → 27卒面が現役、28卒面が翌年度）。
function defaultGradYear(now = new Date()) {
  const y = now.getFullYear() % 100;
  return String(now.getMonth() + 1 >= 4 ? y + 1 : y);
}

// 全ページ共通のナビ/ボタン文言。これを残すと「インターンシップ＆キャリア」タブだけで
// 全社がインターン実施に見える（実測: 全12社中9社が誤検知）ので、判定前に必ず落とす。
const MYNAVI_CHROME = ['インターンシップ＆キャリア', 'インターンシップ\n＆キャリア', '説明会・セミナー', '前年の採用データ',
  'エントリー受付を開始しました', 'エントリー受付開始', '検討リストに登録した企業', '予約リストからも削除されますが',
  '予約リストへ', '検討リスト登録', '説明会の予約可', '会社紹介記事', 'トップページへ', '新規会員登録',
  '選択した企業にエントリー', 'すべて選択', '選択全解除', 'Copyright'];
function stripMynaviChrome(text) {
  let t = String(text || '');
  for (const c of MYNAVI_CHROME) t = t.split(c).join('\n');
  return t.replace(/\n\s*\n+/g, '\n');
}
// 説明会/インターンの「1件」は .box02 ブロック（2026-09 実DOMで確認）。
// テキストの語数ではなく実エントリ数を数える＝「新規開始」「コース増」が意味を持つ。
function mynaviEntries(html) {
  if (!html) return [];
  const $ = cheerio.load(html);
  const out = [];
  $('.box02').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t.length >= 8) out.push(t.slice(0, 400));
  });
  return out;
}

async function collectMynavi(rec, ev, { delay = 150, pages = ['outline', 'sem', 'is', 'employment'] } = {}) {
  const m = mynaviBase(rec, ev);
  if (!m) return ev;
  const texts = [];
  const entries = [];
  for (const p of pages) {
    // sem.html だけ /pc/corpNNN/ 配下（マイナビのURL体系がタブによって違う）
    const url = p === 'sem' ? `https://job.mynavi.jp/${m.gy}/pc/corp${m.id}/sem.html` : m.base + p + '.html';
    const html = await fetchUrl(url);
    await sleep(delay);
    if (!html) continue;
    const t = stripMynaviChrome(toText(html));
    if (t.length < 300) continue;              // 404テンプレは本文が薄い
    if (p === 'outline') {
      ev.掲載URL = url;
      const upd = (t.match(/最終更新日[：:]\s*([0-9]{4}\/[0-9]{1,2}\/[0-9]{1,2})/) || [])[1] || '';
      const hr = extractHireRecord(t);
      if (hr && hr.系列 && hr.系列.length) ev.採用実績系列 = hr.系列.map((x) => x.年 + '年' + x.人数 + '名').join('/');
      ev.掲載面 = { url, 更新日: upd };
    }
    if (p === 'sem' || p === 'is') entries.push(...mynaviEntries(html));
    texts.push(t);
  }
  if (!texts.length) { ev.エラー.push('mynavi:取得できず'); return ev; }
  const entryText = entries.join('\n');
  ev.掲載本文 = (ev.掲載本文 + '\n' + texts.join('\n')).trim().slice(0, 200000);
  ev.インターン本文 = (ev.インターン本文 + '\n' + entryText).trim().slice(0, 100000);
  // エントリ（説明会/仕事体験の1件）のうち、インターン系の語を含むものだけを数える
  ev.インターン件数 = entries.filter((e) => INTERN_WORDS.some((w) => e.includes(w))).length;
  ev.合説出展 = entries.some((e) => EXPO_WORDS.some((w) => e.includes(w)))
    || EXPO_WORDS.some((w) => ev.掲載本文.includes(w));
  if (!ev.採用ページ && ev.掲載面) {
    // 自社サイトが取れない社でも「媒体面の最終更新日」で⑤の一部は語れる
    ev.採用ページ = { url: ev.掲載面.url, hash: '', 長さ: 0, 更新日: ev.掲載面.更新日, 媒体面: true };
  }
  ev.取得ソース.push('mynavi');
  return ev;
}

// =====================================================================
// ③ 自社サイト（公式URL → 採用ページ）
// =====================================================================
const RECRUIT_LINK_RE = /(recruit|saiyo|saiyou|career|careers|job|jobs|entry|newgrad|freshers|採用|新卒|募集)/i;

// トップから採用ページらしきリンクを1本選ぶ（同一登録可能ドメイン内のみ）
function pickRecruitLink(html, baseUrl) {
  if (!html) return '';
  const $ = cheerio.load(html);
  let base;
  try { base = new URL(baseUrl); } catch (_) { return ''; }
  const scored = [];
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    if (!href) return;
    let u;
    try { u = new URL(href, base); } catch (_) { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    if (registrableDomain(u.hostname) !== registrableDomain(base.hostname)) return;
    const hay = u.pathname + ' ' + ($(a).text() || '');
    if (!RECRUIT_LINK_RE.test(hay)) return;
    let s = 0;
    if (/新卒|newgrad|freshers/.test(hay)) s += 3;
    if (/採用|recruit|saiyo/.test(hay)) s += 2;
    if (/career|job|entry/i.test(hay)) s += 1;
    u.hash = '';
    scored.push({ url: u.toString(), s });
  });
  scored.sort((a, b) => b.s - a.s);
  return scored.length ? scored[0].url : '';
}

async function collectSite(rec, ev, { maxPages = 2 } = {}) {
  const top = ev.公式URL || '';
  const known = String(rec['採用ページURL'] || '').trim();
  const seed = /job\.mynavi\.jp|rikunabi|job\.career-tasu/.test(known) ? '' : known;
  if (!top && !seed) return ev;

  const pagesTried = [];
  const emails = new Map();
  const lineSignals = [];
  let pagesOk = 0;
  let recruitPage = null;

  const visit = async (url, role) => {
    if (!url || pagesTried.length >= maxPages) return null;
    pagesTried.push(url);
    const r = await politeGet(url, { render: 'static' });
    if (!r || r.blocked || r.error || !r.html) { ev.エラー.push(`site:${role}:${(r && (r.reason || r.error)) || 'fail'}`); return null; }
    pagesOk++;
    const host = safeHost(r.finalUrl || url);
    for (const e of extractEmailsFromPage(r.html, r.finalUrl || url, host)) {
      if (!emails.has(e.email) || e.confidence > emails.get(e.email).confidence) emails.set(e.email, e);
    }
    const det = detectLineOnPage(r.html, { pageUrl: r.finalUrl || url, pageRole: role });
    for (const s of det.signals || []) lineSignals.push(s);
    return { html: r.html, url: r.finalUrl || url, text: det.text || '' };
  };

  let page = null;
  if (seed) page = await visit(seed, '採用');
  if (!page && top) {
    const home = await visit(top, 'トップ');
    if (home) {
      const link = pickRecruitLink(home.html, home.url);
      if (link) page = await visit(link, '採用');
    }
  }
  if (page) {
    const text = String(page.text || '').replace(/\s+/g, ' ');
    recruitPage = { url: page.url, hash: fingerprint(text), 長さ: text.length };
    ev.掲載本文 = (ev.掲載本文 + '\n' + text).trim().slice(0, 200000);
    ev.インターン本文 = (ev.インターン本文 + '\n' + text).trim().slice(0, 100000);
    if (ev.インターン件数 == null) ev.インターン件数 = countOccurrences(text, INTERN_WORDS);
    if (ev.合説出展 == null) ev.合説出展 = EXPO_WORDS.some((w) => text.includes(w));
  }
  if (pagesOk) {
    ev.取得ソース.push('site');
    // 媒体面しか無い状態なら自社ページの指紋で上書き（差分の土台は自社ページの方が良い）
    if (recruitPage) {
      ev.採用ページ = {
        ...recruitPage,
        更新日: (ev.掲載面 && ev.掲載面.更新日) || '',
        媒体URL: (ev.掲載面 && ev.掲載面.url) || '',
      };
    }
    for (const e of emails.values()) {
      if (!ev.メール.some((x) => x.email === e.email)) ev.メール.push({ email: e.email, ownDomain: !!e.ownDomain, confidence: e.confidence });
    }
    ev.LINE = summarizeLine(lineSignals, { pagesOk });
  }
  return ev;
}

// =====================================================================
// ④ 求人検索エンジン（人事・採用担当の中途求人）
// =====================================================================
// 求人ボックス（実体 xn--pckua2a7gp15o89zb.com）。静的HTMLで取得可。
// セレクタは 2026-09 の実DOMで較正: カード .p-result_card / 社名 .p-result_companyName /
// 職種 .p-result_name / 掲載鮮度 .p-result_updatedAt_hyphen・.p-result_new
const JOBBOX = {
  名称: '求人ボックス',
  searchUrl: (q) => `https://xn--pckua2a7gp15o89zb.com/${encodeURIComponent(q)}の仕事`,
  cardSel: '.p-result_card',
  companySel: '.p-result_companyName',
  titleSel: '.p-result_name',
  dateSel: '.p-result_updatedAt_hyphen, .p-result_new',
};

function parseJobCards(html, 媒体) {
  if (!html) return [];
  const $ = cheerio.load(html);
  const out = [];
  $(JOBBOX.cardSel).each((_, el) => {
    const $c = $(el);
    const 企業名 = $c.find(JOBBOX.companySel).first().text().replace(/\s+/g, ' ').trim();
    const 職種 = $c.find(JOBBOX.titleSel).first().text().replace(/\s+/g, ' ').trim();
    if (!職種) return;
    const 本文 = $c.text().replace(/\s+/g, ' ').trim().slice(0, 600);
    const 掲載 = $c.find(JOBBOX.dateSel).first().text().replace(/\s+/g, ' ').trim();
    const href = $c.find('a[href]').first().attr('href') || '';
    let url = '';
    try { url = new URL(href, 'https://xn--pckua2a7gp15o89zb.com').toString(); } catch (_) {}
    out.push({ 企業名, 職種, 本文, 掲載, url, 媒体 });
  });
  return out;
}

/**
 * 社名 × 人事/採用担当 で中途求人を探す。社名一致するカードだけを返す。
 * ホスト別に直列化されるので（polite.js）、絞り込んだリストに対して使うこと。
 */
async function collectHrJobs(rec, ev, { queries = ['人事', '採用担当'] } = {}) {
  const name = ev.企業名;
  if (!name) return ev;
  const target = normCompanyName(name);
  const cards = [];
  for (const q of queries) {
    const url = JOBBOX.searchUrl(`${name} ${q}`);
    const r = await politeGet(url, { render: 'static' });
    if (!r || r.blocked || r.error || !r.html) { ev.エラー.push(`jobs:${(r && (r.reason || r.error)) || 'fail'}`); continue; }
    for (const c of parseJobCards(r.html, JOBBOX.名称)) {
      const n = normCompanyName(c.企業名 || '');
      if (!n || !(n === target || n.includes(target) || target.includes(n))) continue; // 社名一致のみ
      if (!cards.some((x) => x.url === c.url)) cards.push(c);
    }
    if (cards.length) break; // 1クエリで見つかれば十分（無駄な取得をしない）
  }
  ev.求人カード = cards;
  ev.取得ソース.push('jobs');
  return ev;
}

/**
 * 1社ぶんのエビデンスを集める。
 * @param {object} rec 入力CSVの1行
 * @param {{sources?:string[], delay?:number, sitePages?:number}} opts
 */
async function collectCompany(rec, opts = {}) {
  const sources = new Set(opts.sources || ['csv', 'mynavi', 'site', 'jobs']);
  const ev = fromRow(rec);
  if (sources.has('mynavi')) { try { await collectMynavi(rec, ev, { delay: opts.delay }); } catch (e) { ev.エラー.push('mynavi:' + String(e && e.message || e).slice(0, 60)); } }
  if (sources.has('site')) { try { await collectSite(rec, ev, { maxPages: opts.sitePages || 2 }); } catch (e) { ev.エラー.push('site:' + String(e && e.message || e).slice(0, 60)); } }
  if (sources.has('jobs')) { try { await collectHrJobs(rec, ev); } catch (e) { ev.エラー.push('jobs:' + String(e && e.message || e).slice(0, 60)); } }
  return ev;
}

module.exports = {
  collectCompany, fromRow, collectMynavi, collectSite, collectHrJobs,
  parseJobCards, pickRecruitLink, mynaviBase, defaultGradYear, toText, fetchUrl, JOBBOX,
  stripMynaviChrome, mynaviEntries,
};
