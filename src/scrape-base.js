'use strict';
/**
 * 採用媒体ページ Playwright スクレイパの共通基盤。
 * =====================================================================
 * 各媒体（マイナビ/リクナビ/キャリタス/ONE CAREER）はいずれもJS描画・簡易bot検知が
 * あるため、静的fetchではなく実ブラウザ(Chromium)を人手っぽいカーソル操作で動かす。
 * 媒体ごとに変わるのは「URL構造・セレクタ・読む面の手順」だけなので、
 *   - ブラウザ起動/終了・人手っぽい操作・可視要素探索・デバッグダンプ
 *   - 本文テキストからの 採用担当者名/新卒インテント/企業ファクト(電話・従業員数等) 抽出
 * をここに集約し、各 src/scrape-<媒体>.js は BaseMediaScraper を継承して
 * scrapeCompany(name) だけを実装する。
 *
 * 礼儀（polite.js と同じ思想）: 1社ずつ・ページ間に delay・robots は各媒体実装側で尊重。
 * 環境変数:
 *   SCRAPE_HEADFUL=1     画面を表示（操作確認）
 *   SCRAPE_DEBUG=1       data/<媒体>-cache に screenshot/html を保存（セレクタ較正用）
 *   SCRAPE_PAGE_DELAY_MS ページ操作間の最小待ち（既定3000）
 *   SCRAPE_NAV_TIMEOUT_MS 1ナビゲーションのタイムアウト（既定30000）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normCompanyName } = require('./csv');
const { isFullName, splitName, isKnownSurname } = require('./jp-names');
const { extractPhones } = require('./phone');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 人手っぽいカーソル移動＋クリック（bot検知回避＆描画トリガ）──────────
async function humanClick(page, locator) {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) { await locator.click({ timeout: 5000 }).catch(() => {}); return; }
  const x = box.x + box.width / 2 + (box.width * 0.1);
  const y = box.y + box.height / 2;
  await page.mouse.move(x - 40, y - 20, { steps: 6 });
  await page.mouse.move(x, y, { steps: 8 });
  await sleep(120);
  await page.mouse.click(x, y);
}
async function humanType(page, locator, text) {
  await humanClick(page, locator);
  await sleep(150);
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: 40 + Math.floor(20 * (ch.charCodeAt(0) % 3)) });
  }
}

// ── 採用担当者名の抽出（本文テキスト → キーワード近接 → 人名辞書で検証）──
const NAME_CHARS = '[一-龥々ぁ-んァ-ヶー]';
function extractRecruiterName(text) {
  if (!text) return { name: '', dept: '', role: '' };
  const t = String(text).replace(/[ \t　]+/g, ' ');
  const out = { name: '', dept: '', role: '' };
  // 1) 「採用担当：山田太郎」「人事部 採用担当 山田 太郎」など、担当キーワード直後の氏名
  const kw = '(?:採用ご?担当者?|人事ご?担当者?|ご担当者?|採用責任者|人事責任者|担当者?)';
  const re1 = new RegExp(kw + '\\s*[:：]?\\s*((?:' + NAME_CHARS + '\\s?){2,8})', 'g');
  let m;
  const cands = [];
  while ((m = re1.exec(t)) !== null) cands.push(m[1].replace(/\s/g, ''));
  // 2) 「○○部 ＜氏名＞」: 部署名の直後に来る氏名
  const re2 = new RegExp('(' + NAME_CHARS + '{2,10}?[部課室]|人事|総務)\\s*[ /／・]?\\s*((?:' + NAME_CHARS + '\\s?){2,8})', 'g');
  while ((m = re2.exec(t)) !== null) {
    const raw = m[2].replace(/\s/g, '');
    if (/担当|責任|採用|人事/.test(m[1]) || /部|課|室/.test(m[1])) cands.push(raw);
  }
  // 候補を人名辞書で検証。フルネーム > 既知姓 の順に最初の妥当を採用。
  let best = '';
  for (const c of cands) {
    if (/担当|責任|採用|人事|部署|連絡|問合|問い合|会社|株式|有限/.test(c)) continue; // 非人名を除外
    if (isFullName(c)) { best = c; break; }
    if (!best && isKnownSurname(c) && c.length >= 2) best = c;
  }
  if (best) {
    out.name = best;
    const sp = splitName(best);
    if (sp) out.name = sp.mei ? `${sp.sei} ${sp.mei}` : sp.sei;
  }
  const deptM = t.match(new RegExp('(' + NAME_CHARS + '{0,6}(?:人事部|採用部|人材開発部|総務部|人事課|採用課|管理部)' + ')'));
  if (deptM) out.dept = deptM[1];
  const roleM = t.match(/(採用担当|人事担当|採用責任者|人事部長|採用マネージャー|人事課長|リクルーター)/);
  if (roleM) out.role = roleM[1];
  return out;
}

// ── 募集職種・採用予定人数・卒年の軽量抽出（新卒インテント補強用）──
function extractIntentSignals(text) {
  const t = String(text || '').replace(/[ \t　]+/g, ' ');
  const sig = { 募集職種: '', 募集職種数: '', 採用予定人数: '', 卒年: '' };
  const jobsM = t.match(/(?:募集|職種|募集職種)[^0-9A-Za-z]{0,6}([^\n。]{2,40})/);
  if (jobsM) sig.募集職種 = jobsM[1].trim().slice(0, 40);
  const numM = t.match(/採用(?:予定)?人数[^0-9]{0,4}(\d{1,4})\s*[名人]/);
  if (numM) sig.採用予定人数 = numM[1];
  const gradM = t.match(/(20\d{2}|2[7-9]卒|3[0-2]卒)/);
  if (gradM) sig.卒年 = gradM[1];
  if (sig.募集職種) sig.募集職種数 = String(sig.募集職種.split(/[\/、,・]/).filter(Boolean).length || 1);
  return sig;
}

// ── 企業ファクト抽出（電話・従業員数・資本金・設立・メール）──
//   リクナビ等が非会員に公開している会社概要から、属性値を本文+HTMLで拾う。
function extractCompanyFacts({ html = '', text = '' } = {}) {
  const t = String(text || '').replace(/[ \t　]+/g, ' ');
  const facts = { 電話番号: '', 従業員数: '', 資本金: '', 設立: '', メール: '' };
  // 電話（既存の堅い抽出を流用。会社概要面なので pageBoost を少し乗せる）
  const ph = extractPhones({ html, text, pageBoost: 2 });
  if (ph && ph.phone && !ph.isFax) facts.電話番号 = ph.phone;
  // 従業員数（"従業員数 278名" "社員数：1,234人" 等）
  const emp = t.match(/(?:従業|社)員数?[^0-9]{0,6}([\d,，]{1,7})\s*[名人]/);
  if (emp) facts.従業員数 = emp[1].replace(/[,，]/g, '');
  // 資本金（"資本金 1,000万円" "資本金：1億円"）
  const cap = t.match(/資本金[^0-9]{0,6}([\d,，.]{1,12}\s*(?:億|万)?円)/);
  if (cap) facts.資本金 = cap[1].replace(/\s+/g, '');
  // 設立（"設立 2010年" "創業：1985年4月"）
  const est = t.match(/(?:設立|創業)[^0-9]{0,6}((?:19|20)\d{2})\s*年?/);
  if (est) facts.設立 = est[1];
  // メール（採用系ロールを優先）
  const mails = (t.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [])
    .filter((e) => !/example\.|\.png|\.jpg|sentry|wixpress/i.test(e));
  if (mails.length) {
    const pref = mails.find((e) => /recruit|saiyo|jinji|hr|jobs|採用/.test(e.toLowerCase()));
    facts.メール = pref || mails[0];
  }
  return facts;
}

class BaseMediaScraper {
  /**
   * @param {object} opts
   * @param {string} opts.label    媒体名（ログ・キャッシュ用）
   * @param {string} opts.cacheDir デバッグダンプ先（既定 data/<label>-cache）
   */
  constructor(opts = {}) {
    this.label = opts.label || 'media';
    this.headful = opts.headful != null ? opts.headful : process.env.SCRAPE_HEADFUL === '1';
    this.debug = opts.debug != null ? opts.debug : process.env.SCRAPE_DEBUG === '1';
    this.delay = opts.delay || parseInt(process.env.SCRAPE_PAGE_DELAY_MS || '3000', 10);
    this.navTimeout = opts.navTimeout || parseInt(process.env.SCRAPE_NAV_TIMEOUT_MS || '30000', 10);
    this.userAgent = opts.userAgent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    this.cacheDir = opts.cacheDir || path.resolve(__dirname, '..', 'data', `${this.label}-cache`);
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
      userAgent: this.userAgent,
      viewport: { width: 1366, height: 900 },
    });
    this.context.setDefaultTimeout(this.navTimeout);
    if (this.debug) fs.mkdirSync(this.cacheDir, { recursive: true });
    return this;
  }

  async close() {
    if (this.context) await this.context.close().catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});
    this.context = this.browser = null;
  }

  async newPage() { return this.context.newPage(); }

  // 候補セレクタのうち「実際に見えている」最初の要素を返す（無ければ null）
  async _firstVisible(page, selectors) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if (await loc.count().catch(() => 0)) {
        if (await loc.isVisible().catch(() => false)) return loc;
      }
    }
    return null;
  }

  // domcontentloaded まで素直に開き、networkidle を短く待つ（SPA描画待ち）
  async goto(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.navTimeout }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  }

  async bodyText(page) {
    return page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
  }

  async content(page) { return page.content().catch(() => ''); }

  // デバッグ時のみ screenshot+html を保存（タグでファイル名を安定化）
  async _dump(page, tag) {
    if (!this.debug) return;
    const h = crypto.createHash('sha1').update(this.label + ':' + tag).digest('hex').slice(0, 10);
    await page.screenshot({ path: path.join(this.cacheDir, `${h}.png`), fullPage: false }).catch(() => {});
    try { fs.writeFileSync(path.join(this.cacheDir, `${h}.html`), await this.content(page)); } catch (_) {}
  }

  // 検索結果の中から、対象社名に一致するリンクを返す（正規化一致 or 部分一致）
  async matchingResultLink(page, selectors, targetName, max = 20) {
    const target = normCompanyName(targetName);
    if (!target) return null;
    for (const sel of selectors) {
      const links = page.locator(sel);
      const n = Math.min(await links.count().catch(() => 0), max);
      for (let i = 0; i < n; i++) {
        const lk = links.nth(i);
        const txt = (await lk.innerText().catch(() => '')) || '';
        const nm = normCompanyName(txt);
        if (nm && (nm === target || nm.includes(target) || target.includes(nm))) return lk;
      }
    }
    return null;
  }

  // 本文を読み、result に 採用担当者名/インテント/企業ファクト を埋める（空欄のみ上書き）。
  async readInto(page, result) {
    const text = await this.bodyText(page);
    const html = await this.content(page);
    const nm = extractRecruiterName(text);
    if (nm.name && !result.採用担当者名) { result.採用担当者名 = nm.name; result.根拠 = result.根拠 || '詳細ページから氏名抽出'; }
    if (nm.dept && !result.部署) result.部署 = nm.dept;
    if (nm.role && !result.役職) result.役職 = nm.role;
    const sig = extractIntentSignals(text);
    if (sig.募集職種 && !result.募集職種) result.募集職種 = sig.募集職種;
    if (sig.募集職種数 && !result.募集職種数) result.募集職種数 = sig.募集職種数;
    if (sig.採用予定人数 && !result.採用予定人数) result.採用予定人数 = sig.採用予定人数;
    if (sig.卒年 && !result.卒年) result.卒年 = sig.卒年;
    const f = extractCompanyFacts({ html, text });
    for (const k of ['電話番号', '従業員数', '資本金', '設立', 'メール']) {
      if (f[k] && !result[k]) result[k] = f[k];
    }
    return { text, html };
  }
}

// 媒体結果の空テンプレ（各スクレイパが共通スキーマで返すための土台）
function emptyResult(name, mediaCol) {
  const r = {
    企業名: name, 掲載媒体: '', 掲載: '',
    採用担当者名: '', 役職: '', 部署: '',
    採用ページURL: '', 募集職種: '', 募集職種数: '', 採用予定人数: '', 卒年: '',
    電話番号: '', 従業員数: '', 資本金: '', 設立: '', メール: '', 根拠: '',
  };
  if (mediaCol) r[mediaCol] = '';
  return r;
}

module.exports = {
  BaseMediaScraper, emptyResult,
  humanClick, humanType, sleep,
  extractRecruiterName, extractIntentSignals, extractCompanyFacts,
};
