'use strict';
/**
 * マイナビ新卒 Playwright スクレイパ（カーソル操作版・実DOM較正済 2026-06）
 * =====================================================================
 * 目的（ユーザー指定の主軸）: 手持ちリストの「採用担当者名」を収集する。
 * 副産物として 新卒掲載確認 / 電話 / メール / 募集職種 / 採用予定人数 を持ち帰り、
 * mochica-fit の“新卒インテント（実取得）”を最強ティアに引き上げる。
 *
 * ── 実DOMフロー（job.mynavi.jp/28 を実地調査して確定）────────────────
 *   1. フリーワード検索(GET):
 *      /28/pc/corpinfo/searchCorpListByGenCond/index?actionMode=searchFw&srchWord=社名
 *   2. 検索結果から corp{ID}/outline.html リンクを社名一致で特定 → カーソルでクリック
 *   3. 「インターンシップ＆キャリア(is.html)」「前年の採用データ(employment.html)」タブへ
 *      カーソルで遷移。is.html の『問合せ先』ブロックに 部署＋採用担当者名＋TEL＋メール が載る。
 *      例: 「問合せ先 人事総務部 野崎瑠美 03-6878-3814 saiyo@tsrweb.co.jp」
 *   4. 構造で分解（部署/氏名/電話/メール）。氏名は人名辞書でも二重検証。
 *
 *  - 実ブラウザ(Chromium)＋人手と同じカーソル操作（mouse.move→click, scroll）で遷移。
 *  - DOM変更に強いよう、URL組み立て＋本文テキスト＋構造パースの三段で堅く取る。
 *  - 1社ずつ丁寧に（POLITE_DELAY）。MYNAVI_HEADFUL=1 で画面表示、MYNAVI_DEBUG=1 で保存。
 *
 * 使い方（単体）:  node src/scrape-mynavi.js "株式会社サンプル" "別の会社"
 * モジュール:      const { MynaviScraper } = require('./scrape-mynavi')
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normCompanyName } = require('./csv');
const { isFullName, splitName, isKnownSurname, stripNonName, completeSurname } = require('./jp-names');
const { extractPhones, normalizeJpPhone } = require('./phone');
const { looksLikePersonName } = require('./extract'); // 一般語(関連/関係/案内…)を弾く共通ブロックリスト
const { nameFromEmail } = require('./romaji-name');   // 採用メールのローカル部から姓を推定（中堅大手の個人名レバー）

// ── 較正ポイント（実DOMに合わせてここだけ直す）─────────────────────
const CONFIG = {
  // 卒年（マイナビYYYY のYY）。2026-06時点では 28卒サイトは未開設で404→27卒(マイナビ2027)が実データを返す。
  // ※毎年シーズンで更新が必要。MYNAVI_GRAD_YEAR で上書き可。
  gradYear: process.env.MYNAVI_GRAD_YEAR || '27',
  // フリーワード検索結果（GET・実地で200を確認）
  searchUrl: (gy, q) => `https://job.mynavi.jp/${gy}/pc/corpinfo/searchCorpListByGenCond/index?actionMode=searchFw&srchWord=${encodeURIComponent(q)}`,
  // 検索結果に出る企業詳細リンク（corp{ID}/outline.html）
  corpLinkRe: /corp(\d+)\/outline\.html/i,
  // 採用担当者・問合せ先が載るタブ（is.html＝最有力 → employment.html → outline.html）
  contactPages: (gy, id) => [
    `https://job.mynavi.jp/${gy}/pc/search/corp${id}/is.html`,
    `https://job.mynavi.jp/${gy}/pc/search/corp${id}/employment.html`,
    `https://job.mynavi.jp/${gy}/pc/search/corp${id}/outline.html`,
  ],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DELAY = parseInt(process.env.MYNAVI_POLITE_MS || '3500', 10);
const NAV_TIMEOUT = parseInt(process.env.MYNAVI_NAV_TIMEOUT_MS || '30000', 10);
const CACHE_DIR = path.resolve(__dirname, '..', 'data', 'mynavi-cache');

// 人手っぽいカーソル移動＋クリック（bot検知回避＆描画/遷移トリガ）
async function humanMove(page, x, y) {
  await page.mouse.move(x - 50, y - 25, { steps: 5 });
  await page.mouse.move(x, y, { steps: 8 });
}
async function humanClick(page, locator) {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) { await locator.click({ timeout: 5000 }).catch(() => {}); return; }
  await page.mouse.wheel(0, Math.max(0, box.y - 300)).catch(() => {});
  await sleep(150);
  const b2 = await locator.boundingBox().catch(() => box);
  const x = b2.x + b2.width / 2, y = b2.y + b2.height / 2;
  await humanMove(page, x, y);
  await sleep(120);
  await page.mouse.click(x, y);
}

const NAME_CHARS = '[一-龥々ぁ-んァ-ヶー]';
// 部署: 「人事/総務/採用/…」＋組織サフィックス。サフィックスに「担当」を含めない
// （含めると「人事部 田中花子採用担当」の様に貼り付いた氏名まで部署として飲み込み、氏名が消える）。
// 前置は非貪欲 {0,8}? にする。貪欲だと下流に出る 課/部（例:「中村課長」の課）まで部署が伸び、氏名を飲み込む。
const DEPT_RE = new RegExp('(' + NAME_CHARS + '{0,8}?(?:人事|総務|採用|人材|管理)' + NAME_CHARS + '{0,6}?(?:部|課|室|グループ|G|本部|センター))');
// 氏名領域から剥がす非氏名スパン（役割語・役職・地名）は jp-names の共通辞書 stripNonName を使う。
// 構造アンカー(部署直後)で辞書外姓も許容する都合上、近接の組織語が誤って氏名化するのを防ぐ前処理。
// 人名ではない語（業務語＋地名/組織語）。地名の誤検出（関東支店→「関 東支店」等）を潰す。
const STOPWORDS = /担当|責任|採用|人事|総務|部署|連絡|問合|問い合|会社|株式|有限|募集|電話|メール|応募|エントリー|セミナー|説明|本社|支店|支社|営業所|本部|事業|部門|センター/;
// 地理・組織サフィックス（これを含む候補は氏名として却下）
const GEO_SUFFIX = /[都道府県市区町村]$|支店|支社|営業所|地区|地方|エリア|関東|関西|東海|東北|九州|北海道|沖縄|信越|北陸|中国|四国/;
// 氏名抽出を許可する文脈キーワード（このどれかが無い面では氏名を取らない＝誤抽出を防ぐ）
const CONTACT_KW = /問\s?合わ?せ先|お問い?合わ?せ|連絡先|採用ご?担当|人事ご?担当|ご担当者|採用責任者/;

// 漢字/かな2-6字の人名候補を、辞書フルネーム優先・なければ構造位置で許容して返す。
// マイナビ『問合せ先』は「部署→氏名→電話」の並びが安定しており、姓辞書に無い姓も
// 構造位置で拾える（辞書の取りこぼし＝母集団問題を構造情報で補う）。
function validName(raw, { loose = false } = {}) {
  const s = String(raw || '').replace(/[\s　]/g, '');
  if (!s || s.length < 2 || s.length > 6) return '';
  if (STOPWORDS.test(s)) return '';
  if (GEO_SUFFIX.test(s)) return '';                 // 地名・組織名を氏名と誤認しない
  if (!looksLikePersonName(s)) return '';            // 一般語(関連/関係/案内…)を弾く（共通ブロックリスト）
  if (/[0-9０-９a-zA-Z]/.test(s)) return '';
  if (isFullName(s)) {
    const sp = splitName(s);
    if (sp.mei && GEO_SUFFIX.test(sp.mei)) return ''; // 「関＋東支店」等を弾く
    return sp.mei ? `${sp.sei} ${sp.mei}` : sp.sei;
  }
  // 構造位置（部署直後）からの抽出時は、辞書外でも2-5字の漢字列を氏名として許容
  if (loose && /^[一-龥々]{2,5}$/.test(s)) return s;
  return '';
}

// ブロックから氏名候補を走査して1件返す。精度順の3パス制:
//   pass1: 辞書フルネーム（姓＋名）。最も確実。「山田太郎部長」(役職剥がし後)からも救出。
//   pass2: loose時のみ。辞書に「完全な姓」として載る語の単独出現（中村/佐々木 等）。
//          地名片(関東/中央)は完全姓として載らないので誤採用しない。村/市で終わる姓もここで救う。
//   pass3: loose時のみ。辞書外姓を3字以上の妥当窓で許容（野崎瑠美 等）。2字の辞書外片は精度優先で不採用。
function pickName(block, loose) {
  const s = String(block || '');
  const isNameChar = (ch) => new RegExp('^' + NAME_CHARS + '$').test(ch);
  const isRun = (w, len) => new RegExp('^(?:' + NAME_CHARS + '){' + len + '}$').test(w);
  // pass1: 辞書フルネーム優先（loose可否に関わらず最優先）
  for (let i = 0; i < s.length; i++) {
    if (!isNameChar(s[i])) continue;
    for (let len = Math.min(6, s.length - i); len >= 2; len--) {
      const win = s.slice(i, i + len);
      if (!isRun(win, len)) continue;
      if (isFullName(win)) { const v = validName(win, { loose }); if (v) return v; }
    }
  }
  if (!loose) return '';
  // pass2: 辞書に完全一致する単独姓（splitNameの姓が語全体＝中村/佐々木 等。地名片は載らない）
  for (let i = 0; i < s.length; i++) {
    if (!isNameChar(s[i])) continue;
    for (let len = Math.min(4, s.length - i); len >= 2; len--) {
      const win = s.slice(i, i + len);
      if (!isRun(win, len)) continue;
      const sur = completeSurname(win);
      if (sur) return sur;
    }
  }
  // pass3: 構造位置の辞書外姓（3字以上の最長妥当窓を採用）
  for (let i = 0; i < s.length; i++) {
    if (!isNameChar(s[i])) continue;
    for (let len = Math.min(5, s.length - i); len >= 3; len--) {
      const win = s.slice(i, i + len);
      if (!isRun(win, len)) continue;
      const v = validName(win, { loose: true });
      if (v) return v;
    }
  }
  return '';
}

/**
 * 『問合せ先』ブロックを構造で分解。
 * 典型: 「問合せ先 人事総務部 野崎瑠美 03-6878-3814 saiyo@tsrweb.co.jp」
 * @returns {{採用担当者名, 部署, 電話番号, メール}}
 */
