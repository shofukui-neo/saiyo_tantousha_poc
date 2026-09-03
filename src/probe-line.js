'use strict';
/**
 * 公式LINE利用有無プローブ（取得層）
 * ============================================================================
 * 判定ロジックは line-official.js（純関数）。ここは「どのページを見に行くか」だけを持つ。
 *
 * 見る面の設計（実務上、公式LINEの導線が置かれる場所）:
 *   ・トップ … フッターの友だち追加ボタン/QRが最頻出。まずここ1枚で大半が決まる。
 *   ・お問い合わせ … 「LINEでお問い合わせ」窓口。
 *   ・採用/エントリー … 採用用途かどうかの決め手。用途列の根拠になる。
 *   ・SNS/フォロー一覧 … 公式SNS導線をまとめる面。
 *   ・お知らせ/キャンペーン … 「公式LINEはじめました」告知。
 *
 * ドメイン規律:
 *   ・深掘りは公式URLと同一ドメインのみ（他社のLINEを拾わないため）。
 *   ・採用ページURLが別ドメインでも、求人媒体（マイナビ等）でなければ種として足す。
 *     媒体面のLINEリンクは媒体自身のものなので、媒体ドメインは必ず除外する。
 *
 * 打ち切り:
 *   レベル3（友だち追加リンク/QR等の確実証跡）を取れた時点で以降のページ取得はしない。
 *   「無」を主張する時だけ全ページ見る＝コストを判定の難しさに比例させる。
 *
 *   node src/probe-line.js "会社名" "https://公式URL/" [--verify] [--fresh] [--max 6]
 *     --verify … page.line.me で @ID の実在まで確認 ／ --fresh … キャッシュを使わず取り直す
 */
const cheerio = require('cheerio');
const { politeGet } = require('./polite');
const { closeBrowser } = require('./fetch');
const { rootDomain } = require('./search');
const { detectLineOnPage, summarizeLine, classifyLineUrl, lineTalkGuide } = require('./line-official');

// 求人媒体・SNS・ポータル。ここのLINEリンクは媒体自身のものなので種にしない。
const MEDIA_DOMAINS = [
  'mynavi.jp', 'rikunabi.com', 'recruit.co.jp', 'en-japan.com', 'doda.jp', 'type.jp', 'green-japan.com',
  'onecareer.jp', 'career-tasu.jp', 'gakujo.ne.jp', 'jobtalk.jp', 'wantedly.com', 'indeed.com',
  'baitoru.com', 'townwork.net', 'hellowork.mhlw.go.jp', 'job-medley.com', 'engage.co.jp',
  'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'youtube.com', 'note.com', 'prtimes.jp',
];
function isMediaDomain(host) {
  const h = rootDomain(host || '');
  return MEDIA_DOMAINS.some((d) => h === d || h.endsWith('.' + d));
}

// LINE導線が置かれやすい面のヒント（パス＋アンカーテキストで判定）。w が大きいほど先に見る。
const PAGE_HINTS = [
  { re: /(?:^|[^a-z])line(?:[^a-z]|$)|公式line|sns|social|follow|フォロー/i, role: 'SNS', w: 4 },
  { re: /contact|inquiry|toiawase|otoiawase|問\s*い?\s*合|お問合せ|相談/i, role: '問合せ', w: 3 },
  { re: /recruit|saiyo|entry|careers?|採用|新卒|募集|エントリー|graduate/i, role: '採用', w: 3 },
  { re: /campaign|news|topics|whatsnew|お知らせ|新着|キャンペーン/i, role: 'お知らせ', w: 2 },
  { re: /company|about|corporate|会社概要|企業情報/i, role: '会社', w: 1 },
];
function pageRole(hay) {
  let best = null;
  for (const h of PAGE_HINTS) if (h.re.test(hay)) { if (!best || h.w > best.w) best = h; }
  return best;
}

// トップHTMLから深掘り候補（同一ドメイン・役割つき）を集める。
function collectCandidatePages(baseUrl, html) {
  let base;
  try { base = new URL(baseUrl); } catch { return []; }
  const $ = cheerio.load(html);
  const out = []; const seen = new Set();
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    if (!href) return;
    let u;
    try { u = new URL(href, base); } catch { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    if (rootDomain(u.host) !== rootDomain(base.host)) return;   // 同一ドメインのみ
    u.hash = '';
    const key = u.toString();
    if (seen.has(key) || key === baseUrl) return;
    seen.add(key);
    let path = u.pathname;
    try { path = decodeURIComponent(path); } catch (_) { /* そのまま */ }
    const r = pageRole(`${path} ${($(a).text() || '').trim()}`);
    if (r) out.push({ url: key, role: r.role, score: r.w });
  });
  out.sort((a, b) => b.score - a.score);
  return out;
}

