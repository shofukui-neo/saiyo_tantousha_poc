'use strict';
/**
 * 共通エンリッチ ── ゲートの前に、判定に要る項目（従業員数・URL・所在地）を補う
 * =====================================================================
 * いまは gBizINFO の法人基本情報だけ（法人番号つきの会社のみ）。GBIZ_TOKEN が無ければ何もしない。
 * 電話・担当者名の補完は既存の phone.js / harvest 系を、段階 L1/L2 のキューとして後段で回す。
 */
const { gbizAvailable, gbizGet } = require('../gbiz');

/**
 * @param {object[]} companies resolveCompanies の出力（その場で書き換える）
 * @param {{limit:number, log?:(m:string)=>void}} opt
 * @returns {Promise<{tried:number, filled:number, skipped:string}>}
 */
async function enrichWithGbiz(companies, opt) {
  const log = opt.log || (() => {});
  if (!opt.limit) return { tried: 0, filled: 0, skipped: '' };
  if (!gbizAvailable()) return { tried: 0, filled: 0, skipped: 'GBIZ_TOKEN 未設定' };
  const todo = companies.filter((c) => c.corp_no && (c.employees == null || !c.url)).slice(0, opt.limit);
  let filled = 0;
  for (const c of todo) {
    const h = await gbizGet(c.corp_no);
    if (!h) continue;
    let hit = false;
    if (c.employees == null && h.employees != null) { c.employees = h.employees; c.src.employees = 'gbiz-basic'; hit = true; }
    if (!c.url && h.websiteUrl) { c.url = h.websiteUrl; c.src.url = 'gbiz-basic'; hit = true; }
    if (!c.pref && h.prefecture) { c.pref = h.prefecture; c.src.pref = 'gbiz-basic'; hit = true; }
    if (hit) { filled++; if (!c.sources.includes('gbiz-basic')) c.sources.push('gbiz-basic'); }
  }
  log(`gBizINFO 補完: ${todo.length}社に問い合わせ → ${filled}社を補完`);
  return { tried: todo.length, filled, skipped: '' };
}

module.exports = { enrichWithGbiz };
