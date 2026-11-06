'use strict';
/**
 * 共通パイプライン ── 名寄せ済みの企業レコードを、どのソースから来ても同じ関所に通す
 * =====================================================================
 *   ゲート : NG(架電禁止) → 既存(MOCHICA顧客/BALES/SF/納品済み台帳) → 官公庁 → IT → ICPフロア
 *   段階   : L0 候補 → L1 ICP適合(規模の裏付けあり) → L2 架電可能(+電話) → L3 名指し可能(+担当者名・新卒6名+)
 *   採点   : mochica-fit.js（v5.1）
 *   出力   : csv.js の toCsv（NGガード込み）。除外明細も同じく toCsv
 *
 * 判定の規則はここで新しく作らない。ng-guard / exclusion-index / icp-rules / mochica-fit を
 * そのまま呼ぶだけにして、規則の単一情報源を崩さない。
 */
const crypto = require('crypto');
const ngGuard = require('../ng-guard');
const { ICP, isGovernmentOrg, isExcludedIndustry, passesIcpFloor, qualifiesForList } = require('../icp-rules');
const { scoreMochica } = require('../mochica-fit');
const { createMatchIndex } = require('../company-match');

const STAGES = ['L0', 'L1', 'L2', 'L3'];
const STAGE_LABEL = { L0: 'L0 候補', L1: 'L1 ICP適合', L2: 'L2 架電可能', L3: 'L3 名指し可能' };

const OUTPUT_HEADERS = ['企業名', '法人番号', '段階', 'アポ期待度', '優先度', '確信度',
  '採用担当者名', '役職', '部署', '電話番号', '公式URL', '都道府県', '市区町村',
  '業種', '業種(原文)', '従業員数', '従業員数下限(推定)', '規模帯', '採用予定人数', '拠点数',
  '既存母集団', '取得元ソース', 'ソース数', '項目出典', '根拠URL', '段階の理由', '付帯情報', '取得日'];
const EXCLUDED_HEADERS = ['企業名', '法人番号', '除外理由', '除外の詳細', '取得元ソース', '根拠URL'];

const hashOf = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

/** パイロット用の再現可能な抽出（社名ハッシュ順の先頭N社）。 */
function pilotSample(companies, n) {
  if (!n || companies.length <= n) return companies;
  return companies.slice().sort((a, b) => (hashOf(a.company_name) < hashOf(b.company_name) ? -1 : 1)).slice(0, n);
}

function toRow(c, date) {
  return {
    企業名: c.company_name, 法人番号: c.corp_no || '',
    採用担当者名: c.recruiter_name || '', 役職: c.recruiter_role || '', 部署: c.recruiter_dept || '',
    電話番号: c.phone || '', 公式URL: c.url || '', 都道府県: c.pref || '', 市区町村: c.city || '',
    業種: c.industry || '', '業種(原文)': c.industry_raw || '',
    従業員数: c.employees == null ? '' : c.employees,
    '従業員数下限(推定)': c.employees_min == null ? '' : c.employees_min,
    規模帯: c.employees_band || '',
    採用予定人数: c.hire_newgrad == null ? '' : c.hire_newgrad,
    拠点数: c.sites == null ? '' : c.sites,
    取得元ソース: c.sources.join(' / '), ソース数: c.sources.length,
    項目出典: Object.entries(c.src).map(([k, v]) => `${k}=${v}`).join(' '),
    根拠URL: c.evidence.slice(0, 3).join(' '),
    付帯情報: Object.keys(c.extra).length ? JSON.stringify(c.extra) : '',
    取得日: date,
  };
}

/**
 * ゲート判定。除外なら { reason, detail }、通過なら null（既存母集団の一致は除外せず印だけ付ける）。
 * 既存マスタと既存母集団は別々の索引で引く。1つの索引に混ぜると、母集団への「社名」一致が
 * マスタへの「表記ゆれ」一致より先に当たり、マスタにいる会社を通してしまう（2026-11-05 audit-leak で17件）。
 */
function gateOf(c, ex, pool) {
  if (ngGuard.isNg(c.company_name)) return { reason: 'NG(架電禁止)', detail: '' };
  const key = { 企業名: c.company_name, 法人番号: c.corp_no };
  if (ex) {
    const d = ex.idx.matchDetail(key);
    if (d.matched) return { reason: '既存', detail: `${d.label}（${d.tier}: ${d.master}）` };
  }
  if (pool) c.poolHit = pool.idx.has(key);
  if (isGovernmentOrg(c.company_name, c.industry)) return { reason: '官公庁', detail: '' };
  if (isExcludedIndustry(c.industry)) return { reason: 'IT/ソフト', detail: c.industry_raw || c.industry };
  const floor = passesIcpFloor({ emp: c.employees, hire: c.hire_newgrad });
  if (!floor.pass) return { reason: 'ICPフロア未満', detail: floor.reasons.join(' / ') };
  return null;
}

