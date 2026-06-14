'use strict';
// L5: スコアリング・Tier・架電呼称・ドメイン正規化など、純ロジックのユーティリティ。
const cfg = require('./config');

// URL or ドメイン文字列 → 正規化ドメイン（protocol/www/パス/クエリを除去・小文字化）
function normalizeDomain(urlOrDomain) {
  let s = String(urlOrDomain || '').trim();
  if (!s) return '';
  s = s.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  s = s.split('/')[0].split('?')[0].split('#')[0];
  return s.toLowerCase().trim();
}

/**
 * ICP適合スコア（発掘段階・0〜100）。従業員規模を主軸に、HP有無・代表者名有無を加味。
 * @param {{employees:?number, websiteUrl:?string, representativeName:?string}} h
 */
function discoveryIcpScore(h, c = cfg) {
  const sweetMin = c.ICP_EMP_SWEET_MIN, sweetMax = c.ICP_EMP_SWEET_MAX;
  const empMin = c.ICP_EMP_MIN, empMax = c.ICP_EMP_MAX;
  let score = 0;
  // (A) 従業員規模：最大60点
  if (h.employees != null) {
    const e = h.employees;
    if (e >= sweetMin && e <= sweetMax) score += 60;
    else if (e >= 80 && e < sweetMin) score += 48;
    else if (e > sweetMax && e <= empMax) score += 44;
    else if (e >= empMin && e < 80) score += 32;
    else score += 12;
  } else {
    score += 20; // 不明はニュートラル寄り
  }
  // (B) 自社HP有無：最大25点（採用担当者レース成功率に直結）
  if (h.websiteUrl) score += 25;
  // (C) 代表者名が取れている：最大15点
  if (h.representativeName) score += 15;
  // (D) 補助金採択（国の信用・買いシグナル）：+8（gBiz source=4 突合）
  if (h.subsidy) score += 8;
  // (E) 設立の継続性（新卒採用の定着しやすさ）：10年以上 +5 / 5年以上 +3
  if (h.establishmentYear) {
    const yrs = (new Date()).getFullYear() - Number(h.establishmentYear);
    if (yrs >= 10) score += 5; else if (yrs >= 5) score += 3;
  }
  return Math.min(100, Math.round(score));
}

/**
 * Tier 判定。担当者確度・メール確度・代表者名の有無から A〜D を返す。
 */
function tierOf(hitScore, emailScore, hasRep, c = cfg) {
  const th = c.SCORE_THRESHOLD;
  if (hitScore >= 0.8 && emailScore >= 0.8) return 'A';
  if (hitScore >= th || emailScore >= 0.8) return 'B';
  if (hasRep) return 'C';
  return 'D';
}

/**
 * 架電時の呼称を生成（担当者名が取れなくても必ず作る）。
 * ICP の部署/シグナルから「新卒/中途」を推定して敬称を調整。
 */
function callScript(icp, c = cfg) {
  let dept = c.ICP_DEPARTMENT || '人事部';
  let role = 'ご採用ご担当者様';
  if (icp && icp.buyer_persona && icp.buyer_persona.departments && icp.buyer_persona.departments[0]) {
    dept = icp.buyer_persona.departments[0];
  }
  const hint = icp ? ((icp.primary_value_prop || '') + ' ' + JSON.stringify(icp.buying_signals || [])) : '';
  if (/新卒/.test(hint)) role = '新卒採用ご担当者様';
  else if (/中途|キャリア/.test(hint)) role = '中途採用ご担当者様';
  return dept + ' ' + role;
}

module.exports = { normalizeDomain, discoveryIcpScore, tierOf, callScript };
