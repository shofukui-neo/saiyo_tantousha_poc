'use strict';
/**
 * G-Chain OS v1.5 — 正規化・冪等キー（詳細設計書 §5.1–5.2, §2.3 冪等性）。
 *
 * normCompanyName / normCorpNumber は既存 src/csv.js と規則を共有（詳細§5.2 の要件）。
 * ここでは電話・日時の正規化と、Node/GAS 双方で同一値を返す決定的ハッシュを追加する。
 * 純関数のみ（外部I/O無し）。GAS へは同一ソースをバンドルして流用する前提。
 */

const { normCompanyName, normCorpNumber, toHalfWidth } = require('../csv');

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