function parseContactBlock(text) {
  const out = { 採用担当者名: '', 部署: '', 電話番号: '', メール: '' };
  if (!text) return out;
  const t = String(text).replace(/[ \t　]+/g, ' ');
  // 「問合せ先」直後の160字を作業ブロックに（見出し語自体は消費しない）
  const km = t.match(CONTACT_KW);
  if (!km) return out;
  const block = t.slice(km.index + km[0].length).slice(0, 160);
  // メール・電話
  const em = block.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  if (em) out.メール = em[0];
  const ph = extractPhones({ text: block }).phone;
  if (ph) out.電話番号 = ph;
  // 部署
  const blockJ = block.replace(/([一-龥々ぁ-んァ-ヶー]) (?=[一-龥々ぁ-んァ-ヶー])/g, '$1');
  const dm = blockJ.match(DEPT_RE);
  if (dm) out.部署 = dm[1].replace(/^(?:問\s?合わ?せ先|お問い?合わ?せ|連絡先|ご?担当者?)/, '');
  // 氏名：電話/メールの手前までを領域とし、非氏名スパンを「役割語→役職→地名→部署」の順に剥がす。
  // （順序が肝。例「中村課長」の役職"課長"を先に消さないと、部署照合がその"課"を飲み込み氏名が消える）
  // 残った漢字連を氏名とする。部署が取れている＝強い構造アンカーなので辞書外姓も許容(loose)、無ければ辞書フルネームのみ。
  let head = blockJ;
  const hcut = head.search(/[0-9０-９]|@/);
  if (hcut >= 0) head = head.slice(0, hcut);
  const cleaned = stripNonName(head).replace(new RegExp(DEPT_RE.source, 'g'), ' ');
  out.採用担当者名 = pickName(cleaned, !!dm);
  return out;
}

