'use strict';
const { CONFIDENCE_THRESHOLD, ROLE_KEYWORDS } = require('./config');

// 会社名・部署名など「人名ではない」典型語
const NON_PERSON = /(株式会社|有限会社|合同会社|合資会社|一般社団|財団|\bInc\b|\bCo\b|\bLtd\b|\bLLC\b|部$|課$|チーム$|担当$|窓口$|係$)/i;

/**
 * 抽出結果を検証し、HIT（採用担当者名として採用してよいか）を判定する。
 * 本番の並列レースでは、このゲートを通過したときだけ他ワーカーをキャンセルする。
 * @param {object} ext extractContact の戻り値
 * @param {{threshold?:number, roleKeywords?:string[]}} [opt]
 * @returns {{hit:boolean, reasons:string[]}}
 */
function validateHit(ext, opt = {}) {
  const threshold = opt.threshold ?? CONFIDENCE_THRESHOLD;
  const roleKeywords = opt.roleKeywords ?? ROLE_KEYWORDS;
  const reasons = [];

  if (!ext || !ext.found) return { hit: false, reasons: ['not found'] };

  const name = String(ext.name || '').trim();
  if (name.length < 2) reasons.push('name too short / empty');
  if (NON_PERSON.test(name)) reasons.push('looks like org/department, not a person');

  const roleText = `${ext.role || ''} ${ext.department || ''} ${ext.evidence || ''}`.toLowerCase();
  const roleOk = roleKeywords.some(k => roleText.includes(String(k).toLowerCase()));
  if (!roleOk) reasons.push('no recruiting/HR role signal');

  const conf = Number(ext.confidence || 0);
  if (conf < threshold) reasons.push(`confidence ${conf.toFixed(2)} < ${threshold}`);

  return { hit: reasons.length === 0, reasons };
}

module.exports = { validateHit, NON_PERSON };
