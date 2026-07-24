'use strict';
// L4 拡張: 企業サイトから「公開されている実在メールアドレス」を収集する。
//  email.js（MX＋役割アドレス推測）を土台に、実際にサイト本文/ mailto: に載っている
//  メールを優先的に採取する。外部AI APIは使わない（DNS/取得/正規表現のみ）。
//
// パイプライン:
//   企業名 → 公式URL発見(search.discoverUrl) → トップ＋問い合わせ/採用/会社概要ページを
//   少数だけクロール → mailto: と本文正規表現でメール抽出 → 種別分類＋確度付け →
//   実在メールが無ければ email.enrichEmail（MX＋役割アドレス推測）へフォールバック。
//
// 取得は全て polite.js 経由（robots遵守＋ホスト別レート制限＋ディスクキャッシュ）。
const cheerio = require('cheerio');
const cfg = require('./config');
const { politeGet } = require('./polite');
const { extractText, discoverPages, guessContactPaths, registrableDomain } = require('./fetch');
const { discoverUrl } = require('./search');
const { enrichEmail } = require('./email');
const { normalizeDomain } = require('./score');

// メール抽出の基本パターン（press-contact.js と同系。役割/氏名は別途分類）
const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;

// プレースホルダ/テンプレ由来の「本物でない」ドメイン（テーマ初期値・埋め込みツール等）
const JUNK_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'example.co.jp', 'example.jp',
  'domain.com', 'yourdomain.com', 'your-domain.com', 'yourcompany.com',
  'sample.com', 'test.com', 'email.com', 'mail.example.com', 'company.com',
  'sentry.io', 'sentry.wixpress.com', 'wixpress.com', 'wix.com', 'godaddy.com',
  'w3.org', 'schema.org', 'sentry-next.wixpress.com',
]);

// メールでは無い（画像/アセット/スクリプト断片）の TLD。ローカル部@2x.png 等を弾く。
const ASSET_TLDS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'css', 'js', 'mjs',
  'json', 'xml', 'woff', 'woff2', 'ttf', 'eot', 'mp4', 'webm', 'pdf', 'map',
]);

// フリーメール（自社ドメインでない＝確度は下げるが、中小/個人事業では有効な連絡先）
const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.co.jp', 'yahoo.com', 'ybb.ne.jp',
  'outlook.com', 'outlook.jp', 'hotmail.com', 'hotmail.co.jp', 'live.jp', 'live.com',
  'icloud.com', 'me.com', 'aol.com', 'msn.com', 'gmx.com',
  'docomo.ne.jp', 'ezweb.ne.jp', 'au.com', 'softbank.ne.jp', 'i.softbank.jp', 'nifty.com',
]);

// 種別分類のためのローカル部キーワード（採用系を最優先で拾う）
const ROLE_MAP = [
  { type: 'recruit', label: '採用/人事', re: /(recruit|saiyo|saiyou|jinji|jinzai|career|shinsotsu|hr|jobs?|entry|採用|人事)/i },
  { type: 'contact', label: '問い合わせ/総合', re: /(info|contact|inquiry|otoiawase|toiawase|support|help|mail|office|desk|general|honsya|honsha|soumu|総務|問合)/i },
  { type: 'sales', label: '営業/取引', re: /(sales|eigyo|biz|business|marketing|pr|press|koho|広報|営業)/i },
];

// mailto: href からメール文字列だけを取り出す（?subject 等・複数宛先を除去）
function parseMailto(href) {
  const s = String(href || '').replace(/^mailto:/i, '').trim();
  if (!s) return [];
  return s.split('?')[0].split(',')
    .map((x) => decodeURIComponent(x.trim()).toLowerCase())
    .filter(Boolean);
}

// [at]/(at)/＠ 等のごく一般的な難読化のみ復元（過剰置換で誤検出しないよう保守的に）
function deobfuscate(text) {
  return String(text || '')
    .replace(/＠/g, '@')
    .replace(/\s*[\[（(【]\s*(?:at|アット)\s*[\]）)】]\s*/gi, '@')
    .replace(/\s*[\[（(【]\s*(?:dot|ドット)\s*[\]）)】]\s*/gi, '.');
}

// 1つのメール候補を検証（真偽）。プレースホルダ/アセット/壊れた文字列を弾く。
function isValidEmail(email) {
  const e = String(email || '').toLowerCase().trim();
  if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(e)) return false;
  const [local, domain] = e.split('@');
  if (!local || !domain) return false;
  if (local.length > 64 || e.length > 254) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false;
  if (JUNK_DOMAINS.has(domain)) return false;
  const tld = domain.split('.').pop();
  if (ASSET_TLDS.has(tld)) return false;
  // 明らかな断片（HTMLエンティティ/エンコード残り）
  if (/(^|[^a-z0-9])(u00[0-9a-f]{2}|x[0-9a-f]{2})/.test(e)) return false;
  if (/(sentry|react|webpack|polyfill)/.test(domain)) return false;
  return true;
}

