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
  toHalfWidth, normCorpNumber, normCompanyName, mergeKey, truthy,
};
