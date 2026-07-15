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

const { E7_STRENGTH } = require('./schema');

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
