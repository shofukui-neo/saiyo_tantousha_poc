'use strict';
/**
 * G-Chain OS v1.5 — canonical統合（詳細設計書 §5.3–5.4, baseline §5.3）。
 *
 * 18 は生観測を全保持（削除禁止）。dedup_key ごとに1つだけ is_canonical=true を残す。
 * 集計・path_pattern・ask_count は is_canonical=true のみを使う（E7重複行を構造的に防止）。
 * 純関数（外部I/O無し）。
 */

const { SOURCE_PRIORITY } = require('./schema');
const { normDatetime } = require('./normalize');

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
