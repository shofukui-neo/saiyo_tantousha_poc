'use strict';
/**
 * G-Chain OS v1.5 — HUBスキーマ単一正本（詳細設計書 §3）。
 * 19シートの列定義・型・enum語彙をコードから参照する唯一の源。
 * GAS setup（シート生成・列順固定）と Node ロジック双方がここを読む。
 *
 * 参照: docs/g-chain-os-v1.5-detailed-design.md §3 / baseline §6
 * 純データ（外部I/O無し）。
 */

const SCHEMA_VERSION = '1.5';

// 状態語彙（baseline §2.1）
const EVENT_STATE = Object.freeze(['TRUE', 'FALSE', 'UNKNOWN', 'NOT_ELIGIBLE']);

// イベントコード（baseline §2.3）
const EVENT_CODES = Object.freeze(['E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8']);

// purpose 語彙（baseline §3.2）
const PURPOSES = Object.freeze([
  'NEW_PROSPECTING', 'FOLLOWUP_MATERIAL', 'CALLBACK_SCHEDULED', 'REACTIVATION', 'CONFIRMATION',
]);

// transcript 選定枠（baseline §1.2）
const SELECTION_TYPES = Object.freeze([
  'METRIC_SAMPLE', 'DIAGNOSTIC_PRIORITY', 'BOTH', 'UNSOLICITED',
]);

// observability（詳細§3.2）
const OBSERVABILITY = Object.freeze(['FULL', 'PARTIAL', 'NONE']);

// source_type と canonical 優先順位（baseline §5.3）
const SOURCE_TYPES = Object.freeze([
  'miitel_transcript', 'bales_note', 'bales_structured', 'sf', 'calendar', 'manual',
]);

// canonical 勝者選定の優先順位（数値が大きいほど優先）。manual は常に最優先で別扱い。
const SOURCE_PRIORITY = Object.freeze({
  E3: { miitel_transcript: 2, bales_note: 1 },
  E4: { miitel_transcript: 2, bales_note: 1 },
  E5: { miitel_transcript: 2, bales_note: 1 },
  E6: { miitel_transcript: 2, bales_note: 1 },
  E7: { sf: 4, calendar: 4, bales_structured: 3, miitel_transcript: 2, bales_note: 1 },
  E8: { sf: 3, calendar: 2, bales_note: 1 },
});

// イベント別 subtype 語彙（詳細§3.9）
const SUBTYPE_VOCAB = Object.freeze({
  E4_info_class: ['business', 'timing', 'tool', 'decision'],
  E5_value_type: ['problem', 'dissatisfaction', 'interest', 'future_condition', 'risk_awareness'],
  E5_disclosure_grade: ['a', 'b', 'c'],
  E4_novelty: ['new', 'confirmed', 'contradicted'],
  novelty_precision: ['DAY_LEVEL', 'EVENT_LEVEL'],
  E7_subtype: [
    'meeting_confirmed', 'tentative_booking', 'agreed_callback_datetime',
    'agreed_followup_date', 'vague_permission_to_call', 'unilateral_callback',
  ],
  next_step_disposition: ['created', 'confirmed', 'rescheduled', 'cancelled'],
  next_step_outcome: [
    'held', 'valid_reply', 'opportunity_created', 'rescheduled', 'cancelled', 'no_show', 'pending',
  ],
  speaker: ['agent', 'customer', 'reception', 'system'],
});

// E7 強度表（baseline §2.5）。E7成立は強度2以上。
const E7_STRENGTH = Object.freeze({
  meeting_confirmed: 4,
  tentative_booking: 3,
  agreed_callback_datetime: 2,
  agreed_followup_date: 2,
  vague_permission_to_call: 1,
  unilateral_callback: 0,
});

// 打診（16）語彙（baseline §2.4）
const PROPOSAL_VOCAB = Object.freeze({
  proposal_type: ['material_send', 'callback', 'online_meeting', 'trial'],
  proposal_form: ['two_options', 'single_datetime', 'open_question', 'vague'],
  customer_response: ['accepted', 'conditional', 'deflected', 'declined'],
});

// 帰属・L下位区分（baseline §4.3）
const NONPSYCH_CAUSE_CODES = Object.freeze([
  'TECH_QUALITY', 'PERSONNEL_CHANGE', 'HIRING_FROZEN', 'POLICY_BLOCK', 'FORCE_MAJEURE',
]);
const L_SUBCLASS = Object.freeze(['L-actionable', 'L-exogenous']);

// G層ゲート（baseline §4.1）
const GATES = Object.freeze(['GK', 'G0', 'G1', 'G2', 'G3', 'G4']);