// ローカル部から種別を推定
function classifyRole(email) {
  const local = String(email || '').split('@')[0] || '';
  for (const r of ROLE_MAP) if (r.re.test(local)) return r.type;
  return 'other';
}
function roleLabel(type) {
  const f = ROLE_MAP.find((r) => r.type === type);
  return f ? f.label : 'その他';
}

// 自社ドメインのメールか（サイトの登録可能ドメインと一致）
function isOwnDomain(email, siteDomain) {
  if (!siteDomain) return false;
  const emailDom = String(email || '').split('@')[1] || '';
  try {
    return registrableDomain(emailDom) === registrableDomain(siteDomain);
  } catch (_) { return false; }
}
function isFreemail(email) {
  return FREEMAIL_DOMAINS.has(String(email || '').split('@')[1] || '');
}

// 1ページ(html)から実在メールを抽出して records を返す。
//   { email, role, roleLabel, source:'mailto'|'text', confidence, ownDomain, freemail, foundOn }
function extractEmailsFromPage(html, pageUrl, siteDomain) {
  const found = new Map(); // email -> record（同ページ内は mailto を優先）
  if (!html) return [];
  const $ = cheerio.load(html);

  const add = (raw, source) => {
    const email = String(raw || '').toLowerCase().trim();
    if (!isValidEmail(email)) return;
    const ownDomain = isOwnDomain(email, siteDomain);
    const freemail = isFreemail(email);
    // 確度: mailto は本文抽出より高信頼。自社ドメインは加点、フリーメール/他社は減点。
    let confidence = source === 'mailto' ? 0.85 : 0.72;
    if (ownDomain) confidence += 0.07;
    else if (freemail) confidence -= 0.17;
    else confidence -= 0.1; // 他社ドメイン（代理店/CMS等の可能性）
    confidence = Math.max(0.3, Math.min(0.95, Math.round(confidence * 100) / 100));
    const role = classifyRole(email);
    const rec = { email, role, roleLabel: roleLabel(role), source, confidence, ownDomain, freemail, foundOn: pageUrl || '' };
    const prev = found.get(email);
    if (!prev || rec.confidence > prev.confidence) found.set(email, rec);
  };

  // 1) mailto: リンク（最も確実）
  $('a[href^="mailto:" i]').each((_, a) => {
    for (const e of parseMailto($(a).attr('href'))) add(e, 'mailto');
  });
  // 2) 可視テキスト（難読化を軽く復元してから正規表現）
  const text = deobfuscate(extractText(html));
  const m = text.match(EMAIL_RE) || [];
  for (const e of m) add(e, 'text');

  return [...found.values()];
}

// ページ取得の polite ラッパ（discoverUrl の deps.fetchPage 用にも使う）
async function fetchPagePolite(url, opt = {}) {
  const r = await politeGet(url, { render: opt.render || 'auto' });
  if (!r || r.blocked || r.error || !r.html) {
    const reason = r && (r.reason || r.error) || 'fetch-failed';
    const err = new Error(reason);
    err.blocked = !!(r && r.blocked);
    throw err;
  }
  return { html: r.html, finalUrl: r.finalUrl || url, fromCache: !!r.fromCache };
}

// 公式URLから、メールが載っていそうなページを少数クロールして [{url, html}] を返す。
async function crawlSite(officialUrl, opt = {}) {
  const maxPages = Math.max(1, opt.maxPages || 5);
  const pages = [];
  let url = String(officialUrl).trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  // 1) トップページ（フッターに info@ が載ることが多い）
  //    render: 'static' なら Playwright を使わず高速（大量処理向け）。既定は 'auto'（SPAはレンダリング）。
  const render = opt.render || 'auto';
  let top;
  try { top = await fetchPagePolite(url, { render }); } catch (e) { return { pages, error: e.blocked ? 'robots-disallow' : String(e.message || e) }; }
  pages.push({ url: top.finalUrl, html: top.html });

  const base = top.finalUrl || url;
  // 2) トップの<a>から問い合わせ/採用/会社概要ページを発見（ヒントスコア順）
  let candidates = discoverPages(base, top.html);
  // ヒントに乏しければ定番パスも足す
  if (candidates.length < 3) candidates = candidates.concat(guessContactPaths(base));
  // メール窓口に当たりやすい順（contact/inquiry/採用/会社概要）へ寄せる
  const PRIORITY = /(contact|inquiry|otoiawase|問い合わせ|問合|recruit|saiyo|採用|careers|company|about|会社概要|会社案内|profile)/i;
  candidates.sort((a, b) => (PRIORITY.test(b) ? 1 : 0) - (PRIORITY.test(a) ? 1 : 0));

  const seen = new Set([stripHash(base)]);
  for (const c of candidates) {
    if (pages.length >= maxPages) break;
    const key = stripHash(c);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      // 下層ページは既定で静的取得（速い）。opt.render='auto' 指定時のみレンダリングも許容。
      const p = await fetchPagePolite(c, { render: render === 'auto' ? 'auto' : 'static' });
      pages.push({ url: p.finalUrl, html: p.html });
    } catch (_) { /* 次の候補へ */ }
  }
  return { pages };
}
function stripHash(u) { try { const x = new URL(u); x.hash = ''; return x.toString(); } catch (_) { return String(u || ''); } }

