'use strict';
/**
 * 企業の「公式LINE（LINE公式アカウント）利用有無」判定エンジン（純ロジック・ネット不要）
 * ============================================================================
 * なぜ要るか（営業要件）:
 *   接続後お断り理由の第2位が「公式LINE使ってるから足りてる」（445件・7.2%／docs/分析-接続後断り理由とアポ獲得トーク.md）。
 *   相手が公式LINEを **持っているか / 何に使っているか** を架電前に知れていれば、
 *     ・持っている → 「配信」と「個別の選考進捗・歩留管理」の役割差で最初から切り込める
 *     ・持っていない → LINEを主語にせず母集団/歩留を主語に切り替えられる（LINE推しは逆効果）
 *   ＝トーク分岐の事前確定に効く。よって判定は「有/無」だけでなく **用途（採用か販促か）** まで出す。
 *
 * 判定材料は2系統。どちらも企業サイトのHTMLから取れる。
 *   ①URL証跡（強い）… 友だち追加リンク/アカウントページ/QR/LIFF等。IDが取れるものは実在検証もできる。
 *   ②文言証跡（中）  … 「LINE公式アカウント」「友だち追加」「LINEでお問い合わせ」等。
 *
 * 誤検知の主犯は3つ。ここを落とすのが本モジュールの肝:
 *   (a) 記事の「LINEで送る」シェアボタン（line.me/R/msg/text・social-plugins.line.me）
 *       → 自社アカウントの証跡ではない。むしろ“無”の判断材料なので neg として明示的に持つ。
 *   (b) LINE WORKS（社内チャット）。公式アカウントとは別物。
 *   (c) 英単語の LINE（ONLINE / LINE UP / PRODUCT LINE / 生産ライン）。
 *       → 語境界つき (?<![A-Za-z0-9])LINE(?![A-Za-z0-9]) で拾い、否定語で再度落とす。
 *
 * 使い方（純関数）:
 *   const { detectLineOnPage, summarizeLine } = require('./line-official');
 *   const { signals } = detectLineOnPage(html, { pageUrl });
 *   const 判定 = summarizeLine(signals, { pagesOk: 5 });
 */
const cheerio = require('cheerio');