/** 段階判定。規模の裏付け（実数・下限推定・新卒人数・拠点数のどれか）が無ければ L0 のまま。 */
function stageOf(c, opt = {}) {
  const minSites = opt.minSites || 10;
  const why = [];
  const sized =
    (c.employees != null && c.employees >= ICP.EMP_MIN && why.push(`従業員${c.employees}名`)) ||
    (c.employees_min != null && c.employees_min >= ICP.EMP_MIN && why.push(`従業員${c.employees_min}名以上(推定)`)) ||
    (c.hire_newgrad != null && c.hire_newgrad >= ICP.HIRE_MIN && why.push(`新卒${c.hire_newgrad}名`)) ||
    (c.sites != null && c.sites >= minSites && why.push(`拠点${c.sites}`));
  if (!sized) return { stage: 'L0', why: '規模の裏付けなし(要エンリッチ)' };
  if (!c.phone) return { stage: 'L1', why: `${why.join('')}・電話なし` };
  const q = qualifiesForList({ company: c.company_name, contactName: c.recruiter_name, phone: c.phone,
    hire: c.hire_newgrad, emp: c.employees, industry: c.industry });
  if (q.pass) return { stage: 'L3', why: `${why.join('')}・電話・担当者名・新卒${c.hire_newgrad}名` };
  return { stage: 'L2', why: `${why.join('')}・電話あり／名指し不可: ${q.reasons.join(' / ')}` };
}

/**
 * @param {object[]} companies resolveCompanies の出力
 * @param {{exclusion?:object, pool?:object, minSites?:number, freshOnly?:boolean, date?:string}} opt
 *   exclusion … buildExclusionIndex()（顧客/BALES/SF/納品済み台帳）。一致したら除外
 *   pool      … buildExclusionIndex({ layers: ['pool'] })（既存母集団）。一致は印だけ（--fresh-only で除外）
 *   テストではどちらも { idx: createMatchIndex() } に差し替えられる
 */
function runPipeline(companies, opt = {}) {
  const date = opt.date || new Date().toISOString().slice(0, 10);
  const kept = [];
  const excluded = [];
  const drop = (c, gate) => {
    c.gate = gate;
    excluded.push({ c, row: { 企業名: c.company_name, 法人番号: c.corp_no || '', 除外理由: gate.reason,
      除外の詳細: gate.detail, 取得元ソース: c.sources.join(' / '), 根拠URL: c.evidence[0] || '' } });
  };
  for (const c of companies) {
    const g = gateOf(c, opt.exclusion, opt.pool);
    if (g) { drop(c, g); continue; }
    if (opt.freshOnly && c.poolHit) { drop(c, { reason: '既存母集団(未納品)', detail: '' }); continue; }
    const st = stageOf(c, opt);
    c.stage = st.stage;
    const row = toRow(c, date);
    const s = scoreMochica(row);
    Object.assign(row, { 段階: STAGE_LABEL[st.stage], 段階の理由: st.why, 既存母集団: c.poolHit ? '1' : '',
      アポ期待度: s.total, 優先度: s.priority, 確信度: s.confidence });
    kept.push({ c, row });
  }
  kept.sort((a, b) => STAGES.indexOf(b.c.stage) - STAGES.indexOf(a.c.stage) || b.row.アポ期待度 - a.row.アポ期待度 ||
    (b.c.sites || 0) - (a.c.sites || 0));

  // 出力内の同名重複。法人番号が違う同名の別法人（全国の「有限会社さくら」）は名寄せでは別会社だが、
  // 架電リストに同じ社名が2行並ぶと納品ゲート（audit-leak の自己重複）で落ちる。上位の1社だけ残す。
  const seen = createMatchIndex();
  const unique = [];
  for (const k of kept) {
    const key = { 企業名: k.c.company_name, 法人番号: k.c.corp_no };
    const d = seen.matchDetail(key);
    if (d.matched) { k.c.stage = null; drop(k.c, { reason: '同名の別法人', detail: `上位の「${d.master}」を残した（${d.tier}）` }); continue; }
    seen.addRecord(key, k.c.company_name);
    unique.push(k);
  }
  return { kept: unique, excluded };
}

/**
 * ソース別スコアカード。複数ソースに出た会社は、それぞれのソースに数える。
 * @returns {object[]} ソースごとの集計
 */
function scorecard(result, sourceIds) {
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const all = [...result.kept.map((k) => k.c), ...result.excluded.map((e) => e.c)];
  return sourceIds.map((id) => {
    const cs = all.filter((c) => c.sources.includes(id));
    const keep = cs.filter((c) => !c.gate);
    const by = (r) => cs.filter((c) => c.gate && c.gate.reason === r).length;
    const stage = Object.fromEntries(STAGES.map((s) => [s, keep.filter((c) => c.stage === s).length]));
    const known = cs.filter((c) => c.gate && c.gate.reason === '既存').length;
    const pool = cs.filter((c) => c.poolHit).length;
    return {
      source: id, 社数: cs.length,
      除外: { NG: by('NG(架電禁止)'), 既存: known, 官公庁: by('官公庁'), IT: by('IT/ソフト'), フロア未満: by('ICPフロア未満'),
        既存母集団: by('既存母集団(未納品)'), 同名の別法人: by('同名の別法人') },
      新規率: pct(cs.length - known - pool, cs.length),
      ICP適合率: pct(keep.length - stage.L0, cs.length),
      電話率: pct(keep.filter((c) => c.phone).length, keep.length),
      担当者名率: pct(keep.filter((c) => c.recruiter_name).length, keep.length),
      新卒6名以上率: pct(keep.filter((c) => c.hire_newgrad != null && c.hire_newgrad >= ICP.HIRE_MIN).length, keep.length),
      業種あり率: pct(keep.filter((c) => c.industry).length, keep.length),
      段階: stage,
    };
  });
}

module.exports = { runPipeline, scorecard, pilotSample, stageOf, gateOf, toRow, OUTPUT_HEADERS, EXCLUDED_HEADERS, STAGES, STAGE_LABEL };
