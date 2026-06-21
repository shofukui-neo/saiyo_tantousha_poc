'use strict';
/**
 * ONE CAREER Playwright スクレイパ（実DOM較正済 2026-06）
 * =====================================================================
 * ONE CAREER(www.onecareer.jp)はNuxt製SPA。クチコミ/ES等の主要コンテンツは会員限定だが、
 * 企業ページ /companies/{id} は会社概要を非会員に公開する（実地確認）:
 *   「本社：東京都 資本金：59百万円 売上高：7,576百万円 従業員数：307名 ※2026年3月時点」
 *
 * 検索: トップの検索ボックス input#search-company（name=company-keyword,
 *   placeholder「企業、職種、勤務地など」）に社名を入れ Enter → クライアント側で企業検索へ遷移。
 *   結果の /companies/{id} リンクを社名一致で特定 → 企業ページで会社概要を抽出。
 *
 * ※ クチコミ/通過ES等の会員限定領域は取得しない（規約・不正競争防止法リスク）。
 *
 * 使い方: node src/scrape-onecareer.js "ワンキャリア" ...
 * モジュール: const { OnecareerScraper } = require('./scrape-onecareer')
 */
const { BaseMediaScraper, emptyResult, humanType, sleep } = require('./scrape-base');
const { normCompanyName } = require('./csv');

const CONFIG = {
  topUrl: 'https://www.onecareer.jp/',
  searchBoxSel: ['input#search-company', 'input[name="company-keyword"]',
    'input[placeholder*="企業"]', 'input[type="text"][placeholder*="会社"]'],
  companyUrl: (id) => `https://www.onecareer.jp/companies/${id}`,
  companyLinkRe: /\/companies\/(\d+)(?:[/?#]|$)/,
};

class OnecareerScraper extends BaseMediaScraper {
  constructor(opts = {}) { super({ label: 'onecareer', ...opts }); }

  /** @returns 共通スキーマ + { ワンキャリア掲載 } */
  async scrapeCompany(name) {
    const result = emptyResult(name, 'ワンキャリア掲載');
    const page = await this.newPage();
    try {
      const target = normCompanyName(name);
      // 1) トップで検索ボックスに入力→Enter（クライアント側遷移）
      await this.goto(page, CONFIG.topUrl);
      const box = await this._firstVisible(page, CONFIG.searchBoxSel);
      if (!box) { result.根拠 = 'ワンキャリア検索ボックス未検出'; return result; }
      await humanType(page, box, name);
      await sleep(250);
      await page.keyboard.press('Enter');
      await sleep(this.settleMs + 2000);
      await this._dump(page, 'search:' + name);

      // 2) 結果の /companies/{id} リンクを収集（イベント等のサブパスは id へ正規化）
      const ids = await page.$$eval('a[href]', (els) =>
        [...new Set(els.map((e) => {
          const m = (e.getAttribute('href') || '').match(/\/companies\/(\d+)(?:[/?#]|$)/);
          return m ? m[1] : null;
        }).filter(Boolean))]).catch(() => []);
      if (!ids.length) { result.根拠 = 'ワンキャリア検索ヒット無し'; return result; }

      // 3) 候補を最大3社開き、会社名一致を採用（おすすめ枠の取り違え防止）
      for (const id of ids.slice(0, 3)) {
        await this.goto(page, CONFIG.companyUrl(id));
        await this._dump(page, 'company:' + name);
        const ctext = await this.bodyText(page);
        const head = normCompanyName(ctext.slice(0, 300));
        if (target && (head.includes(target) || target.includes(head.slice(0, Math.max(2, target.length))) || ctext.includes(name))) {
          result.ワンキャリア掲載 = '○'; result.掲載 = '○'; result.掲載媒体 = 'ワンキャリア';
          result.採用ページURL = CONFIG.companyUrl(id);
          await this.readInto(page, result); // 従業員数/資本金/設立/電話/メール
          result.根拠 = '企業ページ(会社概要)から抽出';
          break;
        }
      }
      if (!result.ワンキャリア掲載) result.根拠 = 'ワンキャリア社名一致せず';
    } catch (e) {
      result.根拠 = 'error:' + String(e && e.message || e).slice(0, 80);
    } finally {
      await page.close().catch(() => {});
    }
    return result;
  }
}

async function main() {
  const names = process.argv.slice(2);
  if (!names.length) {
    console.error('使い方: node src/scrape-onecareer.js "会社名1" "会社名2" ...');
    console.error('  環境変数: SCRAPE_HEADFUL=1 SCRAPE_DEBUG=1 SCRAPE_SETTLE_MS=4000');
    process.exit(1);
  }
  const sc = new OnecareerScraper();
  await sc.launch();
  try {
    for (const nm of names) {
      process.stdout.write(`\n[ワンキャリア] ${nm} … `);
      const r = await sc.scrapeCompany(nm);
      console.log(JSON.stringify({
        掲載: r.ワンキャリア掲載 || '×', 従業員: r.従業員数 || '', 資本金: r.資本金 || '',
        設立: r.設立 || '', 根拠: r.根拠, URL: r.採用ページURL || '',
      }, null, 0));
      await sleep(sc.delay);
    }
  } finally { await sc.close(); }
}
if (require.main === module) main().catch((e) => { console.error('FATAL', e); process.exit(1); });

module.exports = { OnecareerScraper, CONFIG };
