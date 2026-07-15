'use strict';
/* @deprecated v2.0(MiiTel非依存)で廃止: transcript抽出そのもの。設計 docs/g-chain-os-v2.0-structured-only.md §9。参照用に保持(barrel除外)。 */
/**
 * G-Chain OS v1.5 — LLM I/O契約（詳細設計書 §7, baseline §8）。
 *
 * LCS-1.5.0 は1通話につき2 JSON を出力: (A)L1イベント抽出→18形式 / (B)L2診断→03形式。
 * ここでは盲検貼付テンプレ生成と、受入前バリデーション（引用必須・確信度・enum整合・
 * 未来情報禁止・盲検逸脱）を実装する。純関数（外部I/O無し）。
 */

const {
  SUBTYPE_VOCAB, PROPOSAL_VOCAB, GATES, NONPSYCH_CAUSE_CODES, L_SUBCLASS, EVENT_CODES,
} = require('./schema');

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