// ---- LINE IDの正規化 ---------------------------------------------------------
// 「%40acme」「@Acme」「acme」→ 「@acme」。IDとして有り得ない語（パス断片/言語コード）は捨てる。
const ID_RESERVED = new Set([
  'ti', 'p', 'r', 'nv', 'msg', 'share', 'oauth2', 'dialog', 'ja', 'en', 'ko', 'th', 'zh-hant', 'zh-hans',
  'profile', 'report', 'signboard', 'search', 'sitemaps', 'static', 'assets', 'img', 'images', 'about',
]);
function normalizeLineId(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  try { s = decodeURIComponent(s); } catch (_) { /* %が単独で入っている等はそのまま */ }
  s = s.replace(/^[@＠~〜%]+/, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  if (!/^[a-z0-9._-]{2,30}$/.test(s)) return '';
  if (ID_RESERVED.has(s)) return '';
  if (!/[a-z0-9]/.test(s)) return '';
  return '@' + s;
}

// ---- URL証跡のルール表 -------------------------------------------------------
// neg:true は「LINEを使っている証跡にならない」もの。先に評価して positive に流さない。
// level: 3=確実 / 2=ほぼ確実 / 1=疑い
const URL_RULES = [
  // (a) 記事シェアボタン。自社アカウントとは無関係。
  {
    kind: 'share', level: 0, neg: true,
    re: /(?:social-plugins\.line\.me\/lineit|line\.me\/R\/msg\/text|line\.me\/R\/share|timeline\.line\.me\/social-plugin)/i,
  },
  // (b) LINE WORKS（社内チャット）。公式アカウントではない。
  { kind: 'works', level: 0, neg: true, re: /(?:line\.worksmobile\.com|lineworks\.com|works\.do)/i },
  // LINE社のコーポレート/記事面。証跡にならない。
  { kind: 'corp', level: 0, neg: true, re: /(?:linecorp\.com|lycorp\.co\.jp|linebiz\.com\/jp\/(?:column|case|service|news))/i },

  // --- 以下 positive ---
  // 友だち追加リンク。@IDが取れる最強証跡。
  {
    kind: 'add-friend', level: 3, idIdx: 1,
    re: /line\.me\/(?:R\/)?ti\/p\/(?:%40|@)([A-Za-z0-9._%-]{2,30})/i,
  },
  // 公式アカウント推奨リンク。
  {
    kind: 'recommend-oa', level: 3, idIdx: 1,
    re: /line\.me\/R\/nv\/recommendOA\/(?:%40|@)([A-Za-z0-9._%-]{2,30})/i,
  },
  // アカウントページ（page.line.me/{id}）。存在検証もここのIDで行える。
  {
    kind: 'account-page', level: 3, idIdx: 1,
    re: /page\.line\.me\/(?:\?accountId=)?(?:%40|@)?([A-Za-z0-9._%-]{2,40})/i,
  },
  // 公式アカウントのQR画像（アカウントが実在しないと発行されない）。
  { kind: 'qr', level: 3, re: /(?:qr-official\.line\.me|qr-official\.line-scdn\.net|qr\.line-scdn\.net)/i },
  // 管理画面リンク（稀だが決定的）。
  { kind: 'oa-manager', level: 3, re: /(?:manager\.line\.biz|admin-official\.line\.me)/i },
  // 短縮リンク。ほぼ公式アカウント誘導だが、辿るまでIDが判らない。
  { kind: 'short', level: 2, re: /(?:^|[^A-Za-z0-9.])lin\.ee\/([A-Za-z0-9]{3,20})/i },
  // LIFF（公式アカウント上で動くミニアプリ）。アカウント保有が前提。
  { kind: 'liff', level: 2, re: /liff\.line\.me\/(\d{6,12}-[A-Za-z0-9]{3,12})/i },
  // LINEログイン連携。チャネル保有の傍証だが公式アカウントとは限らない。
  { kind: 'login', level: 1, re: /access\.line\.me\/(?:oauth2|dialog|o2)/i },
  // 個人LINE ID（~付き）。公式アカウントではない可能性が高いので疑い止まり。
  { kind: 'personal-id', level: 1, re: /line\.me\/(?:R\/)?ti\/p\/(?:%7E|~)([A-Za-z0-9._-]{2,30})/i },
];

const KIND_LABEL = {
  'add-friend': '友だち追加リンク', 'recommend-oa': '公式アカウント推奨リンク', 'account-page': 'アカウントページ',
  qr: '公式アカウントQR', 'oa-manager': 'LINE公式アカウント管理画面', short: 'lin.ee短縮リンク',
  liff: 'LIFF(ミニアプリ)', login: 'LINEログイン連携', 'personal-id': '個人LINE ID',
  share: 'LINEシェアボタン', works: 'LINE WORKS(社内チャット)', corp: 'LINE社ページ',
};

/**
 * 1本のURLを分類する。
 * @returns {{kind:string,level:number,neg:boolean,id:string,label:string}|null} LINE無関係なら null
 */
function classifyLineUrl(url) {
  const u = String(url || '');
  if (!/lin(?:e|\.ee)/i.test(u)) return null;     // 早期棄却（lin.ee は 'line' を含まないので別途拾う）
  for (const r of URL_RULES) {
    const m = u.match(r.re);
    if (!m) continue;
    const id = r.idIdx ? normalizeLineId(m[r.idIdx]) : '';
    // page.line.me は言語パス等も食うので、IDが取れなければ証跡として採らない。
    if (r.kind === 'account-page' && !id) continue;
    return { kind: r.kind, level: r.level, neg: !!r.neg, id, label: KIND_LABEL[r.kind] || r.kind };
  }
  return null;
}

// URL抽出: href/src/JS文字列すべてを拾うため、生HTMLに正規表現をかける（プロトコル相対も拾う）。
const URL_RE = /(?:https?:)?\/\/[^\s"'<>()\\]+/g;
function extractUrls(html) {
  const out = new Set();
  const s = String(html || '');
  let m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(s))) {
    let u = m[0].replace(/&amp;/g, '&').replace(/[.,;:)]+$/, '');
    if (u.startsWith('//')) u = 'https:' + u;
    out.add(u);
    if (out.size > 4000) break;                  // 巨大ページの暴走防止
  }
  return [...out];
}