// 変更管理（baseline §15）
const CHANGE_CLASS = Object.freeze(['BUGFIX', 'BLOCKER', 'MODEL_CHANGE']);
const CHANGE_STATUS = Object.freeze(['candidate', 'approved', 'rejected']);

// 監査共通列（全シート付与・詳細§3冒頭）
const AUDIT_COLUMNS = Object.freeze(['created_at', 'created_by', 'updated_at', 'schema_version']);

/**
 * 19シートの列定義。各シート: { key, primaryKey, generated, columns[] }
 * generated=true は「派生ビュー・直接編集禁止」（詳細§1.2）。
 * columns は監査共通列を除いた業務列（順序が物理列順）。
 */
const SHEETS = Object.freeze({
  '00_設定': {
    primaryKey: 'key',
    generated: false,
    columns: ['key', 'value', 'valid_from', 'valid_until', 'note'],
  },
  // 取込3面は揮発（毎日クリア・詳細§1.1）。HUB「19シート」には数えない staging。
  '00_取込_BALES': {
    primaryKey: ['batch_id', 'row_index'],
    generated: false,
    volatile: true,
    columns: ['batch_id', 'row_index', 'raw_json', 'row_hash', 'ingest_state'],
  },
  '00_取込_SF': {
    primaryKey: ['batch_id', 'row_index'],
    generated: false,
    volatile: true,
    columns: ['batch_id', 'row_index', 'raw_json', 'row_hash', 'ingest_state'],
  },
  '00_取込_MiiTel': {
    primaryKey: ['batch_id', 'row_index'],
    generated: false,
    volatile: true,
    columns: ['batch_id', 'row_index', 'raw_json', 'row_hash', 'ingest_state', 'transcript_selection_type'],
  },
  '01_架電イベント': {
    primaryKey: 'call_id',
    generated: true,
    columns: [
      'call_id', 'call_at', 'uid', 'company_name',
      'e0_state', 'e1_state', 'e2_state', 'e3_state', 'e4_state',
      'e5_state', 'e6_state', 'e7_state', 'e8_state',
      'max_event', 'path_pattern', 'event_set',
      'purpose_planned', 'purpose_resolved', 'purpose_changed',
      'analysis_level', 'transcript_available', 'event_observability',
      'transcript_selection_type', 'official_metric_eligible',
      'event_required_for_purpose', 'dialogue_continued', 'journey_id',
      'proposal_opportunity', 'nonpsych_cause_code', 'script_version', 'experiment_tag',
    ],
  },
  '02_通話コンテンツ': {
    primaryKey: 'call_id',
    generated: false,
    columns: ['call_id', 'raw_transcript', 'clean_transcript', 'turns_json', 'quality_flags'],
  },
  '03_LCS診断': {
    primaryKey: 'call_id',
    generated: false,
    columns: [
      'call_id', 'l_share', 'c_share', 's_share', 'l_subclass',
      'primary_gate_hypothesis', 'secondary_gate_hypothesis', 'gate_confidence',
      'alternative_nonpsychological_cause', 'evidence_quotes_json',
      'good_json', 'more_json', 'next_action_json', 'next_ng_json',
      'prompt_version', 'diagnosis_status',
    ],
  },
  '04_次アクション': {
    primaryKey: 'action_id',
    generated: false,
    columns: ['action_id', 'call_id', 'uid', 'action_type', 'due_date', 'done_condition', 'state', 'overdue', 'completed_at'],
  },
  '05_実験管理': {
    primaryKey: 'exp_id',
    generated: false,
    columns: [
      'exp_id', 'type', 'hypothesis', 'single_variable', 'assignment_rule',
      'primary_metric', 'secondary_metrics_json', 'safety_metrics_json',
      'n_target', 'fidelity_target', 'decision_date', 'stop_condition',
      'other_changes', 'comparison_condition', 'mask_until', 'evidence_grade',
    ],
  },
  '06_企業・接点マスタ': {
    primaryKey: 'uid',
    generated: false,
    columns: ['uid', 'corporate_number', 'company_name', 'norm_company_name', 'norm_phone', 'domain', 'cumulative_result', 'cooldown_until', 'contradicted_queue_json'],
  },
  '07_集計': {
    primaryKey: ['period', 'segment'],
    generated: true,
    columns: ['period', 'segment', 'metric_key', 'numerator', 'denominator', 'value', 'unknown_band'],
  },
  '08_改修ログ': {
    primaryKey: 'change_id',
    generated: false,
    columns: ['change_id', 'change_class', 'change_status', 'summary', 'impact_scope', 'linked_at'],
  },
  '09_ナレッジ索引': {
    primaryKey: 'knowledge_id',
    generated: false,
    columns: ['knowledge_id', 'type', 'apply_condition', 'counterexample', 'evidence_grade', 'source'],
  },
  '10_訴求根拠マスタ': {
    primaryKey: 'claim_id',
    generated: false,
    columns: ['claim_id', 'usable_wording', 'source', 'condition', 'expires_at', 'forbidden_wording'],
  },
  '11_スクリプト版': {
    primaryKey: 'script_version',
    generated: false,
    columns: ['script_version', 'full_text', 'change_note', 'related_exp'],
  },
  '12_データ品質': {
    primaryKey: 'batch_id',
    generated: true,
    columns: [
      'batch_id', 'batch_state', 'count_delta', 'dup_rate', 'match_rate',
      'transcript_sync_rate', 'metric_coverage', 'unknown_rate', 'purpose_changed_rate',
      'ingest_delta', 'warnings_json',
    ],
  },
  '13_ラベル監査': {
    primaryKey: 'audit_id',
    generated: false,
    columns: ['audit_id', 'call_id', 'audit_type', 'diff_json', 'confirmed', 'regression_result'],
  },
  '14_教師データVIEW': {
    primaryKey: 'call_id',
    generated: true,
    columns: [
      'call_id', 'feature_json', 'posthoc_label_json', 'label_available_at', 'leakage_flag',
    ],
  },
  '15_評価基準台帳': {
    primaryKey: ['item_id', 'item_version'],
    generated: false,
    columns: [
      'item_id', 'item_version', 'construct', 'decision_hypothesis',
      'eligible_population', 'target_event', 'minimum_practical_effect',
      'anchor_2', 'anchor_1', 'anchor_0',
      'm1', 'm2', 'm3', 'm4a', 'm4b', 'm5',
      'evidence_grade', 'operational_status', 'definition_hash', 'valid_from', 'valid_until',
    ],
  },
  '16_打診イベント': {
    primaryKey: 'proposal_id',
    generated: false,
    columns: [
      'proposal_id', 'call_id', 'proposal_type', 'proposal_form',
      'proposal_order', 'proposal_wording', 'customer_response', 'weak_close_candidate',
    ],
  },
  '17_ジャーニー': {
    primaryKey: 'journey_id',
    generated: true,
    columns: [
      'journey_id', 'uid', 'journey_start', 'journey_end',
      'call_ids_json', 'e7_events_json', 'e8_events_json', 'originating_call_id', 'journey_outcome',
    ],
  },
  '18_Eイベント明細': {
    primaryKey: 'event_id',
    generated: false, // 事実の正本。手動訂正のみ許可。
    columns: [
      'event_id', 'observation_id', 'canonical_event_id', 'is_canonical', 'dedup_key',
      'call_id', 'event_code', 'event_order', 'sequence_quality',
      'occurred_at_sec', 'turn_index', 'subtype', 'info_class',
      'novelty', 'novelty_precision', 'disclosure_grade', 'value_type',
      'evidence_quote', 'speaker', 'source_type', 'extractor_version',
      'label_confidence', 'reviewed',
    ],
  },
});

