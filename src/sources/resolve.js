'use strict';
/**
 * 名寄せ ── 複数ソースの観測を「1社1レコード」に畳む
 * =====================================================================
 * 突合規則は company-match.js（法人番号 → 社名 → 農協 → 表記ゆれ）をそのまま使う。
 * 長音ゆれ（tier5）は別法人の衝突があり得るので、ソース間の合流には使わない。
 *
 * 項目ごとに「どのソースの値か」を残す（出力の「項目出典」列）。値の採用順は
 *   ソース信頼度（登録簿 reliability）の高い順 → 観測順。先に入った非空値を優先する。
 */
const { createMatchIndex } = require('../company-match');
const { normCorpNumber } = require('../csv');

const FIELDS = ['corp_no', 'url', 'phone', 'pref', 'city', 'industry_raw', 'industry',
  'employees', 'employees_min', 'employees_band', 'hire_newgrad', 'sites',
  'recruiter_name', 'recruiter_role', 'recruiter_dept'];

const empty = (v) => v == null || v === '';

/**
 * @param {object[]} observations 観測レコード（複数ソース混在可）
 * @param {{reliabilityOf?:(id:string)=>number}} [opt]
 * @returns {object[]} 企業レコード
 */
function resolveCompanies(observations, opt = {}) {
  const rel = opt.reliabilityOf || (() => 1);
  const ordered = observations
    .map((o, i) => ({ o, i, r: rel(o.source_id) }))
    .sort((a, b) => b.r - a.r || a.i - b.i)
    .map((x) => x.o);

  const idx = createMatchIndex({ fuzzy: false });
  const byId = new Map();
  let seq = 0;

  for (const o of ordered) {
    const key = { 企業名: o.company_name, 法人番号: o.corp_no };
    const hit = idx.matchDetail(key);
    let c = hit.matched ? byId.get(hit.label) : null;
    // 社名が同じでも法人番号が両方あって食い違うなら別法人（全国に同名の「有限会社さくら」は多い）。
    // この場合は社名キーで引けないよう、法人番号だけで索引に載せる。
    const conflict = c && hit.tier !== '法人番号' && o.corp_no && c.corp_no && normCorpNumber(o.corp_no) !== normCorpNumber(c.corp_no);
    if (conflict) {
      c = { id: `c${++seq}`, company_name: o.company_name, sources: [], evidence: [], extra: {}, signals: [], src: {}, matchTiers: [] };
      byId.set(c.id, c);
      idx.addBango(o.corp_no, c.id, o.company_name);
    }
    if (!c) {
      c = { id: `c${++seq}`, company_name: o.company_name, sources: [], evidence: [], extra: {}, signals: [], src: {}, matchTiers: [] };
      byId.set(c.id, c);
    } else if (hit.tier) {
      c.matchTiers.push(hit.tier);
    }
    if (!conflict) idx.addRecord(key, c.id);
    if (!c.sources.includes(o.source_id)) c.sources.push(o.source_id);
    if (o.evidence_url && !c.evidence.includes(o.evidence_url)) c.evidence.push(o.evidence_url);
    for (const f of FIELDS) {
      if (empty(c[f]) && !empty(o[f])) { c[f] = o[f]; c.src[f] = o.source_id; }
    }
    if (o.signal) c.signals.push({ ...o.signal, source: o.source_id });
    if (o.extra && Object.keys(o.extra).length) c.extra[o.source_id] = o.extra;
  }
  for (const c of byId.values()) c.corp_no = normCorpNumber(c.corp_no);
  return [...byId.values()];
}

module.exports = { resolveCompanies, FIELDS };