// www の有無を入れ替えたURL（片方しか生きていないサイトの救済）。
function altHostUrl(url) {
  try {
    const u = new URL(url);
    u.host = u.host.startsWith('www.') ? u.host.slice(4) : 'www.' + u.host;
    return u.toString();
  } catch (_) { return ''; }
}

/**
 * lin.ee 短縮リンクを辿って @ID を確定する（リダイレクト先が line.me/R/ti/p/@id）。
 * @returns {Promise<string>} '@id' もしくは ''
 */
async function resolveShortLink(shortUrl) {
  const r = await politeGet(shortUrl, { render: 'static' }).catch(() => null);
  if (!r || r.blocked) return '';
  const c = classifyLineUrl(r.finalUrl || '');
  if (c && c.id) return c.id;
  // 転送がJS/metaの場合はHTML中の友だち追加リンクから拾う
  const html = r.html || '';
  const m = html.match(/line\.me\/(?:R\/)?ti\/p\/(?:%40|@)([A-Za-z0-9._%-]{2,30})/i);
  if (m) { const c2 = classifyLineUrl('https://line.me/R/ti/p/@' + m[1]); return c2 ? c2.id : ''; }
  return '';
}

/**
 * @IDのアカウントが実在するか page.line.me で確認する。
 *   実測: 存在=200 / 不在=404（どちらも line.me/R/ti/p/@id へ転送される）。robots.txt でも許可されている面。
 * 注: politeGet は 404 をリトライするため1社あたり数秒かかる。--verify は任意オプションに留める。
 * @returns {Promise<boolean|null>} true=実在 / false=不在 / null=判定不能
 */
async function verifyLineAccount(id) {
  const bare = String(id || '').replace(/^@/, '');
  if (!/^[a-z0-9._-]{2,30}$/i.test(bare)) return null;
  const r = await politeGet(`https://page.line.me/${bare}`, { render: 'static' }).catch(() => null);
  if (!r) return null;
  if (r.blocked) return null;
  if (r.error) return /HTTP\s*404/.test(r.error) ? false : null;
  return true;
}

/**
 * 1社の公式LINE利用有無を判定する。
 * @param {string} companyName
 * @param {string} officialUrl 公式サイトURL（必須）
 * @param {{maxPages?:number, verify?:boolean, recruitUrl?:string, render?:string, noCache?:boolean}} [opts]
 * @returns {Promise<object>} { 判定, 確度, ID, URL, 用途, 根拠, トーク指針, 検査ページ数, 失敗ページ数, pages, signals }
 */
