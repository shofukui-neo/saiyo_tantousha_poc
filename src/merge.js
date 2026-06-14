'use strict';
// 多系統ソース統合・名寄せエンジン（設計「6. 統合オペレーション」）。
//   突合キー = 法人番号（無ければ正規化社名） で複数ソースを1レコードに統合。
//   役割固定 = 系統A(新卒フラグ)/系統B(属性)/系統C(intent) で、フィールドごとに権威ソースを採用。
//   重複は法人番号で排除。各レコードに 取得元媒体（出所）/系統/intent★/起点 を刻む（KPI帰属の土台）。
// 純ロジック（ネットワーク/APIキー不要）。fs は build-list.js 側で扱う。
const cfg = require('./config');
const { normCorpNumber, normCompanyName, mergeKey, truthy } = require('./csv');

// 系統の優先順位（起点の確定・取得元媒体の並び順）。設計: 採用メディアA起点 → C → D → B。
const SYSTEM_ORDER = ['A', 'C', 'D', 'B'];
function systemRank(sys) { const i = SYSTEM_ORDER.indexOf(sys); return i < 0 ? 99 : i; }

function numOr(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }

/**
 * intent★（0-5）を算出。系統の既定強度＋manifest個別intent＋トリガー列の数。
 * @param {object} rec マージ後（または途中）のレコード
 * @param {string[]} systems 寄与した系統の配列
 * @param {number[]} srcIntents manifest で指定された source 別 intent 値
 */
function intentStars(rec, systems, srcIntents, c = cfg) {
  const sysIntent = (c.SYSTEM_INTENT) || {};
  let base = 0;
  for (const s of (systems || [])) base = Math.max(base, sysIntent[s] || 0);
  for (const v of (srcIntents || [])) base = Math.max(base, numOr(v, 0));
  // 系統Cの「今動いている」トリガー列を加点（各1★）
  const triggers = (c.INTENT_TRIGGER_COLS || []).filter((k) => truthy(rec[k]));
  const stars = Math.min(5, Math.round(base) + triggers.length);
  return { stars, triggers };
}

// 寄与レコード群から、connectフィールドを確度優先で1値選ぶ
function pickByConfidence(contribs, field, confField) {
  let best = '', bestConf = -1;
  for (const ct of contribs) {
    const v = String(ct.rec[field] == null ? '' : ct.rec[field]).trim();
    if (!v) continue;
    const conf = confField ? numOr(ct.rec[confField], 0) : 0;
    if (conf > bestConf || (conf === bestConf && !best)) { best = v; bestConf = conf; }
  }
  return best;
}

// 役割固定でフィールド値を選ぶ。owners(系統配列)があればその系統の非空値を優先、無ければ最初の非空値。
function pickByOwner(contribs, field, owners) {
  if (owners && owners.length) {
    const ordered = contribs.slice().sort((a, b) => owners.indexOf(a.system) - owners.indexOf(b.system));
    for (const ct of ordered) {
      if (owners.indexOf(ct.system) < 0) continue;
      const v = String(ct.rec[field] == null ? '' : ct.rec[field]).trim();
      if (v) return v;
    }
  }
  for (const ct of contribs) {
    const v = String(ct.rec[field] == null ? '' : ct.rec[field]).trim();
    if (v) return v;
  }
  return '';
}

/**
 * ソース群を統合。
 * @param {Array<{system:string, source:string, intent?:number, cost?:number, records:object[]}>} sources
 * @param {object} c config
 * @returns {{master:object[], stats:object}}
 */
