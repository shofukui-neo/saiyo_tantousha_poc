'use strict';
/**
 * G-Chain OS v1.5 — Wave 0 BALES 列→Eイベント マッピング（詳細設計書 付録A の確定実装）。
 *
 * MiiTel transcript が無いため、BALESの構造化「コール結果」を正規源(bales_structured)として
 * E0-E2 の接続ファネルを確定し、次のアクション/商談から E7/E8 を導く。
 * 会話質(E3-E6)は transcript 欠損のため原則 UNKNOWN（顧客の課題感メモがある時のみ bales_note で E4/E5 を弱く付与）。
 * 純関数（外部I/O無し）。
 */

// コール結果1：結果 → 接続イベントの真偽（構造化・observability=PARTIAL）。
// e0=発信成立, e1=人接触, e2=担当接続。null は当該結果からは判定不能(UNKNOWN)。
const RESULT_MAP = {
  '担当者接触：アポ獲得': { e0: true, e1: true, e2: true, e7: 'meeting_confirmed' },
  '担当者接触：お断り': { e0: true, e1: true, e2: true },
  '担当者接触：営業フォロー': { e0: true, e1: true, e2: true, e7soft: true },
  'ヒアリング成功': { e0: true, e1: true, e2: true, hearing: true },
  'ヒアリング不可': { e0: true, e1: true, e2: true },
  '問い合わせ': { e0: true, e1: true, e2: true, inbound: true },
  '担当者不在': { e0: true, e1: true, e2: false },
  '受付ブロック': { e0: true, e1: true, e2: false, reception: true },
  '鳴りっぱなし': { e0: true, e1: false, e2: false },
  'コールのみ': { e0: true, e1: null, e2: null },
  '番号不備': { e0: false, e1: false, e2: false, invalid: true },
  '現在使われていない': { e0: false, e1: false, e2: false, invalid: true },
};

/** 接続先で E2 を補正（担当者=E2成立の傍証）。 */
function refineByContact(base, connectTo) {
  const b = Object.assign({}, base);
  if (connectTo === '担当者' && b.e2 == null) b.e2 = true;
  if (connectTo === '担当者以外' && b.e2 == null) b.e2 = false;
  return b;
}

/**
 * BALESレコード → 生観測配列（18形式・is_canonical付与前）。
 * rec は列名→値のオブジェクト。callId/observationId 採番は呼出側。
 */
function toObservations(rec, ids) {
  const result = (rec['コール結果1：結果'] || '').trim();
  const connectTo = (rec['コール結果1：接続先'] || '').trim();
  const startedAt = (rec['コール結果1：開始日時'] || '').trim();
  const callId = ids.callId;
  const obs = [];
  let n = 0;
  const push = (event_code, over) => {
    obs.push(Object.assign({
      event_id: `${callId}-${event_code}-${n}`,
      observation_id: `${ids.observationBase}-${n}`,
      call_id: callId,
      event_code,
      source_type: 'bales_structured',
      occurred_at_sec: null,
      subtype: '',
      event_order: n,
      sequence_quality: 'inferred',
      extractor_version: 'bales-map-1.5',
      label_confidence: 0.9,
      reviewed: false,
    }, over));
    n++;
  };

  const base = RESULT_MAP[result];
  const meta = { called: false, e0: null, e1: null, e2: null, invalid: false, hearing: false };
  if (base) {
    const m = refineByContact(base, connectTo);
    meta.called = true;
    meta.e0 = m.e0; meta.e1 = m.e1; meta.e2 = m.e2;
    meta.invalid = !!m.invalid;
    meta.hearing = !!m.hearing;
    // 成立(TRUE)イベントのみ 18 に観測行を作る（FALSEは resolveCall が observability から導出）
    if (m.e0 === true) push('E0');
    if (m.e1 === true) push('E1');
    if (m.e2 === true) push('E2');
    // ヒアリング成功 → 課題感メモがあれば E4/E5 を bales_note で弱く付与
    if (m.hearing || (rec['カスタム情報：顧客の課題感'] || '').trim()) {
      const issue = (rec['カスタム情報：顧客の課題感'] || '').trim();
      if (issue) {
        push('E5', {
          source_type: 'bales_note', label_confidence: 0.5, sequence_quality: 'unknown',
          subtype: 'problem', value_type: 'problem', disclosure_grade: 'b',
          evidence_quote: issue.slice(0, 120),
        });
      }
      const status = (rec['カスタム情報：顧客の現状'] || '').trim();
      if (status) {
        push('E4', {
          source_type: 'bales_note', label_confidence: 0.5, sequence_quality: 'unknown',
          info_class: 'business', novelty: 'new', evidence_quote: status.slice(0, 120),
        });
      }
    }
    // E7: アポ獲得 → meeting_confirmed(created)
    if (m.e7) push('E7', { subtype: m.e7, next_step_disposition: 'created', source_type: 'bales_structured', label_confidence: 0.95 });
  }

  // 次のアクション1〜16 → E7(次接点計画) / E8(完了)
  const nextActions = collectNextActions(rec);
  meta.next_action_count = nextActions.length;
  meta.next_action_completed = nextActions.filter((a) => a.done).length;
  for (const a of nextActions) {
    if (a.done && meta.e2 === true && result === '担当者接触：アポ獲得') {
      // アポ獲得の次アクション完了 → E8 held の傍証（resolveCall は createdE7Records で解決）
    }
  }

  return { observations: obs, meta, startedAt, nextActions, result, connectTo };
}

/** 次のアクション1〜16 を配列化。 */
function collectNextActions(rec) {
  const out = [];
  for (let i = 1; i <= 16; i++) {
    const name = (rec[`次のアクション${i}：アクション名`] || '').trim();
    const planned = (rec[`次のアクション${i}：予定日時`] || '').trim();
    const done = (rec[`次のアクション${i}：完了日時`] || '').trim();
    if (!name && !planned && !done) continue;
    out.push({ index: i, name, planned, done: !!done, done_at: done, planned_at: planned });
  }
  return out;
}

/**
 * createdE7Records（event-engine.resolveCall 用）を BALES から構築。
 * アポ獲得(meeting_confirmed) を created E7 とし、完了/商談で E8 を解決。
 */
function createdE7Records(parsed, rec, nowSec) {
  const recs = [];
  if (parsed.result === '担当者接触：アポ獲得') {
    // 商談作成 or 次アクション完了 → held、未完了は pending
    const dealCreated = (rec['商談1：商談作成日時'] || '').trim();
    const anyDone = parsed.nextActions.some((a) => a.done);
    let outcome = 'pending';
    if (dealCreated || anyDone) outcome = 'held';
    recs.push({
      next_step_disposition: 'created',
      next_step_outcome: outcome,
      occurred_at_epoch: toEpochSec(parsed.startedAt),
    });
  }
  return recs;
}

function toEpochSec(dt) {
  if (!dt) return NaN;
  const m = String(dt).match(/(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})/);
  if (!m) return NaN;
  const [, y, mo, d, hh, mi] = m.map(Number);
  return Math.floor(Date.UTC(y, mo - 1, d, hh, mi) / 1000);
}

module.exports = {
  RESULT_MAP, refineByContact, toObservations, collectNextActions, createdE7Records, toEpochSec,
};
