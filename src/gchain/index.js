'use strict';
/**
 * G-Chain OS v1.5 — Node バレル（詳細設計書 §12 のロジック層を一括輸出）。
 * GAS へは build-gas.js が同一ソースをバンドルする（単一正本）。
 */
module.exports = {
  schema: require('./schema'),
  config: require('./config'),
  normalize: require('./normalize'),
  canonical: require('./canonical'),
  eventEngine: require('./event-engine'),
  sampling: require('./sampling'),
  scoring: require('./scoring'),
  kpi: require('./kpi'),
  experiment: require('./experiment'),
  llmContract: require('./llm-contract'),
  meta: require('./meta'),
};
