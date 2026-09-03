'use strict';
/**
 * ATS（採用管理システム）未導入判定エンジン ― 層1：エントリー動線の分類（純ロジック・ネット不要）
 * ============================================================================
 * なぜ要るか（営業要件）:
 *   MOCHICA受注ドライバの実測トップは「他社ATS未導入」（勝率2.8倍差／docs 参照）。
 *   つまり全リードを「ATSを持っていない企業」に絞れれば、それだけで架電効率が跳ねる。
 *   さらに未導入の中でも **どう受けているか（エントリー動線）** で刺さり方が違う:
 *     ・PDFでエントリーシートを配っている  → 手作業が最重症。提案が一番刺さる
 *     ・説明会予約が電話番号だけ            → 取りこぼしが最大。母集団の話が通る
 *     ・Googleフォーム                      → 応募は取れているが管理が手作業
 *     ・メールアドレス直記載                 → 同上、かつ返信漏れが起きている
 *     ・媒体の管理画面だけ                   → 媒体が終わると何も残らない
 *   よって出力は「有無」ではなく **entry_type（動線の型）** を1フィールドに落とす。
 *
 * 分類（entry_type）:
 *   [営業指定の6分類]
 *     google_form   … Googleフォームに飛ぶ。未導入確定・運用が最もしんどい層
 *     mail_direct   … 「エントリーはこちらまで」でメールアドレス直記載。未導入確定
 *     phone_only    … 説明会予約が電話番号のみ。重症
 *     pdf_download  … エントリーシートをPDFでDLさせる。最重症・提案が刺さる
 *     media_only    … マイナビ/リクナビの掲載ページにしか導線がない。媒体管理画面だけで運用
 *     ats_vendor    … 外部ベンダーのドメインに飛ぶ。除外
 *   [残余。6分類に押し込むと精度が壊れるので別に立てた ― 運用上どちらも“未導入”側]
 *     generic_form  … 汎用フォームSaaS（多社に同居するがATSではないと自前データが示したホスト）
 *     own_form      … 自社ドメイン内の応募フォーム。未導入だが痛みは相対的に小さい
 *     none          … エントリー動線が見つからない（採用ページ自体が無い/JS描画/取得失敗）
 *
 * ベンダー指紋を外部から持ち込まない（本設計の肝）:
 *   ここには **ベンダー名もベンダーのドメインも一切書かない**。
 *   判定に使うのは構造だけ ―「エントリー文脈のリンクが自社ドメインの外に出ているか」。
 *   外に出た先が何者かは data/ats-fingerprints.json（自前で学習した辞書）に問い合わせる。
 *   辞書は src/learn-ats-fingerprints.js が
 *     ①多テナント性（無関係な複数企業のエントリー導線が同じホストに集まる＝ベンダー）
 *     ②BALESCLOUD「カスタム情報：利用中ATS」の自己申告ラベル（＝ベンダー名と正解ラベル）
 *   の2つだけから作る。よって精度は自分で測れるし、辞書が育つほど「要確認」が減る。
 *
 * 使い方（純関数）:
 *   const { detectEntryOnPage, summarizeAts } = require('./ats-detect');
 *   const { signals } = detectEntryOnPage(html, { pageUrl, pageRole, companyName, dict });
 *   const 判定 = summarizeAts(signals, { pagesOk: 4, dict });
 */
const cheerio = require('cheerio');

