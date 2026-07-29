/* ============================================================================
 * G-Chain OS v1.5 — 自動生成バンドル（EDITしないこと）
 * 生成元: src/gchain/*.js + gas/orchestration.gs（単一正本）
 * 再生成: node src/gchain/build-gas.js
 * ========================================================================== */
var GChain = {};
var GChainVendor = {};

/* --- vendor: csv.js --- */
GChainVendor.csv = (function () {
  var module = { exports: {} };
  'use strict';
  // 共有CSVユーティリティ＋名寄せキー生成。
  // 多系統マージ（merge.js）・ソース別KPI（source-kpi.js）・統合オーケストレータ（build-list.js）で共用。
  // 依存なし・純ロジック（ネットワーク/APIキー不要）。

  // ---- CSVパース（ダブルクォート対応・改行/カンマ内包可・BOM除去）----
  function parseCsv(text) {
    const rows = [];
    let row = [], cur = '', q = false;
    const s = String(text).replace(/^﻿/, '');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) {
        if (ch === '"' && s[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cur); cur = ''; }
      else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (ch === '\r') { /* skip */ }
      else cur += ch;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.filter((r) => r.length && r.some((c) => String(c).trim() !== ''));
  }

  // 2次元配列（1行目ヘッダ）→ { headers, records(オブジェクト配列) }
  function rowsToRecords(rows) {
    if (!rows.length) return { headers: [], records: [] };
    const headers = rows[0].map((h) => String(h).trim());
    const records = [];
    for (let i = 1; i < rows.length; i++) {
      const rec = {};
      headers.forEach((h, j) => { rec[h] = rows[i][j] != null ? rows[i][j] : ''; });
      records.push(rec);
    }
    return { headers, records };
  }

  // CSVテキスト → オブジェクト配列（ショートカット）
  function readCsv(text) { return rowsToRecords(parseCsv(text)); }

  function csvEscape(v) {
    const sv = String(v == null ? '' : v);
    return /[",\n\r]/.test(sv) ? '"' + sv.replace(/"/g, '""') + '"' : sv;
  }

  // レコード配列＋ヘッダ → CSVテキスト
  function toCsv(headers, records) {
    const lines = [headers.map(csvEscape).join(',')];
    for (const rec of records) lines.push(headers.map((h) => csvEscape(rec[h])).join(','));
    return lines.join('\n');
  }

  // 全角英数記号 → 半角（名寄せの揺れ吸収）
  function toHalfWidth(s) {
    return String(s || '').replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/　/g, ' ');
  }

  // ---- 名寄せキー（統合オペレーションの突合キー）----
  // ① 法人番号：数字13桁に正規化（取れていれば最優先キー）
  function normCorpNumber(v) {
    const d = String(v || '').replace(/[^0-9]/g, '');
    return d.length === 13 ? d : '';
  }

  // ② 企業名：法人格・記号・空白を落として正規化（法人番号が無い行のフォールバックキー）
  const CORP_FORMS = [
    '株式会社', '有限会社', '合同会社', '合資会社', '合名会社', '一般社団法人', '一般財団法人',
    '公益社団法人', '公益財団法人', '社会福祉法人', '医療法人社団', '医療法人財団', '医療法人',
    '学校法人', '宗教法人', '特定非営利活動法人', 'ＮＰＯ法人', 'NPO法人', '独立行政法人', '国立大学法人',
  ];
  function normCompanyName(name) {
    let s = toHalfWidth(name).trim();
    // 囲み文字の法人格マーク（㈱㈲㈳㈿）と括弧付き表記（（株）(株)（有）等）
    s = s.replace(/[㈱㈲㈳㈿]/g, '');
    s = s.replace(/[（(]\s*(株|有|合|社|財)\s*[)）]/g, '');
    for (const f of CORP_FORMS) s = s.split(f).join('');
    s = s.replace(/[\s・,，.．\-‐－―_/／&＆]/g, '');
    return s.toLowerCase();
  }

  // レコードの名寄せキー（法人番号 → 正規化社名 の順で確定）。空なら null。
  function mergeKey(rec) {
    const cn = normCorpNumber(rec['法人番号']);
    if (cn) return 'C:' + cn;
    const nm = normCompanyName(rec['企業名'] || rec['company_name'] || '');
    return nm ? 'N:' + nm : null;
  }

  // 値が真（"○"/"true"/"1"/"有"/"あり"/"掲載中"/"出稿" 等）か（quality.js と整合）
  function truthy(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    return /^(○|◯|✓|true|1|yes|y|有|あり|掲載中|出稿|済|当)$/.test(s) || s === 'o';
  }

  module.exports = {
    parseCsv, rowsToRecords, readCsv, csvEscape, toCsv,
    toHalfWidth, normCorpNumber, normCompanyName, mergeKey, truthy, CORP_FORMS,
  };

  return module.exports;
})();

/* --- module: schema.js --- */
GChain.schema = (function () {
  var module = { exports: {} };
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

  return module.exports;
})();

/* --- module: config.js --- */
GChain.config = (function () {
  var module = { exports: {} };
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

  return module.exports;
})();

/* --- module: normalize.js --- */
GChain.normalize = (function () {
  var module = { exports: {} };
  'use strict';
  /**
   * G-Chain OS v1.5 — 正規化・冪等キー（詳細設計書 §5.1–5.2, §2.3 冪等性）。
   *
   * normCompanyName / normCorpNumber は既存 src/csv.js と規則を共有（詳細§5.2 の要件）。
   * ここでは電話・日時の正規化と、Node/GAS 双方で同一値を返す決定的ハッシュを追加する。
   * 純関数のみ（外部I/O無し）。GAS へは同一ソースをバンドルして流用する前提。
   */

  const { normCompanyName, normCorpNumber, toHalfWidth } = GChainVendor.csv;

  /** ① 正規化電話番号: 数字のみ抽出し、日本の国番号(+81/81)を先頭0へ畳む。 */
  function normPhone(v) {
    let d = String(v == null ? '' : v).replace(/[^0-9+]/g, '');
    d = d.replace(/^\+?81/, '0'); // +81-3-... / 8103... → 03...
    d = d.replace(/[^0-9]/g, '');
    // 二重先頭ゼロ（0081 由来の 00...）を1つに畳む
    d = d.replace(/^00+/, '0');
    return d;
  }

  /**
   * ② 正規化日時: JST・秒精度の ISO8601 風文字列へ。
   * 解釈できない場合は入力を trim して返す（型変換エラーは呼び出し側で隔離）。
   * タイムゾーンは付与しない（社内単一TZ運用・比較は文字列一致で足りる）。
   */
  function normDatetime(v) {
    if (v == null || v === '') return '';
    const s = String(v).trim();
    // 既に ISO 風（YYYY-MM-DD HH:MM(:SS)?）ならセパレータだけ整える
    const m = s.match(
      /(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})[日]?[ T]?(\d{1,2})?[:時]?(\d{1,2})?[:分]?(\d{1,2})?/
    );
    if (!m) return s;
    const [, y, mo, d, hh = '0', mi = '0', ss = '0'] = m;
    const p2 = (n) => String(n).padStart(2, '0');
    return `${y}-${p2(mo)}-${p2(d)} ${p2(hh)}:${p2(mi)}:${p2(ss)}`;
  }

  /** 日付部分のみ（call_date 用）。normDatetime の先頭10文字。 */
  function normDate(v) {
    const dt = normDatetime(v);
    return dt ? dt.slice(0, 10) : '';
  }

  /**
   * 決定的 32bit FNV-1a。Node/GAS で完全に同一値。
   * >>> 0 で符号無し32bitへ畳む。
   */
  function fnv1a32(str, seed) {
    let h = (seed >>> 0) || 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      // h *= 16777619 を32bitで（32bit乗算のオーバーフロー安全版）
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  /**
   * 決定的16桁hex（32bit×2seed連結）。衝突耐性を row_hash/dedup 用に確保。
   * crypto/Utilities に依存せず Node↔GAS 同値。
   */
  function stableHashHex(str) {
    const a = fnv1a32(str, 0x811c9dc5);
    const b = fnv1a32(str, 0x01000193);
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
  }

  /** 昇順ソート用の数値キー（sampling の裁量ゼロ選定に使用・詳細§6.1）。 */
  function stableHash32(str) {
    return fnv1a32(str, 0x811c9dc5);
  }

  /**
   * row_hash（冪等性フォールバック・詳細§2.3）。
   * source_event_id が無いソース行の一意キー。
   * キー = 正規化日時 + 正規化電話 + 通話秒 + 結果。
   */
  function rowHash(fields) {
    const parts = [
      normDatetime(fields.datetime),
      normPhone(fields.phone),
      String(fields.call_sec == null ? '' : fields.call_sec),
      String(fields.result == null ? '' : fields.result).trim().toLowerCase(),
    ];
    return stableHashHex(parts.join('|'));
  }

  /**
   * 冪等キー（詳細§2.3）。source_event_id 優先、無ければ row_hash。
   * 返り値は 18/取込面 の突合に使う文字列。
   */
  function idempotencyKey(fields) {
    if (fields.source_system && fields.source_event_id) {
      return `${fields.source_system}:${fields.source_event_id}`;
    }
    return `hash:${rowHash(fields)}`;
  }

  /**
   * 名寄せキー（詳細§5.1 カスケードの決定的部分）。
   * 法人番号 → 正規化電話 → 正規化社名 の順。ドメイン/手動は上位で解決。
   * 返り値 { key, basis } — basis は match_rate 集計用の根拠区分。
   */
  function matchKey(rec) {
    const corp = normCorpNumber(rec.corporate_number || rec['法人番号']);
    if (corp) return { key: 'C:' + corp, basis: 'corporate_number' };
    const phone = normPhone(rec.phone || rec['電話番号']);
    if (phone) return { key: 'P:' + phone, basis: 'phone' };
    const name = normCompanyName(rec.company_name || rec['企業名'] || '');
    if (name) return { key: 'N:' + name, basis: 'company_name' };
    return { key: null, basis: 'unmatched' };
  }

  module.exports = {
    normCompanyName, normCorpNumber, toHalfWidth, // 再輸出（同一規則共有）
    normPhone, normDatetime, normDate,
    fnv1a32, stableHashHex, stableHash32,
    rowHash, idempotencyKey, matchKey,
  };

  return module.exports;
})();

