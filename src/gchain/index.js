'use strict';
/**
 * G-Chain OS — Node バレル。
 * v2.0（構造化シグナル版・MiiTel非依存）が現行。設計: docs/g-chain-os-v2.0-structured-only.md
 *
 * 生存(v1.5継承): schema/config/normalize/canonical/eventEngine/kpi/experiment/meta
 * 新規(v2.0):     features/outcome/lossIntel/reactivation/discipline/balesMap
 * 廃止(transcript前提): sampling/scoring/llmContract → require はできるが barrel から除外（設計書 §9）
 */
module.exports = {
  // データ基盤（v1.5継承）
  schema: require('./schema'),
  config: require('./config'),
  normalize: require('./normalize'),
  canonical: require('./canonical'),
  eventEngine: require('./event-engine'),
  kpi: require('./kpi'),
  experiment: require('./experiment'),
  meta: require('./meta'),
  // Wave 0 マッピング
  balesMap: require('./bales-map'),
  // v2.0 構造化分析層
  features: require('./features'),
  outcome: require('./outcome'),
  lossIntel: require('./loss-intel'),
  reactivation: require('./reactivation'),
  discipline: require('./discipline'),
};