// ---- 文言証跡のルール表 -----------------------------------------------------
// 「LINE」出現地点の前後だけを見る（窓）。窓の中で positive が立ち、negative が立たなければ採る。
const MENTION_RE = /(?<![A-Za-z0-9])LINE(?![A-Za-z0-9])|ＬＩＮＥ|公式ライン|ライン公式/gi;
const TEXT_RULES = [
  { key: '公式アカウント表記', level: 2, re: /(?:LINE|ＬＩＮＥ|ライン)\s*公式\s*アカウント|公式\s*(?:LINE|ＬＩＮＥ|ライン)|LINE@|LINEアット/i },
  { key: '友だち追加', level: 2, re: /友(?:だち|達|ダチ)\s*(?:追加|登録|になる|になろう)|ともだち追加|(?:LINE|ライン)で友(?:だち|達)/i },
  { key: 'LINE ID表記', level: 2, idIdx: 1, re: /(?:LINE|ＬＩＮＥ|ライン)\s*(?:公式)?\s*(?:ID|アカウント)?\s*[:：]?\s*[@＠]([A-Za-z0-9._-]{2,20})/i },
  { key: 'LINE窓口', level: 2, re: /(?:LINE|ＬＩＮＥ|ライン)(?:から|にて|より|でも?|を使って|を利用して)?(?:の)?(?:ご|お)?(?:問(?:い)?\s*合(?:わ)?せ|相談|予約|申(?:し)?込|エントリー|受付|応募|連絡)/i },
  { key: 'LINE運用', level: 1, re: /(?:LINE|ＬＩＮＥ|ライン)(?:で|にて|を)?(?:の)?(?:配信|情報発信|お知らせ|通知|クーポン|運用|開設|はじめ|始め|活用)/i },
  { key: 'QRコード', level: 1, re: /QR\s*コード|QRcode/i },
];
// 窓の中にこれが在れば positive を採らない（シェアボタン/別サービス/英単語のLINE）。
const NEG_TEXT_RE = /(?:LINE|ライン)で(?:送る|シェア|共有)|LINEに送る|シェアする|LINE\s*WORKS|LINEワークス|LINE\s*Pay|LINE証券|LINEギフト|LINEスタンプ|LINEミュージック|LINE\s*UP|LINEUP|ラインナップ|生産ライン|ライン作業|オンライン/i;

// 用途（採用 / 販促・顧客）。トーク分岐に直結するのでURL・本文の両方から見る。
const RECRUIT_RE = /採用|新卒|中途|募集|求人|エントリー|説明会|選考|インターン|internship|recruit|saiyo|entry|career/i;
const CUSTOMER_RE = /クーポン|キャンペーン|来店|予約|入庫|お得|セール|会員|新商品|割引|お客様|購入|通販|店舗|見積/i;
function purposeOfText(s) {
  if (RECRUIT_RE.test(s)) return '採用';
  if (CUSTOMER_RE.test(s)) return '販促・顧客';
  return '';
}

// 全ページ共通のフッター/SNSアイコン列を見分ける（用途判定を汚さないため）。
const FOOTER_RE = /footer|f-nav|f_nav|copyright|sns|social|global-?nav|gnav|utility/i;
// 祖先要素の tag/class/id を5段まで連ねた文字列（構造ヒント）。
function ancestorChain($, el) {
  const parts = [];
  let cur = el;
  for (let i = 0; i < 5 && cur; i++) {
    const tag = (cur.tagName || cur.name || '').toLowerCase();
    const cls = ($(cur).attr('class') || '') + ' ' + ($(cur).attr('id') || '');
    parts.push(tag + ' ' + cls);
    cur = cur.parent;
  }
  return parts.join(' | ');
}
// リンクが属するブロックのテキスト（用途の手掛かり。長すぎると無関係語を拾うので短く切る）。
function sectionText($, el) {
  let cur = el;
  for (let i = 0; i < 3 && cur; i++) {
    const txt = ($(cur).text() || '').replace(/\s+/g, ' ').trim();
    if (txt.length >= 12) return txt.slice(0, 200);
    cur = cur.parent;
  }
  return '';
}

// 可視テキスト＋属性テキスト（LINEボタンは alt/aria-label にだけ文言が出ることがある）。
function pageText(html) {
  const $ = cheerio.load(String(html || ''));
  $('script,style,noscript,svg').remove();
  const body = ($('body').text() || '').replace(/[\t\r\n]+/g, '\n').replace(/[ 　]{2,}/g, ' ');
  const attrs = [];
  $('img[alt],[title],[aria-label]').each((_, el) => {
    for (const a of ['alt', 'title', 'aria-label']) {
      const v = $(el).attr(a);
      if (v && v.trim()) attrs.push(v.trim());
    }
  });
  return (body + '\n' + attrs.join(' / ')).trim();
}

/**
 * 1ページ分のHTMLからLINE証跡を集める。
 * @param {string} html
 * @param {{pageUrl?:string, pageRole?:string}} [opts]
 * @returns {{signals:Array<object>, text:string}} signals = {source,kind,level,neg,id,url,evidence,purpose}
 */
