'use strict';
/**
 * リクナビ新卒 Playwright スクレイパ（調査報告の本命）
 * =====================================================================
 * リクナビ新卒(job.rikunabi.com)の企業ページは、非会員にも
 *   電話番号 / 従業員数 / 採用予定人数 / 募集職種 / 住所
 * を公開している（報告書 2026-06 時点）。ただし2026/2027版は Next.js 製 SPA で、
 * 生のGETでは _next シェルしか返らないため、ヘッドレスブラウザでのレンダリングが必須。
 *
 * 手順:
 *   1) 企業名で検索（/{年度}/search/?kw=...）
 *   2) 結果から対象社の企業ページリンク(/{年度}/company/{id}/)を特定して開く
 *   3) 会社概要(本体)＋採用情報(/employ/)を読み、ファクトとインテントを回収
 *
 * 使い方: node src/scrape-rikunabi.js "株式会社サンプル" ...
 * モジュール: const { RikunabiScraper } = require('./scrape-rikunabi')
 */
const { BaseMediaScraper, emptyResult, humanType, humanClick, sleep } = require('./scrape-base');
const { normCompanyName } = require('./csv');

const CONFIG = {
  gradYear: process.env.RIKUNABI_GRAD_YEAR || '2027', // 卒年度別サブサイト（27卒=本命）。2026も可。
  searchEntries: (gy) => [
    `https://job.rikunabi.com/${gy}/search/?kw=__Q__`,
    `https://job.rikunabi.com/${gy}/search/list/?kw=__Q__`,
    `https://job.rikunabi.com/${gy}/`,
  ],
  searchBoxSel: ['input[name="kw"]', 'input[type="search"]',
    'input[placeholder*="企業"]', 'input[placeholder*="検索"]', 'input[type="text"]'],
  searchBtnSel: ['button[type="submit"]', 'input[type="submit"]', 'button:has-text("検索")', 'a:has-text("検索")'],
  // 検索結果の企業ページリンク（/company/{id}/）
  resultLinkSel: ['a[href*="/company/"]', '.js-companyName a', '.castDataArea a', 'h2 a', 'h3 a'],
  // 採用情報（初任給・従業員・採用予定人数）面へのタブ/リンク文言
  employTabHints: ['採用情報', '募集要項', '採用データ', '会社概要', '企業情報'],
};

class RikunabiScraper extends BaseMediaScraper {
  constructor(opts = {}) {
    super({ label: 'rikunabi', ...opts });
    this.gradYear = opts.gradYear || CONFIG.gradYear;
  }

  /**
   * 1社をリクナビ新卒で検索→企業ページを読み、ファクト/インテントを回収。
   * @returns 共通スキーマ + { リクナビ掲載 }
   */
  async scrapeCompany(name) {
    const result = emptyResult(name, 'リクナビ掲載');
    const page = await this.newPage();
    try {
      const target = normCompanyName(name);
      let opened = false;
      for (const tmpl of CONFIG.searchEntries(this.gradYear)) {
        const url = tmpl.replace('__Q__', encodeURIComponent(name));
        await this.goto(page, url);
        // 検索ボックスが見えれば人手操作で再検索（SPA描画トリガ）
        const box = await this._firstVisible(page, CONFIG.searchBoxSel);
        if (box) {
          await humanType(page, box, name);
          await sleep(200);
          const btn = await this._firstVisible(page, CONFIG.searchBtnSel);
          if (btn) await humanClick(page, btn); else await page.keyboard.press('Enter');
          await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        }
        await this._dump(page, 'search:' + name);
        // 直接企業ページに飛んでいる場合
        if (/\/company\//.test(page.url())) { opened = true; await this._readCompany(page, result); break; }
        const link = await this.matchingResultLink(page, CONFIG.resultLinkSel, target);
        if (link) {
          await humanClick(page, link);
          await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
          opened = true;
          await this._readCompany(page, result);
          break;
        }
        await sleep(this.delay);
      }
      if (opened) {
        result.リクナビ掲載 = '○'; result.掲載 = '○'; result.掲載媒体 = 'リクナビ';
      } else {
        result.根拠 = result.根拠 || 'リクナビ検索ヒット無し';
      }
    } catch (e) {
      result.根拠 = 'error:' + String(e && e.message || e).slice(0, 80);
    } finally {
      await page.close().catch(() => {});
    }
    return result;
  }

  // 企業ページ本体を読み、採用情報(/employ/)面も巡回してファクトを補完
  async _readCompany(page, result) {
    result.採用ページURL = result.採用ページURL || page.url();
    await this._dump(page, 'company:' + result.企業名);
    await this.readInto(page, result);

    // /employ/（採用情報）面が別URLなら直接開く（従業員数・採用予定人数が載りやすい）
    const employUrl = this._employUrl(page.url());
    if (employUrl && employUrl !== page.url()) {
      await this.goto(page, employUrl);
      await this._dump(page, 'employ:' + result.企業名);
      await this.readInto(page, result);
    }
    // タブ型UIの場合はリンク文言で採用情報面を辿る
    if (!result.採用予定人数 || !result.従業員数) {
      for (const hint of CONFIG.employTabHints) {
        const tab = page.locator(`a:has-text("${hint}")`).first();
        if (!(await tab.count().catch(() => 0)) || !(await tab.isVisible().catch(() => false))) continue;
        await humanClick(page, tab);
        await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
        await this.readInto(page, result);
        if (result.採用予定人数 && result.従業員数) break;
        await sleep(600);
      }
    }
  }

  // /{年度}/company/{id}/ → /{年度}/company/{id}/employ/
  _employUrl(url) {
    try {
      const m = url.match(/(https?:\/\/[^/]+\/\d{4}\/company\/[^/]+\/)/);
      return m ? m[1] + 'employ/' : '';
    } catch { return ''; }
  }
}

async function main() {
  const names = process.argv.slice(2);
  if (!names.length) {
    console.error('使い方: node src/scrape-rikunabi.js "会社名1" "会社名2" ...');
    console.error('  環境変数: SCRAPE_HEADFUL=1 SCRAPE_DEBUG=1 RIKUNABI_GRAD_YEAR=2027');
    process.exit(1);
  }
  const sc = new RikunabiScraper();
  await sc.launch();
  try {
    for (const nm of names) {
      process.stdout.write(`\n[リクナビ] ${nm} … `);
      const r = await sc.scrapeCompany(nm);
      console.log(JSON.stringify({
        掲載: r.リクナビ掲載 || '×', 担当者: r.採用担当者名 || '—',
        職種: r.募集職種 || '', 人数: r.採用予定人数 || '', 従業員: r.従業員数 || '',
        資本金: r.資本金 || '', 設立: r.設立 || '', 電話: r.電話番号 || '', メール: r.メール || '',
        根拠: r.根拠, URL: r.採用ページURL || '',
      }, null, 0));
      await sleep(sc.delay);
    }
  } finally { await sc.close(); }
}
if (require.main === module) main().catch((e) => { console.error('FATAL', e); process.exit(1); });

module.exports = { RikunabiScraper, CONFIG };