// ---- 求人媒体ドメイン（自前資産 data/media-catalog.json から生成。外部知識ではない）--------
// media_only の判定に要る。catalog が読めない環境でも壊れないよう、最低限の素は持つ。
const MEDIA_SEED = [
  'mynavi.jp', 'rikunabi.com', 'recruit.co.jp', 'gakujo.ne.jp', 'career-tasu.jp', 'onecareer.jp',
  'en-japan.com', 'doda.jp', 'type.jp', 'green-japan.com', 'wantedly.com', 'indeed.com',
  'hellowork.mhlw.go.jp', 'engage.co.jp', 'kyujin-box.com', 'townwork.net', 'baitoru.com',
];
let MEDIA_HOSTS = null;
function mediaHosts() {
  if (MEDIA_HOSTS) return MEDIA_HOSTS;
  const set = new Set(MEDIA_SEED);
  try {
    const cat = require('../data/media-catalog.json');
    for (const m of (cat.media || [])) {
      try { set.add(rootDomain(new URL(m.url).hostname)); } catch (_) { /* URL不正はスキップ */ }
    }
  } catch (_) { /* カタログ無しでも seed で動く */ }
  MEDIA_HOSTS = set;
  return set;
}
// SNS・動画・共有ボタン等。エントリー動線ではないので判定から外す。
const SOCIAL_RE = /(?:^|\.)(?:facebook|twitter|x|instagram|youtube|tiktok|linkedin|line|note|ameblo|hatena|pinterest|threads)\.(?:com|jp|me|co\.jp|ne\.jp|net)$/i;
// 解析/CDN/フォント等の第三者ホスト。<a> には出ないが form action や script src で拾ってしまうため除外。
const INFRA_RE = /(?:google-analytics|googletagmanager|googleapis|gstatic|doubleclick|cloudflare|jsdelivr|unpkg|cdnjs|jquery|bootstrapcdn|fontawesome|adobe|hotjar|clarity\.ms|criteo|yahoo|karte|ptengine|user-heat|sitest|juicer)\./i;
// 地図・短縮URL・認証マーク・動画・ブラウザ配布等のユーティリティ。
// 採用ページの「アクセス」「プライバシーマーク」バナー等が、周辺文脈のせいでベンダー候補に化けるのを止める。
// 実測（学習クロール110社）で privacymark.jp / maps.app.goo.gl / goo.gl / youtu.be / support.google.com /
// sasp.mapion.co.jp が上位に湧いていた。いずれもエントリーの遷移先ではない。
const UTIL_RE = /^(?:speakerdeck\.com|slideshare\.net|vimeo\.com|youtube-nocookie\.com|player\.vimeo\.com|privacymark\.jp|isms\.jp|goo\.gl|maps\.app\.goo\.gl|google\.com|support\.google\.com|maps\.google\.[a-z.]+|youtu\.be|bit\.ly|t\.co|ow\.ly|mapion\.co\.jp|sasp\.mapion\.co\.jp|its-mo\.com|navitime\.co\.jp|get\.adobe\.com|adobe\.com|microsoft\.com|apple\.com)$/i;

function rootDomain(hostname) {
  return String(hostname || '').replace(/^www\./i, '').toLowerCase();
}
// 「同じ会社のドメインか」。www 差・サブドメイン差（recruit.acme.co.jp）を同一とみなす。
//   co.jp / ne.jp / or.jp 等の2段TLDを考慮して“登録可能ドメイン”まで畳む。
const SECOND_LEVEL = /\.(?:co|ne|or|ac|go|ed|gr|lg)\.jp$/i;
function registrableDomain(hostname) {
  const h = rootDomain(hostname);
  const parts = h.split('.');
  if (SECOND_LEVEL.test(h)) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}
function sameCompanyHost(a, b) {
  if (!a || !b) return false;
  return registrableDomain(a) === registrableDomain(b);
}
function isMediaHost(host) {
  const h = rootDomain(host);
  return [...mediaHosts()].some((d) => h === d || h.endsWith('.' + d));
}
function isSocialHost(host) { return SOCIAL_RE.test(rootDomain(host)); }
function isInfraHost(host) {
  const h = rootDomain(host);
  return INFRA_RE.test(h + '.') || UTIL_RE.test(h);
}

// ---- エントリー文脈の語彙 ---------------------------------------------------
// 「応募/エントリーの入口」を指す語。リンク文言・href・周辺テキストのいずれかに出れば文脈ありとみなす。
const ENTRY_RE = /エントリー|ｴﾝﾄﾘｰ|応募|申[しし]?込|お申込|選考|説明会|セミナー予約|マイページ|プレエントリー|新卒採用情報|募集要項|entry|apply|application|mypage|recruit-entry/i;
// 「説明会/選考の予約」に強く寄った語。phone_only はここで電話が唯一の手段の時に立てる。
const RESERVE_RE = /説明会|セミナー|見学会|面談|面接|予約|受付|問い?合わせ|お問合せ|連絡/i;
// PDFのエントリーシート系。ここに当たるPDFだけが pdf_download。会社案内PDFを拾わないための絞り。
const ES_PDF_RE = /エントリー\s*シート|ｴﾝﾄﾘｰｼｰﾄ|応募\s*(?:用紙|書類|票|申込書)|履歴\s*書|自己\s*紹介\s*書|受験\s*票|entry\s*sheet|application\s*form|es[-_ ]?sheet|さい?よう?.*申込/i;
// 新卒文脈（中途/アルバイトのフォームで新卒判定を汚さないための補助）
const SHINSOTSU_RE = /新卒|新規学卒|20\d{2}年卒|2[5-9]卒|学生|大学生|大学院生|インターン|graduate|internship/i;

// ---- 汎用フォームSaaS/Googleフォームの構造判定 -----------------------------
// Googleフォームだけは「営業指定の分類そのもの」なので構造として直書きする（ベンダー辞書ではない）。
const GOOGLE_FORM_RE = /(?:docs\.google\.com\/forms|forms\.gle|forms\.google\.com)/i;

// ---- メール/電話の抽出 -------------------------------------------------------
const MAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// 日本の電話番号（市外局番-市内局番-加入者番号 / 0120 / 携帯）。全角ハイフンも許す。
const TEL_RE = /0\d{1,4}[-‐―ー－(（]?\d{1,4}[)）]?[-‐―ー－]?\d{3,4}/;