// キーワード近接の汎用氏名抽出（問合せ先ブロックが無い旧来レイアウト向けフォールバック）
function extractRecruiterName(text) {
  const c = parseContactBlock(text);
  if (c.採用担当者名) return { name: c.採用担当者名, dept: c.部署, role: '' };
  const t = String(text || '').replace(/[ \t　]+/g, ' ');
  const kw = '(?:採用ご?担当者?|人事ご?担当者?|ご担当者?|採用責任者|担当者?)';
  const re = new RegExp(kw + '\\s*[:：]?\\s*((?:' + NAME_CHARS + '\\s?){2,6})', 'g');
  let m;
  while ((m = re.exec(t)) !== null) { const v = validName(m[1]); if (v) return { name: v, dept: (t.match(DEPT_RE) || [])[1] || '', role: '' }; }
  return { name: '', dept: (t.match(DEPT_RE) || [])[1] || '', role: '' };
}

// 募集職種・採用予定人数・卒年・電話の軽量抽出（インテント補強）
function extractIntentSignals(text) {
  const t = String(text || '').replace(/[ \t　]+/g, ' ');
  const sig = { 募集職種: '', 募集職種数: '', 採用予定人数: '', 卒年: '', 電話番号: '' };
  // 職種は誤抽出が多いので「職種らしい語」を含む場合のみ採用（断片を弾く）
  const jobsM = t.match(/(?:募集(?:職種|コース)|職種)\s*[:：]?\s*([^\n。]{2,40})/);
  if (jobsM && /(職|エンジニア|営業|技術|総合|事務|販売|開発|研究|企画|設計|コンサル|デザイ|施工|生産|品質)/.test(jobsM[1])) {
    sig.募集職種 = jobsM[1].trim().slice(0, 40);
  }
  const numM = t.match(/募集人(?:数|員)[^0-9]{0,4}(\d{1,4})\s*[～~]?\s*\d{0,4}\s*[名人]/) || t.match(/採用(?:予定)?人数[^0-9]{0,4}(\d{1,4})\s*[名人]/);
  if (numM) sig.採用予定人数 = numM[1];
  const gradM = t.match(/(20\d{2}|2[7-9]卒|3[0-2]卒)/);
  if (gradM) sig.卒年 = gradM[1];
  const phM = (t.match(/(?:TEL|電話番号?)[\s:：]*([0-9０-９][\d０-９\-－()（）]{7,})/) || [])[1];
  if (phM) { const p = normalizeJpPhone(phM); if (p) sig.電話番号 = p; }
  if (sig.募集職種) sig.募集職種数 = String(sig.募集職種.split(/[\/、,・]/).filter(Boolean).length || 1);
  return sig;
}