function detectLineOnPage(html, opts = {}) {
  const pageUrl = opts.pageUrl || '';
  const pageRole = opts.pageRole || '';
  const signals = [];
  if (!html) return { signals, text: '' };
  const $ = cheerio.load(String(html));

  // ① URL証跡
  //   まず <a> 由来（周辺文脈が取れる＝用途判定ができる）、次に生HTML由来（img/JS内のQR等）。
  const seenUrlKey = new Set();
  const pushUrlSignal = (u, c, ctx) => {
    const key = c.kind + '|' + (c.id || String(u).slice(0, 120));
    if (seenUrlKey.has(key)) return;
    seenUrlKey.add(key);
    signals.push({
      source: 'url', kind: c.kind, level: c.level, neg: c.neg, id: c.id, url: u,
      evidence: `${c.label}: ${String(u).slice(0, 160)}`,
      // 用途はリンク周辺の文脈だけから採る。ページURLからは採らない
      //   （全ページ共通フッターのSNSアイコンが、たまたま採用ページに出ただけで「採用用途」になるのを防ぐ）。
      purpose: purposeOfText(safeDecode(u)) || purposeOfText((ctx && ctx.text) || ''),
      footer: !!(ctx && ctx.footer), pageUrl, pageRole,
    });
  };
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    const c = classifyLineUrl(href);
    if (!c) return;
    const anchor = [$(a).text(), $(a).attr('title'), $(a).attr('aria-label'), $(a).find('img').attr('alt')]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const chain = ancestorChain($, a);
    const footer = FOOTER_RE.test(chain);
    // フッター/SNSアイコン列は全ページ共通の可能性が高い。周辺テキスト（「採用情報」等のリンク集）は
    // 用途の根拠にならないので、アンカー自身の文言だけを見る。
    const near = footer ? anchor : (anchor + ' ' + sectionText($, a));
    pushUrlSignal(String(href), c, { text: near, footer });
  });
  for (const u of extractUrls(html)) {
    const c = classifyLineUrl(u);
    if (c) pushUrlSignal(u, c, null);
  }

  // ② 文言証跡（「LINE」出現の前後窓のみ判定）
  const text = pageText(html);
  const perKey = new Map();
  MENTION_RE.lastIndex = 0;
  let m;
  while ((m = MENTION_RE.exec(text))) {
    const win = text.slice(Math.max(0, m.index - 60), Math.min(text.length, m.index + 80)).replace(/\s+/g, ' ');
    if (NEG_TEXT_RE.test(win)) {
      if (!perKey.has('NEG')) {
        perKey.set('NEG', true);
        signals.push({
          source: 'text', kind: 'share-text', level: 0, neg: true, id: '', url: '',
          evidence: `シェア/別サービス文言: ${win.slice(0, 120)}`, purpose: '', pageUrl, pageRole,
        });
      }
      continue;
    }
    for (const r of TEXT_RULES) {
      const mm = win.match(r.re);
      if (!mm) continue;
      if ((perKey.get(r.key) || 0) >= 2) break;    // 同種文言は1ページ2件まで（証跡の水増し防止）
      perKey.set(r.key, (perKey.get(r.key) || 0) + 1);
      signals.push({
        source: 'text', kind: r.key, level: r.level, neg: false,
        id: r.idIdx ? normalizeLineId(mm[r.idIdx]) : '',
        url: '', evidence: `${r.key}: ${win.slice(0, 120)}`,
        purpose: purposeOfText(win),
        pageUrl, pageRole,
      });
      break;                                       // 1窓につき最上位ルール1件
    }
    if (signals.length > 60) break;
  }
  return { signals, text };
}

function safeDecode(s) {
  try { return decodeURIComponent(String(s || '')); } catch (_) { return String(s || ''); }
}

/**
 * 複数ページの証跡を1社の判定に畳む。
 * @param {Array<object>} signals detectLineOnPage の signals を全ページ分連結したもの
 * @param {{pagesOk?:number, pagesFailed?:number, verified?:boolean|null}} [ctx]
 *        verified: page.line.me での実在検証結果（true=実在 / false=不在 / null=未検証）
 * @returns {{判定:string,確度:number,ID:string,URL:string,用途:string,根拠:string,レベル:number,証跡数:number}}
 */