/* --- module: canonical.js --- */
GChain.canonical = (function () {
  var module = { exports: {} };
  'use strict';
  /**
   * G-Chain OS v1.5 — canonical統合（詳細設計書 §5.3–5.4, baseline §5.3）。
   *
   * 18 は生観測を全保持（削除禁止）。dedup_key ごとに1つだけ is_canonical=true を残す。
   * 集計・path_pattern・ask_count は is_canonical=true のみを使う（E7重複行を構造的に防止）。
   * 純関数（外部I/O無し）。
   */

  const { SOURCE_PRIORITY } = GChain.schema;
  const { normDatetime } = GChain.normalize;

  const DEFAULT_TIME_BUCKET_SEC = 30; // 00_設定.dedup_time_bucket_sec で上書き可

  /** subtype を dedup 用に正規化（null/空 → ''、trim + lower）。 */
  function normSubtype(subtype) {
    if (subtype == null) return '';
    return String(subtype).trim().toLowerCase();
  }

  /** occurred_at_sec を time_bucket に丸める。NULL は単一バケット(-1)。 */
  function timeBucket(occurredAtSec, bucketSec) {
    const b = bucketSec || DEFAULT_TIME_BUCKET_SEC;
    if (occurredAtSec == null || occurredAtSec === '') return -1;
    const n = Number(occurredAtSec);
    if (!Number.isFinite(n)) return -1;
    return Math.floor(n / b);
  }

  /**
   * dedup_key = call_id + event_code + normalized_subtype + time_bucket（詳細§5.3）。
   */
  function dedupKey(obs, opts) {
    const bucketSec = opts && opts.bucketSec;
    return [
      obs.call_id,
      obs.event_code,
      normSubtype(obs.subtype),
      timeBucket(obs.occurred_at_sec, bucketSec),
    ].join('#');
  }

  /** source_type の優先度スコア（event_code 別・schema.SOURCE_PRIORITY）。未定義は0。 */
  function sourcePriority(eventCode, sourceType) {
    const table = SOURCE_PRIORITY[eventCode];
    if (!table) return 0;
    return table[sourceType] || 0;
  }

  /**
   * 1グループ（同一 dedup_key）から正規源(勝者)を選ぶ（詳細§5.3）。
   * 規則: manual は常に最優先 → source優先度 → label_confidence → occurred_at_sec昇順 → observation_id昇順（決定的タイブレーク）。
   */
  function pickCanonical(group, eventCode) {
    if (!group.length) return null;
    const scored = group.map((o) => ({
      o,
      manual: o.source_type === 'manual' ? 1 : 0,
      prio: sourcePriority(eventCode, o.source_type),
      conf: Number(o.label_confidence) || 0,
      at: o.occurred_at_sec == null ? Infinity : Number(o.occurred_at_sec),
      oid: String(o.observation_id || ''),
    }));
    scored.sort((a, b) =>
      (b.manual - a.manual) ||
      (b.prio - a.prio) ||
      (b.conf - a.conf) ||
      (a.at - b.at) ||
      (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0)
    );
    return scored[0].o;
  }

  /**
   * 生観測配列を受け取り is_canonical / canonical_event_id を付与して返す（詳細§5.3）。
   * 入力を変更せず新オブジェクト配列を返す。event_code はグループ内で一定の前提。
   */
  function dedupeObservations(observations, opts) {
    const groups = new Map();
    for (const o of observations) {
      const k = dedupKey(o, opts);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(o);
    }
    const out = [];
    for (const [k, group] of groups) {
      const eventCode = group[0].event_code;
      const winner = pickCanonical(group, eventCode);
      const winnerId = winner.event_id != null ? winner.event_id : winner.observation_id;
      for (const o of group) {
        const isWinner = o === winner;
        out.push({
          ...o,
          dedup_key: k,
          is_canonical: isWinner,
          canonical_event_id: winnerId,
        });
      }
    }
    return out;
  }

  /**
   * 制約チェック（詳細§5.4）: dedup_key ごとに is_canonical=true は高々1。
   * 違反 dedup_key の配列を返す（空なら健全）。SYNC-5 が CANONICAL_CONFLICT を記録する材料。
   */
  function assertCanonicalUnique(rows) {
    const count = new Map();
    for (const r of rows) {
      if (r.is_canonical === true || r.is_canonical === 'TRUE') {
        count.set(r.dedup_key, (count.get(r.dedup_key) || 0) + 1);
      }
    }
    const conflicts = [];
    for (const [k, n] of count) if (n > 1) conflicts.push({ dedup_key: k, count: n });
    return conflicts;
  }

  /** 手動訂正行の必須列チェック（詳細§5.4）。欠落フィールド配列を返す（空なら合格）。 */
  function validateManualCorrection(row) {
    const missing = [];
    for (const f of ['editor', 'timestamp', 'before', 'after']) {
      if (row[f] == null || row[f] === '') missing.push(f);
    }
    return missing;
  }

  module.exports = {
    DEFAULT_TIME_BUCKET_SEC,
    normSubtype, timeBucket, dedupKey, sourcePriority,
    pickCanonical, dedupeObservations, assertCanonicalUnique, validateManualCorrection,
    normDatetime, // 便宜再輸出
  };

  return module.exports;
})();