class MynaviScraper {
  constructor(opts = {}) {
    this.headful = process.env.MYNAVI_HEADFUL === '1' || opts.headful;
    this.debug = process.env.MYNAVI_DEBUG === '1' || opts.debug;
    this.gradYear = opts.gradYear || CONFIG.gradYear;
    this.browser = null;
    this.context = null;
  }

  async launch() {
    const { chromium } = require('playwright');
    this.browser = await chromium.launch({
      headless: !this.headful,
      args: ['--disable-blink-features=AutomationControlled', '--lang=ja-JP'],
    });
    this.context = await this.browser.newContext({
      locale: 'ja-JP',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 900 },
    });
    this.context.setDefaultTimeout(NAV_TIMEOUT);
    if (this.debug) fs.mkdirSync(CACHE_DIR, { recursive: true });
    return this;
  }

  async close() {
    if (this.context) await this.context.close().catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});
  }

  async _dump(page, tag) {
    if (!this.debug) return;
    const h = crypto.createHash('sha1').update(tag).digest('hex').slice(0, 10);
    await page.screenshot({ path: path.join(CACHE_DIR, `${h}.png`) }).catch(() => {});
    try { fs.writeFileSync(path.join(CACHE_DIR, `${h}.html`), await page.content()); } catch (_) {}
  }

  /**
   * 1社をマイナビ新卒で検索 → 詳細から採用担当者名と新卒インテントを取得。
   * @returns {{企業名, マイナビ掲載, 採用担当者名, 役職, 部署, メール, 電話番号,
   *            採用ページURL, 募集職種, 募集職種数, 採用予定人数, 卒年, 根拠}}
   */
  async scrapeCompany(name) {
    const r = {
      企業名: name, マイナビ掲載: '', 採用担当者名: '', 担当者確度: '', 役職: '', 部署: '', メール: '', 電話番号: '',
      採用ページURL: '', 募集職種: '', 募集職種数: '', 採用予定人数: '', 卒年: '', 根拠: '',
    };
    const page = await this.context.newPage();
    try {
      const target = normCompanyName(name);
      // 1) フリーワード検索（GET）
      await page.goto(CONFIG.searchUrl(this.gradYear, name), { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await this._dump(page, 'search:' + name);

      // 2) 社名一致する corp{ID}/outline.html を特定
      const corp = await this._matchCorp(page, target);
      if (!corp) { r.根拠 = 'マイナビ検索ヒット無し'; return r; }
      r.マイナビ掲載 = '○';
      r.採用ページURL = `https://job.mynavi.jp/${this.gradYear}/pc/search/corp${corp.id}/outline.html`;

      // 2.5) 結果ページ上の該当リンクをカーソルでクリックして遷移（実操作）
      if (corp.locator) { await humanClick(page, corp.locator); await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); }

      // 3) 問合せ先/採用データのタブをカーソルで巡回して担当者名を取得
      await this._chaseContact(page, corp.id, r);

      // 4) 個人名フォールバック: 問合せ先に氏名が無くても、採用メールのローカル部が人名なら姓を推定する
      //    （中堅大手は氏名非公開が大半だが、ksato@/Tsagara@ 等のメールが数少ない個人名レバー）。
      if (!r.採用担当者名 && r.メール) {
        const em = nameFromEmail(r.メール);
        if (em) {
          r.採用担当者名 = em.surname;
          r.担当者確度 = em.confidence;
          r.根拠 = (r.根拠 ? r.根拠 + ' / ' : '') + `メール推定(${em.romaji}→${em.surname})`;
        }
      }
    } catch (e) {
      r.根拠 = r.根拠 || ('error:' + String(e && e.message || e).slice(0, 80));
    } finally {
      await page.close().catch(() => {});
    }
    return r;
  }

  // 検索結果から社名一致する企業の corpID とクリック用ロケータを返す
  async _matchCorp(page, target) {
    if (!target) return null;
    const links = page.locator('a[href*="outline.html"]');
    const n = Math.min(await links.count().catch(() => 0), 30);
    let firstHit = null;
    for (let i = 0; i < n; i++) {
      const lk = links.nth(i);
      const href = (await lk.getAttribute('href').catch(() => '')) || '';
      const mm = href.match(CONFIG.corpLinkRe);
      if (!mm) continue;
      const txt = ((await lk.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      const nm = normCompanyName(txt);
      const cand = { id: mm[1], locator: lk, text: txt };
      if (nm && nm === target) return cand;              // 完全一致を最優先
      if (nm && (nm.includes(target) || target.includes(nm)) && !firstHit) firstHit = cand;
    }
    return firstHit; // 部分一致のみなら先頭を返す（無ければ null）
  }

  async _chaseContact(page, id, r) {
    for (const url of CONFIG.contactPages(this.gradYear, id)) {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => null);
      if (resp && resp.status() >= 400) continue;
      await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
      await page.mouse.wheel(0, 600).catch(() => {});  // 遅延描画トリガ
      await sleep(300);
      const text = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
      await this._dump(page, 'detail:' + r.企業名 + ':' + url.split('/').pop());

      const c = parseContactBlock(text);
      // 氏名は is.html（較正済みの『問合せ先』ブロック）からのみ採る。outline/employment は会社概要・採用実績で
      // 「大塚商会は/岡三にい/神田神保(地名)/南大学」等の社名・地名・断片を氏名と誤抽出するため除外。
      // さらに同ブロック内に電話 or メールが共在することを必須化（本物の問合せ先の構造）。
      const isContactPage = /\/is\.html$/.test(url);
      if (c.採用担当者名 && !r.採用担当者名 && isContactPage && (c.電話番号 || c.メール)) {
        r.採用担当者名 = c.採用担当者名;
        r.根拠 = '問合せ先から氏名抽出(' + url.split('/').pop() + ')';
      }
      if (c.部署 && !r.部署) r.部署 = c.部署;
      if (c.メール && !r.メール) r.メール = c.メール;
      if (c.電話番号 && !r.電話番号) r.電話番号 = c.電話番号;

      const sig = extractIntentSignals(text);
      if (sig.募集職種 && !r.募集職種) r.募集職種 = sig.募集職種;
      if (sig.募集職種数 && !r.募集職種数) r.募集職種数 = sig.募集職種数;
      if (sig.採用予定人数 && !r.採用予定人数) r.採用予定人数 = sig.採用予定人数;
      if (sig.卒年 && !r.卒年) r.卒年 = sig.卒年;
      if (sig.電話番号 && !r.電話番号) r.電話番号 = sig.電話番号;

      if (r.採用担当者名) break; // 担当者名が取れたら十分
      await sleep(800);
    }
    if (!r.根拠) r.根拠 = r.電話番号 ? 'マイナビ掲載確認(担当者名は非公開)' : 'マイナビ掲載確認';
  }
}

// ── CLI（単体実行・動作確認用）─────────────────────────────────────
async function main() {
  const names = process.argv.slice(2);
  if (!names.length) {
    console.error('使い方: node src/scrape-mynavi.js "会社名1" "会社名2" ...');
    console.error('  環境変数: MYNAVI_HEADFUL=1(画面表示) MYNAVI_DEBUG=1(html/png保存) MYNAVI_GRAD_YEAR=28');
    process.exit(1);
  }
  const sc = new MynaviScraper();
  await sc.launch();
  try {
    for (const nm of names) {
      process.stdout.write(`\n[マイナビ] ${nm} … `);
      const r = await sc.scrapeCompany(nm);
      console.log(JSON.stringify({
        掲載: r.マイナビ掲載 || '×', 担当者: r.採用担当者名 || '—', 部署: r.部署 || '', メール: r.メール || '',
        電話: r.電話番号 || '', 職種: r.募集職種 || '', 人数: r.採用予定人数 || '', 卒年: r.卒年 || '', 根拠: r.根拠,
      }));
      await sleep(DELAY);
    }
  } finally {
    await sc.close();
  }
}

if (require.main === module) main().catch((e) => { console.error('FATAL', e); process.exit(1); });

module.exports = { MynaviScraper, parseContactBlock, extractRecruiterName, extractIntentSignals, validName, CONFIG };
