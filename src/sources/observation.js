'use strict';
/**
 * 観測レコード（Observation）── 全ソースアダプタの出力の共通形
 * =====================================================================
 * アダプタは「このソースでこの会社をこう観測した」を1件ずつ返すだけで、除外・採点・出力はしない。
 * 取れなかった項目は空のまま（推定値で埋めない）。推定値は *_min のように推定と分かる名前で持つ。
 *
 *   {
 *     source_id, observed_at, company_name, corp_no,
 *     url, phone, pref, city, industry_raw, industry,
 *     employees,        // 従業員数（実数）
 *     employees_min,    // 従業員数の下限推定（区分基準などから。実数ではない）
 *     employees_band,   // 規模帯ラベル（例: 健康経営の「大規模法人部門」）
 *     hire_newgrad,     // 年間新卒採用人数
 *     sites,            // 拠点・事業所数
 *     recruiter_name, recruiter_role, recruiter_dept,
 *     signal,           // 出来事 { type, date }（出来事系ソースのみ）
 *     evidence_url,     // 必須。この観測の出典
 *     extra,            // ソース固有の付帯情報（出力の「付帯情報」列にJSONで残す）
 *   }
 */
const { normCorpNumber } = require('../csv');

const STR_FIELDS = ['company_name', 'url', 'phone', 'pref', 'city', 'industry_raw', 'industry',
  'employees_band', 'recruiter_name', 'recruiter_role', 'recruiter_dept', 'evidence_url'];
const NUM_FIELDS = ['employees', 'employees_min', 'hire_newgrad', 'sites'];

const str = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v == null ? '' : v).normalize('NFKC').replace(/[,，名人社]/g, '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(parseFloat(s));
}

/**
 * 1件を正規化して検証する。
 * @returns {{ok:boolean, obs:object, errors:string[]}}
 */
function normalize(raw, sourceId, observedAt) {
  const o = { source_id: sourceId, observed_at: observedAt };
  for (const f of STR_FIELDS) o[f] = str(raw[f]);
  for (const f of NUM_FIELDS) o[f] = num(raw[f]);
  o.corp_no = normCorpNumber(raw.corp_no);
  o.signal = raw.signal && raw.signal.type ? { type: str(raw.signal.type), date: str(raw.signal.date) } : null;
  o.extra = raw.extra && typeof raw.extra === 'object' ? raw.extra : {};
  const errors = [];
  if (!o.company_name) errors.push('company_name が空');
  if (!o.evidence_url) errors.push('evidence_url が空');
  return { ok: errors.length === 0, obs: o, errors };
}

module.exports = { normalize, STR_FIELDS, NUM_FIELDS };