// メール候補の並び替えスコア（採用系＞問い合わせ＞営業、実在＞推測、自社＞フリーメール）。
function priorityScore(rec) {
  const roleW = { recruit: 40, contact: 30, sales: 20, other: 10 }[rec.role] || 10;
  const realW = rec.source === 'guess' ? 0 : 8;
  const ownW = rec.ownDomain ? 3 : 0;
  return roleW + realW + ownW + (rec.confidence || 0);
}

/**
 * 企業名（または既知URL/ドメイン）から公開メールを収集する。
 * @param {string} companyName 企業名
 * @param {object} opt { url|websiteUrl, domain, addressHint, maxPages, guess:boolean,
 *                       render:'auto'|'static', verify:boolean }
 *   render='static': Playwright を使わず高速取得（大量処理向け・SPAは取りこぼす可能性）
 *   verify=false:    URL発見時にページ検証を省いて最有力候補を即採用（高速・精度は僅かに低下）
 * @returns {Promise<{company,url,domain,source,emails:Array,best:string,note:string}>}
 */
async function collectEmailsForCompany(companyName, opt = {}) {
  const out = { company: companyName || '', url: '', domain: '', source: '', emails: [], best: '', note: '' };

  // 1) 公式URLの確定（既知があれば発見をスキップ＝高速）
  let url = String(opt.url || opt.websiteUrl || '').trim();
  let domain = normalizeDomain(opt.domain || url || '');
  if (!url && domain) url = 'https://' + domain;
  if (!url) {
    try {
      // verify=false なら fetch deps を渡さず、検証フェッチを省いて最有力候補を即採用（大量処理向け）。
      const deps = opt.verify === false ? {} : { fetchPage: (u) => fetchPagePolite(u, { render: opt.render || 'auto' }), extractText };
      const d = await discoverUrl(companyName, deps, { addressHint: opt.addressHint });
      if (d && d.url) { url = d.url; out.source = d.source || 'search'; }
      else { out.note = (d && d.error) ? ('URL不明: ' + d.error) : '公式URL不明'; }
    } catch (e) { out.note = 'URL発見失敗: ' + String(e && e.message || e); }
  } else {
    out.source = 'provided';
  }
  if (!url) return out;
  if (!domain) domain = normalizeDomain(url);
  out.url = url; out.domain = domain;

  // 2) サイトを少数クロールして実在メールを抽出
  const { pages, error } = await crawlSite(url, { maxPages: opt.maxPages, render: opt.render });
  if (error && !pages.length) out.note = error;
  const collected = new Map();
  for (const pg of pages) {
    for (const rec of extractEmailsFromPage(pg.html, pg.url, domain)) {
      const prev = collected.get(rec.email);
      if (!prev || rec.confidence > prev.confidence) collected.set(rec.email, rec);
    }
  }
  let emails = [...collected.values()];

  // 3) 実在メールが無ければ役割アドレス推測（MX篩い）へフォールバック
  if (!emails.length && opt.guess !== false) {
    const siteHasContactEvidence = hasContactEvidence(pages);
    if (siteHasContactEvidence) {
      try {
        // 推測は登録可能ドメイン（例 corp.example.co.jp → example.co.jp）で行う。
        // メールはコーポレートサブドメインでなくルートに置かれることが多く、MXもそちらに載る。
        let guessDomain = domain;
        try { guessDomain = registrableDomain(domain) || domain; } catch (_) {}
        const g = await enrichEmail({ domain: guessDomain, websiteUrl: url }, cfg);
        if (g && g.email) {
          const role = classifyRole(g.email);
          emails.push({
            email: g.email, role, roleLabel: roleLabel(role), source: 'guess',
            confidence: g.score || 0.4, ownDomain: true, freemail: false, foundOn: '(MX推測)', mx: g.mx || '',
          });
          out.note = out.note || '実在メール未検出（役割アドレスを推測）';
        } else {
          out.note = out.note || (g && g.note) || 'メール検出なし';
        }
      } catch (e) { out.note = out.note || 'メール推測失敗: ' + String(e && e.message || e); }
    } else {
      out.note = out.note || 'メール検出なし（問い合わせページ/メール証拠なしのため推測を抑制）';
    }
  } else if (!emails.length) {
    out.note = out.note || 'メール検出なし';
  }

  emails.sort((a, b) => priorityScore(b) - priorityScore(a));

  function hasContactEvidence(pages) {
    if (!pages || !pages.length) return false;
    const pathHintRe = /\/(?:contact|inquiry|otoiawase|contact-us|contactus|support|help|recruit|careers|career|saiyo|採用|company|about|profile|会社概要|会社案内|お問い合わせ|問合)\b/i;
    const linkHintRe = /(?:mailto:|contact(?:[-_ ]?us)?|inquiry|otoiawase|お問い合わせ|問合|support|help|recruit|career|careers|saiyo|採用|会社概要|会社案内|profile)/i;
    return pages.some((pg) => {
      const html = String(pg.html || '');
      const url = String(pg.url || '');
      if (/mailto:/i.test(html)) return true;
      if (pathHintRe.test(url)) return true;
      if (linkHintRe.test(html) && /<a\s[^>]*href=/i.test(html)) return true;
      return false;
    });
  }
  out.emails = emails;
  out.best = emails.length ? emails[0].email : '';
  return out;
}

