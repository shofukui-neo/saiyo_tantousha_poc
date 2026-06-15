'use strict';
/**
 * ONE CAREER Playwright スクレイパ（調査報告で最難・best-effort）
 * =====================================================================
 * ONE CAREER(www.onecareer.jp)は Nuxt 製 SPA。企業ページ(/companies/{id})自体は
 * 従業員数などを非会員に公開するが、クチコミ/ES等の主要コンテンツは会員限定。
 * よって取得できるのは「掲載有無＋公開された企業ファクト（従業員数等）」が中心。
 * クチコミ/ES等の会員限定領域は取得しない（規約・不正競争防止法リスク）。
 *
 * 使い方: node src/scrape-onecareer.js "株式会社サンプル" ...
 * モジュール: const { OnecareerScraper } = require('./scrape-onecareer')
 */
const { BaseMediaScraper, emptyResult, humanType, humanClick, sleep } = require('./scrape-base');
const { normCompanyName } = require('./csv');

const CONFIG = {
  searchEntries: () => [
    'https://www.onecareer.jp/companies/search?keyword=__Q__',
    'https://www.onecareer.jp/companies?keyword=__Q__',
    'https://www.onecareer.jp/companies',
  ],
  searchBoxSel: ['input[name="keyword"]', 'input[type="search"]',
    'input[placeholder*="企業"]', 'input[placeholder*="検索"]', 'input[type="text"]'],
  searchBtnSel: ['button[type="submit"]', 'button:has-text("検索")', 'a:has-text("検索")'],
  resultLinkSel: ['a[href*="/companies/"]', '.company-name a', '[class*="company"] a', 'h2 a', 'h3 a'],
};

class OnecareerScraper extends BaseMediaScraper {
  constructor(opts = {}) { super({ label: 'onecareer', ...opts }); }

  /** @returns 共通スキーマ + { ワンキャリア掲載 } */
  async scrapeCompany(name) {
    const result = emptyResult(name, 'ワンキャリア掲載');
    const page = await this.newPage();
    try {
      const target = normCompanyName(name);
      let opened = false;
      for (const tmpl of CONFIG.searchEntries()) {
        const url = tmpl.replace('__Q__', encodeURIComponent(name));
        await this.goto(page, url);
        const box = await this._firstVisible(page, CONFIG.searchBoxSel);
        if (box) {
          await humanType(page, box, name);
          await sleep(200);
          const btn = await this._firstVisible(page, CONFIG.searchBtnSel);
          if (btn) await humanClick(page, btn); else await page.keyboard.press('Enter');
          await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        }
        await this._dump(page, 'search:' + name);
        if (/\/companies\/\d/.test(page.url())) { opened = true; await this._readDetail(page, result); break; }
        const link = await this.matchingResultLink(page, CONFIG.resultLinkSel, target);
        if (link) {
          await humanClick(page, link);
          await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
          opened = true;
          await this._readDetail(page, result);
          break;
        }
        await sleep(this.delay);
      }
      if (opened) {
        result.ワンキャリア掲載 = '○'; result.掲載 = '○'; result.掲載媒体 = 'ワンキャリア';
      } else {
        result.根拠 = result.根拠 || 'ワンキャリア検索ヒット無し';
      }
    } catch (e) {
      result.根拠 = 'error:' + String(e && e.message || e).slice(0, 80);
    } finally {
      await page.close().catch(() => {});
    }
    return result;
  }

  async _readDetail(page, result) {
    result.採用ページURL = result.採用ページURL || page.url();
    await this._dump(page, 'company:' + result.企業名);
    // SPAなので企業ファクトの描画を少し待つ
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
    await this.readInto(page, result);
  }
}

async function main() {
  const names = process.argv.slice(2);
  if (!names.length) {
    console.error('使い方: node src/scrape-onecareer.js "会社名1" "会社名2" ...');
    console.error('  環境変数: SCRAPE_HEADFUL=1 SCRAPE_DEBUG=1');
    process.exit(1);
  }
  const sc = new OnecareerScraper();
  await sc.launch();
  try {
    for (const nm of names) {
      process.stdout.write(`\n[ワンキャリア] ${nm} … `);
      const r = await sc.scrapeCompany(nm);
      console.log(JSON.stringify({
        掲載: r.ワンキャリア掲載 || '×', 従業員: r.従業員数 || '', 設立: r.設立 || '',
        根拠: r.根拠, URL: r.採用ページURL || '',
      }, null, 0));
      await sleep(sc.delay);
    }
  } finally { await sc.close(); }
}
if (require.main === module) main().catch((e) => { console.error('FATAL', e); process.exit(1); });

module.exports = { OnecareerScraper, CONFIG };
