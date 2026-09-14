'use strict';
/**
 * site-signal — 企業の一次情報（公式サイト／採用ページ）からインテントを取る
 * =====================================================================
 * なぜこれが要るか（PR TIMES 主軸の限界）:
 *   PR TIMES はリリースを出す企業しか載らない。実測すると母集団はスタートアップと
 *   IT に強く偏り、こちらの ICP（非IT × 従業員300-500名 × 新卒6名以上）とほとんど
 *   重ならない。実際 releases.jsonl の首位は合同会社のピラティススタジオだった。
 *   ＝「収集ソースが ICP と合っていない」ことが、シグナル基盤の最大の穴。
 *
 *   一方、こちらは既に 28,000社規模の企業台帳（leads-consolidated-all.csv 等）を
 *   持っている。**その企業の公式サイト／採用ページを自分で定期巡回すれば**、
 *   ICP に合った企業だけを母集団にしたインテント収集ができる。第三者Intentを買う
 *   前に、自前の観測を一次情報から作るという順序（1st-party を基準値にする）。
 *
 * ここが提供するもの:
 *   crawlCompany(target)  … 1社ぶんの巡回（トップ→採用/ニュースの導線を辿る）
 *     → { signals, fp, facts, pages, error }
 *        signals … detectSignals が拾ったテキストシグナル（根拠URL付き）
 *        fp      … ページ指紋 {recruit, news}（本文は保存せずハッシュだけ持つ）
 *                  次回巡回との比較で「採用ページ更新」差分シグナルを作る
 *        facts   … ページから拾えた 電話番号 / 採用担当者名 / 採用人数
 *
 * 巡回の作法:
 *   ・全取得は polite 経由（robots.txt 遵守・ホスト別レート制限・キャッシュ）
 *   ・1社あたり最大 maxPages（既定4）ページまで。サイト全体は舐めない
 *   ・キャッシュTTLは短め（既定12時間）。差分を見るのが目的なので古い本文は無意味
 */
const crypto = require('crypto');
const cheerio = require('cheerio');
const { politeGet } = require('./polite');
const { detectSignals, daysAgo } = require('./hot-signal');
const { extractPressContact } = require('./press-contact');

// 採用/ニュース導線のアンカー語。日本企業サイトはこの語彙でほぼ網羅できる。
const RECRUIT_WORDS = /(採用|リクルート|recruit|新卒|キャリア|careers?|entry|募集)/i;
const NEWS_WORDS = /(ニュース|news|お知らせ|新着|トピックス|topics|press|プレスリリース|information)/i;
// 追ってはいけない導線（外部SNS・PDF・問い合わせフォーム・巨大ファイル）
const SKIP_HREF = /(\.pdf|\.zip|\.jpe?g|\.png|\.docx?|\.xlsx?|mailto:|tel:|javascript:|#|facebook\.com|twitter\.com|x\.com|instagram\.com|youtube\.com|linkedin\.com|line\.me)/i;

/**
 * 企業サイト本文 → **日付のついた出来事**だけを切り出す。
 *
 * ここが企業サイト収集の肝。プレスリリースは全文が1つの出来事だが、
 * 企業サイトの本文はほとんどが「恒常的な説明文」で、出来事ではない。
 * detectSignals をページ全文にそのまま当てると、実測で次のように総崩れになった:
 *   「1984年12月 第二工場竣工」（沿革表）        → 新工場OPEN
 *   「東京・宮城・栃木にも拠点を展開しています」  → 新拠点開設
 *   「【新入社員研修】入社式後、約2か月間の…」    → 通常採用活動
 * どれも40年前の話や制度の説明であって、今の採用ニーズではない。
 *
 * そこで「新着情報／お知らせの1件」＝日付から次の日付までを1つの出来事として切り出し、
 * **その単位でだけ**シグナルを判定する。副産物として各シグナルに正しい発生日が付くので、
 * 鮮度係数（RECENCY）がそのまま効くようになる。沿革表の古い年は鮮度で自然に落ちる。
 *
 * @param {string} text ページ本文
 * @param {{maxItems?:number, itemChars?:number}} opt
 * @returns {Array<{date:string, text:string}>} 新しい順ではなく出現順
 */
const DATE_RE = /(20\d{2})\s*[年./\-]\s*(\d{1,2})\s*[月./\-]\s*(\d{1,2})\s*日?/g;

function extractDatedItems(text, opt = {}) {
  const maxItems = opt.maxItems == null ? 60 : opt.maxItems;
  const itemChars = opt.itemChars == null ? 180 : opt.itemChars;
  const t = String(text || '').replace(/\s+/g, ' ');
  const hits = [];
  let m;
  DATE_RE.lastIndex = 0;
  while ((m = DATE_RE.exec(t)) !== null && hits.length < maxItems * 3) {
    const mo = parseInt(m[2], 10);
    const day = parseInt(m[3], 10);
    if (!(mo >= 1 && mo <= 12 && day >= 1 && day <= 31)) continue;      // 「2026.1.35」のような誤一致を弾く
    hits.push({ at: m.index, end: m.index + m[0].length, date: `${m[1]}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}` });
  }
  const out = [];
  for (let i = 0; i < hits.length && out.length < maxItems; i++) {
    const h = hits[i];
    // 次の日付が来るまで、ただし最大 itemChars。沿革表は日付が密に並ぶので1件が短く切れる＝正しい
    const stop = Math.min(h.end + itemChars, i + 1 < hits.length ? hits[i + 1].at : t.length);
    const body = t.slice(h.end, stop).trim();
    if (body.length < 6) continue;
    out.push({ date: h.date, text: body });
  }
  return out;
}

/** 本文テキストの指紋。日付や閲覧数のような毎回変わる数値は落としてから取る。 */
function fingerprint(text) {
  const t = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/20\d{2}[年/.-]\s?\d{1,2}[月/.-]\s?\d{1,2}日?/g, '')   // 掲載日
    .replace(/\d{1,2}:\d{2}(:\d{2})?/g, '')                        // 時刻
    .trim();
  if (!t) return '';
  return crypto.createHash('sha1').update(t).digest('hex').slice(0, 16);
}