async function probeLineOfficial(companyName, officialUrl, opts = {}) {
  const maxPages = opts.maxPages != null ? opts.maxPages : 6;
  const started = Date.now();
  const signals = [];
  const pages = [];
  let pagesOk = 0; let pagesFailed = 0;

  const empty = (reason) => ({
    ...summarizeLine([], { pagesOk: 0 }), トーク指針: lineTalkGuide('不明', ''),
    検査ページ数: 0, 失敗ページ数: pagesFailed, pages, signals, エラー: reason, 所要ms: Date.now() - started,
  });
  if (!officialUrl || !/^https?:\/\//i.test(officialUrl)) return empty('公式URLなし');

  const visit = async (url, role, render) => {
    const r = await politeGet(url, { render: render || 'static', noCache: !!opts.noCache }).catch(() => null);
    if (!r || r.blocked || r.error || !r.html) {
      pagesFailed++;
      pages.push({ url, role, ok: false, reason: r ? (r.reason || r.error || 'no-html') : 'fetch-failed' });
      return null;
    }
    pagesOk++;
    const finalUrl = r.finalUrl || url;
    const { signals: sig } = detectLineOnPage(r.html, { pageUrl: finalUrl, pageRole: role });
    signals.push(...sig);
    pages.push({ url: finalUrl, role, ok: true, 証跡: sig.filter((s) => !s.neg && s.level > 0).length });
    return r;
  };

  // トップは JS 差し込みのLINEボタンを拾うため 'auto'（本文が薄い時だけレンダリングに昇格）。
  let top = await visit(officialUrl, 'トップ', opts.render || 'auto');
  // リストの公式URLは www 有無が実サイトと食い違うことがある（例: show-wa.co.jp はNG／www.show-wa.co.jp はOK）。
  // 取れなければ www を足す/外すだけの補正を1回試す。これを入れないと「不明」が水増しされる。
  if (!top) {
    const alt = altHostUrl(officialUrl);
    if (alt) top = await visit(alt, 'トップ(www補正)', opts.render || 'auto');
  }
  const baseUrl = top ? (top.finalUrl || officialUrl) : officialUrl;

  const best = () => signals.reduce((a, s) => (!s.neg && s.level > a ? s.level : a), 0);

  if (top && best() < 3) {
    const cands = collectCandidatePages(baseUrl, top.html);
    // 別ドメインの採用サイト（媒体でなければ）も種にする。採用用途の判定に効く。
    if (opts.recruitUrl && /^https?:\/\//i.test(opts.recruitUrl)) {
      try {
        const ru = new URL(opts.recruitUrl);
        if (!isMediaDomain(ru.host) && rootDomain(ru.host) !== rootDomain(new URL(baseUrl).host)) {
          cands.unshift({ url: opts.recruitUrl, role: '採用', score: 3 });
        }
      } catch (_) { /* 不正URLは無視 */ }
    }
    const seen = new Set([baseUrl]);
    let fetched = 0;
    for (const c of cands) {
      if (fetched >= maxPages) break;
      if (best() >= 3) break;                 // 確実証跡が出たら打ち切り
      if (seen.has(c.url)) continue;
      seen.add(c.url);
      await visit(c.url, c.role, 'static');
      fetched++;
    }
  }

  // 短縮リンクしか無い場合は辿って@IDを確定（実在検証と台帳の名寄せに効く）
  let verified = null;
  const posSignals = signals.filter((s) => !s.neg && s.level > 0);
  if (!posSignals.some((s) => s.id)) {
    const short = posSignals.find((s) => s.kind === 'short');
    if (short && opts.resolveShort !== false) {
      const id = await resolveShortLink(short.url).catch(() => '');
      if (id) { short.id = id; short.evidence += ` → ${id}`; }
    }
  }
  const idSig = signals.find((s) => !s.neg && s.level > 0 && s.id);
  if (opts.verify && idSig) verified = await verifyLineAccount(idSig.id).catch(() => null);

  const sum = summarizeLine(signals, { pagesOk, pagesFailed, verified });
  return {
    ...sum,
    トーク指針: lineTalkGuide(sum.判定, sum.用途),
    検査ページ数: pagesOk, 失敗ページ数: pagesFailed,
    実在検証: verified === true ? '実在' : verified === false ? '不在' : '',
    pages, signals, 所要ms: Date.now() - started,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const name = args[0]; const url = args[1];
  if (!name || !url) {
    console.error('使い方: node src/probe-line.js "会社名" "https://公式URL/" [--verify] [--fresh] [--max 6]');
    process.exit(1);
  }
  const verify = args.includes('--verify');
  const noCache = args.includes('--fresh');
  const mi = args.indexOf('--max');
  const maxPages = mi >= 0 && args[mi + 1] ? parseInt(args[mi + 1], 10) : 6;
  console.log(`[公式LINE判定] ${name} <${url}>`);
  const r = await probeLineOfficial(name, url, { verify, maxPages, noCache });
  console.log(`  判定: ${r.判定}（確度${r.確度}） 用途: ${r.用途 || '-'} ID: ${r.ID || '-'} ${r.実在検証 || ''}`);
  console.log(`  根拠: ${r.根拠}`);
  console.log(`  トーク: ${r.トーク指針}`);
  console.log(`  検査: ${r.検査ページ数}ページ成功 / ${r.失敗ページ数}失敗 / ${r.所要ms}ms`);
  for (const p of r.pages) console.log(`    - [${p.role}] ${p.ok ? `証跡${p.証跡}` : 'NG:' + p.reason} ${p.url}`);
  await closeBrowser().catch(() => {});   // レンダリングに昇格した場合、ブラウザを閉じないとプロセスが終わらない
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = {
  probeLineOfficial, verifyLineAccount, resolveShortLink, collectCandidatePages, pageRole, isMediaDomain,
};
