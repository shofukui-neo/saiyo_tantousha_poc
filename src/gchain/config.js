'use strict';
/**
 * G-Chain OS v1.5 — 00_設定 既定値（詳細設計書 §3.3, baseline §0）。
 * 実運用では 00_設定 シート（valid_from 付き行）が正本。ここはブートストラップ既定と型注釈。
 * 純データ（外部I/O無し）。
 */

const DEFAULTS = Object.freeze({
  // サンプリング（詳細§6.1 / baseline §1.2）
  daily_transcript_cap: 10,
  metric_sample_size: 7,
  diagnostic_size: 3,

  // 帰属窓（baseline §2.6 / §3.3）
  e8_attribution_days: 30,

  // canonical time_bucket 粒度（詳細§5.3）
  dedup_time_bucket_sec: 30,

  // 最小実務差（★仮・baseline §9.1）
  min_practical_effect: {
    E4_rate: 5, // pt
    E7_rate: 2, // pt
    Q_item: 0.3,
  },

  // モデルTier（2026-07時点・baseline §16）
  model: {
    T1: 'claude-opus-4-8',      // Frontier: 設計・曖昧帰属・実験判定
    T2: 'claude-opus-4-8',      // High: 大規模実装・例外処理
    T3: 'claude-sonnet-5',      // Standard: 定常LCS・GAS
    T4: 'claude-haiku-4-5-20251001', // Fast: 整形・バッチ
  },

  // purpose テンプレート（baseline §3.2）: 期待経路・成功定義・必須イベント
  purpose_template: {
    NEW_PROSPECTING: {
      expected_path: ['E2', 'E3', 'E4', 'E5', 'E6', 'E7'],
      success_def: 'E7強度2+ or A2+',
      required_events: ['E3', 'E4', 'E5', 'E6', 'E7'],
    },
    FOLLOWUP_MATERIAL: {
      expected_path: ['E2', 'E3', 'E4', 'E6', 'E7'],
      success_def: '確認日→面談転換 or 次期限',
      required_events: ['E3', 'E6', 'E7'],
    },
    CALLBACK_SCHEDULED: {
      expected_path: ['E2', 'E3', 'E6', 'E7'],
      success_def: '前回合意履行＋前進',
      required_events: ['E3', 'E6', 'E7'],
    },
    REACTIVATION: {
      expected_path: ['E2', 'E3', 'E4', 'E7'],
      success_def: '時期確認＋次接点',
      required_events: ['E3', 'E4', 'E7'],
    },
    CONFIRMATION: {
      expected_path: ['E2'],
      success_def: 'next_step_disposition=confirmed',
      required_events: ['E2'],
    },
  },

  // KPI 目標（baseline §10・目標値は運用で調整）
  kpi_targets: {
    match_rate: 0.95,
    metric_coverage: 0.90,
    e2_rate: null,
    e4_rate: null,
    e7_rate: null,
  },

  // ラベル品質（baseline §8）
  confidence_hold: 0.60,
  regression_review_period_calls: 100,

  // セキュリティ・保持（baseline §14）
  retention_days: 730,
});

/**
 * 00_設定 行（valid_from/valid_until 付き）から現在有効な値を引く（詳細§3.3）。
 * settingRows: [{ key, value, valid_from, valid_until }]
 * refDate: 参照日（'YYYY-MM-DD'）
 */
function resolveSetting(settingRows, key, refDate) {
  const candidates = settingRows
    .filter((r) => r.key === key)
    .filter((r) => (!r.valid_from || String(r.valid_from) <= refDate)
      && (!r.valid_until || refDate < String(r.valid_until)));
  if (!candidates.length) return undefined;
  // 最も新しい valid_from を採用
  candidates.sort((a, b) => String(b.valid_from || '') < String(a.valid_from || '') ? -1 : 1);
  return candidates[0].value;
}

/** 00_設定 初期投入行を DEFAULTS から生成（GAS setup 用・valid_from は呼出側で付与）。 */
function seedRows(validFrom) {
  const rows = [];
  const flat = (prefix, obj) => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) flat(key, v);
      else rows.push({ key, value: Array.isArray(v) ? JSON.stringify(v) : v, valid_from: validFrom || '', valid_until: '' });
    }
  };
  flat('', DEFAULTS);
  return rows;
}

module.exports = { DEFAULTS, resolveSetting, seedRows };