/* --- module: event-engine.js --- */
GChain.eventEngine = (function () {
  var module = { exports: {} };
  'use strict';
  /**
   * G-Chain OS v1.5 — Eイベント判定エンジン（詳細設計書 §4, baseline §2）。
   * 18(is_canonical=true) → 01 の e{n}_state / max_event / path_pattern / event_set を再生成。
   *
   * 不変則:
   *  - Eは事実、状態は {TRUE,FALSE,UNKNOWN,NOT_ELIGIBLE}（baseline §2.1）
   *  - FALSE は「観測可能だったのに発生せず」の時のみ（observability=FULL 要件）
   *  - NOT_ELIGIBLE は論理的前提のみ。purpose は根拠にしない（baseline §2.2）
   *  - E7_state=TRUE は disposition=created かつ強度≥2 のみ（baseline §2.5）
   *  - E8 は時間依存（帰属窓・§2.6）
   * 純関数（now は引数注入）。
   */

  const { E7_STRENGTH } = GChain.schema;

  const STRUCTURED_EVENTS = new Set(['E0', 'E1', 'E2']); // L0構造化・transcript不要で観測可能
  const DEFAULT_E8_WINDOW_DAYS = 30;
  const HIGH_TRUST_SEQ = new Set(['exact', 'inferred_high']);

  /** E7観測が成立資格を満たすか（強度≥2 かつ disposition=created）。 */
  function e7Qualifies(obs) {
    const strength = E7_STRENGTH[obs.subtype];
    return strength != null && strength >= 2 && obs.next_step_disposition === 'created';
  }

  /** 論理的前提（NOT_ELIGIBLE 判定・baseline §2.2）。purpose は使わない。 */
  function prerequisiteMet(eventCode, states, flags) {
    switch (eventCode) {
      case 'E0':
      case 'E1':
      case 'E2':
        return true;
      case 'E3':
      case 'E4':
      case 'E5':
        return states.E2 === 'TRUE';
      case 'E6':
        // 営業発話が存在し、接触が成立している
        return states.E1 === 'TRUE' && flags.agent_spoke !== false;
      case 'E7':
        // 「次接点」という概念が存在する接触か
        return flags.next_step_conceivable !== false;
      case 'E8':
        // 帰属対象の created E7 が存在するか
        return (flags.createdE7Count || 0) > 0;
      default:
        return true;
    }
  }

  /** その事象が当該 observability で観測可能か（FALSE を付与してよいか）。 */
  function observableFor(eventCode, observability) {
    if (STRUCTURED_EVENTS.has(eventCode)) return true; // 構造化ログで常に観測可能
    if (eventCode === 'E8') return false; // E8 は resolveE8 で時間解決（generic FALSE を通さない）
    return observability === 'FULL';
  }

  /**
   * 汎用状態決定（詳細§4.1）。E8 以外に適用。
   * occurred: この event_code の canonical 成立観測が存在するか（E7 は資格判定済みで渡す）。
   */
  function resolveEventState(eventCode, occurred, states, flags, observability) {
    if (!prerequisiteMet(eventCode, states, flags)) return 'NOT_ELIGIBLE';
    if (occurred) return 'TRUE';
    if (observability === 'FULL' && observableFor(eventCode, observability)) return 'FALSE';
    if (STRUCTURED_EVENTS.has(eventCode)) return 'FALSE'; // 構造化は observability=FULL でなくても FALSE 確定
    return 'UNKNOWN';
  }

  /**
   * 単一 created E7 の E8_state（詳細§4.1 resolveE8, baseline §2.6）。
   * nowSec / e7AtSec は同一基準（秒）。windowDays は 00_設定 由来。
   */
  function resolveE8ForRecord(e7record, nowSec, windowDays) {
    const o = e7record.next_step_outcome;
    if (o === 'held' || o === 'valid_reply' || o === 'opportunity_created') return 'TRUE';
    if (o === 'rescheduled' || o === 'cancelled' || o === 'no_show') return 'FALSE';
    if (o === 'pending' || o == null || o === '') {
      const windowSec = (windowDays || DEFAULT_E8_WINDOW_DAYS) * 86400;
      const at = Number(e7record.occurred_at_epoch);
      if (!Number.isFinite(at) || !Number.isFinite(nowSec)) return 'UNKNOWN';
      return (nowSec - at) <= windowSec ? 'UNKNOWN' : 'FALSE';
    }
    return 'UNKNOWN';
  }

  /** call レベルの E8 rollup。created E7 群の各 E8 を集約。 */
  function resolveE8Call(createdE7Records, nowSec, windowDays) {
    if (!createdE7Records || !createdE7Records.length) return 'NOT_ELIGIBLE';
    let anyTrue = false, anyUnknown = false;
    for (const rec of createdE7Records) {
      const s = resolveE8ForRecord(rec, nowSec, windowDays);
      if (s === 'TRUE') anyTrue = true;
      else if (s === 'UNKNOWN') anyUnknown = true;
    }
    if (anyTrue) return 'TRUE';
    if (anyUnknown) return 'UNKNOWN';
    return 'FALSE';
  }

  /**
   * call 全体を解決（詳細§4）。
   * input:
   *  {
   *    call_id, event_observability,
   *    canonicalEvents: [{event_code, subtype, next_step_disposition, event_order, sequence_quality}], // is_canonical=true
   *    createdE7Records: [{next_step_outcome, occurred_at_epoch}],  // E8用
   *    flags: { agent_spoke, next_step_conceivable },
   *    nowSec, e8WindowDays
   *  }
   * 返り値: { states:{E0..E8}, max_event, path_pattern, event_set }
   */
  function resolveCall(input) {
    const ev = input.canonicalEvents || [];
    const observability = input.event_observability || 'NONE';
    const flags = Object.assign({}, input.flags);

    // 成立観測の集合（E7 は資格を満たすもののみ TRUE 候補）
    const occurred = new Set();
    let createdE7Count = 0;
    for (const o of ev) {
      if (o.event_code === 'E7') {
        if (e7Qualifies(o)) { occurred.add('E7'); createdE7Count++; }
      } else if (o.event_code !== 'E8') {
        occurred.add(o.event_code);
      }
    }
    flags.createdE7Count = createdE7Count;

    const states = {};
    // E0..E7 を順に（prereq が先行状態を参照するため順序が重要）
    for (const e of ['E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7']) {
      states[e] = resolveEventState(e, occurred.has(e), states, flags, observability);
    }
    // E8 は時間解決
    states.E8 = prerequisiteMet('E8', states, flags)
      ? resolveE8Call(input.createdE7Records, input.nowSec, input.e8WindowDays)
      : 'NOT_ELIGIBLE';

    return {
      states,
      max_event: maxEvent(states),
      path_pattern: buildPathPattern(ev, states),
      event_set: buildEventSet(states),
    };
  }

  /** max_event = TRUE の最大 event_code（baseline §2.3）。 */
  function maxEvent(states) {
    let max = null;
    for (const e of ['E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8']) {
      if (states[e] === 'TRUE') max = e;
    }
    return max;
  }

  /**
   * path_pattern（詳細§4.3, §5.4）。
   * 全 canonical が高信頼順序(exact/inferred_high)を持つ時のみ順序連結。
   * さもなくば UNKNOWN_SEQUENCE。偽の経路(E7>E7)は canonical 単一化で発生しない。
   */
  function buildPathPattern(canonicalEvents, states) {
    const trueEvents = canonicalEvents.filter((o) => states[o.event_code] === 'TRUE' && o.event_code !== 'E8');
    if (!trueEvents.length) return '';
    const allHighTrust = trueEvents.every(
      (o) => o.event_order != null && o.event_order !== '' && HIGH_TRUST_SEQ.has(o.sequence_quality)
    );
    if (!allHighTrust) return 'UNKNOWN_SEQUENCE';
    const sorted = [...trueEvents].sort((a, b) => Number(a.event_order) - Number(b.event_order));
    return sorted.map((o) => o.event_code).join('>');
  }

  /** event_set = TRUE の event_code を昇順・distinct・| 連結（順不同集合）。 */
  function buildEventSet(states) {
    const codes = ['E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8'].filter((e) => states[e] === 'TRUE');
    return codes.join('|');
  }

  /** event_required_for_purpose（詳細§4.2）。purpose テンプレの required_events を結合。 */
  function eventRequiredForPurpose(purpose, purposeTemplates) {
    const tpl = purposeTemplates && purposeTemplates[purpose];
    const required = (tpl && tpl.required_events) || [];
    const reqSet = new Set(required);
    const out = {};
    for (const e of ['E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8']) out[e] = reqSet.has(e);
    return out;
  }

  module.exports = {
    STRUCTURED_EVENTS, DEFAULT_E8_WINDOW_DAYS,
    e7Qualifies, prerequisiteMet, observableFor,
    resolveEventState, resolveE8ForRecord, resolveE8Call, resolveCall,
    maxEvent, buildPathPattern, buildEventSet, eventRequiredForPurpose,
  };

  return module.exports;
})();

