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
const { validUrl } = require('./opportunity-signals');
const { parseFace } = require('./mynavi-face');

function addDocument(ev, doc) {
  if (!doc || typeof doc !== 'object' || !validUrl(doc.url) || !String(doc.text || '').trim()) return;
  ev.インテント資料 ||= [];
  if (!ev.インテント資料.some(d => d.url === doc.url && d.text === doc.text && d.date === doc.date)) {
    ev.インテント資料.push({ text: String(doc.text).slice(0, 200000), url: validUrl(doc.url),
      date: String(doc.date || ''), title: String(doc.title || ''), source: doc.source || 'csv' });
  }
}

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

// インラインの強調タグで一文を分断しない。段落境界は保持する。
function evidenceText(html) {
  const $ = cheerio.load(html || '');
  $('script, style, nav, header, footer').remove();
  $('p, li, div, section, article, h1, h2, h3, h4, tr, br').each((_, el) => $(el).after('\n'));
  return $.root().text().replace(/[\t　 ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
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
    採用予定人数: String(rec['採用予定人数'] ?? rec['年間新卒採用人数'] ?? ''),
    メール: [],
    掲載本文: '', インターン本文: '', インターン件数: null, 合説出展: null,
    LINE: null, 採用ページ: null,
    公式URL: String(rec['公式URL'] || '').trim(),
    掲載URL: page,
    取得ソース: ['csv'], エラー: [], インテント資料: [],
  };
  if (mail && /@/.test(mail)) {
    const dom = ev.公式URL ? registrableDomain(safeHost(ev.公式URL)) : '';
    ev.メール.push({ email: mail, ownDomain: dom ? registrableDomain(mail.split('@')[1] || '') === dom : false });
  }
  if (rec['インテント資料JSON']) {
    try {
      const docs = JSON.parse(rec['インテント資料JSON']);
      if (!Array.isArray(docs)) throw new Error('array required');
      for (const doc of docs.slice(0, 50)) addDocument(ev, doc);
    } catch (_) { ev.エラー.push('csv:インテント資料JSON不正'); }
  }
  addDocument(ev, { text: rec['インテント本文'], url: rec['インテント根拠URL'], date: rec['インテント発生日'], source: 'csv' });
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
/**
 * インターン面（is.html）のプログラム数を数える。
 * 説明会面（sem.html）と違って .box02 のカセットを持たない（2026-09 実DOMで確認: 0件）。
 * プログラム1本につき必ず1回出る見出し「開催時期と実施日数」を数える。
 * 実施していない社は約1,000字の定型ページが返り、この見出しは0回になるので区別できる。
 *
 * これを入れる前は sem 由来の .box02 だけを見ていて、9月（インターン最盛期）なのに
 * S7（インターン新規開始）が200社中3社しか立っていなかった。
 */
const INTERN_PROGRAM_MARKERS = ['開催時期と実施日数', '体験できる職種', 'コース参加の選考'];
function mynaviInternPrograms(text) {
  const t = String(text || '');
  return Math.max(...INTERN_PROGRAM_MARKERS.map((m) => t.split(m).length - 1));
}

// 説明会の「1件」は .box02 ブロック（2026-09 実DOMで確認）。
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

/**
 * 卒年面（27卒面・28卒面…）を2面ぶん取る。
 * corpID は卒年をまたいで安定しているので、同じ会社の隣の卒年面が同じURL体系で取れる。
 * これが層2の「幅」の本体: 履歴が1回も無い初回でも
 *   募集人数の増減／初任給の引き上げ／次年度面の始動
 * を“今日の2面の差”として言える（従来は観測台帳が2周するまで言えなかった）。
 */
/**
 * 1社の処理中に同じURLを二度取りに行かない。
 * mynavi 系統と faces 系統は現行卒年の outline/employment が丸かぶりで、
 * 素直に並べると1社あたり2本ぶん余計に叩く（相手サイトにも無駄な負荷になる）。
 */
async function fetchOnce(ev, url, delay) {
  ev._page = ev._page || new Map();
  if (ev._page.has(url)) return ev._page.get(url);
  const html = await fetchUrl(url);
  await sleep(delay);
  ev._page.set(url, html);
  return html;
}

async function collectMynaviFaces(rec, ev, { delay = 150, years = null } = {}) {
  const m = mynaviBase(rec, ev);
  if (!m) return ev;
  const cur = parseInt(defaultGradYear(), 10);
  const list = years || [String(cur).padStart(2, '0'), String(cur + 1).padStart(2, '0')];
  ev.卒年面 = ev.卒年面 || {};
  for (const gy of list) {
    const base = `https://job.mynavi.jp/${gy}/pc/search/corp${m.id}/`;
    const parts = [];
    for (const p of ['outline', 'employment']) {
      const url = base + p + '.html';
      const html = await fetchOnce(ev, url, delay);
      if (!html) continue;
      const t = stripMynaviChrome(toText(html));
      if (t.length < 300) continue;               // 404テンプレは本文が薄い
      parts.push(t);
      addDocument(ev, { text: stripMynaviChrome(evidenceText(html)), url, source: 'mynavi' });
    }
    if (!parts.length) continue;
    const face = parseFace(parts.join('\n'), { 卒年: gy, url: base });
    if (face) ev.卒年面[gy] = face;
  }
  // mynavi 系統とは別ラベルにする。どちらが動いたのかを行から読めるようにするため
  // （両方 'mynavi' を積むと 取得ソース が csv+mynavi+mynavi になって意味を持たない）。
  if (Object.keys(ev.卒年面).length) ev.取得ソース.push('faces');
  return ev;
}

/**
 * どのタブを「どの卒年面」から取るか。
 * 実測（2026-09・各40社/15社）で確かめた結果:
 *   outline     27卒 40/40   employment 27卒 40/40   sem 27卒 29/40
 *   is（インターン） 27卒  0/40  ／ 28卒 10/15  ← 現行卒年の面には存在しない
 *   obog（先輩情報） 27卒 13/40・平均1.8千字。追加8軸の検知には寄与せず、費用に見合わない
 *
 * インターンは「次の卒年の学生」に向けて開くものなので、is は次年度面から取る。
 * ここを現行卒年から取っていたため、9月（インターン最盛期）なのに
 * S7（インターン新規開始）が200社中3社しか立っていなかった。
 */
const MYNAVI_PAGES = [
  { page: 'outline', year: 'cur' },
  { page: 'employment', year: 'cur' },
  { page: 'sem', year: 'cur' },       // 説明会・セミナー
  { page: 'is', year: 'next' },       // インターンシップ＆キャリア（次年度面にしか無い）
];

async function collectMynavi(rec, ev, { delay = 150, pages = MYNAVI_PAGES } = {}) {
  const m = mynaviBase(rec, ev);
  if (!m) return ev;
  const nextGy = String(parseInt(m.gy, 10) + 1).padStart(2, '0');
  const texts = [];
  const entries = [];
  const internTexts = [];
  let インターン件数 = 0;
  for (const spec of pages) {
    const p = typeof spec === 'string' ? spec : spec.page;
    const gy = (typeof spec === 'string' ? 'cur' : spec.year) === 'next' ? nextGy : m.gy;
    // sem.html だけ /pc/corpNNN/ 配下（マイナビのURL体系がタブによって違う）
    const url = p === 'sem' ? `https://job.mynavi.jp/${gy}/pc/corp${m.id}/sem.html`
      : `https://job.mynavi.jp/${gy}/pc/search/corp${m.id}/${p}.html`;
    const html = await fetchOnce(ev, url, delay);
    if (!html) continue;
    const t = stripMynaviChrome(toText(html));
    if (t.length < 300) continue;              // 404テンプレは本文が薄い
    addDocument(ev, { text: stripMynaviChrome(evidenceText(html)), url, source: 'mynavi', title: cheerio.load(html)('title').text() }); // 更新日≠課題発生日
    if (p === 'outline') {
      ev.掲載URL = url;
      const upd = (t.match(/最終更新日[：:]\s*([0-9]{4}\/[0-9]{1,2}\/[0-9]{1,2})/) || [])[1] || '';
      const hr = extractHireRecord(t);
      if (hr && hr.系列 && hr.系列.length) ev.採用実績系列 = hr.系列.map((x) => x.年 + '年' + x.人数 + '名').join('/');
      ev.掲載面 = { url, 更新日: upd };
    }
    if (p === 'sem') entries.push(...mynaviEntries(html));
    // インターン面はカセット構造を持たないので、プログラム見出しの数で数える
    if (p === 'is') { インターン件数 += mynaviInternPrograms(t); internTexts.push(t); }
    texts.push(t);
  }
  if (!texts.length) { ev.エラー.push('mynavi:取得できず'); return ev; }
  const entryText = entries.join('\n');
  ev.掲載本文 = (ev.掲載本文 + '\n' + texts.join('\n')).trim().slice(0, 200000);
  ev.インターン本文 = (ev.インターン本文 + '\n' + entryText + '\n' + internTexts.join('\n')).trim().slice(0, 100000);
  // インターン面のプログラム数＋説明会カセットのうちインターン系の語を含むもの
  ev.インターン件数 = インターン件数
    + entries.filter((e) => INTERN_WORDS.some((w) => e.includes(w))).length;
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
    addDocument(ev, { text: evidenceText(page.html), url: page.url, source: 'site', title: cheerio.load(page.html)('title').text() });
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
      if (!n || n !== target) continue; // 社名の正規化後完全一致のみ
      if (!cards.some((x) => x.url === c.url)) cards.push(c);
    }
    if (cards.length) break; // 1クエリで見つかれば十分（無駄な取得をしない）
  }
  ev.求人カード = cards;
  for (const c of cards) {
    // 社名の部分一致でグループ会社・人材紹介会社の課題を取り込まない。
    if (normCompanyName(c.企業名) !== target) continue;
    addDocument(ev, { text: `${c.職種} ${c.本文}`, url: c.url, source: 'jobs' });
  }
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
  // 卒年面（隣の卒年）は mynavi とは別系統。--sources に faces を入れた時だけ取る。
  // mynavi より先に回すのは、現行卒年の outline/employment が両系統で丸かぶりだから。
  // 先に取っておけば fetchOnce のキャッシュに載り、mynavi 側は取り直さない。
  if (sources.has('faces')) { try { await collectMynaviFaces(rec, ev, { delay: opts.delay, years: opts.years }); } catch (e) { ev.エラー.push('faces:' + String(e && e.message || e).slice(0, 60)); } }
  if (sources.has('mynavi')) { try { await collectMynavi(rec, ev, { delay: opts.delay }); } catch (e) { ev.エラー.push('mynavi:' + String(e && e.message || e).slice(0, 60)); } }
  if (sources.has('site')) { try { await collectSite(rec, ev, { maxPages: opts.sitePages || 2 }); } catch (e) { ev.エラー.push('site:' + String(e && e.message || e).slice(0, 60)); } }
  if (sources.has('jobs')) { try { await collectHrJobs(rec, ev); } catch (e) { ev.エラー.push('jobs:' + String(e && e.message || e).slice(0, 60)); } }
  delete ev._page;   // 取得済みHTMLは判定に使い終わっている。行に持ち越さない
  ev.取得ソース = [...new Set(ev.取得ソース)];
  return ev;
}

module.exports = {
  collectCompany, fromRow, collectMynavi, collectMynaviFaces, collectSite, collectHrJobs,
  parseJobCards, pickRecruitLink, mynaviBase, defaultGradYear, toText, fetchUrl, JOBBOX, MYNAVI_PAGES,
  stripMynaviChrome, mynaviEntries, mynaviInternPrograms, addDocument, evidenceText,
};