// シート物理列順（監査共通列を末尾に付与）
function physicalColumns(sheetKey) {
  const s = SHEETS[sheetKey];
  if (!s) throw new Error(`unknown sheet: ${sheetKey}`);
  return [...s.columns, ...AUDIT_COLUMNS];
}

function isGenerated(sheetKey) {
  const s = SHEETS[sheetKey];
  if (!s) throw new Error(`unknown sheet: ${sheetKey}`);
  return !!s.generated;
}

/** 永続HUBシート（揮発staging除外）。baseline §6 の「19シート」= これ。 */
function persistentSheetKeys() {
  return Object.keys(SHEETS).filter((k) => !SHEETS[k].volatile);
}

module.exports = {
  SCHEMA_VERSION,
  EVENT_STATE, EVENT_CODES, PURPOSES, SELECTION_TYPES, OBSERVABILITY,
  SOURCE_TYPES, SOURCE_PRIORITY, SUBTYPE_VOCAB, E7_STRENGTH, PROPOSAL_VOCAB,
  NONPSYCH_CAUSE_CODES, L_SUBCLASS, GATES, CHANGE_CLASS, CHANGE_STATUS,
  AUDIT_COLUMNS, SHEETS,
  physicalColumns, isGenerated, persistentSheetKeys,
};