/* --- module: kpi.js --- */
GChain.kpi = (function () {
  var module = { exports: {} };
  'use strict';
  /**
   * G-Chain OS v1.5 — KPI集計（詳細設計書 §9, baseline §10）。
   *
   * 大原則:
   *  - UNKNOWN と NOT_ELIGIBLE は常に分母外。
   *  - 会話系(E3〜E6)は official_metric_eligible=true ∧ purposeセグメント内。
   *  - 分母規則は officialDenominator に集約し KPI 間のドリフトを防ぐ（詳細§9.1）。
   * 純関数（外部I/O無し）。call 行は 01 の1レコード形。
   */

  const IN_DENOM_STATES = new Set(['TRUE', 'FALSE']); // UNKNOWN/NOT_ELIGIBLE は常に除外

  /** 状態が分母に入るか（UNKNOWN/NOT_ELIGIBLE を弾く共通ゲート）。 */
  function stateInDenom(state) {
    return IN_DENOM_STATES.has(state);
  }

  /**
   * 会話系イベントの official 分母資格（詳細§9.1 の集約述語）。
   * conversationEvent=true の KPI は official_metric_eligible を要求する。
   */
  function officialDenominator(call, eventCode, opts) {
    const conversation = new Set(['E3', 'E4', 'E5', 'E6']);
    if (conversation.has(eventCode) && !call.official_metric_eligible) return false;
    if (opts && opts.purpose && call.purpose_planned !== opts.purpose) return false;
    return true;
  }

  /** 汎用レート: 分母メンバ判定 + 分子判定。UNKNOWN/NOT_ELIGIBLE は inDenom 側で除外。 */
  function computeRate(calls, inDenom, isNumerator) {
    let num = 0, den = 0;
    for (const c of calls) {
      if (!inDenom(c)) continue;
      den++;
      if (isNumerator(c)) num++;
    }
    return { numerator: num, denominator: den, value: den ? num / den : null };
  }

  const st = (c, e) => c[e.toLowerCase() + '_state'];

  /**
   * KPIレジストリ（詳細§9 表）。各KPI: { inDenom(call,opts), numerator(call) }。
   * E率系は official_metric_eligible をゲート。opts.purpose でセグメント。
   */
  const KPI = {
    // 接続: E2率 = E2/E0（全通話・official不要）
    e2_rate: {
      inDenom: (c) => stateInDenom(st(c, 'E0')),
      numerator: (c) => st(c, 'E2') === 'TRUE',
    },
    // 会話: E3率 = E3(TRUE)/E2（official∧purpose）
    e3_rate: {
      inDenom: (c, o) => st(c, 'E2') === 'TRUE' && officialDenominator(c, 'E3', o),
      numerator: (c) => st(c, 'E3') === 'TRUE',
    },
    // E4率 = E4(TRUE)/(E4∈{T,F})（official∧purpose）
    e4_rate: {
      inDenom: (c, o) => stateInDenom(st(c, 'E4')) && officialDenominator(c, 'E4', o),
      numerator: (c) => st(c, 'E4') === 'TRUE',
    },
    // E5率 = E5(TRUE, b以上)/(E5∈{T,F})
    e5_rate: {
      inDenom: (c, o) => stateInDenom(st(c, 'E5')) && officialDenominator(c, 'E5', o),
      numerator: (c) => st(c, 'E5') === 'TRUE',
    },
    // 打診率 = E6/(E5∧opportunity=yes)（適格性補正）
    proposal_rate: {
      inDenom: (c, o) => st(c, 'E5') === 'TRUE' && c.proposal_opportunity === 'yes' && officialDenominator(c, 'E6', o),
      numerator: (c) => st(c, 'E6') === 'TRUE',
    },
    // 相手質問発生率 = customer_question/E3
    question_rate: {
      inDenom: (c, o) => st(c, 'E3') === 'TRUE' && officialDenominator(c, 'E3', o),
      numerator: (c) => !!c.customer_question,
    },
    // 成果: E7率
    e7_rate: {
      inDenom: (c, o) => stateInDenom(st(c, 'E7')) && officialDenominator(c, 'E7', o),
      numerator: (c) => st(c, 'E7') === 'TRUE',
    },
    // 監視: purpose_changed率（全通話）
    purpose_changed_rate: {
      inDenom: () => true,
      numerator: (c) => c.purpose_changed === true,
    },
    // 品質: UNKNOWN率（transcript対象イベントのUNKNOWN比率・E4基準）
    unknown_rate: {
      inDenom: (c) => st(c, 'E2') === 'TRUE',
      numerator: (c) => st(c, 'E4') === 'UNKNOWN',
    },
  };

  /** 1 KPI を calls に対し集計（opts.purpose でセグメント）。 */
  function runKpi(name, calls, opts) {
    const k = KPI[name];
    if (!k) throw new Error(`unknown KPI: ${name}`);
    return computeRate(calls, (c) => k.inDenom(c, opts), k.numerator);
  }

  /**
   * 実施率 = held / (created済E7のうちoutcome確定分)（詳細§9, baseline §2.6）。
   * pending(窓内)=UNKNOWN は分母外。
   * e7records: [{ next_step_disposition, next_step_outcome, e8_resolved }]
   * e8_resolved は event-engine.resolveE8ForRecord の結果（TRUE/FALSE/UNKNOWN）。
   */
  function heldRate(e7records) {
    let num = 0, den = 0;
    for (const r of e7records) {
      if (r.next_step_disposition !== 'created') continue;
      if (r.e8_resolved === 'UNKNOWN') continue; // pending窓内は確定待ち → 分母外
      den++;
      if (r.next_step_outcome === 'held') num++;
    }
    return { numerator: num, denominator: den, value: den ? num / den : null };
  }

  /**
   * D2ファネル（詳細§9）: 各段の TRUE/FALSE/UNKNOWN/NOT_ELIGIBLE 分布。
   * UNKNOWN帯をグレー表示するための集計。
   */
  function funnel(calls, eventCodes) {
    const codes = eventCodes || ['E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8'];
    const out = {};
    for (const e of codes) {
      const dist = { TRUE: 0, FALSE: 0, UNKNOWN: 0, NOT_ELIGIBLE: 0 };
      for (const c of calls) {
        const s = st(c, e);
        if (dist[s] != null) dist[s]++;
      }
      out[e] = dist;
    }
    return out;
  }

  module.exports = {
    IN_DENOM_STATES, stateInDenom, officialDenominator, computeRate,
    KPI, runKpi, heldRate, funnel,
  };

  return module.exports;
})();

/* --- module: sampling.js --- */
GChain.sampling = (function () {
  var module = { exports: {} };
  'use strict';
  /**
   * G-Chain OS v1.5 — 文字起こし二枠サンプリング（詳細設計書 §6, baseline §1.2）。
   *
   * METRIC_SAMPLE: E2成立通話から無作為・裁量ゼロ（決定的hash昇順の上位N）。KPI/実験の正式分母。
   * DIAGNOSTIC_PRIORITY: METRIC除外後の残りから優先抽出。診断/コーチング用。
   * official_metric_eligible = observability=FULL AND selection∈{METRIC_SAMPLE,BOTH}。
   * 純関数（外部I/O無し・seed固定で再現可能 → AT-1 seed再現性）。
   */

  const { stableHash32 } = GChain.normalize;

  const DEFAULT_CAP = 10;
  const DEFAULT_METRIC = 7;
  const DEFAULT_DIAGNOSTIC = 3;

  /** 決定的選定キー（詳細§6.1）: hash(source_event_id + call_date) 昇順。 */
  function metricKey(call) {
    return stableHash32(String(call.source_event_id || call.call_id || '') + '|' + String(call.call_date || ''));
  }

  /**
   * 診断優先スコア（詳細§6.1）: アポ・打診到達失注・未知パターンを優先。
   * 高いほど優先。決定的（乱数不使用）。
   */
  function diagnosticScore(call) {
    let s = 0;
    if (call.is_appointment) s += 100;
    if (call.reached_proposal_but_lost) s += 60;
    if (call.is_novel_pattern) s += 30;
    return s;
  }

  /**
   * 二枠選定（詳細§6.1）。
   * input:
   *   e2Calls: E2成立通話配列（各 {call_id, source_event_id, call_date, is_appointment, reached_proposal_but_lost, is_novel_pattern, experiment_tag}）
   *   config: { cap, metricSize, diagnosticSize }
   * 返り値: { selections: Map<call_id, selection_type>, metric:[call_id], diagnostic:[call_id] }
   * selection_type ∈ {METRIC_SAMPLE, DIAGNOSTIC_PRIORITY, BOTH}
   */
  function selectTranscripts(e2Calls, config) {
    const cfg = config || {};
    const metricSize = cfg.metricSize != null ? cfg.metricSize : DEFAULT_METRIC;
    const diagnosticSize = cfg.diagnosticSize != null ? cfg.diagnosticSize : DEFAULT_DIAGNOSTIC;

    // 実験対象は優先（原則両群全件 FULL・§6.1）→ METRIC に必ず含める
    const experimentCalls = e2Calls.filter((c) => c.experiment_tag);
    const experimentIds = new Set(experimentCalls.map((c) => c.call_id));

    // 枠1: METRIC（無作為・裁量ゼロ・決定的hash昇順）
    const byKey = [...e2Calls].sort((a, b) => {
      const ka = metricKey(a), kb = metricKey(b);
      if (ka !== kb) return ka - kb;
      return String(a.call_id) < String(b.call_id) ? -1 : 1; // 決定的タイブレーク
    });
    const metricSet = new Set(experimentIds); // 実験は無条件で
    for (const c of byKey) {
      if (metricSet.size >= metricSize) break;
      metricSet.add(c.call_id);
    }

    // 枠2: DIAGNOSTIC（METRIC除外後の残りから優先スコア上位）
    const remaining = e2Calls.filter((c) => !metricSet.has(c.call_id));
    remaining.sort((a, b) => {
      const d = diagnosticScore(b) - diagnosticScore(a);
      if (d !== 0) return d;
      return metricKey(a) - metricKey(b); // 決定的タイブレーク
    });
    const diagnosticSet = new Set();
    for (const c of remaining) {
      if (diagnosticSet.size >= diagnosticSize) break;
      if (diagnosticScore(c) <= 0) break; // 診断価値の無い通話は選ばない
      diagnosticSet.add(c.call_id);
    }

    // 選定タイプの割当（無作為枠に診断価値もあれば BOTH）
    const selections = new Map();
    for (const c of e2Calls) {
      const inMetric = metricSet.has(c.call_id);
      const inDiag = diagnosticSet.has(c.call_id);
      const diagnosticWorthy = diagnosticScore(c) > 0;
      if (inMetric && diagnosticWorthy) selections.set(c.call_id, 'BOTH');
      else if (inMetric) selections.set(c.call_id, 'METRIC_SAMPLE');
      else if (inDiag) selections.set(c.call_id, 'DIAGNOSTIC_PRIORITY');
    }

    return {
      selections,
      metric: [...metricSet],
      diagnostic: [...diagnosticSet],
    };
  }

  /** official_metric_eligible（詳細§6.2）: 率分母のゲート。 */
  function isOfficialEligible(observability, selectionType) {
    return observability === 'FULL' && (selectionType === 'METRIC_SAMPLE' || selectionType === 'BOTH');
  }

  /** metric_coverage（詳細§6.3）: 品質KPI。 */
  function metricCoverage(metricAcquired, e2Total) {
    if (!e2Total) return null;
    return metricAcquired / e2Total;
  }

  module.exports = {
    DEFAULT_CAP, DEFAULT_METRIC, DEFAULT_DIAGNOSTIC,
    metricKey, diagnosticScore, selectTranscripts, isOfficialEligible, metricCoverage,
  };

  return module.exports;
})();

