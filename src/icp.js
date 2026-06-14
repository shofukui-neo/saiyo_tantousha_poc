'use strict';
// L1: 商材 → ICP（理想顧客プロファイル）。
//  - GEMINI_KEY ＋ PRODUCT_DESC があれば Gemini で生成。
//  - 無ければ .env の手動設定（業種・地域・従業員レンジ）から ICP を組み立てる。
// いずれの場合も discovery.js / score.js が使える共通形に正規化して返す。
const cfg = require('./config');
const { geminiAvailable, geminiJson } = require('./gemini');

// ICP を共通スキーマへ正規化（欠損は手動設定/既定で補完）
function normalizeIcp(icp, c = cfg) {
  icp = icp || {};
  const size = icp.company_size || {};
  return {
    primary_value_prop: icp.primary_value_prop || '',
    target_industries: (icp.target_industries && icp.target_industries.length)
      ? icp.target_industries : c.ICP_INDUSTRIES,
    geography: (icp.geography && icp.geography.length)
      ? icp.geography : c.ICP_PREFECTURES,
    company_size: {
      employees_min: Number.isFinite(size.employees_min) ? size.employees_min : c.ICP_EMP_MIN,
      employees_max: Number.isFinite(size.employees_max) ? size.employees_max : c.ICP_EMP_MAX,
    },
    buying_signals: icp.buying_signals || [],
    pain_points: icp.pain_points || [],
    buyer_persona: {
      titles: (icp.buyer_persona && icp.buyer_persona.titles) || [],
      departments: (icp.buyer_persona && icp.buyer_persona.departments && icp.buyer_persona.departments.length)
        ? icp.buyer_persona.departments : [c.ICP_DEPARTMENT],
    },
    exclusion: icp.exclusion || [],
    source: icp.source || 'manual',
  };
}

// Gemini で商材説明から ICP を生成
async function buildIcpViaGemini(c = cfg) {
  const prompt =
    'あなたはB2B SaaSのRevOpsアナリストです。次の自社商材から理想顧客プロファイル(ICP)を日本語でJSON出力してください。\n' +
    '商材説明:\n' + c.PRODUCT_DESC + '\n' +
    (c.PRODUCT_EXISTING ? '既存受注（参考・類似性を学習）:\n' + c.PRODUCT_EXISTING + '\n' : '') +
    '出力キー: primary_value_prop(string), target_industries(string[]), ' +
    'company_size{employees_min:int, employees_max:int}, geography(string[]都道府県), ' +
    'buying_signals(string[]), pain_points(string[]), ' +
    'buyer_persona{titles:string[], departments:string[]}, exclusion(string[])';
  const j = await geminiJson(prompt, { maxTokens: 1200 }, c);
  return j ? Object.assign({ source: 'gemini' }, j) : null;
}

/**
 * ICP を取得。Gemini が使えて商材説明があれば生成、無ければ手動設定。
 * @returns {Promise<object>} 正規化済みICP
 */
async function getIcp(c = cfg) {
  if (geminiAvailable(c) && c.PRODUCT_DESC) {
    const icp = await buildIcpViaGemini(c);
    if (icp) return normalizeIcp(icp, c);
  }
  return normalizeIcp({ source: 'manual' }, c);
}

module.exports = { getIcp, normalizeIcp, buildIcpViaGemini };
