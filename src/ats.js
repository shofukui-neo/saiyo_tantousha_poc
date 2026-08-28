'use strict';
/**
 * エントリーページURL → 利用ATS（採用管理システム）判定。
 * =====================================================================
 * 用途: MOCHICAの営業前に「その企業がどのATSを使っているか」を機械判定する。
 *   - 競合ATS導入済み（sonar/i-web/AOL…）→ リプレイス提案・切替時期の見極め
 *   - ナビ媒体のみ / 自作フォーム（ATS未導入疑い）→ 新規導入の最有力
 *   - MOCHICA自身 → 既存顧客（除外）
 *
 * 判定は3系統。上ほど確度が高い:
 *   1) エントリーURLのホスト（例 career-cloud.asia → 採用一括かんりくん）
 *   2) リダイレクト後の最終URL（自社ドメイン → ATSへ飛ばす構成が多い）
 *   3) ページHTML内の埋め込み（iframe/script/form action のホスト、本文マーカー）
 *      → 自社サイトにフォームを埋め込む構成はホスト判定では取れないため必須。
 *
 * ネットワークは触らない純ロジック（HTMLは呼び出し側が渡す）。
 * ライブ取得は enrich-ats.js が polite.js 経由で行う。
 */

// ---- 種別 ---------------------------------------------------------------
//  ats   : 採用管理システム（＝競合。リプレイス商談の対象）
//  media : 就職ナビ媒体（ATSではない。媒体経由エントリーのみ＝ATS未導入の可能性）
//  form  : 汎用フォーム／自作フォーム（ATS未導入の最有力シグナル）
//  sns   : SNS/スカウト媒体
const KIND_LABEL = { ats: '採用管理システム', media: 'ナビ媒体', form: '汎用フォーム', sns: 'SNS/スカウト' };

/**
 * ベンダー定義。
 *  hosts       : 登録ドメイン。完全一致 + サブドメイン一致（`.` 境界必須。career-cloud.asia.evil.com は不一致）
 *  pathHosts   : ホストだけでは決まらないもの（docs.google.com/forms 等）
 *  htmlMarkers : ページHTML内の文字列マーカー（ホストが取れない埋め込み構成の保険）
 *  aliases     : CRM（BALESの「カスタム情報：利用中ATS」）の手入力表記ゆれ。normalizeAtsName() 用
 *  note        : 営業側が読む短い注記
 * 追加は data/ats-registry.json（任意）でも可能。registry() 参照。
 */