/* --- module: scoring.js --- */
GChain.scoring = (function () {
  var module = { exports: {} };
  'use strict';
  /**
   * G-Chain OS v1.5 — Q評価合成（詳細設計書 §8.2, baseline §7.2）。
   *
   * 規則:
   *  - 項目スコア ∈ {2,1,0,NA}。NAは0点扱いしない（分母から除外）。
   *  - telemetry欠損の時間系 → NA_TELEMETRY_MISSING（NA扱い）。
   *  - 適用可能満点 < 16 → Q_INSUFFICIENT（非表示）。
   *  - Q_raw = 100 * Σ得点 / 適用可能満点。
   *  - 主表示はセクション別サブスコア。
   *  - 共通項目法: 両期間で適用された項目のみ再計算（分母固定）。
   *  - mastered は優先度除外のみ。総合・共通項目法には残す（回帰番兵）。
   *  - 重大違反 cap C0/C1/C2/C3。cap前後の両スコア保存。
   * 純関数（外部I/O無し）。
   */

  const NA_VALUES = new Set(['NA', 'NA_TELEMETRY_MISSING']);
  const ITEM_MAX = 2;
  const Q_MIN_APPLICABLE = 16; // 適用可能満点の下限
  const SECTIONS = Object.freeze(['A', 'B', 'C', 'D', 'E']); // 冒頭/質問/価値/打診/スタンス

  function isNA(score) {
    return NA_VALUES.has(score);
  }

  function isApplied(item) {
    return !isNA(item.score) && item.score != null;
  }

  /**
   * Q合成（詳細§8.2）。
   * items: [{ id, section, score(2|1|0|'NA'|'NA_TELEMETRY_MISSING'), mastered?:bool }]
   * 返り値:
   *  { status:'OK'|'Q_INSUFFICIENT', q_raw, achieved, applicable_max,
   *    subscores:{A..E}, applied_ids:[], na_ids:[] }
   */
  function computeQ(items) {
    const applied = items.filter(isApplied);
    const applicable_max = applied.length * ITEM_MAX;
    const achieved = applied.reduce((s, it) => s + Number(it.score), 0);

    const sectionAgg = {};
    for (const sec of SECTIONS) sectionAgg[sec] = { achieved: 0, max: 0 };
    for (const it of applied) {
      const sec = it.section;
      if (sectionAgg[sec]) {
        sectionAgg[sec].achieved += Number(it.score);
        sectionAgg[sec].max += ITEM_MAX;
      }
    }
    const subscores = {};
    for (const sec of SECTIONS) {
      const a = sectionAgg[sec];
      subscores[sec] = a.max ? round1(100 * a.achieved / a.max) : null;
    }

    if (applicable_max < Q_MIN_APPLICABLE) {
      return {
        status: 'Q_INSUFFICIENT',
        q_raw: null, achieved, applicable_max, subscores,
        applied_ids: applied.map((i) => i.id),
        na_ids: items.filter((i) => isNA(i.score)).map((i) => i.id),
      };
    }
    return {
      status: 'OK',
      q_raw: round1(100 * achieved / applicable_max),
      achieved, applicable_max, subscores,
      applied_ids: applied.map((i) => i.id),
      na_ids: items.filter((i) => isNA(i.score)).map((i) => i.id),
    };
  }

  /**
   * 重大違反 cap（詳細§8.2, baseline §7.2）。cap前後を両方返す。
   * violations: Set|Array<'C0'|'C1'|'C2'|'C3'>
   * qResult: computeQ の返り値
   * aScore: A軸(資産化)の値（C2 で 0 強制）
   */
  function applyCaps(qResult, violations, aScore) {
    const v = new Set(violations || []);
    const preQ = qResult.q_raw;
    let postQ = preQ;
    const flags = { teacher_excluded: false, pp_excluded: false, itt_retained: false, a_forced_zero: false };

    if (v.has('C0')) { postQ = capAt(postQ, 49); flags.teacher_excluded = true; }
    if (v.has('C1')) { postQ = capAt(postQ, 69); }
    if (v.has('C2')) { flags.a_forced_zero = true; }
    if (v.has('C3')) { flags.pp_excluded = true; flags.itt_retained = true; }

    return {
      caps_applied: [...v].sort(),
      q_pre_cap: preQ,
      q_post_cap: postQ,
      a_pre_cap: aScore,
      a_post_cap: flags.a_forced_zero ? 0 : aScore,
      ...flags,
    };
  }

  function capAt(q, ceil) {
    if (q == null) return q;
    return Math.min(q, ceil);
  }

  /**
   * 共通項目法（詳細§8.2）: 両期間で「適用された」項目のみで両スコア再計算。
   * mastered も残す（分母を動かさない）。
   * itemsA, itemsB: 同一 rubric の項目配列（id で対応）。
   * 返り値: { shared_ids, a:{...computeQ}, b:{...computeQ} }
   */
  function commonItemMethod(itemsA, itemsB) {
    const appliedA = new Set(itemsA.filter(isApplied).map((i) => i.id));
    const appliedB = new Set(itemsB.filter(isApplied).map((i) => i.id));
    const shared = [...appliedA].filter((id) => appliedB.has(id));
    const sharedSet = new Set(shared);
    const filt = (items) => items.filter((i) => sharedSet.has(i.id));
    return {
      shared_ids: shared,
      a: computeQ(filt(itemsA)),
      b: computeQ(filt(itemsB)),
    };
  }

  /**
   * 優先度対象項目（mastered を除外・詳細§8.2）。総合には残すが、コーチング優先度表示から外す。
   */
  function priorityItems(items) {
    return items.filter((i) => !i.mastered);
  }

  /**
   * MORE 優先度（baseline §7.3）: frequency × gate_loss × controllability × confidence。
   */
  function morePriority(f) {
    return Number(f.frequency || 0) * Number(f.gate_loss || 0)
      * Number(f.controllability || 0) * Number(f.confidence || 0);
  }

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  module.exports = {
    NA_VALUES, ITEM_MAX, Q_MIN_APPLICABLE, SECTIONS,
    isNA, isApplied, computeQ, applyCaps, commonItemMethod, priorityItems, morePriority,
  };

  return module.exports;
})();

/* --- module: experiment.js --- */
GChain.experiment = (function () {
  var module = { exports: {} };
  'use strict';
  /**
   * G-Chain OS v1.5 — 実験マネージャ（詳細設計書 §10, baseline §11）。
   *
   * 原則: 一実験一変数／ブロック割付(hash固定・週替わり禁止)／判定日まで効果指標マスク／
   *       ITT主(purpose_planned基準)・PP併記。
   * 純関数（外部I/O無し・now は引数注入）。
   */

  const { stableHash32 } = GChain.normalize;
  const { computeRate } = GChain.kpi;

  const ARMS = Object.freeze(['A', 'B']);

  /**
   * 決定的アーム割付（詳細§10.1）。hash(uid or call_id) % 2。週替わり禁止 = 入力に週を含めない。
   * exp_id を混ぜ実験間で割付を独立させる。
   */
  function assignArm(unitId, expId) {
    const h = stableHash32(String(expId || '') + '|' + String(unitId));
    return ARMS[h % 2];
  }

  /** ブロックキー（詳細§10.1）: 時間帯 × 新規/追客。業界はセル数確認後に追加。 */
  function blockKey(call) {
    const band = timeBand(call.call_at);
    const seg = (call.purpose_planned === 'NEW_PROSPECTING') ? 'new' : 'followup';
    return `${band}#${seg}`;
  }

  function timeBand(callAt) {
    if (!callAt) return 'unk';
    const m = String(callAt).match(/\b(\d{1,2}):/);
    const h = m ? Number(m[1]) : NaN;
    if (!Number.isFinite(h)) return 'unk';
    if (h < 11) return 'am';
    if (h < 14) return 'noon';
    if (h < 17) return 'pm';
    return 'eve';
  }

  /** マスク判定（詳細§10.1）: 判定日前は効果指標を隠す。 */
  function isMasked(nowDate, decisionDate) {
    if (!decisionDate) return true;
    return String(nowDate) < String(decisionDate);
  }

  /**
   * 忠実度検知（詳細§10.2 実験#001）: transcript から give_first を機械検知。
   * B腕は give_first_detected=true, A腕は false が忠実。
   * 返り値: { compliant, reason }
   */
  function checkFidelity(call, expectedArm) {
    const give = !!call.give_first_detected;
    if (expectedArm === 'B') return { compliant: give, reason: give ? 'ok' : 'B_missing_give' };
    if (expectedArm === 'A') return { compliant: !give, reason: give ? 'A_has_give_contamination' : 'ok' };
    return { compliant: true, reason: 'na' };
  }

  /** 割付汚染率（AT-5 <5%）: 忠実度非適合の割合。 */
  function contaminationRate(assignedCalls) {
    let bad = 0;
    for (const c of assignedCalls) {
      if (!checkFidelity(c, c.assigned_arm).compliant) bad++;
    }
    return assignedCalls.length ? bad / assignedCalls.length : 0;
  }

  /**
   * 実験判定（詳細§10.1, baseline §11）。ITT主・PP併記。判定日前はマスク。
   * input:
   *   calls: 割付済 call 配列（各 c.assigned_arm ∈ {A,B}）
   *   metric: { inDenom(call), numerator(call) }  一次指標の分母/分子述語
   *   spec: { decision_date }
   *   nowDate
   * 返り値: マスク中は {masked:true}。判定日以降は ITT/PP のアーム別レートと差分。
   */
  function decideExperiment(calls, metric, spec, nowDate) {
    if (isMasked(nowDate, spec.decision_date)) {
      return { masked: true, decision_date: spec.decision_date };
    }
    const armCalls = (arm) => calls.filter((c) => c.assigned_arm === arm);

    // ITT: 割付通り全件（purpose_planned 基準は metric.inDenom 側で担保）
    const ittA = computeRate(armCalls('A'), metric.inDenom, metric.numerator);
    const ittB = computeRate(armCalls('B'), metric.inDenom, metric.numerator);

    // PP: 忠実度適合のみ
    const compliant = (arm) => armCalls(arm).filter((c) => checkFidelity(c, arm).compliant);
    const ppA = computeRate(compliant('A'), metric.inDenom, metric.numerator);
    const ppB = computeRate(compliant('B'), metric.inDenom, metric.numerator);

    return {
      masked: false,
      decision_date: spec.decision_date,
      itt: { A: ittA, B: ittB, diff: diff(ittB.value, ittA.value) },
      pp: { A: ppA, B: ppB, diff: diff(ppB.value, ppA.value) },
      contamination_rate: contaminationRate(calls),
    };
  }

  function diff(b, a) {
    if (b == null || a == null) return null;
    return Math.round((b - a) * 1000) / 1000;
  }

  module.exports = {
    ARMS, assignArm, blockKey, timeBand, isMasked,
    checkFidelity, contaminationRate, decideExperiment,
  };

  return module.exports;
})();

