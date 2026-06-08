'use strict';

// スプレッドシートの C 列以降に書き戻す結果カラム。
// 入力は A=company_name（必須）, B=homepage_url（任意・空なら企業名から自動発見）。
const OUTPUT_HEADERS = [
  'status', 'resolved_url', 'phone', 'name', 'role', 'department', 'confidence',
  'url_source', 'phone_source_url', 'name_source_url', 'evidence', 'engine',
  'pages_checked', 'elapsed_ms', 'error', 'updated_at',
];

/**
 * シートの values（2次元配列。1行目=ヘッダ）を企業オブジェクト配列へ変換。
 * A列=company_name（必須）, B列=homepage_url（任意）, C列=既存status（あれば）。
 * row はシート上の実際の行番号（1始まり）。企業名・URLが共に空の行はスキップ。
 */
function rowsToCompanies(rows) {
  const out = [];
  if (!Array.isArray(rows)) return out;
  for (let i = 1; i < rows.length; i++) {       // i=0 はヘッダ行
    const r = rows[i] || [];
    const name = String(r[0] ?? '').trim();
    const homepage = String(r[1] ?? '').trim();
    const status = String(r[2] ?? '').trim();
    if (!name && !homepage) continue;            // 企業名もURLも無い行は対象外
    out.push({ name: name || '(no name)', homepage_url: homepage, row: i + 1, status });
  }
  return out;
}

/** processCompany の結果を、C列以降に書き込む1行（OUTPUT_HEADERS と同数）へ整形 */
function resultToRow(r) {
  r = r || {};
  return [
    r.status || '',
    r.resolved_url || '',
    r.phone || '',
    r.name || '',
    r.role || '',
    r.department || '',
    (r.confidence != null && r.confidence !== '') ? Number(r.confidence) : '',
    r.url_source || '',
    r.phone_source_url || '',
    r.name_source_url || '',
    r.evidence || '',
    r.engine || '',
    (r.pages_checked != null) ? r.pages_checked : '',
    (r.elapsed_ms != null) ? r.elapsed_ms : '',
    r.error || '',
    new Date().toISOString(),
  ];
}

module.exports = { OUTPUT_HEADERS, rowsToCompanies, resultToRow };
