'use strict';
/**
 * キャリタス就活 Playwright スクレイパ（調査報告の準本命）
 * =====================================================================
 * キャリタス就活(job.career-tasu.jp)はサーバ生成寄りで、検索結果一覧が非会員に
 *   企業名 / 業種 / 勤務地 / 給与レンジ / 採用見込人数 / 企業規模
 * を表示する。企業ページは /corp/{8桁ID}/default/ 構造。ログイン誘導は常時出るが
 * 閲覧自体はブロックされない（スカウト用の誘導）。
 *
 * 使い方: node src/scrape-careertasu.js "株式会社サンプル" ...
 * モジュール: const { CareertasuScraper } = require('./scrape-careertasu')
 */
const { BaseMediaScraper, emptyResult, humanType, humanClick, sleep } = require('./scrape-base');
const { normCompanyName } = require('./csv');

const CONFIG = {
  searchEntries: () => [
    'https://job.career-tasu.jp/employment-search/?freeword=__Q__',
    'https://job.career-tasu.jp/employment-search/?keyword=__Q__',
    'https://job.career-tasu.jp/',
  ],
  searchBoxSel: ['input[name="freeword"]', 'input[name="keyword"]', 'input[type="search"]',
    'input[placeholder*="企業"]', 'input[placeholder*="キーワード"]', 'input[type="text"]'],
  searchBtnSel: ['button[type="submit"]', 'input[type="submit"]', 'button:has-text("検索")', 'a:has-text("検索")'],
  // 検索結果の企業ページリンク（/corp/{id}/default/）
  resultLinkSel: ['a[href*="/corp/"]', '.company-name a', '[class*="company"] a', 'h2 a', 'h3 a'],
  detailTabHints: ['会社概要', '企業情報', '募集要項', '採用情報', 'データ'],
};

class CareertasuScraper extends BaseMediaScraper {
  constructor(opts = {}) { super({ label: 'careertasu', ...opts }); }

  /** @returns 共通スキーマ + { キャリタス掲載 } */
  async scrapeCompany(name) {
    const result = emptyResult(name, 'キャリタス掲載');
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
        if (/\/corp\//.test(page.url())) { opened = true; await this._readDetail(page, result); break; }
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
        result.キャリタス掲載 = '○'; result.掲載 = '○'; result.掲載媒体 = 'キャリタス';
      } else {
        result.根拠 = result.根拠 || 'キャリタス検索ヒット無し';
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
    await this._dump(page, 'corp:' + result.企業名);
    await this.readInto(page, result);
    // 会社概要/募集要項タブを辿って従業員数・採用見込人数を補完
    if (!result.採用予定人数 || !result.従業員数) {
      for (const hint of CONFIG.detailTabHints) {
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
}

async function main() {
  const names = process.argv.slice(2);
  if (!names.length) {
    console.error('使い方: node src/scrape-careertasu.js "会社名1" "会社名2" ...');
    console.error('  環境変数: SCRAPE_HEADFUL=1 SCRAPE_DEBUG=1');
    process.exit(1);
  }
  const sc = new CareertasuScraper();
  await sc.launch();
  try {
    for (const nm of names) {
      process.stdout.write(`\n[キャリタス] ${nm} … `);
      const r = await sc.scrapeCompany(nm);
      console.log(JSON.stringify({
        掲載: r.キャリタス掲載 || '×', 担当者: r.採用担当者名 || '—',
        職種: r.募集職種 || '', 人数: r.採用予定人数 || '', 従業員: r.従業員数 || '',
        設立: r.設立 || '', 電話: r.電話番号 || '', 根拠: r.根拠, URL: r.採用ページURL || '',
      }, null, 0));
      await sleep(sc.delay);
    }
  } finally { await sc.close(); }
}
if (require.main === module) main().catch((e) => { console.error('FATAL', e); process.exit(1); });

module.exports = { CareertasuScraper, CONFIG };
