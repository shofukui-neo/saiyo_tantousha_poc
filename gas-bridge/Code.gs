/**
 * 採用担当者名PoC ─ スプレッドシート橋渡し（GCP不要の方式②）
 *
 * 使い方:
 *  1) 対象スプレッドシートを開く → 拡張機能 → Apps Script
 *  2) このコードを貼り付け、必要なら TAB を実際のシート名に変更
 *  3) デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *       - 次のユーザーとして実行: 自分
 *       - アクセスできるユーザー: 全員
 *  4) 発行された /exec のURLを PoC の .env の GAS_URL に設定
 *
 * シート列レイアウト:
 *  A=company_name（必須）, B=homepage_url（任意・空なら企業名から自動発見）, C以降=本スクリプトが書き戻す結果（1行目はヘッダ）
 */
var TAB = 'Sheet1'; // ← 実際のシート名に合わせて変更

var OUTPUT_HEADERS = [
  'status', 'resolved_url', 'phone', 'name', 'role', 'department', 'confidence',
  'url_source', 'phone_source_url', 'name_source_url', 'evidence', 'engine',
  'pages_checked', 'elapsed_ms', 'error', 'updated_at'
];

function sheet_() {
  var ss = SpreadsheetApp.getActive();
  return ss.getSheetByName(TAB) || ss.getSheets()[0];
}

// 読み込み: GET ?action=list → { companies:[{row, name, homepage_url, status}] }
function doGet(e) {
  var sh = sheet_();
  var last = sh.getLastRow();
  var companies = [];
  if (last > 1) {
    var values = sh.getRange(2, 1, last - 1, 3).getValues(); // A:C
    for (var i = 0; i < values.length; i++) {
      var name = String(values[i][0] || '').trim();
      var url = String(values[i][1] || '').trim();
      var status = String(values[i][2] || '').trim();
      if (!name && !url) continue; // 企業名・URLが共に空の行のみスキップ（URLは空でも企業名から自動発見）
      companies.push({ row: i + 2, name: name || '(no name)', homepage_url: url, status: status });
    }
  }
  return json_({ companies: companies });
}

// 書き戻し: POST { results:[{row, values:[...12要素...]}] }
function doPost(e) {
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) {}
  var sh = sheet_();
  // ヘッダ整備（C1から）
  sh.getRange(1, 3, 1, OUTPUT_HEADERS.length).setValues([OUTPUT_HEADERS]);
  var results = body.results || [];
  var n = 0;
  for (var i = 0; i < results.length; i++) {
    var it = results[i];
    if (it && it.row && it.values && it.values.length) {
      sh.getRange(it.row, 3, 1, it.values.length).setValues([it.values]);
      n++;
    }
  }
  return json_({ ok: true, written: n });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