/**
 * 複数企業を並列に収集する（企業ごとに別ホスト＝polite.js のホスト別レート制限は保ったまま
 * 企業をまたいだ並列度でスループットを出す設計）。5000件規模の一括処理の中核。
 * @param {Array<{company?:string,name?:string,url?:string}>} items 企業一覧
 * @param {object} opt { concurrency, maxPages, guess, render, verify, onResult, isAborted }
 *   onResult(index, item, result, done) を各社完了時に呼ぶ（逐次進捗表示用）
 *   isAborted() が true を返すと以降の投入を停止する（UIのクライアント切断対応）
 * @returns {Promise<Array>} 各社の収集結果（items と同じ順序。中断分は undefined）
 */
async function harvestMany(items, opt = {}) {
  const list = Array.isArray(items) ? items : [];
  const concurrency = Math.max(1, Math.min(128, parseInt(opt.concurrency, 10) || 8));
  const results = new Array(list.length);
  const perOpt = { maxPages: opt.maxPages, guess: opt.guess, render: opt.render, verify: opt.verify };
  let idx = 0, done = 0;
  async function worker() {
    while (true) {
      if (opt.isAborted && opt.isAborted()) return;
      const my = idx++;
      if (my >= list.length) return;
      const it = list[my] || {};
      const name = String(it.company || it.name || '').trim();
      let res;
      try {
        res = await collectEmailsForCompany(name, Object.assign({}, perOpt, { url: it.url || it.websiteUrl || '' }));
      } catch (e) {
        res = { company: name, url: it.url || '', domain: '', source: '', emails: [], best: '', note: 'ERROR: ' + String(e && e.message || e) };
      }
      results[my] = res;
      done++;
      if (opt.onResult) { try { opt.onResult(my, it, res, done); } catch (_) {} }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

/**
 * スループット概算（事前見積り／UIの推定時間表示用）。ネットワーク不要の純計算。
 * @param {object} p { count, concurrency, maxPages, delayMs, discovery:boolean, static:boolean }
 * @returns {{perCompanySec:number, totalSec:number, perMin:number}}
 */
function estimateThroughput(p = {}) {
  const count = Math.max(0, parseInt(p.count, 10) || 0);
  const concurrency = Math.max(1, parseInt(p.concurrency, 10) || 8);
  const maxPages = Math.max(1, parseInt(p.maxPages, 10) || 3);
  const delaySec = Math.max(0, (parseInt(p.delayMs, 10) || 1200) / 1000);
  const avgFetch = p.static === false ? 3.2 : 1.6;         // レンダリング有無で1ページの実測時間が変わる
  const gaps = (maxPages - 1) * delaySec;                   // 自社内ページ間のホスト間隔
  const discovery = p.discovery ? 2.5 : 0;                  // 検索発見の追加コスト（verify省略時の概算）
  const perCompanySec = maxPages * avgFetch + gaps + discovery + 0.3; // +robots初回
  const totalSec = count * perCompanySec / concurrency;
  const perMin = 60 * concurrency / perCompanySec;
  return { perCompanySec: Math.round(perCompanySec * 10) / 10, totalSec: Math.round(totalSec), perMin: Math.round(perMin) };
}

module.exports = {
  collectEmailsForCompany, harvestMany, estimateThroughput, crawlSite, extractEmailsFromPage,
  isValidEmail, classifyRole, roleLabel, isOwnDomain, isFreemail,
  parseMailto, deobfuscate, priorityScore, fetchPagePolite,
};