function summarizeLine(signals, ctx = {}) {
  const pagesOk = ctx.pagesOk || 0;
  const pos = (signals || []).filter((s) => !s.neg && s.level > 0);
  const neg = (signals || []).filter((s) => s.neg);
  const level = pos.reduce((a, s) => Math.max(a, s.level), 0);

  // 代表ID/URL: レベルが高く、IDを持つ証跡を優先。
  const ranked = pos.slice().sort((a, b) => (b.level - a.level) || ((b.id ? 1 : 0) - (a.id ? 1 : 0)));
  const withId = ranked.find((s) => s.id);
  const id = withId ? withId.id : '';
  const urlSig = ranked.find((s) => s.url) || null;
  const url = urlSig ? urlSig.url : '';

  // 用途: リンク/文言の周辺文脈から採る。文脈が無ければ「その口座が採用面にしか出ていない」時だけ採用と見なす。
  //   全ページ共通フッターのSNSアイコン(footer:true)は面を選ばず出るので、この推定から外す。
  const nonFooter = pos.filter((s) => !s.footer);
  const 用途 = pos.some((s) => s.purpose === '採用') ? '採用'
    : pos.some((s) => s.purpose === '販促・顧客') ? '販促・顧客'
      : level <= 0 ? ''
        : (nonFooter.length && nonFooter.every((s) => s.pageRole === '採用')) ? '採用' : '不明';

  let 判定; let 確度;
  if (pagesOk === 0) { 判定 = '不明'; 確度 = 0; }
  else if (level >= 2) { 判定 = '有'; 確度 = level >= 3 ? 85 : 70; }
  else if (level === 1) { 判定 = '要確認'; 確度 = 45; }
  else { 判定 = '無'; 確度 = Math.min(80, 58 + pagesOk * 4); }

  if (判定 === '有' || 判定 === '要確認') {
    if (id) 確度 += 5;
    if (new Set(pos.map((s) => s.kind)).size >= 2) 確度 += 5;
    if (pos.some((s) => s.source === 'url') && pos.some((s) => s.source === 'text')) 確度 += 5; // URLと文言の二重証跡
    if (ctx.verified === true) { 判定 = '有'; 確度 = Math.max(確度, 95); }
    // 実在しないID（旧LINE@の貼りっぱなし等）は自信を大きく削り「要確認」に落とす。
    if (ctx.verified === false) { 確度 = Math.max(20, 確度 - 40); if (判定 === '有') 判定 = '要確認'; }
  }
  確度 = Math.max(0, Math.min(98, Math.round(確度)));

  // 根拠は上位3件＋（有力証跡が無い時のみ）シェアボタン所見。
  const parts = ranked.slice(0, 3).map((s) => s.evidence);
  if (!parts.length && neg.length) parts.push('LINEシェアボタン/別サービスのみ（自社アカウントの証跡なし）');
  if (ctx.verified === true && id) parts.push(`page.line.me/${id.slice(1)} で実在確認`);
  if (ctx.verified === false && id) parts.push(`page.line.me/${id.slice(1)} は不在（IDが古い可能性）`);
  if (判定 === '無') parts.push(`検査${pagesOk}ページで証跡なし`);

  return {
    判定, 確度, ID: id, URL: url, 用途, レベル: level, 証跡数: pos.length,
    根拠: parts.join(' ／ ').slice(0, 500),
  };
}

/**
 * 判定→架電トーク指針（docs/分析-接続後断り理由とアポ獲得トーク.md の「公式LINE誤解」克服トークに対応）。
 */
function lineTalkGuide(判定, 用途) {
  if (判定 === '有' && 用途 === '採用') {
    return '採用で公式LINE運用中。「LINEは“一斉配信”、MOCHICAは“一人ひとりの選考進捗と歩留管理”」と役割差から入る（LINE前提の会話が通じる相手）';
  }
  if (判定 === '有' && 用途 === '販促・顧客') {
    return '公式LINEは販促/顧客用途。「同じLINEを採用の歩留に使う」提案として持ち込む（社内にLINE運用の素地あり）';
  }
  if (判定 === '有') {
    return '公式LINEあり（用途は不明）。「LINEは何にお使いですか」と一問置き、配信用途なら選考進捗・歩留管理との役割差へ';
  }
  if (判定 === '要確認') {
    return 'LINE言及あり（確証は弱い）。冒頭で「公式LINEは使われていますか」と一問置いてから分岐';
  }
  if (判定 === '無') {
    return 'LINE未使用。LINEを主語にせず母集団/歩留まりを主語に（LINE推しは逆効果）';
  }
  return '未調査。通常トーク（母集団・歩留から）';
}

module.exports = {
  normalizeLineId, classifyLineUrl, extractUrls, detectLineOnPage, summarizeLine, lineTalkGuide,
  pageText, URL_RULES, TEXT_RULES,
};