/* --- module: llm-contract.js --- */
GChain.llmContract = (function () {
  var module = { exports: {} };
  'use strict';
  /**
   * G-Chain OS v1.5 — LLM I/O契約（詳細設計書 §7, baseline §8）。
   *
   * LCS-1.5.0 は1通話につき2 JSON を出力: (A)L1イベント抽出→18形式 / (B)L2診断→03形式。
   * ここでは盲検貼付テンプレ生成と、受入前バリデーション（引用必須・確信度・enum整合・
   * 未来情報禁止・盲検逸脱）を実装する。純関数（外部I/O無し）。
   */

  const {
    SUBTYPE_VOCAB, PROPOSAL_VOCAB, GATES, NONPSYCH_CAUSE_CODES, L_SUBCLASS, EVENT_CODES,
  } = GChain.schema;

  const CONFIDENCE_HOLD = 0.60; // < これは HOLD（baseline §4.2/§8）
  // 盲検で剥ぐべき結果・所感の痕跡（貼付テンプレ検査・詳細§7.3）
  const RESULT_LEAK_PATTERNS = [
    /アポ(取得|獲得|成立|なし|無し)/, /結果[:：]/, /所感[:：]/, /失注/, /受注/,
    /^\s*(良|悪)かった/, /ゴール/, /成功|失敗/,
  ];

  /**
   * 盲検貼付テンプレ生成（詳細§7.3）。transcript本文から結果・所感・アポ有無を機械除去。
   * 返り値: { text, stripped:[{line, reason}] }
   */
  function buildBlindPaste(transcript) {
    const lines = String(transcript || '').split(/\r?\n/);
    const kept = [];
    const stripped = [];
    for (const line of lines) {
      const hit = RESULT_LEAK_PATTERNS.find((re) => re.test(line));
      if (hit) stripped.push({ line, reason: String(hit) });
      else kept.push(line);
    }
    return { text: kept.join('\n'), stripped };
  }

  /** 盲検逸脱検査（詳細§7.2）: 入力に結果・所感が残っていないか。残存行配列を返す。 */
  function detectBlindLeak(text) {
    const lines = String(text || '').split(/\r?\n/);
    return lines.filter((l) => RESULT_LEAK_PATTERNS.some((re) => re.test(l)));
  }

  function inVocab(val, list) {
    return val == null || val === '' || list.indexOf(val) >= 0;
  }

  /**
   * L1イベント抽出JSON バリデーション（詳細§7.1-7.2）。
   * 返り値: { valid, errors:[], holds:[event_id], invalidated:[event_id] }
   * - E3〜E5 は evidence_quote 必須（無ければ当該ラベル無効）
   * - label_confidence < 0.60 は HOLD
   * - enum 整合（subtype/info_class/value_type/novelty/speaker）
   */
  function validateL1Json(json) {
    const errors = [];
    const holds = [];
    const invalidated = [];
    if (!json || typeof json !== 'object') return { valid: false, errors: ['not_object'], holds, invalidated };
    if (!json.call_id) errors.push('missing_call_id');
    const events = Array.isArray(json.events) ? json.events : [];

    for (const ev of events) {
      const tag = ev.event_id || `${json.call_id}-${ev.event_code}-${ev.event_order}`;
      if (!EVENT_CODES.includes(ev.event_code)) errors.push(`bad_event_code:${ev.event_code}`);

      // 引用必須（E3〜E5）
      if (['E3', 'E4', 'E5'].includes(ev.event_code) && !ev.evidence_quote) {
        invalidated.push(tag);
        errors.push(`missing_evidence_quote:${tag}`);
      }
      // 確信度
      if (ev.label_confidence != null && Number(ev.label_confidence) < CONFIDENCE_HOLD) {
        holds.push(tag);
      }
      // enum 整合
      const sub = ev.subtype || {};
      if (ev.event_code === 'E4') {
        if (!inVocab(sub.info_class, SUBTYPE_VOCAB.E4_info_class)) errors.push(`bad_info_class:${tag}`);
        if (!inVocab(ev.novelty, SUBTYPE_VOCAB.E4_novelty)) errors.push(`bad_novelty:${tag}`);
      }
      if (ev.event_code === 'E5') {
        if (!inVocab(sub.value_type, SUBTYPE_VOCAB.E5_value_type)) errors.push(`bad_value_type:${tag}`);
        if (!inVocab(sub.disclosure_grade, SUBTYPE_VOCAB.E5_disclosure_grade)) errors.push(`bad_disclosure_grade:${tag}`);
      }
      if (ev.event_code === 'E7') {
        if (!inVocab(ev.subtype && ev.subtype.e7_subtype || sub.e7_subtype, SUBTYPE_VOCAB.E7_subtype)) errors.push(`bad_e7_subtype:${tag}`);
      }
      if (!inVocab(ev.speaker, SUBTYPE_VOCAB.speaker)) errors.push(`bad_speaker:${tag}`);
    }

    // 打診（proposals）enum
    for (const p of (json.proposals || [])) {
      if (!inVocab(p.proposal_type, PROPOSAL_VOCAB.proposal_type)) errors.push(`bad_proposal_type`);
      if (!inVocab(p.proposal_form, PROPOSAL_VOCAB.proposal_form)) errors.push(`bad_proposal_form`);
      if (!inVocab(p.customer_response, PROPOSAL_VOCAB.customer_response)) errors.push(`bad_customer_response`);
    }

    return { valid: errors.length === 0, errors, holds, invalidated };
  }

  /**
   * L2診断JSON バリデーション（詳細§7.1-7.2）。
   * - evidence_quotes 空なら診断無効
   * - gate_confidence < 0.60 → HOLD
   * - gate/l_subclass/nonpsych_cause の enum 整合
   * - 未来情報禁止（outcome 参照フィールドが無いこと）
   * - GOOD/MORE/次行動/次NG の必須フィールド（構造チェック）
   * 返り値: { valid, errors:[], status:'ACTIVE'|'HOLD' }
   */
  function validateL2Json(json) {
    const errors = [];
    if (!json || typeof json !== 'object') return { valid: false, errors: ['not_object'], status: 'HOLD' };
    if (!json.call_id) errors.push('missing_call_id');

    const quotes = json.evidence_quotes || [];
    if (!Array.isArray(quotes) || quotes.length === 0) errors.push('missing_evidence_quotes');

    const gate = json.gate || {};
    if (!inVocab(gate.primary, GATES)) errors.push('bad_primary_gate');
    if (!inVocab(gate.secondary, GATES)) errors.push('bad_secondary_gate');
    if (gate.alternative_nonpsychological_cause == null || gate.alternative_nonpsychological_cause === '') {
      errors.push('missing_alternative_cause'); // "none" 明記が必要
    }

    const attr = json.attribution || {};
    if (!inVocab(attr.l_subclass, L_SUBCLASS)) errors.push('bad_l_subclass');
    if (!inVocab(attr.nonpsych_cause_code, NONPSYCH_CAUSE_CODES)) errors.push('bad_nonpsych_cause');

    // 未来情報禁止（詳細§7.2）: 診断に outcome/journey_outcome を持ち込まない
    for (const leak of ['outcome', 'journey_outcome', 'appointment_result']) {
      if (json[leak] != null) errors.push(`future_info_leak:${leak}`);
    }

    // GOOD/MORE/次行動/次NG 構造（baseline §7.3）
    requireFields(json.good, ['action', 'quote', 'passed_event', 'reason', 'reuse_condition'], 'good', errors);
    requireFields(json.next_action, ['when', 'do', 'say', 'success', 'window'], 'next_action', errors);
    requireFields(json.next_ng, ['stop_condition', 'alternative'], 'next_ng', errors);

    const conf = Number(gate.gate_confidence);
    const status = (Number.isFinite(conf) && conf < CONFIDENCE_HOLD) ? 'HOLD' : 'ACTIVE';

    return { valid: errors.length === 0, errors, status };
  }

  function requireFields(obj, fields, label, errors) {
    if (!obj || typeof obj !== 'object') { errors.push(`missing_${label}`); return; }
    for (const f of fields) {
      if (obj[f] == null || obj[f] === '') errors.push(`missing_${label}.${f}`);
    }
  }

  module.exports = {
    CONFIDENCE_HOLD, RESULT_LEAK_PATTERNS,
    buildBlindPaste, detectBlindLeak, validateL1Json, validateL2Json,
  };

  return module.exports;
})();