/**
 * 1本のリンクをエントリー動線として分類する（構造のみ。ベンダー名は辞書に委ねる）。
 * @param {string} href
 * @param {{baseHost:string, anchor?:string, near?:string, dict?:object}} ctx
 * @returns {{entry_type:string, host:string, vendor:string, level:number, side:string, label:string}|null}
 */
function classifyEntryLink(href, ctx = {}) {
  const raw = String(href || '').trim();
  if (!raw) return null;

  // mailto: / tel: は host を持たない。文脈語がある時だけ動線として採る。
  if (/^mailto:/i.test(raw)) {
    const addr = raw.slice(7).split('?')[0].trim();
    if (!MAIL_RE.test(addr)) return null;
    return { entry_type: 'mail_direct', host: (addr.split('@')[1] || '').toLowerCase(), vendor: '', level: 3, side: 'diy', label: 'mailtoリンク: ' + addr };
  }
  if (/^tel:/i.test(raw)) {
    const num = raw.slice(4).replace(/[^0-9+]/g, '');
    if (num.length < 9) return null;
    return { entry_type: 'phone_only', host: '', vendor: '', level: 2, side: 'diy', label: 'telリンク: ' + num };
  }

  let u;
  try { u = new URL(raw, ctx.baseUrl || ('https://' + (ctx.baseHost || 'example.com'))); } catch (_) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  const full = u.toString();

  // Googleフォーム（分類の名前そのもの）
  if (GOOGLE_FORM_RE.test(full)) {
    return { entry_type: 'google_form', host: rootDomain(host), vendor: '', level: 3, side: 'diy', label: 'Googleフォーム: ' + full.slice(0, 120) };
  }

  // エントリーシートPDF
  if (/\.pdf(?:[?#]|$)/i.test(u.pathname + u.search)) {
    const hay = `${decodeSafe(u.pathname)} ${ctx.anchor || ''}`;
    if (ES_PDF_RE.test(hay)) {
      return { entry_type: 'pdf_download', host: rootDomain(host), vendor: '', level: 3, side: 'diy', label: 'エントリーシートPDF: ' + full.slice(0, 120) };
    }
    return null;                       // 会社案内PDF等は動線ではない
  }

  if (isSocialHost(host) || isInfraHost(host)) return null;

  // 自社ドメイン内（サブドメイン含む）。
  //   ここは全ての内部リンクが素通りするので、エントリー文脈が確認できた時だけ動線として採る。
  //   採らないと1ページ100件超の own_form が湧き、台帳が肥大して判定も鈍る（実測で確認）。
  if (sameCompanyHost(host, ctx.baseHost)) {
    if (!ctx.entryCtx) return null;
    return { entry_type: 'own_form', host: rootDomain(host), vendor: '', level: 1, side: 'diy', label: '自社ドメイン内の応募導線: ' + u.pathname.slice(0, 80) };
  }

  // 求人媒体
  if (isMediaHost(host)) {
    // 媒体ページ自体を見ている時、その媒体内リンクは媒体のUI（お気に入り・エントリー予約一覧など）であって
    // 企業の応募導線ではない。実測でマイナビの bookmark_list/entry_reserve_all.html を
    // 「企業の媒体経由エントリー」として96/100社に付けてしまった。
    // media_only が意味を持つのは「企業サイトから媒体へ出ていく」時だけ。
    if (ctx.mediaBaseHost && sameCompanyHost(host, ctx.mediaBaseHost)) return null;
    return { entry_type: 'media_only', host: rootDomain(host), vendor: '', level: 3, side: 'media', label: '媒体掲載ページ: ' + rootDomain(host) + u.pathname.slice(0, 60) };
  }

  // ここから先は「自社ドメインの外・媒体でもSNSでもない」＝ベンダー候補。
  // 何者かは自前辞書に訊く。辞書に無ければ vendor 不明の“要確認”として残す（辞書の成長点）。
  const fp = matchFingerprint(host, ctx.dict);
  if (fp && fp.side === 'diy') {
    return { entry_type: 'generic_form', host: rootDomain(host), vendor: fp.vendor || '', level: 3, side: 'diy', label: `汎用フォームSaaS(自前辞書): ${rootDomain(host)}` };
  }
  if (fp && fp.side === 'ats') {
    return { entry_type: 'ats_vendor', host: rootDomain(host), vendor: fp.vendor || '', level: 3, side: 'ats', label: `ATSベンダー(自前辞書${fp.companies}社で確認): ${rootDomain(host)}${fp.vendor ? ' = ' + fp.vendor : ''}` };
  }
  return { entry_type: 'ats_vendor', host: rootDomain(host), vendor: '', level: 2, side: 'unknown', label: `外部ホストへ遷移(辞書未収載): ${rootDomain(host)}` };
}

function decodeSafe(s) { try { return decodeURIComponent(String(s || '')); } catch (_) { return String(s || ''); } }

/**
 * 自前辞書に host を問い合わせる。
 * @param {string} host
 * @param {object} dict data/ats-fingerprints.json の中身（{hosts:{...}}）
 * @returns {{vendor:string, side:string, companies:number}|null}
 */
function matchFingerprint(host, dict) {
  if (!dict || !dict.hosts) return null;
  const h = rootDomain(host);
  if (dict.hosts[h]) return dict.hosts[h];
  // サブドメイン（tenant.vendor.jp）は登録可能ドメインで引き直す
  const reg = registrableDomain(h);
  if (dict.hosts[reg]) return dict.hosts[reg];
  return null;
}

// ---- ページ構造からの証跡収集 -----------------------------------------------
// リンクの周辺テキスト（文脈判定用）。長すぎると無関係語を拾うので短く切る。
function nearText($, el) {
  let cur = el;
  for (let i = 0; i < 3 && cur; i++) {
    const txt = ($(cur).text() || '').replace(/\s+/g, ' ').trim();
    if (txt.length >= 10) return txt.slice(0, 240);
    cur = cur.parent;
  }
  return '';
}
// 祖先の class/id 連鎖。フッター共通導線かどうかの判別に使う。
const FOOTER_RE = /footer|copyright|f-nav|f_nav|global-?nav|gnav|utility|breadcrumb/i;
function ancestorChain($, el) {
  const parts = [];
  let cur = el;
  for (let i = 0; i < 5 && cur; i++) {
    parts.push(((cur.tagName || cur.name || '') + ' ' + ($(cur).attr('class') || '') + ' ' + ($(cur).attr('id') || '')));
    cur = cur.parent;
  }
  return parts.join(' | ');
}

function pageText(html) {
  const $ = cheerio.load(String(html || ''));
  $('script,style,noscript,svg').remove();
  return ($('body').text() || '').replace(/[\t\r]+/g, ' ').replace(/[ 　]{2,}/g, ' ');
}

/**
 * 1ページのHTMLからエントリー動線の証跡を集める。
 * @param {string} html
 * @param {{pageUrl?:string, pageRole?:string, dict?:object, companyName?:string}} [opts]
 * @returns {{signals:Array<object>, hosts:Array<string>, scripts:Array<string>, metas:Array<string>}}
 *   signals = { entry_type, host, vendor, level, side, entry_ctx, footer, evidence, pageUrl, pageRole, source }
 *   hosts/scripts/metas は指紋学習の材料（判定には使わない）。
 */
function detectEntryOnPage(html, opts = {}) {
  const out = { signals: [], hosts: [], scripts: [], metas: [] };
  if (!html) return out;
  const pageUrl = opts.pageUrl || '';
  const pageRole = opts.pageRole || '';
  const dict = opts.dict || null;
  let baseHost = '';
  try { baseHost = new URL(pageUrl).hostname; } catch (_) { /* pageUrl未指定でも動く */ }
  // 公式URLとして媒体ページが登録されている社が実在する（BALESのWebサイト列にマイナビURL等）。
  // その場合 baseHost が媒体になり、媒体内リンクが全て own_form に化けて「自社フォームで受付」に見える。
  // 自社ドメインが判らない扱いにして、媒体リンクは media_only のまま残す。
  let mediaBase = '';
  if (baseHost && isMediaHost(baseHost)) { mediaBase = baseHost; baseHost = ''; }

  // 採用サイトそのものをベンダーのドメインで運用している社がある
  //   （リストの公式URLが job.<vendor>.jp / <brand>.saiyo.jp 等になっている実例が誤判定サンプルに出た）。
  // この場合サイト内のリンクは全部「自社ドメイン内」に見えるので、動線をいくら辿っても
  // ベンダー遷移が観測できない＝未導入に化ける。ホスト自体を辞書に照会して先に確定させる。
  const baseFp = baseHost ? matchFingerprint(baseHost, dict) : null;

  const $ = cheerio.load(String(html));
  const seen = new Set();
  const push = (sig) => {
    const key = `${sig.entry_type}|${sig.host}|${(sig.evidence || '').slice(0, 60)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.signals.push(sig);
  };
  if (baseFp && baseFp.side === 'ats') {
    push({
      source: 'host', entry_type: 'ats_vendor', host: rootDomain(baseHost), vendor: baseFp.vendor || '',
      side: 'ats', level: 3, entry_ctx: true, reserve_ctx: false, shinsotsu: false, footer: false,
      evidence: `採用サイト自体がベンダーのドメイン(自前辞書${baseFp.companies || '?'}社で確認): ${rootDomain(baseHost)}`,
      anchor: '', pageUrl, pageRole,
    });
  }

  // ① <a> リンク（本命。文脈が取れるのでエントリー導線か否かを見分けられる）
  $('a[href]').each((_, a) => {
    if (out.signals.length > 120) return;
    const href = $(a).attr('href');
    const anchor = [$(a).text(), $(a).attr('title'), $(a).attr('aria-label'), $(a).find('img').attr('alt')]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const chain = ancestorChain($, a);
    const footer = FOOTER_RE.test(chain);
    const near = footer ? anchor : (anchor + ' ' + nearText($, a));
    // エントリー文脈の強弱を分ける。
    //   強 … リンク文言か href 自身にエントリー語彙がある（＝そのリンクが応募の入口）
    //   弱 … 周辺ブロックのテキストにしかない（＝同じ枠に応募案内が載っているだけ）
    // 外部ホストは強い文脈でしか entry_ctx としない。弱い文脈まで許すと、採用ページの
    // 地図リンクやバナーが「ベンダー遷移」に化けて誤って導入済/要確認になる（実測で確認）。
    const strongCtx = ENTRY_RE.test(`${anchor} ${decodeSafe(String(href))}`);
    const weakCtx = ENTRY_RE.test(near);
    const c = classifyEntryLink(href, { baseHost, mediaBaseHost: mediaBase, baseUrl: pageUrl, anchor, near, entryCtx: strongCtx || weakCtx, dict });
    if (!c) return;
    const external = c.entry_type === 'ats_vendor' || c.entry_type === 'generic_form';
    const entryCtx = external ? strongCtx : (strongCtx || weakCtx);
    const hay = `${anchor} ${decodeSafe(String(href))} ${near}`;
    push({
      source: 'link', entry_type: c.entry_type, host: c.host, vendor: c.vendor, side: c.side,
      level: c.level, entry_ctx: entryCtx, reserve_ctx: RESERVE_RE.test(hay), shinsotsu: SHINSOTSU_RE.test(hay),
      footer, evidence: c.label, anchor: anchor.slice(0, 60), pageUrl, pageRole,
    });
    if (c.host && !sameCompanyHost(c.host, baseHost)) out.hosts.push(c.host);
  });

  // ② <form action>（フォームがどこへ POST されるか＝動線の実体）
  $('form[action]').each((_, f) => {
    const action = $(f).attr('action');
    if (!action) return;
    let host = '';
    try { host = new URL(action, pageUrl || 'https://example.com').hostname.toLowerCase(); } catch (_) { return; }
    const formText = ($(f).text() || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const entryCtx = ENTRY_RE.test(formText + ' ' + decodeSafe(action));
    // 検索フォーム等を除くため、エントリー語彙がある時だけ動線として扱う
    if (!entryCtx) { if (host && !sameCompanyHost(host, baseHost) && !isInfraHost(host)) out.hosts.push(host); return; }
    const c = classifyEntryLink(action, { baseHost, mediaBaseHost: mediaBase, baseUrl: pageUrl, anchor: formText, entryCtx: true, dict });
    if (!c) return;
    push({
      source: 'form', entry_type: c.entry_type, host: c.host, vendor: c.vendor, side: c.side,
      level: Math.max(c.level, sameCompanyHost(host, baseHost) ? 3 : c.level), // 自社ドメインへのPOST＝自社フォーム確定
      entry_ctx: true, reserve_ctx: false, shinsotsu: SHINSOTSU_RE.test(formText), footer: false,
      evidence: `フォーム送信先: ${c.label}`, anchor: '', pageUrl, pageRole,
    });
    if (c.host && !sameCompanyHost(c.host, baseHost)) out.hosts.push(c.host);
  });

  // ③ <iframe src>（Googleフォーム/ベンダーフォームの埋め込み）
  //    採用ページには動画・スライドの埋め込みが普通にあるので、iframeを無条件に動線と見なすと
  //    speakerdeck / vimeo / youtube-nocookie が「エントリー先」になる（台帳600社で実測: speakerdeck 39社）。
  //    正体が判っているもの（Googleフォーム or 辞書収載ホスト）だけを動線として採る。
  $('iframe[src]').each((_, fr) => {
    const src = $(fr).attr('src');
    let host = '';
    try { host = new URL(src, pageUrl || 'https://example.com').hostname.toLowerCase(); } catch (_) { return; }
    if (sameCompanyHost(host, baseHost) || isSocialHost(host) || isInfraHost(host)) return;
    const c = classifyEntryLink(src, { baseHost, mediaBaseHost: mediaBase, baseUrl: pageUrl, anchor: '', entryCtx: true, dict });
    if (!c) return;
    if (c.entry_type !== 'google_form' && !matchFingerprint(host, dict)) { out.hosts.push(rootDomain(host)); return; }
    push({
      source: 'iframe', entry_type: c.entry_type, host: c.host, vendor: c.vendor, side: c.side,
      level: c.level, entry_ctx: true, reserve_ctx: false, shinsotsu: false, footer: false,
      evidence: `埋め込み: ${c.label}`, anchor: '', pageUrl, pageRole,
    });
    out.hosts.push(c.host);
  });

  // ④ script src（指紋学習の材料。加えて、辞書で確定済みのベンダーJSは導入済の傍証になる）
  //    「エントリーリンクは媒体経由だがマイページ用JSだけ埋まっている」型の導入済企業をここで拾う。
  const recruitFace = /^(採用|エントリー|募集要項|説明会)$/.test(pageRole);
  $('script[src]').each((_, s) => {
    const src = $(s).attr('src');
    let u;
    try { u = new URL(src, pageUrl || 'https://example.com'); } catch (_) { return; }
    const file = (u.pathname.split('/').pop() || '').slice(0, 60);
    const own = sameCompanyHost(u.hostname, baseHost);
    const key = (own ? '' : rootDomain(u.hostname) + '/') + file;
    if (file) out.scripts.push(key);
    if (own || isInfraHost(u.hostname) || isSocialHost(u.hostname) || isMediaHost(u.hostname)) return;
    const fp = matchFingerprint(u.hostname, dict);
    const scriptFp = dict && dict.scripts ? dict.scripts[key] : null;
    if ((fp && fp.side === 'ats') || (scriptFp && scriptFp.side === 'ats')) {
      push({
        source: 'script', entry_type: 'ats_vendor', host: rootDomain(u.hostname),
        vendor: (fp && fp.vendor) || (scriptFp && scriptFp.vendor) || '', side: 'ats', level: 2,
        entry_ctx: recruitFace, reserve_ctx: false, shinsotsu: false, footer: false,
        evidence: `ベンダーJS読込(自前辞書): ${key}`, anchor: '', pageUrl, pageRole,
      });
    }
  });
  $('meta[name="generator"],meta[name="application-name"]').each((_, m) => {
    const v = ($(m).attr('content') || '').trim();
    if (v) out.metas.push(v.slice(0, 60));
  });

  // ⑤ 本文のメール直記載／電話のみ受付（リンクになっていないケースが実務では多い）
  const text = pageText(html);
  const windows = [];
  const re = new RegExp(ENTRY_RE.source, 'gi');
  let m;
  while ((m = re.exec(text)) && windows.length < 12) {
    windows.push(text.slice(Math.max(0, m.index - 80), Math.min(text.length, m.index + 200)).replace(/\s+/g, ' '));
  }
  for (const w of windows) {
    const mail = w.match(MAIL_RE);
    if (mail) {
      push({
        source: 'text', entry_type: 'mail_direct', host: (mail[0].split('@')[1] || '').toLowerCase(), vendor: '', side: 'diy',
        level: 2, entry_ctx: true, reserve_ctx: false, shinsotsu: SHINSOTSU_RE.test(w), footer: false,
        evidence: `本文にメール直記載: …${w.slice(0, 110)}…`, anchor: '', pageUrl, pageRole,
      });
    }
    // 電話は「予約・申込の受付手段として書かれている」時だけ拾う。
    //   エントリー窓（±200字）のどこかに電話番号がある、程度の条件だと
    //   お知らせ欄の代表電話やイベント告知を掴んでしまう（実測: ENEOSグローブ/サン電子）。
    //   番号のすぐ近く（±45字）に受付動詞があることを要求する。
    const telM = w.match(TEL_RE);
    if (telM) {
      const at = w.indexOf(telM[0]);
      const tight = w.slice(Math.max(0, at - 45), Math.min(w.length, at + telM[0].length + 45));
      const 受付動詞 = /(?:ご)?予約|お?申[しし]?込|受付(?:中|時間|け)?|お電話(?:にて|で|ください)|お問合せ(?:ください)?|ご連絡ください|までご連絡|までお電話/;
      const 用件 = /説明会|セミナー|見学会|面接|選考|エントリー|応募|採用/;
      if (受付動詞.test(tight) && 用件.test(tight)) {
        push({
          source: 'text', entry_type: 'phone_only', host: '', vendor: '', side: 'diy',
          level: 1, entry_ctx: true, reserve_ctx: true, shinsotsu: SHINSOTSU_RE.test(w), footer: false,
          evidence: `本文に電話受付: …${tight}…`, anchor: '', pageUrl, pageRole,
        });
      }
    }
  }
  return out;
}

// ---- 集約 -------------------------------------------------------------------
// entry_type の「動線としての強さ」。同じページに複数出た時、どれを主動線とするか。
// ats_vendor を最上位に置くのは、ベンダーに飛ぶ導線が1本でもあれば導入済＝除外対象だから
// （未導入と誤判定して架電するコストの方が、除外し過ぎるコストより高い）。
const TYPE_RANK = {
  ats_vendor: 100, google_form: 80, generic_form: 70, pdf_download: 65,
  mail_direct: 60, own_form: 50, media_only: 40, phone_only: 30, none: 0,
};
// 未導入企業の“痛み”の強さ＝提案の刺さりやすさ。営業の架電順に直結する。
const SEVERITY = {
  pdf_download: 5, phone_only: 5, mail_direct: 4, google_form: 4,
  generic_form: 3, media_only: 3, own_form: 2, none: 1, ats_vendor: 0,
};
const TYPE_LABEL = {
  google_form: 'Googleフォーム', mail_direct: 'メール直記載', phone_only: '電話のみ',
  pdf_download: 'PDFエントリーシート', media_only: '媒体ページのみ', ats_vendor: '外部ATSベンダー',
  generic_form: '汎用フォームSaaS', own_form: '自社フォーム', none: '動線不明',
};

/**
 * 全ページの証跡を1社の判定に畳む。
 * @param {Array<object>} signals detectEntryOnPage の signals を全ページ分連結
 * @param {{pagesOk?:number, pagesFailed?:number, recruitFound?:boolean}} [ctx]
 * @returns {{ATS判定:string, entry_type:string, entry_host:string, ベンダー:string, 確度:number,
 *            重症度:number, 動線内訳:string, 根拠:string, 証跡数:number}}
 */
function summarizeAts(signals, ctx = {}) {
  const pagesOk = ctx.pagesOk || 0;
  const all = (signals || []).filter((s) => s && s.entry_type);
  // 主動線の候補: エントリー文脈があるものを優先。無ければ採用面のものまで許す。
  const ctxHits = all.filter((s) => s.entry_ctx);
  // 文脈語のある証跡が1つも無い時のフォールバック（採用面に出ているだけの証跡も見る）。
  // ただし「正体不明の外部ホスト」はここから外す。弱い文脈で拾った地図/バナーが
  // 要確認を量産し、未導入プール（＝成果物）から良質リードを削ってしまうため。
  // 辞書で確定済みのベンダー(side='ats')は、文言が無くても証拠として有効なので残す。
  const recruitHits = all.filter((s) => !s.entry_ctx && s.pageRole === '採用' && !s.footer
    && !(s.entry_type === 'ats_vendor' && s.side === 'unknown'));
  const pool = ctxHits.length ? ctxHits : recruitHits;

  const typesFound = new Set(pool.map((s) => s.entry_type));
  const rank = (s) => TYPE_RANK[s.entry_type] || 0;
  const ranked = pool.slice().sort((a, b) => (rank(b) - rank(a)) || (b.level - a.level) || ((b.entry_ctx ? 1 : 0) - (a.entry_ctx ? 1 : 0)));
  const primary = ranked[0] || null;

  // phone_only は「他に手段が無い」時だけ成立する（電話番号はどのページにも載っている）。
  //   他の動線が1つでもあれば、その動線を主とし phone は内訳に残すだけ。
  let entry_type = primary ? primary.entry_type : 'none';
  if (entry_type === 'phone_only' && typesFound.size > 1) {
    const alt = ranked.find((s) => s.entry_type !== 'phone_only');
    if (alt) entry_type = alt.entry_type;
  }
  const primarySig = ranked.find((s) => s.entry_type === entry_type) || primary;

  // 判定: ATSベンダー行きの導線があれば「導入済」。無く、かつ動線を1つでも掴めていれば「未導入」。
  const vendorSigs = pool.filter((s) => s.entry_type === 'ats_vendor');
  const knownVendor = vendorSigs.find((s) => s.side === 'ats');
  const unknownVendor = vendorSigs.find((s) => s.side === 'unknown');

  // 「未導入」と言い切るには動線の“実体”が要る。
  //   実体 = フォームの送信先／Googleフォーム／メール直記載/電話受付の明記／ESのPDF／媒体ページ。
  //   実体でない唯一のもの = 自社サイト内リンク <a href="/recruit/entry">。
  //   これは受付方法ではなく“次のページへの案内”でしかなく、実際はその先でベンダーに飛んでいる社が
  //   未導入に化ける（精度検証の誤判定サンプルは、ほぼ全てこの型だった）。
  //   フォームの送信先として自社ドメインが見えている場合(source='form')は実体として扱う。
  const hasSubstance = pool.some((s) => !(s.entry_type === 'own_form' && s.source === 'link'));

  let 判定; let 確度;
  if (pagesOk === 0) { 判定 = '不明'; 確度 = 0; entry_type = 'none'; }
  else if (knownVendor) { 判定 = '導入済'; 確度 = 88; }
  else if (unknownVendor) { 判定 = '要確認'; 確度 = 50; }
  else if (entry_type === 'none') { 判定 = '不明'; 確度 = Math.min(45, 20 + pagesOk * 5); }
  else if (!hasSubstance) { 判定 = '不明'; 確度 = Math.min(45, 25 + pagesOk * 4); }
  else { 判定 = '未導入'; 確度 = 60; }

  // 未導入の確信度を積む: 動線が強い証跡ほど、また見たページ数が多いほど「他に無い」と言い切れる。
  if (判定 === '未導入') {
    if (primarySig && primarySig.level >= 3) 確度 += 12;
    if (primarySig && primarySig.source === 'form') 確度 += 5;      // フォーム送信先まで見えている
    if (pagesOk >= 4) 確度 += 8; else if (pagesOk >= 2) 確度 += 4;
    if (typesFound.size >= 2) 確度 += 3;                            // 複数の手作業動線が同居＝ATS不在の傍証
    if (pool.some((s) => s.shinsotsu)) 確度 += 5;                   // 新卒面で確認できた
    if (ctx.recruitFound === false) 確度 -= 10;                     // 採用ページに辿り着けていない
  }
  if (判定 === '導入済') {
    if (vendorSigs.filter((s) => s.side === 'ats').length >= 2) 確度 += 5;
    if (knownVendor && knownVendor.vendor) 確度 += 5;
  }
  確度 = Math.max(0, Math.min(97, Math.round(確度)));

  const entry_host = primarySig ? (primarySig.host || '') : '';
  const ベンダー = knownVendor ? (knownVendor.vendor || '(名称未特定)') : (unknownVendor ? '(辞書未収載)' : '');

  // 内訳は営業が読む列。見つかった動線を強い順に並べる。
  const 動線内訳 = [...typesFound].sort((a, b) => (TYPE_RANK[b] || 0) - (TYPE_RANK[a] || 0))
    .map((t) => TYPE_LABEL[t] || t).join('/');

  const parts = ranked.slice(0, 3).map((s) => s.evidence);
  if (判定 === '不明' && pagesOk > 0) {
    parts.push(entry_type !== 'none' && !hasSubstance
      ? `エントリー導線のリンクはあるが受付の実体（フォーム送信先/フォーム/メール/ES）を確認できず（検査${pagesOk}ページ）`
      : `検査${pagesOk}ページでエントリー動線を検出できず`);
  }
  if (判定 === '未導入') parts.push(`検査${pagesOk}ページでベンダー遷移なし`);
  if (unknownVendor) parts.push('外部ホストが辞書に無い＝学習対象（ats:learn で解決）');

  return {
    ATS判定: 判定, entry_type, entry_host, ベンダー, 確度,
    重症度: 判定 === '未導入' ? (SEVERITY[entry_type] || 1) : 0,
    動線内訳, 証跡数: pool.length,
    根拠: parts.join(' ／ ').slice(0, 500),
  };
}

/**
 * 判定 → 架電トークの入口。未導入の型ごとに「相手が今どう困っているか」を言い当てる形にする。
 */
function atsTalkGuide(判定, entry_type, ベンダー) {
  if (判定 === '導入済') {
    return `他社ATS導入済み（${ベンダー || 'ベンダー不明'}）。受注ドライバから外れる層。かけるなら乗り換え時期（更新月）狙いで、LINE到達率の差だけを一点突破`;
  }
  if (判定 === '要確認') {
    return '外部システムへ遷移する導線あり（何かは未特定）。冒頭で「エントリーの受付は何でされていますか」と一問置いてから分岐';
  }
  if (判定 === '不明') {
    return 'エントリー動線が取れていない。通常トーク（母集団・歩留から）で入り、受付方法を聞き出す';
  }
  switch (entry_type) {
    case 'pdf_download':
      return 'エントリーシートをPDF配布＝受付後は全て手作業。「集めた後の集計と連絡、今どなたがやられてますか」から入ると刺さる（最重症）';
    case 'phone_only':
      return '説明会予約が電話のみ＝営業時間外の応募を丸ごと取りこぼしている。「夜間・土日の予約が拾えていない」を主語に';
    case 'mail_direct':
      return 'エントリーがメール直受け＝返信漏れ・二重対応が起きやすい。「応募メールの返信、何時間以内に返せていますか」から歩留の話へ';
    case 'google_form':
      return 'Googleフォーム運用＝応募は取れるが、その後の進捗管理・日程調整・連絡が全部手作業。「スプレッドシートの後工程」を主語に';
    case 'generic_form':
      return '汎用フォームで受付＝応募は取れるが選考管理は手作業。「フォームの後、進捗はどこで管理されていますか」から入る';
    case 'media_only':
      return '媒体の管理画面だけで運用＝掲載終了で母集団も履歴も残らない。「媒体が切れた後の再アプローチ」を主語に';
    case 'own_form':
      return '自社フォームで受付＝ATSは未導入。痛みは相対的に弱いので、母集団規模と歩留（辞退率）から入る';
    default:
      return 'ATS未導入。母集団・歩留を主語に通常トーク';
  }
}

module.exports = {
  classifyEntryLink, detectEntryOnPage, summarizeAts, atsTalkGuide, matchFingerprint,
  rootDomain, registrableDomain, sameCompanyHost, isMediaHost, isSocialHost, isInfraHost, mediaHosts,
  TYPE_RANK, SEVERITY, TYPE_LABEL, ENTRY_RE, ES_PDF_RE,
};
