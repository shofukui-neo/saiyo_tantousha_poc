'use strict';
/**
 * G-Chain OS v2.0 — 構造化特徴抽出（設計書 §3）。
 * 架電時点で確定している列のみを特徴化。失注理由・商談・最終ステージ等の
 * 架電後に変化する列は特徴に入れない（未来情報禁止・原則8）→ ラベル側(outcome.js)。
 * 純関数（外部I/O無し）。
 */

// 架電時点で確定している特徴列（column → feature_key）
const FEATURE_SPECS = [
  { key: 'recruit_size', col: 'カスタム情報：採用人数(選択リスト)', type: 'categorical' },
  { key: 'industry', col: '会社情報：業種', type: 'categorical' },
  { key: 'emp_scale', col: '会社情報：従業員規模', type: 'categorical' },
  { key: 'pref', col: '会社情報：住所：都道府県', type: 'categorical' },
  { key: 'current_ats', col: 'カスタム情報：利用中ATS', type: 'categorical' },
  { key: 'consider_timing', col: 'カスタム情報：検討開始時期', type: 'categorical' },
  { key: 'renewal_month', col: 'カスタム情報：現利用サービス更新予定月', type: 'categorical' },
  { key: 'owner', col: 'リード関連情報：リード所有者', type: 'categorical' },
  { key: 'lead_stage_at_call', col: 'リード関連情報：最終リードステージ', type: 'categorical', caveat: 'mutable' },
];

// 架電後に確定する＝ラベル側（特徴に混ぜてはならない）
const LABEL_COLUMNS = [
  'コール結果1：結果', 'コール結果1：接続状況', 'コール結果1：接続先',
  '商談1：商談作成日時', '商談1：日時', '商談1：金額',
  'カスタム情報：失注商談失注理由大', 'カスタム情報：失注商談失注理由中', 'カスタム情報：失注商談失注理由小',
  'カスタム情報：失注商談失注日', 'カスタム情報：失注商談',
];

/** リードソースを1つに要約（最初に流入日時が入っているソース）。 */
function primarySource(rec) {
  const prefixes = Object.keys(rec).filter((k) => k.indexOf('リードソース：') === 0);
  let best = null, bestAt = null;
  for (const k of prefixes) {
    const v = (rec[k] || '').toString().trim();
    if (!v) continue;
    const name = k.replace('リードソース：', '');
    const at = (rec['リード流入日時：' + name] || '').toString().trim();
    if (best == null || (at && (bestAt == null || at < bestAt))) { best = name; bestAt = at || bestAt; }
  }
  return best || '不明';
}

/** 架電日時 → 曜日・時間帯（架電時点で確定＝特徴に使える）。 */
function callTimeFeatures(callAt) {
  const out = { call_weekday: 'unk', call_band: 'unk' };
  const m = String(callAt || '').match(/(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):/);
  if (!m) return out;
  const [, y, mo, d, hh] = m.map(Number);
  const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); // 0=日
  out.call_weekday = ['日', '月', '火', '水', '木', '金', '土'][wd];
  out.call_band = hh < 11 ? 'am' : hh < 14 ? 'noon' : hh < 17 ? 'pm' : 'eve';
  return out;
}

/** 採用人数帯を MOCHICA ICP 3区分に丸め（50-150名が設計期の主戦場）。 */
function icpBand(recruitSize) {
  const s = String(recruitSize || '');
  const m = s.match(/(\d+)\s*[～~-]\s*(\d+)/);
  if (!m) return 'unknown';
  const hi = Number(m[2]);
  if (hi <= 15) return 'micro';        // ~15名
  if (hi <= 50) return 'small';        // 16-50
  if (hi <= 150) return 'icp_core';    // 51-150（本命）
  return 'large';                       // 151+
}

/**
 * 架電時点特徴を抽出（設計書 §3.1-3.2）。
 * 返り値: { features:{...}, leak:[] }。leak が非空なら未来情報混入。
 */
function extractFeatures(rec) {
  const features = {};
  for (const spec of FEATURE_SPECS) {
    features[spec.key] = (rec[spec.col] || '').toString().trim() || null;
  }
  features.source = primarySource(rec);
  features.icp_band = icpBand(features.recruit_size);
  const callAt = (rec['コール結果1：開始日時'] || '').toString().trim();
  Object.assign(features, callTimeFeatures(callAt));

  // リーク検査: ラベル列が features に紛れていないか（キー名で機械チェック）
  const leak = [];
  const labelKeys = new Set(['結果', '商談', '失注', '接続状況', '接続先']);
  for (const [k, v] of Object.entries(features)) {
    if (v && [...labelKeys].some((lk) => k.indexOf(lk) >= 0)) leak.push(k);
  }
  return { features, leak };
}

module.exports = {
  FEATURE_SPECS, LABEL_COLUMNS,
  primarySource, callTimeFeatures, icpBand, extractFeatures,
};