const REGISTRY = [
  // ── 新卒ATS（競合） ────────────────────────────────────────────────
  { id: 'kanrikun', name: '採用一括かんりくん', vendor: 'HRクラウド株式会社', kind: 'ats',
    hosts: ['career-cloud.asia'], htmlMarkers: ['採用一括かんりくん', 'career-cloud.asia'],
    aliases: ['管理くん', 'かんりくん', '管理君', '採用管理くん', '一括かんりくん', 'career-cloud'],
    note: '新卒中心。エントリーフォームは career-cloud.asia 配下' },
  { id: 'aol', name: 'アクセスオンライン（AOL/AOLC）', vendor: 'マイナビ', kind: 'ats',
    hosts: ['axol.jp'], htmlMarkers: ['axol.jp'],
    aliases: ['AOL', 'AOLC', 'アクセスオンライン', 'axol', 'アクセスオンラインキャリア'],
    note: 'マイナビ運営。job.axol.jp がマイページ、mail.axol.jp が送信元' },
  { id: 'hrmos', name: 'HRMOS採用（ハーモス）', vendor: 'ビズリーチ', kind: 'ats',
    hosts: ['hrmos.co'], htmlMarkers: ['hrmos.co'],
    aliases: ['HRMOS', 'HARMOS', 'ハーモス', 'HRMOS採用', 'ハーモス採用'],
    note: '求人一覧は hrmos.co/pages/{企業ID}/jobs' },
  { id: 'iweb', name: 'i-web', vendor: 'ヒューマネージ', kind: 'ats',
    hosts: ['i-web.jp'], htmlMarkers: ['i-web.jp'],
    aliases: ['i-web', 'iweb', 'アイウェブ', 'i-web NEXT'],
    note: '大手・大量応募向け。大企業比率が高い' },
  { id: 'sonar', name: 'sonar ATS', vendor: 'Thinkings（ソフトバンクG）', kind: 'ats',
    hosts: ['sonar-ats.jp'], htmlMarkers: ['sonar-ats.jp', 'sonar ATS'],
    aliases: ['sonar', 'sonarATS', 'sonar ATS', 'SONAR', 'ソナー'],
    note: '新卒・中途一元。導入社数が多い主要競合' },
  { id: 'jobsuite', name: 'JobSuite（FRESHERS/CAREER）', vendor: '株式会社ステラス', kind: 'ats',
    hosts: ['jobsuite.jp'], htmlMarkers: ['jobsuite.jp', 'JobSuite'],
    aliases: ['JobSuite', 'ジョブスイート', 'JobSuite FRESHERS', 'ジョブスイートフレッシャーズ'], note: '' },
  { id: 'jobcan', name: 'ジョブカン採用管理', vendor: '株式会社DONUTS', kind: 'ats',
    hosts: ['jobcan.jp', 'jobcan.ne.jp'], htmlMarkers: ['ats.jobcan.jp'],
    aliases: ['ジョブカン', 'jobcan', 'ジョブカン採用管理'],
    note: '中小・アルバイト併用が多い。エントリーは ats.jobcan.jp' },
  { id: 'herp', name: 'HERP Hire', vendor: '株式会社HERP', kind: 'ats',
    hosts: ['herp.careers', 'herp.cloud'], htmlMarkers: ['herp.careers'],
    aliases: ['HERP', 'ハープ', 'HERP Hire'], note: '中途・IT寄り' },
  { id: 'talentio', name: 'Talentio', vendor: '株式会社タレンティオ', kind: 'ats',
    hosts: ['talentio.com'], htmlMarkers: ['talentio.com'], aliases: ['Talentio', 'タレンティオ'], note: '' },
  { id: 'saiyo-kakaricho', name: '採用係長', vendor: '株式会社ネットオン', kind: 'ats',
    hosts: ['saiyo-kakaricho.com'], htmlMarkers: ['採用係長'], aliases: ['採用係長'], note: '中小・Indeed連携が主用途' },
  { id: 'engage', name: 'engage（エンゲージ）', vendor: 'エン・ジャパン', kind: 'ats',
    hosts: ['en-gage.net'], htmlMarkers: ['en-gage.net'], aliases: ['engage', 'エンゲージ', 'エン・ジャパンengage'],
    note: '無料ATS。ATS未導入層に近い' },
  { id: 'mochica', name: 'MOCHICA', vendor: '株式会社ネオキャリア', kind: 'ats', own: true,
    hosts: ['mochica.jp'], htmlMarkers: ['MOCHICA'], aliases: ['MOCHICA', 'モチカ', 'もちか'],
    note: '自社サービス＝既存顧客。リストから除外する' },

  // ── ドメインが未確認のATS（CRMの「利用中ATS」表記からの名寄せに使う） ──
  { id: 'caritas-contact', name: 'キャリタスContact', vendor: '株式会社ディスコ', kind: 'ats',
    hosts: [], htmlMarkers: ['キャリタスContact'],
    aliases: ['キャリタスContact', 'キャリタスコンタクト', 'キャリタスcontact', 'キャリタス'],
    note: 'キャリタス就活（媒体）と対のエントリー管理' },
  { id: 'line-saiyo-connect', name: 'LINE採用コネクト', vendor: 'LINEヤフー', kind: 'ats',
    hosts: [], htmlMarkers: ['LINE採用コネクト'], aliases: ['LINE採用コネクト', 'ラインさいようこねくと'],
    note: 'LINE連携＝MOCHICAと訴求が正面衝突する競合' },

  // ── 外資ATS（日本法人・グローバル企業で稀に出る） ──────────────────
  { id: 'greenhouse', name: 'Greenhouse', vendor: 'Greenhouse Software', kind: 'ats',
    hosts: ['greenhouse.io'], htmlMarkers: ['boards.greenhouse.io'], note: '外資' },
  { id: 'lever', name: 'Lever', vendor: 'Lever', kind: 'ats',
    hosts: ['lever.co'], htmlMarkers: ['jobs.lever.co'], note: '外資' },
  { id: 'workday', name: 'Workday', vendor: 'Workday', kind: 'ats',
    hosts: ['myworkdayjobs.com', 'workday.com'], htmlMarkers: ['myworkdayjobs.com'], note: '外資・大手' },
  { id: 'smartrecruiters', name: 'SmartRecruiters', vendor: 'SmartRecruiters', kind: 'ats',
    hosts: ['smartrecruiters.com'], htmlMarkers: ['smartrecruiters.com'], note: '外資' },
  { id: 'workable', name: 'Workable', vendor: 'Workable', kind: 'ats',
    hosts: ['workable.com'], htmlMarkers: ['apply.workable.com'], note: '外資' },
  { id: 'successfactors', name: 'SAP SuccessFactors', vendor: 'SAP', kind: 'ats',
    hosts: ['successfactors.com', 'jobs.sap.com'], htmlMarkers: ['successfactors'], note: '外資・大手' },
  { id: 'taleo', name: 'Oracle Taleo', vendor: 'Oracle', kind: 'ats',
    hosts: ['taleo.net'], htmlMarkers: ['taleo.net'], note: '外資・大手' },

  // ── ナビ媒体（ATSではない。媒体だけ＝自社ATS未導入の可能性） ────────
  { id: 'rikunabi', name: 'リクナビ', vendor: 'リクルート', kind: 'media',
    hosts: ['rikunabi.com'], htmlMarkers: ['job.rikunabi.com'], aliases: ['リクナビ', 'rikunabi'], note: '媒体エントリー' },
  { id: 'mynavi', name: 'マイナビ', vendor: 'マイナビ', kind: 'media',
    hosts: ['mynavi.jp'], htmlMarkers: ['job.mynavi.jp'], aliases: ['マイナビ', 'mynavi'],
    note: '媒体エントリー（ATSはAOLが別）' },
  { id: 'career-tasu', name: 'キャリタス就活', vendor: '株式会社ディスコ', kind: 'media',
    hosts: ['career-tasu.jp'], htmlMarkers: ['career-tasu.jp'], aliases: ['キャリタス就活'], note: '媒体エントリー' },
  { id: 'gakujo', name: 'あさがくナビ', vendor: '株式会社学情', kind: 'media',
    hosts: ['gakujo.ne.jp'], htmlMarkers: ['gakujo.ne.jp'],
    aliases: ['あさがくナビ', 'あさがくナビコミュニケーター', '学情', 'Re就活'], note: '媒体エントリー' },
  { id: 'onecareer', name: 'ONE CAREER', vendor: '株式会社ワンキャリア', kind: 'media',
    hosts: ['onecareer.jp'], htmlMarkers: ['onecareer.jp'], note: '媒体エントリー' },
  { id: 'indeed', name: 'Indeed', vendor: 'Indeed', kind: 'media',
    hosts: ['indeed.com'], htmlMarkers: ['jp.indeed.com'], note: '求人検索' },
  { id: 'offerbox', name: 'OfferBox', vendor: '株式会社i-plug', kind: 'sns',
    hosts: ['offerbox.jp'], htmlMarkers: ['offerbox.jp'], note: '逆求人' },
  { id: 'kimisuka', name: 'キミスカ', vendor: '株式会社グローアップ', kind: 'sns',
    hosts: ['kimisuka.com'], htmlMarkers: ['kimisuka.com'], note: '逆求人' },
  { id: 'wantedly', name: 'Wantedly', vendor: 'ウォンテッドリー', kind: 'sns',
    hosts: ['wantedly.com'], htmlMarkers: ['wantedly.com'], note: '中途・ベンチャー寄り' },

  // ── 汎用フォーム（ATS未導入シグナル＝MOCHICA新規導入の最有力） ──────
  { id: 'google-forms', name: 'Googleフォーム', vendor: 'Google', kind: 'form',
    hosts: ['forms.gle'], pathHosts: [{ host: 'docs.google.com', path: '^/forms/' }],
    htmlMarkers: ['docs.google.com/forms', 'forms.gle'], note: 'ATS未導入の可能性が高い' },
  { id: 'formrun', name: 'formrun', vendor: '株式会社ベーシック', kind: 'form',
    hosts: ['form.run'], htmlMarkers: ['form.run'], note: 'ATS未導入の可能性が高い' },
  { id: 'formzu', name: 'フォームズ', vendor: 'フォームズ株式会社', kind: 'form',
    hosts: ['formzu.net', 'formzu.com'], htmlMarkers: ['formzu.net'], note: 'ATS未導入の可能性が高い' },
  { id: 'form-mailer', name: 'フォームメーラー', vendor: '株式会社フュージョン', kind: 'form',
    hosts: ['form-mailer.jp'], htmlMarkers: ['form-mailer.jp'], note: 'ATS未導入の可能性が高い' },
  { id: 'hubspot-forms', name: 'HubSpotフォーム', vendor: 'HubSpot', kind: 'form',
    hosts: ['hsforms.com', 'hsforms.net'], htmlMarkers: ['js.hsforms.net'], note: '' },
  { id: 'tayori', name: 'Tayori', vendor: 'PR TIMES', kind: 'form',
    hosts: ['tayori.com'], htmlMarkers: ['tayori.com'], note: '' },
  { id: 'wpcf7', name: 'Contact Form 7（自作フォーム）', vendor: 'WordPressプラグイン', kind: 'form',
    hosts: [], htmlMarkers: ['wpcf7', 'contact-form-7'], note: '自社サイト内の自作フォーム＝ATS未導入' },
];