/* --- module: meta.js --- */
GChain.meta = (function () {
  var module = { exports: {} };
  'use strict';
  /**
   * G-Chain OS v1.5 — M層メタ評価・回帰ゲート（詳細設計書 §11, baseline §9）。
   *
   * 評価基準自体を仮説として淘汰する層。M1〜M5 とライフサイクル、回帰ゲート（切替の門）。
   * 純関数（外部I/O無し）。
   */

  const MIN_ELIGIBLE_N = 30; // 有効レビュー（詳細§11.1）

  /**
   * M1: 改善余地×変動性（詳細§11.1）。
   * scores: 数値配列（当該項目の採点、NA除外済み）。target: 目標値。prevMean: 前週平均。
   * 返り値: { eligible_n, mean, variance, weekly_change, target_gap, verdict }
   *   verdict: 'mastered'(全満点=回帰番兵) | 'top_priority'(全0) | 'definition_suspect'(全NA/n=0) | 'active'
   */
  function m1(scores, opts) {
    const o = opts || {};
    const vals = scores.filter((v) => typeof v === 'number');
    const n = vals.length;
    if (n === 0) return { eligible_n: 0, mean: null, variance: null, weekly_change: null, target_gap: null, verdict: 'definition_suspect' };
    const mean = vals.reduce((a, b) => a + b, 0) / n;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    const max = o.item_max != null ? o.item_max : 2;
    let verdict = 'active';
    if (vals.every((v) => v === max)) verdict = 'mastered';       // 回帰番兵（休眠にしない）
    else if (vals.every((v) => v === 0)) verdict = 'top_priority'; // 最優先（休眠禁止）
    return {
      eligible_n: n,
      mean: round3(mean),
      variance: round3(variance),
      weekly_change: o.prev_mean != null ? round3(mean - o.prev_mean) : null,
      target_gap: o.target != null ? round3(o.target - mean) : null,
      verdict,
    };
  }

  /**
   * M2: 判定信頼性 — 二次重み付きκ（詳細§11.1）。
   * ratingsA, ratingsB: 対応する整数評点配列（NA は事前に対で除外）。
   * カテゴリ数は maxCat+1（既定 0,1,2 の3カテゴリ）。
   */
  function weightedKappa(ratingsA, ratingsB, maxCat) {
    const K = (maxCat != null ? maxCat : 2) + 1;
    const n = ratingsA.length;
    if (n === 0 || n !== ratingsB.length) return null;

    const O = Array.from({ length: K }, () => new Array(K).fill(0));
    const rowMarg = new Array(K).fill(0);
    const colMarg = new Array(K).fill(0);
    for (let i = 0; i < n; i++) {
      const a = ratingsA[i], b = ratingsB[i];
      if (a < 0 || a >= K || b < 0 || b >= K) return null;
      O[a][b]++; rowMarg[a]++; colMarg[b]++;
    }
    // 二次重み W[i][j] = (i-j)^2 / (K-1)^2
    const denom = (K - 1) ** 2;
    let numObs = 0, numExp = 0;
    for (let i = 0; i < K; i++) {
      for (let j = 0; j < K; j++) {
        const w = ((i - j) ** 2) / denom;
        const eij = (rowMarg[i] * colMarg[j]) / n;
        numObs += w * O[i][j];
        numExp += w * eij;
      }
    }
    if (numExp === 0) return 1; // 完全一致（分散無し）
    return round3(1 - numObs / numExp);
  }

  /**
   * C0〜C3 の生涯信頼性（詳細§11.1）: 再現率100%・偽陽性≤5%。
   * cases: [{ gold_violation:bool, detected_violation:bool }]（当該Cコードのみ）
   * 返り値: { recall, false_positive_rate, pass }
   */
  function capReliability(cases) {
    let tp = 0, fn = 0, fp = 0, tn = 0;
    for (const c of cases) {
      if (c.gold_violation && c.detected_violation) tp++;
      else if (c.gold_violation && !c.detected_violation) fn++;
      else if (!c.gold_violation && c.detected_violation) fp++;
      else tn++;
    }
    const recall = (tp + fn) ? tp / (tp + fn) : 1;
    const fpr = (fp + tn) ? fp / (fp + tn) : 0;
    return { recall: round3(recall), false_positive_rate: round3(fpr), pass: recall >= 1 && fpr <= 0.05 };
  }

  /**
   * M4a: actionability（詳細§11.1）— MORE選出→実行可能次行動の生成率。
   * items: [{ more_selected:bool, actionable_next_action:bool }]
   */
  function actionability(items) {
    const sel = items.filter((i) => i.more_selected);
    if (!sel.length) return null;
    const ok = sel.filter((i) => i.actionable_next_action).length;
    return round3(ok / sel.length);
  }

  /**
   * M4b 昇格判定（詳細§11.1）: proximal≥最小実務差 ∧ downstream2窓連続同方向 ∧ confounded=false。
   * res: { proximal_effect, min_practical_effect, downstream:[w1_dir, w2_dir], confounded }
   */
  function m4bPromote(res) {
    const proximalOk = Number(res.proximal_effect) >= Number(res.min_practical_effect);
    const d = res.downstream || [];
    const downstreamOk = d.length >= 2 && d[0] != null && d[0] === d[1] && d[0] !== 0;
    return proximalOk && downstreamOk && res.confounded === false;
  }

  /**
   * M5: コスト（詳細§11.1）。NA率・保留率・所要。
   * items: [{ na:bool, hold:bool, duration_sec:number }]
   */
  function m5(items) {
    const n = items.length || 1;
    const na = items.filter((i) => i.na).length / n;
    const hold = items.filter((i) => i.hold).length / n;
    const dur = items.reduce((a, b) => a + (Number(b.duration_sec) || 0), 0) / n;
    return { na_rate: round3(na), hold_rate: round3(hold), avg_duration_sec: round3(dur) };
  }

  /**
   * 回帰ゲート（詳細§11.3, baseline §9.3）— 切替の門。回帰未実施の切替禁止。
   * mode: 'prompt_minor'（ゴールド20）| 'model_or_criteria'（ゴールド60）
   * metrics: { gold_n, item_agreement, more_agreement, c_detection_diff, mae, e_agreement }
   * 返り値: { pass, mode, required, failures:[] }
   */
  function regressionGate(mode, metrics) {
    const failures = [];
    const req = mode === 'model_or_criteria'
      ? { gold_n: 60, item_agreement: 0.95, more_agreement: 0.80, c_detection_diff: 0, mae_max: 8, e_agreement: 0.95 }
      : { gold_n: 20, item_agreement: 0.90, more_agreement: 0.80, c_detection_diff: 0 };

    if ((metrics.gold_n || 0) < req.gold_n) failures.push(`gold_n<${req.gold_n}`);
    if ((metrics.item_agreement || 0) < req.item_agreement) failures.push(`item_agreement<${req.item_agreement}`);
    if ((metrics.more_agreement || 0) < req.more_agreement) failures.push(`more_agreement<${req.more_agreement}`);
    if (Math.abs(metrics.c_detection_diff || 0) > req.c_detection_diff) failures.push('c_detection_diff!=0');
    if (mode === 'model_or_criteria') {
      if ((metrics.mae == null ? Infinity : metrics.mae) > req.mae_max) failures.push('mae>8');
      if ((metrics.e_agreement || 0) < req.e_agreement) failures.push('e_agreement<0.95');
    }
    return { pass: failures.length === 0, mode, required: req, failures };
  }

  function round3(n) {
    return Math.round(n * 1000) / 1000;
  }

  module.exports = {
    MIN_ELIGIBLE_N,
    m1, weightedKappa, capReliability, actionability, m4bPromote, m5, regressionGate,
  };

  return module.exports;
})();

