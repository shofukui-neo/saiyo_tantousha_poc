'use strict';
/**
 * リクナビ新卒 Playwright スクレイパ（実DOM較正済 2026-06）
 * =====================================================================
 * リクナビは2027卒刷新で卒年度別サイト(/2027/等)を廃止し、全学年統合の
 * フィード型SPA(job.rikunabi.com)へ移行済み（実地確認）。本スクレイパは現行構造に対応:
 *
 *   1. フリーワード検索(GET): /job_search/?kw=社名
 *      → 結果見出し「{社名}の…一覧 N件」。該当が無いと「該当する募集がありません」。
 *      → 各募集は /company_jobs/{id}/ リンクで表現される（先頭が最上位ヒット）。
 *   2. 企業ページ: /company_jobs/{id}/?mode=selection（本選考ビュー）に
 *      会社名・卒年(例 27年卒)・職種・勤務エリア・募集タイトルが載る。
 *      ?mode=intern はインターン一覧。
 *
 * ※ 現行リクナビは旧構造と異なり、企業ページに電話/従業員数/採用担当者名は載らない
 *   （フィード型）。本スクレイパが回収するのは「掲載有無・卒年・職種・エリア」の新卒インテント。
 *
 * 使い方: node src/scrape-rikunabi.js "アイリスオーヤマ" ...
 * モジュール: const { RikunabiScraper } = require('./scrape-rikunabi')
 */
const { BaseMediaScraper, emptyResult, sleep } = require('./scrape-base');
const { normCompanyName } = require('./csv');

const CONFIG = {
  searchUrl: (q) => `https://job.rikunabi.com/job_search/?kw=${encodeURIComponent(q)}`,
  companyUrl: (id) => `https://job.rikunabi.com/company_jobs/${id}/?mode=selection`,
  internUrl: (id) => `https://job.rikunabi.com/company_jobs/${id}/?mode=intern`,
  companyLinkRe: /\/company_jobs\/(\d+)\//,
  noHitText: '該当する募集がありません',
  // 本選考ビューの職種・エリア（テキスト抽出のフォールバックも持つ）
  occupationLabels: ['営業', 'エンジニア', '企画', 'マーケティング', '事務', '販売', '技術', '研究',
    '人事', '広報', '経理', '財務', 'デザイン', 'コンサル', 'SE', '生産', '購買', '物流'],
};

class RikunabiScraper extends BaseMediaScraper {
  constructor(opts = {}) { super({ label: 'rikunabi', ...opts }); }

  /** @returns 共通スキーマ + { リクナビ掲載 } */
  async scrapeCompany(name) {
    const result = emptyResult(name, 'リクナビ掲載');
    const page = await this.newPage();
    try {
      const target = normCompanyName(name);
      // 1) フリーワード検索
      await this.goto(page, CONFIG.searchUrl(name));
      await this._dump(page, 'search:' + name);
      const text = await this.bodyText(page);
      if (text.includes(CONFIG.noHitText)) { result.根拠 = 'リクナビ該当募集なし'; return result; }

      // 2) 先頭の company_jobs リンク（最上位ヒット）を取得
      const ids = await page.$$eval('a[href*="/company_jobs/"]', (els) =>
        [...new Set(els.map((e) => {
          const m = (e.getAttribute('href') || '').match(/\/company_jobs\/(\d+)\//);
          return m ? m[1] : null;
        }).filter(Boolean))]).catch(() => []);
      if (!ids.length) { result.根拠 = 'リクナビ検索ヒット無し'; return result; }

      // 3) 候補を最大3社まで開き、会社名が一致するものを採用（おすすめ枠の取り違え防止）
      for (const id of ids.slice(0, 3)) {
        await this.goto(page, CONFIG.companyUrl(id));
        await this._dump(page, 'company:' + name);
        const ctext = await this.bodyText(page);
        const cnNorm = normCompanyName(ctext.slice(0, 200)); // ページ冒頭に会社名が出る
        if (target && (cnNorm.includes(target) || target.includes(cnNorm.slice(0, target.length)) || ctext.includes(name))) {
          result.リクナビ掲載 = '○'; result.掲載 = '○'; result.掲載媒体 = 'リクナビ';
          result.採用ページURL = CONFIG.companyUrl(id);
          this._readNewGrad(ctext, result);
          result.根拠 = '企業ページ(本選考)から新卒情報抽出';
          break;
        }
      }
      if (!result.リクナビ掲載) result.根拠 = 'リクナビ社名一致せず（おすすめのみ）';
    } catch (e) {
      result.根拠 = 'error:' + String(e && e.message || e).slice(0, 80);
    } finally {
      await page.close().catch(() => {});
    }
    return result;
  }

  // 本選考ビュー本文から 卒年/職種/エリア を抽出
  _readNewGrad(text, result) {
    const t = String(text || '').replace(/[ \t　]+/g, ' ');
    const gy = t.match(/(20[2-9]\d年卒|2[7-9]年卒)/);
    if (gy) result.卒年 = gy[1];
    // 職種は読点区切りの一覧で出る（「営業、SCM/生産管理…、人事、広報/IR、商品企画…」）
    const occ = CONFIG.occupationLabels.filter((o) => t.includes(o));
    if (occ.length) { result.募集職種 = occ.slice(0, 8).join('・'); result.募集職種数 = String(occ.length); }
    // 採用職種列にも入れる（系統A用）
    if (result.募集職種) result.採用職種 = result.募集職種;
  }
}

async function main() {
  const names = process.argv.slice(2);
  if (!names.length) {
    console.error('使い方: node src/scrape-rikunabi.js "会社名1" "会社名2" ...');
    console.error('  環境変数: SCRAPE_HEADFUL=1 SCRAPE_DEBUG=1 SCRAPE_SETTLE_MS=4000');
    process.exit(1);
  }
  const sc = new RikunabiScraper();
  await sc.launch();
  try {
    for (const nm of names) {
      process.stdout.write(`\n[リクナビ] ${nm} … `);
      const r = await sc.scrapeCompany(nm);
      console.log(JSON.stringify({
        掲載: r.リクナビ掲載 || '×', 卒年: r.卒年 || '', 職種: r.募集職種 || '',
        根拠: r.根拠, URL: r.採用ページURL || '',
      }, null, 0));
      await sleep(sc.delay);
    }
  } finally { await sc.close(); }
}
if (require.main === module) main().catch((e) => { console.error('FATAL', e); process.exit(1); });

module.exports = { RikunabiScraper, CONFIG };