// ---- URL/ホストの下ごしらえ ---------------------------------------------
/** 文字列をURLへ。`career-cloud.asia/27/form` のようなスキーム無しも救う。失敗時 null。 */
function toUrl(url) {
  const s = String(url || '').trim();
  if (!s) return null;
  try { return new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { return null; }
}

/** URL文字列 → ホスト名（www除去・小文字）。失敗時は空文字。 */
function hostOfUrl(url) {
  const u = toUrl(url);
  return u ? u.hostname.replace(/^www\./i, '').toLowerCase() : '';
}

/**
 * 登録ドメイン一致（サブドメイン可・部分文字列は不可）。
 * `career-cloud.asia.evil.com` を誤検知しないよう `.` 境界を必須にする。
 */
function hostMatches(host, registrable) {
  if (!host || !registrable) return false;
  const h = String(host).toLowerCase(), r = String(registrable).toLowerCase();
  return h === r || h.endsWith('.' + r);
}

// ---- 1) URLだけで判定（ネットワーク不要） ------------------------------
/**
 * @param {string} url エントリーページURL
 * @returns {object|null} ヒット1件（{ id, name, vendor, kind, confidence, evidence, source }）
 */
function detectAtsByUrl(url) {
  const u = toUrl(url);
  if (!u) return null;
  const host = u.hostname.replace(/^www\./i, '').toLowerCase();
  for (const v of registry()) {
    for (const h of v.hosts || []) {
      if (hostMatches(host, h)) return hit(v, 0.95, `URLホスト ${host}`, 'url');
    }
    // ホストだけでは決まらないもの（docs.google.com/forms/… 等）
    for (const p of v.pathHosts || []) {
      if (hostMatches(host, p.host) && new RegExp(p.path).test(u.pathname)) {
        return hit(v, 0.95, `URL ${host}${u.pathname}`, 'url');
      }
    }
  }
  return null;
}

// ---- 2) HTMLから判定（自社ドメインに埋め込むケース） --------------------
// src / href / action / data-src の絶対URLを拾う（iframe・script・formいずれも同じ属性名）
const RESOURCE_ATTR_RE = /\b(?:src|href|action|data-src)\s*=\s*["']([^"']+)["']/gi;

/**
 * ページHTMLから外部埋め込みとマーカー文字列を見て判定する。
 * 自社サイトにATSのフォームをiframe/scriptで埋め込む構成はURL判定に出ないため、この経路が要。
 * @param {string} html
 * @param {string} [baseUrl] 自ホスト判定用（自分自身への参照はノイズなので捨てる）
 * @returns {object[]} 確度降順の候補（同一ベンダーは1件に畳む）
 */
function detectAtsByHtml(html, baseUrl) {
  const s = String(html || '');
  if (!s) return [];
  const selfHost = hostOfUrl(baseUrl);
  const found = new Map();   // id -> 候補
  const add = (v, conf, ev, src) => {
    const cur = found.get(v.id);
    if (!cur || cur.confidence < conf) found.set(v.id, hit(v, conf, ev, src));
  };

  // 2-a) 埋め込みリソースのホスト（マーカーより確実）
  const hosts = new Set();
  let m;
  RESOURCE_ATTR_RE.lastIndex = 0;
  while ((m = RESOURCE_ATTR_RE.exec(s))) {
    const raw = m[1];
    if (!/^(https?:)?\/\//i.test(raw)) continue;      // 相対・data:・mailto: は対象外
    const h = hostOfUrl(raw.startsWith('//') ? 'https:' + raw : raw);
    if (h && h !== selfHost) hosts.add(h);
  }
  for (const v of registry()) {
    for (const h of hosts) {
      if ((v.hosts || []).some((reg) => hostMatches(h, reg))) add(v, 0.85, `埋め込みリソース ${h}`, 'embed');
      else if ((v.pathHosts || []).some((p) => hostMatches(h, p.host))) add(v, 0.75, `埋め込みリソース ${h}`, 'embed');
    }
  }

  // 2-b) 本文マーカー（クラス名・コピーライト等。確度は一段低い）
  const lower = s.toLowerCase();
  for (const v of registry()) {
    if (found.has(v.id)) continue;
    for (const mk of v.htmlMarkers || []) {
      if (lower.includes(String(mk).toLowerCase())) { add(v, 0.6, `HTML内マーカー "${mk}"`, 'marker'); break; }
    }
  }
  return [...found.values()].sort((a, b) => b.confidence - a.confidence);
}

// ---- 3) 統合 ------------------------------------------------------------
const EMPTY = { found: false, id: '', name: '', vendor: '', kind: '', kindLabel: '', own: false,
  note: '', confidence: 0, evidence: '', source: '', others: [] };

/**
 * URL（＋あればHTML・リダイレクト後URL）からATSを1つに決める。
 * @param {string} url エントリーページURL
 * @param {{html?:string, finalUrl?:string}} [opts]
 * @returns {object} EMPTY と同形。others に次点候補（媒体併用などが読める）
 */
function detectAts(url, opts = {}) {
  const cands = [];
  const byUrl = detectAtsByUrl(url);
  if (byUrl) cands.push(byUrl);
  // リダイレクト後URL（自社ドメイン → ATS のパターン）。元URL一致より僅かに下げる
  if (opts.finalUrl && hostOfUrl(opts.finalUrl) !== hostOfUrl(url)) {
    const byFinal = detectAtsByUrl(opts.finalUrl);
    if (byFinal) cands.push({ ...byFinal, confidence: 0.9, source: 'redirect', evidence: `リダイレクト先 ${hostOfUrl(opts.finalUrl)}` });
  }
  if (opts.html) cands.push(...detectAtsByHtml(opts.html, opts.finalUrl || url));

  // 同一IDを畳んでランク付け
  const best = new Map();
  for (const c of cands) {
    const cur = best.get(c.id);
    if (!cur || cur.confidence < c.confidence) best.set(c.id, c);
  }
  const ranked = [...best.values()].sort((a, b) =>
    (kindRank(b.kind) - kindRank(a.kind)) || (b.confidence - a.confidence));
  if (!ranked.length) return { ...EMPTY };
  return { found: true, ...ranked[0], others: ranked.slice(1) };
}

// ATS > フォーム > 媒体 > SNS。媒体タグが同居していても、入っているATSを主判定にする。
function kindRank(kind) { return ({ ats: 3, form: 2, media: 1, sns: 0 })[kind] || 0; }

function hit(v, confidence, evidence, source) {
  return { id: v.id, name: v.name, vendor: v.vendor, kind: v.kind, kindLabel: KIND_LABEL[v.kind] || v.kind,
    own: !!v.own, note: v.note || '', confidence, evidence, source };
}

// ---- CRMの手入力表記 → 正規ベンダー ------------------------------------
// BALESの「カスタム情報：利用中ATS」は自由入力で、同じ製品が
// 「sonarATS / SONAR」「採用一括かんりくん / 管理くん」と割れている。ツール別リストを作るには名寄せが要る。
const NONE_RE = /^(無し|なし|無|未導入|導入なし|使っていない|特になし|none)$/i;

/** 比較キー: 全角→半角・小文字化・記号/空白除去（`i-web` と `iweb` を同一視）。 */
function atsKey(s) {
  return String(s || '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .toLowerCase()
    .replace(/[\s　・･\-ー―‐_.、,/／()（）]/g, '');
}

/**
 * CRMの利用中ATS表記を正規化する。
 * @param {string} raw 「sonarATS」「管理くん」「無し」など
 * @returns {{status:'empty'|'none'|'known'|'unknown', id:string, name:string, vendor:string, kind:string, own:boolean, raw:string}}
 *   known   : 定義に当たった（name は正規名）
 *   unknown : 定義に無い製品名（name は原文のまま。勝手にベンダーを推測しない）
 *   none    : 「無し」＝ATS未導入と記録されている
 */
function normalizeAtsName(raw) {
  const s = String(raw || '').trim();
  const base = { id: '', name: '', vendor: '', kind: '', own: false, raw: s };
  if (!s) return { ...base, status: 'empty' };
  if (NONE_RE.test(s)) return { ...base, status: 'none', id: 'none', name: '無し（ATS未導入）' };
  const k = atsKey(s);
  for (const v of registry()) {
    const names = [v.id, v.name, ...(v.aliases || [])];
    if (names.some((n) => atsKey(n) === k)) {
      return { status: 'known', id: v.id, name: v.name, vendor: v.vendor, kind: v.kind, own: !!v.own, raw: s };
    }
  }
  return { ...base, status: 'unknown', id: 'other:' + k, name: s };
}

/** 営業向けの一言（リストのメモ列に入れる想定）。 */
function salesHint(det) {
  if (!det || !det.found) return '判定不能（要目視）';
  if (det.own) return '既存顧客（MOCHICA導入済み）';
  if (det.kind === 'ats') return `競合ATS導入済み（${det.vendor}）＝リプレイス提案`;
  if (det.kind === 'form') return 'ATS未導入の可能性大＝新規導入提案';
  if (det.kind === 'media') return '媒体エントリーのみ＝ATS未導入の可能性';
  return 'スカウト媒体のみ＝ATS未導入の可能性';
}

// ---- 任意の追加定義（data/ats-registry.json） ---------------------------
// 新ベンダーはコードを触らずここに足せる。形式は REGISTRY の1要素と同じ。
let _cache = null;
function registry() {
  if (_cache) return _cache;
  _cache = REGISTRY.slice();
  try {
    const fs = require('fs'), path = require('path');
    const p = path.resolve(__dirname, '..', 'data', 'ats-registry.json');
    const extra = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const e of Array.isArray(extra) ? extra : []) {
      if (!e || !e.id || !e.name) continue;
      const i = _cache.findIndex((v) => v.id === e.id);
      if (i >= 0) _cache[i] = { ..._cache[i], ...e };      // 既存定義の上書き（hosts追加など）
      else _cache.push({ kind: 'ats', hosts: [], htmlMarkers: [], ...e });
    }
  } catch (_) { /* 無ければ組込み定義のみ */ }
  return _cache;
}
/** テスト用: 追加定義キャッシュを捨てる。 */
function resetRegistry() { _cache = null; }

module.exports = {
  detectAts, detectAtsByUrl, detectAtsByHtml, salesHint, normalizeAtsName, atsKey,
  hostMatches, hostOfUrl, toUrl, registry, resetRegistry, KIND_LABEL, REGISTRY,
};
