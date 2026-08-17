'use strict';
// 共有CSVユーティリティ＋名寄せキー生成。
// 多系統マージ（merge.js）・ソース別KPI（source-kpi.js）・統合オーケストレータ（build-list.js）で共用。
// 依存なし・純ロジック（ネットワーク/APIキー不要）。

/**
 * 区切り文字の推定（ヘッダ行のみで判定）。
 * スプレッドシートから落とした「.csv だが中身はTSV」が混ざるため。実害があった例:
 * MOCHICA既存顧客マスタがTSVで、カンマ固定パースだと1列に潰れて `法人名` が引けず、
 * exclusion-index の顧客レイヤが**0件突合のまま警告も出ずに**通っていた（2026-08）。
 * ヘッダにカンマが1つでもあれば従来通りカンマ（既存CSVの挙動を変えない）。
 */
function sniffDelimiter(s) {
  const head = s.slice(0, s.indexOf('\n') + 1 || s.length);
  if (head.includes(',')) return ',';
  return head.includes('\t') ? '\t' : ',';
}

// ---- CSVパース（ダブルクォート対応・改行/カンマ内包可・BOM除去・TSV自動判別）----
function parseCsv(text, opts = {}) {
  const rows = [];
  let row = [], cur = '', q = false;
  const s = String(text).replace(/^﻿/, '');
  const delim = opts.delimiter || sniffDelimiter(s);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
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
function readCsv(text, opts) { return rowsToRecords(parseCsv(text, opts)); }

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
// 社名末尾/内部の注釈（別称・読み・支店ラベル）を囲む括弧類。
// 例: 「高知県農業協同組合(JA高知県)」「○○銀行【本店営業部】」「田中商店（たなか）」
//     → 括弧内は同一法人を指す別称/読み/内部ラベルであり、法人の同定には使わない。
// 最内周から反復除去（入れ子・複数対応）。除去して空になる場合は原文を維持（degenerate回避）。
function stripAnnotations(input) {
  let s = input;
  let prev;
  do {
    prev = s;
    s = s
      .replace(/【[^【】]*】/g, '')
      .replace(/〔[^〔〕]*〕/g, '')
      .replace(/《[^《》]*》/g, '')
      .replace(/\([^()]*\)/g, '')
      .replace(/\[[^\[\]]*\]/g, '');
  } while (s !== prev);
  return s;
}
function normCompanyName(name) {
  let s = toHalfWidth(name).trim();
  // 囲み文字の法人格マーク（㈱㈲㈳㈿）を除去
  s = s.replace(/[㈱㈲㈳㈿]/g, '');
  // 括弧類の注釈（別称/読み/支店ラベル。(株)(有)等の法人格表記もここで一括除去）
  const stripped = stripAnnotations(s);
  if (stripped.replace(/[\s・,，.．\-‐－―_/／&＆]/g, '').trim()) s = stripped; // 空にならない時のみ採用
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
  parseCsv, rowsToRecords, readCsv, csvEscape, toCsv, sniffDelimiter,
  toHalfWidth, normCorpNumber, normCompanyName, stripAnnotations, mergeKey, truthy, CORP_FORMS,
};