/** HTML → 判定に回す本文テキスト（script/style/nav を落とす）。 */
function pageText($) {
  $('script, style, noscript, nav, header, footer, iframe').remove();
  return ($('main').first().text() || $('body').text() || '').replace(/[ \t　]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** 絶対URL化（相対パス・プロトコル相対を吸収）。失敗したら空文字。 */
function absUrl(href, base) {
  try {
    const u = new URL(String(href).trim(), base);
    if (!/^https?:$/.test(u.protocol)) return '';
    u.hash = '';
    return u.toString();
  } catch (_) { return ''; }
}

/**
 * トップページから採用ページ・ニュースページの導線を1本ずつ選ぶ。
 * 同一ホストに限る（グループ会社サイトへ飛ぶと社名と観測がずれる）。
 * @returns {{recruit:string, news:string}}
 */
function pickSectionLinks($, baseUrl) {
  let host = '';
  try { host = new URL(baseUrl).hostname; } catch (_) { /* baseUrl が壊れていれば同一ホスト判定は諦める */ }
  const out = { recruit: '', news: '' };
  $('a[href]').each((_i, el) => {
    if (out.recruit && out.news) return false;
    const href = $(el).attr('href') || '';
    if (!href || SKIP_HREF.test(href)) return;
    const abs = absUrl(href, baseUrl);
    if (!abs) return;
    if (host) { try { if (new URL(abs).hostname !== host) return; } catch (_) { return; } }
    if (abs === baseUrl) return;
    const hay = ($(el).text() || '') + ' ' + href;
    if (!out.recruit && RECRUIT_WORDS.test(hay)) out.recruit = abs;
    else if (!out.news && NEWS_WORDS.test(hay)) out.news = abs;
  });
  return out;
}

/**
 * 1社ぶん巡回してシグナルと指紋を返す。
 *
 * @param {{name:string, url:string, recruitUrl?:string, industry?:string, pref?:string}} target
 * @param {{maxPages?:number, cacheTtlMs?:number, asOf?:string}} opt
 * @returns {Promise<{name:string, signals:Array, fp:object, facts:object, pages:string[], rejected:string, error:string}>}
 */
async function crawlCompany(target, opt = {}) {
  const maxPages = opt.maxPages == null ? 4 : opt.maxPages;
  const ttl = opt.cacheTtlMs == null ? 12 * 3600 * 1000 : opt.cacheTtlMs;
  const out = { name: target.name, signals: [], fp: {}, facts: {}, pages: [], rejected: '', error: '' };

  const get = async (u) => {
    const r = await politeGet(u, { render: 'static', maxAgeMs: ttl }).catch((e) => ({ error: String(e && e.message || e) }));
    if (!r || r.error) { out.error = out.error || (r && r.error) || 'fetch-failed'; return null; }
    if (r.blocked) { out.rejected = 'robots-disallow'; return null; }
    if (!r.html) return null;
    return r;
  };

  // ── 1) 巡回するページを決める ────────────────────────────
  // 採用ページURLが台帳にあれば、それを最優先で見る（導線探索が1ホップ減る）。
  const queue = [];
  const seen = new Set();
  const push = (u, kind) => { if (u && !seen.has(u)) { seen.add(u); queue.push({ url: u, kind }); } };
  push(target.recruitUrl, 'recruit');
  push(target.url, 'top');

  const texts = [];
  let discovered = false;
  while (queue.length && out.pages.length < maxPages) {
    const { url, kind } = queue.shift();
    const r = await get(url);
    if (!r) continue;
    const $ = cheerio.load(r.html);
    const text = pageText($);
    out.pages.push(url);
    texts.push({ url, kind, title: ($('title').text() || '').trim(), text });

    // トップページからだけ導線を1回展開する（サイト全体のクロールはしない）
    if (kind === 'top' && !discovered) {
      discovered = true;
      const links = pickSectionLinks($, url);
      push(links.recruit, 'recruit');
      push(links.news, 'news');
    }
  }
  if (!texts.length) { out.rejected = out.rejected || 'no-page'; return out; }

  // ── 2) 指紋（次回巡回との差分の元）────────────────────────
  for (const p of texts) {
    if (p.kind === 'recruit' && !out.fp.recruit) out.fp.recruit = fingerprint(p.text);
    if (p.kind === 'news' && !out.fp.news) out.fp.news = fingerprint(p.text);
    if (p.kind === 'top' && !out.fp.top) out.fp.top = fingerprint(p.text);
  }

  // ── 3) テキストシグナル（日付つきの出来事だけ）────────────
  // ページ全文は判定に回さない。回すと沿革・制度説明で誤爆する（extractDatedItems の説明を参照）。
  const maxAge = opt.maxAgeDays == null ? 365 : opt.maxAgeDays;
  const best = new Map();
  let items = 0;
  for (const p of texts) {
    for (const it of extractDatedItems(p.text)) {
      const age = daysAgo(it.date, opt.asOf);
      if (age == null || age < -3 || age > maxAge) continue;     // 沿革表の古い年・未来日付を捨てる
      items++;
      const det = detectSignals({
        title: '', text: it.text, company: target.name,
        industry: target.industry || '', date: it.date, url: p.url, asOf: opt.asOf,
      });
      for (const s of det.signals) {
        // 採用ページで拾ったものの方が確度が高い。同一キーは「採用ページ優先 → 新しい順」で残す
        const cur = best.get(s.key);
        const better = !cur
          || (p.kind === 'recruit' && cur.kind !== 'recruit')
          || (p.kind === cur.kind && (s.days != null && (cur.days == null || s.days < cur.days)));
        if (better) best.set(s.key, { ...s, source: p.kind === 'recruit' ? '採用ページ' : '公式サイト', kind: p.kind });
      }
    }
  }
  out.signals = [...best.values()].map(({ kind, ...s }) => s);
  out.datedItems = items;
  if (out.signals.length) out.rejected = '';
  else out.rejected = out.rejected || (items ? 'no-signal' : 'no-dated-item(出来事の記載なし)');

  // ── 4) 架電に必要な事実（電話・担当者名）────────────────────
  const joined = texts.map((p) => p.text).join('\n').slice(0, 20000);
  const contact = extractPressContact(joined);
  if (contact && contact.name) { out.facts.採用担当者名 = contact.name; out.facts.担当役職 = contact.role || contact.dept || ''; }
  const tel = joined.match(/(?:TEL|Tel|電話|代表電話)[\s:：]*(0\d{1,4}[-－(（]?\d{1,4}[-－)）]?\d{3,4})/);
  if (tel) out.facts.電話番号 = tel[1].replace(/[－(（)）]/g, '-').replace(/-+/g, '-');

  return out;
}

module.exports = { crawlCompany, extractDatedItems, fingerprint, pickSectionLinks, pageText, absUrl, RECRUIT_WORDS, NEWS_WORDS };