function mergeSources(sources, c = cfg) {
  const owners = c.FIELD_OWNERS || {};
  const contactFields = c.CONTACT_FIELDS || [];
  const flagCols = c.SHINSOTSU_FLAG_COLS || [];

  // 1) 各ソースのレコードに出所メタを付け、名寄せキーでグルーピング
  const groups = new Map();          // key -> [{rec, system, source, intent, cost}]
  let rawCount = 0, noKey = 0;
  const allCols = new Set();

  for (const src of (sources || [])) {
    for (const rec of (src.records || [])) {
      rawCount++;
      const key = mergeKey(rec);
      Object.keys(rec).forEach((k) => allCols.add(k));
      if (!key) { noKey++; continue; }
      const entry = { rec, system: src.system, source: src.source, intent: src.intent, cost: src.cost };
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
  }

  // 統合で必ず持たせる出力メタ列
  const META_COLS = ['取得元媒体', '系統', '起点系統', '起点ソース', 'ソース数', '新卒フラグ', 'intent★', 'トリガー', '名寄せキー'];
  // フィールド集合（メタ列は値マージの対象外）
  const valueCols = Array.from(allCols).filter((k) => META_COLS.indexOf(k) < 0);

  const master = [];
  for (const [key, contribs] of groups) {
    // 起点：系統優先順位で最上位の寄与を起点とする（A=新卒フラグ起点を最優先）
    const ordered = contribs.slice().sort((a, b) => systemRank(a.system) - systemRank(b.system));
    const origin = ordered[0];
    const systems = Array.from(new Set(contribs.map((x) => x.system))).sort((a, b) => systemRank(a) - systemRank(b));
    const sources = Array.from(new Set(ordered.map((x) => x.source).filter(Boolean)));

    const out = {};
    // 値フィールドを役割固定でマージ
    for (const col of valueCols) {
      if (contactFields.indexOf(col) >= 0) continue; // 連絡先は後でまとめて確度優先
      out[col] = pickByOwner(contribs, col, owners[col]);
    }
    // 連絡先は確度優先
    out['採用担当者名'] = pickByConfidence(contribs, '採用担当者名', '担当者確度');
    out['メール'] = pickByConfidence(contribs, 'メール', 'メール確度');
    for (const f of ['役職', '部署', '電話番号', 'メール確度', '担当者確度']) {
      if (contactFields.indexOf(f) >= 0 && out[f] == null) out[f] = pickByOwner(contribs, f, null);
    }

    // 新卒フラグ：系統A寄与あり、または新卒系列のいずれかが truthy
    const hasA = systems.indexOf('A') >= 0;
    const flagged = hasA || contribs.some((ct) => flagCols.some((col) => truthy(ct.rec[col])));
    out['新卒フラグ'] = flagged ? '○' : '';

    // intent★・トリガー
    const srcIntents = contribs.map((x) => x.intent).filter((v) => v != null);
    const { stars, triggers } = intentStars(out, systems, srcIntents, c);
    out['intent★'] = stars;
    out['トリガー'] = triggers.join('+');

    // 出所メタ
    out['取得元媒体'] = sources.join('+');
    out['系統'] = systems.join(',');
    out['起点系統'] = origin.system;
    out['起点ソース'] = origin.source || '';
    out['ソース数'] = contribs.length;
    out['名寄せキー'] = key;
    // 法人番号・企業名を正規化済みで補完（空なら寄与から拾う）
    if (!out['法人番号']) out['法人番号'] = pickByOwner(contribs, '法人番号', null);
    if (!out['企業名']) out['企業名'] = pickByOwner(contribs, '企業名', null);

    master.push(out);
  }

  // 統計
  const bySystem = {};
  for (const src of (sources || [])) {
    const s = src.system;
    bySystem[s] = bySystem[s] || { sources: new Set(), raw: 0 };
    bySystem[s].sources.add(src.source);
    bySystem[s].raw += (src.records || []).length;
  }
  const stats = {
    rawCount, noKey, unique: master.length, dedupRemoved: rawCount - noKey - master.length,
    flagged: master.filter((m) => m['新卒フラグ']).length,
    multiSource: master.filter((m) => (m['ソース数'] || 0) > 1).length,
    bySystem: Object.fromEntries(Object.entries(bySystem).map(([k, v]) => [k, { sources: v.sources.size, raw: v.raw }])),
    starHist: master.reduce((a, m) => { const s = m['intent★'] || 0; a[s] = (a[s] || 0) + 1; return a; }, {}),
    metaCols: META_COLS,
  };
  return { master, stats };
}

module.exports = { mergeSources, intentStars, systemRank, SYSTEM_ORDER };
