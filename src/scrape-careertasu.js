'use strict';
/**
 * キャリタス就活 Playwright スクレイパ（実DOM較正済 2026-06）
 * =====================================================================
 * キャリタス就活(job.career-tasu.jp)はサーバ生成(SSR)寄り。企業ページ
 *   /corp/{8桁ID}/  に 従業員数・設立・受付状況・株式上場 等が非会員に公開される（実地確認）。
 *
 * 検索は GET ?freeword= ではなく POSTフォーム（実地確認）:
 *   トップの検索ボックス(input#HeaderSearchKeyword / placeholder「企業名やキーワードを入力する」)へ
 *   社名を入力→Enterで /condition-search/postResult/ に keyword でPOST → 結果に /corp/{id}/ リンク。
 *
 * 取得: 掲載有無 / 従業員数 / 設立 / 採用予定人数 / 職種（採用情報面 /corp/{id}/employment/）。
 *
 * 使い方: node src/scrape-careertasu.js "アフラック生命保険" ...
 * モジュール: const { CareertasuScraper } = require('./scrape-careertasu')
 */
const { BaseMediaScraper, emptyResult, humanType, humanClick, sleep } = require('./scrape-base');
const { normCompanyName } = require('./csv');

const CONFIG = {
  topUrl: 'https://job.career-tasu.jp/',
  // 可視の検索ボックス（POSTフォームの keyword に同期される）
  searchBoxSel: ['input#HeaderSearchKeyword', 'input#pcSearchTabCompKeyword',
    'input[name="pcSearchTabCompKeyword"]', 'input[type="search"][placeholder*="企業名"]', 'input[type="search"]'],
  corpUrl: (id) => `https://job.career-tasu.jp/corp/${id}/`,
  employUrl: (id) => `https://job.career-tasu.jp/corp/${id}/employment/`,
  corpLinkRe: /\/corp\/(\d{6,8})\//,
};

class CareertasuScraper extends BaseMediaScraper {
  constructor(opts = {}) { super({ label: 'careertasu', ...opts }); }

  /** @returns 共通スキーマ + { キャリタス掲載 } */
  async scrapeCompany(name) {
    const result = emptyResult(name, 'キャリタス掲載');
    const page = await this.newPage();
    try {
      const target = normCompanyName(name);
      // 1) トップで検索ボックスに入力→Enterで POST 検索
      await this.goto(page, CONFIG.topUrl);
      const box = await this._firstVisible(page, CONFIG.searchBoxSel);
      if (!box) { result.根拠 = 'キャリタス検索ボックス未検出'; return result; }
      await humanType(page, box, name);
      await sleep(250);
      await page.keyboard.press('Enter');
      await sleep(this.settleMs + 2000); // POST遷移＋結果描画待ち
      await this._dump(page, 'search:' + name);

      // 2) 結果の /corp/{id}/ リンクを、リンク文言が社名一致するものに絞って採用
      const cands = await page.$$eval('a[href*="/corp/"]', (els) =>
        els.map((e) => ({ href: e.getAttribute('href') || '', txt: (e.innerText || '').replace(/\s+/g, ' ').trim() }))
          .filter((x) => /\/corp\/\d{6,8}\//.test(x.href))).catch(() => []);
      const seen = new Set();
      let matchedId = '';
      for (const c of cands) {
        const m = c.href.match(CONFIG.corpLinkRe); if (!m) continue;
        const id = m[1]; if (seen.has(id)) continue; seen.add(id);
        const n = normCompanyName(c.txt);
        if (target && n && (n.includes(target) || target.includes(target.length > 4 ? target : n))) { matchedId = id; break; }
      }
      // リンク文言で一致しない場合、先頭候補を開いて会社名照合（最大3件）
      const tryIds = matchedId ? [matchedId] : [...seen].slice(0, 3);
      for (const id of tryIds) {
        await this.goto(page, CONFIG.corpUrl(id));
        await this._dump(page, 'corp:' + name);
        const ctext = await this.bodyText(page);
        const head = normCompanyName(ctext.slice(0, 300));
        if (matchedId || (target && (head.includes(target) || ctext.includes(name)))) {
          result.キャリタス掲載 = '○'; result.掲載 = '○'; result.掲載媒体 = 'キャリタス';
          result.採用ページURL = CONFIG.corpUrl(id);
          this._readReception(ctext, result);            // 受付状況を先に確定（インテント正規表現のノイズに勝たせる）
          await this.readInto(page, result);            // 従業員数/設立/電話/メール
          // 採用情報面で採用予定人数・職種を補完
          await this.goto(page, CONFIG.employUrl(id));
          await this._dump(page, 'employ:' + name);
          await this.readInto(page, result);
          result.根拠 = '企業ページからSSR属性抽出';
          break;
        }
      }
      if (!result.キャリタス掲載) result.根拠 = result.根拠 || 'キャリタス社名一致せず';
    } catch (e) {
      result.根拠 = 'error:' + String(e && e.message || e).slice(0, 80);
    } finally {
      await page.close().catch(() => {});
    }
    return result;
  }

  // 受付状況（本選考エントリー受付中 等）→ 新卒インテントの裏付け
  _readReception(text, result) {
    const t = String(text || '');
    const m = t.match(/(本選考エントリー受付中|エントリー受付中|説明会受付中|インターン受付中|受付終了)/);
    if (m && !result.募集職種) result.募集職種 = m[1];
  }
}

async function main() {
  const names = process.argv.slice(2);
  if (!names.length) {
    console.error('使い方: node src/scrape-careertasu.js "会社名1" "会社名2" ...');
    console.error('  環境変数: SCRAPE_HEADFUL=1 SCRAPE_DEBUG=1 SCRAPE_SETTLE_MS=4000');
    process.exit(1);
  }
  const sc = new CareertasuScraper();
  await sc.launch();
  try {
    for (const nm of names) {
      process.stdout.write(`\n[キャリタス] ${nm} … `);
      const r = await sc.scrapeCompany(nm);
      console.log(JSON.stringify({
        掲載: r.キャリタス掲載 || '×', 従業員: r.従業員数 || '', 設立: r.設立 || '',
        人数: r.採用予定人数 || '', 受付: r.募集職種 || '', 根拠: r.根拠, URL: r.採用ページURL || '',
      }, null, 0));
      await sleep(sc.delay);
    }
  } finally { await sc.close(); }
}
if (require.main === module) main().catch((e) => { console.error('FATAL', e); process.exit(1); });

module.exports = { CareertasuScraper, CONFIG };