/* --- orchestration --- */
/* ============================================================================
 * G-Chain OS v1.5 — GAS オーケストレーション層（詳細設計書 §2, §12）
 *
 * 上のバンドル部（GChain.*）は src/gchain/*.js の単一正本から build-gas.js が生成。
 * ここは Sheets/Drive I/O と SYNC-0..6・18→01再生成・保護を担う薄いGAS層。
 * 依存: SpreadsheetApp / DriveApp（会社Workspace）。外部API依存ゼロ（baseline §0.2）。
 * ========================================================================== */

var GC = GChain; // 短縮

/** メニュー（onOpen）。人手操作の入口。 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('G-Chain OS')
    .addItem('初期セットアップ（19シート生成）', 'gcSetup')
    .addItem('日次同期 SYNC-0..6', 'gcRunSync')
    .addItem('二枠選定を提示', 'gcProposeSampling')
    .addItem('01を18から再生成', 'gcRegenerateAll')
    .addToUi();
}

/** 初期セットアップ: schema から全シートを生成し、生成ビューを保護（詳細§1.2, §3）。 */
function gcSetup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = GC.schema.SHEETS;
  Object.keys(sheets).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var cols = GC.schema.physicalColumns(name);
    if (sh.getLastRow() === 0) sh.appendRow(cols);
    if (GC.schema.isGenerated(name)) _protect(sh); // 直接編集禁止
  });
  // 00_設定 既定投入
  _seedSettings(ss);
  SpreadsheetApp.getUi().alert('G-Chain OS: 19シート＋取込面を生成しました。');
}

function _protect(sh) {
  var p = sh.protect().setDescription('generated view — GAS only');
  p.removeEditors(p.getEditors());
  p.setWarningOnly(true); // 誤編集警告（サービスアカウント運用時は false + editor限定）
}

function _seedSettings(ss) {
  var sh = ss.getSheetByName('00_設定');
  if (sh.getLastRow() > 1) return; // 既投入
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var rows = GC.config.seedRows(today);
  var out = rows.map(function (r) { return [r.key, r.value, r.valid_from, r.valid_until, '']; });
  if (out.length) sh.getRange(2, 1, out.length, 5).setValues(out);
}

/** 日次同期 SYNC-0..6（詳細§2.2）。冪等・batch状態遷移。 */
function gcRunSync() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var batchId = _newBatchId(ss);
  _setBatchState(ss, batchId, 'STARTED');
  try {
    var ingested = _sync4_normalizeAndIngest(ss, batchId); // 列認識・型変換・source_event_id・18投入
    _setBatchState(ss, batchId, 'NORMALIZED');
    _sync5_qualityReport(ss, batchId, ingested);            // 件数一致・重複・名寄せ率・metric_coverage
    gcRegenerateAll();                                      // 18→01再生成
    _setBatchState(ss, batchId, 'GENERATED');
    _sync6_snapshotAndClear(ss, batchId);                   // Drive保存→取込面クリア
    _setBatchState(ss, batchId, 'DONE');
  } catch (e) {
    _setBatchState(ss, batchId, 'FAILED');                  // 取込面はクリアしない（復旧のため）
    throw e;
  }
}

/** SYNC-4: 取込3面→正規化→18生観測投入（冪等キーで重複skip）。 */
function _sync4_normalizeAndIngest(ss, batchId) {
  var stats = { ingest_delta: 0, sources: {} };
  ['00_取込_BALES', '00_取込_SF', '00_取込_MiiTel'].forEach(function (src) {
    var rows = _readRows(ss, src);
    var existing = _existingIdempotencyKeys(ss);
    rows.forEach(function (row) {
      var fields = _extractFields(src, row);
      var key = GC.normalize.idempotencyKey(fields);
      if (existing[key]) return;          // 既存 → skip（増分ゼロ・詳細§2.3）
      _appendObservations(ss, src, batchId, fields, row);
      existing[key] = true;
      stats.ingest_delta++;
    });
    stats.sources[src] = rows.length;
  });
  return stats;
}

/** SYNC-5: 品質KPIを 12_データ品質 に記録（詳細§2.2）。 */
function _sync5_qualityReport(ss, batchId, stats) {
  var obs = _readRows(ss, '18_Eイベント明細');
  var deduped = GC.canonical.dedupeObservations(obs, { bucketSec: _setting(ss, 'dedup_time_bucket_sec') });
  var conflicts = GC.canonical.assertCanonicalUnique(deduped);
  var warnings = conflicts.length ? [{ code: 'CANONICAL_CONFLICT', detail: conflicts }] : [];
  _writeQuality(ss, batchId, {
    ingest_delta: stats.ingest_delta,
    warnings_json: JSON.stringify(warnings),
  });
}

/** SYNC-6: raw を Drive 制限フォルダへ保存し取込面をクリア（詳細§2.2, §14）。 */
function _sync6_snapshotAndClear(ss, batchId) {
  var folder = _rawFolder();
  ['00_取込_BALES', '00_取込_SF', '00_取込_MiiTel'].forEach(function (src) {
    var sh = ss.getSheetByName(src);
    var data = sh.getDataRange().getValues();
    folder.createFile(batchId + '_' + src + '.json', JSON.stringify(data), 'application/json');
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();
  });
}

/** 二枠選定を提示（詳細§6.1）。人はGASが選んだ通話だけ MiiTel を貼る。 */
function gcProposeSampling() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var e2Calls = _todayE2Calls(ss);
  var sel = GC.sampling.selectTranscripts(e2Calls, {
    metricSize: _setting(ss, 'metric_sample_size'),
    diagnosticSize: _setting(ss, 'diagnostic_size'),
  });
  var lines = ['[METRIC] ' + sel.metric.join(', '), '[DIAGNOSTIC] ' + sel.diagnostic.join(', ')];
  SpreadsheetApp.getUi().alert('本日の文字起こし対象:\n' + lines.join('\n'));
}

/** 01 を 18(is_canonical) から全再生成（詳細§4）。生成ビューは常にここでのみ更新。 */
function gcRegenerateAll() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var obs = _readRows(ss, '18_Eイベント明細');
  var deduped = GC.canonical.dedupeObservations(obs, { bucketSec: _setting(ss, 'dedup_time_bucket_sec') });
  var byCall = {};
  deduped.filter(function (r) { return r.is_canonical; }).forEach(function (r) {
    (byCall[r.call_id] = byCall[r.call_id] || []).push(r);
  });
  var nowSec = Math.floor(Date.now() / 1000);
  var win = _setting(ss, 'e8_attribution_days');
  var out = [];
  Object.keys(byCall).forEach(function (callId) {
    var events = byCall[callId];
    var meta = _callMeta(ss, callId);
    var r = GC.eventEngine.resolveCall({
      call_id: callId,
      event_observability: meta.event_observability,
      canonicalEvents: events,
      createdE7Records: _createdE7Records(ss, callId),
      flags: meta.flags,
      nowSec: nowSec,
      e8WindowDays: win,
    });
    out.push(_toCallRow(callId, meta, r));
  });
  _write01(ss, out);
}

/* ---- 以下は Sheets I/O ヘルパ（実運用で列マッピングに合わせ実装） ---- */
function _readRows(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  var values = sh.getDataRange().getValues();
  var head = values[0];
  return values.slice(1).map(function (row) {
    var o = {}; head.forEach(function (h, i) { o[h] = row[i]; }); return o;
  });
}
function _setting(ss, key) {
  var rows = _readRows(ss, '00_設定');
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var v = GC.config.resolveSetting(rows, key, today);
  return v != null ? v : GC.config.DEFAULTS[key];
}
function _newBatchId(ss) {
  var d = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd');
  var q = _readRows(ss, '12_データ品質').filter(function (r) { return String(r.batch_id).indexOf(d) === 0; });
  return d + '-' + String(q.length + 1).padStart(3, '0');
}
function _setBatchState(ss, batchId, state) { _writeQuality(ss, batchId, { batch_state: state }); }
function _rawFolder() {
  var name = 'GChainOS_raw_restricted';
  var it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}
// 実装未確定の I/O は Wave 0 実データで確定（詳細 付録A）。以下はプレースホルダ。
function _existingIdempotencyKeys(ss) { return {}; }
function _extractFields(src, row) { return row; }
function _appendObservations(ss, src, batchId, fields, row) { /* 18へ生観測追記 */ }
function _writeQuality(ss, batchId, patch) { /* 12へ upsert */ }
function _todayE2Calls(ss) { return []; }
function _callMeta(ss, callId) { return { event_observability: 'NONE', flags: {} }; }
function _createdE7Records(ss, callId) { return []; }
function _toCallRow(callId, meta, r) { return [callId].concat(Object.keys(r.states).map(function (k) { return r.states[k]; })); }
function _write01(ss, rows) { /* 01へ再生成書込（保護を一時解除して更新） */ }

