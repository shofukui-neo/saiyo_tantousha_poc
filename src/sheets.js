'use strict';
// 方式①: Google Sheets API（サービスアカウント）でシートを直接読み書きする。
// 自動実行・スケジューラ運用に向く標準的な方法。GCPでサービスアカウントを作り、
// 対象スプレッドシートをそのサービスアカウントのメールに「編集者」で共有しておくこと。
const { OUTPUT_HEADERS, rowsToCompanies, resultToRow } = require('./io-common');

let _sheets = null;
async function getClient(cfg) {
  if (_sheets) return _sheets;
  let google;
  try { ({ google } = require('googleapis')); }
  catch (_) { throw new Error("googleapis 未インストール。`npm install` を実行してください（または --source csv / gas を使用）"); }
  const auth = new google.auth.GoogleAuth({
    keyFile: cfg.GOOGLE_APPLICATION_CREDENTIALS || undefined, // 未指定なら環境変数 GOOGLE_APPLICATION_CREDENTIALS を使用
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  _sheets = google.sheets({ version: 'v4', auth: authClient });
  return _sheets;
}

// A1:N を読み、企業（+ 既存status）配列を返す
async function readCompanies(cfg) {
  if (!cfg.SHEET_ID) throw new Error('SHEET_ID が未設定です（.env を設定してください）');
  const sheets = await getClient(cfg);
  const range = `${cfg.SHEET_TAB}!A1:N`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: cfg.SHEET_ID, range });
  return rowsToCompanies(res.data.values || []);
}

// pairs: [{ row, result }] を C{row}:N{row} に書き戻す（ヘッダも整備）
async function writeResults(cfg, pairs) {
  if (!pairs || pairs.length === 0) return;
  const sheets = await getClient(cfg);
  const lastCol = colLetter(2 + OUTPUT_HEADERS.length); // C(=3) から始まる → 終端列
  // ヘッダ行
  await sheets.spreadsheets.values.update({
    spreadsheetId: cfg.SHEET_ID,
    range: `${cfg.SHEET_TAB}!C1:${lastCol}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [OUTPUT_HEADERS] },
  });
  // 各行を該当行へ（batchUpdateで200行ずつ）
  const data = pairs.map(p => ({
    range: `${cfg.SHEET_TAB}!C${p.row}:${lastCol}${p.row}`,
    values: [resultToRow(p.result)],
  }));
  for (let i = 0; i < data.length; i += 200) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: cfg.SHEET_ID,
      requestBody: { valueInputOption: 'RAW', data: data.slice(i, i + 200) },
    });
  }
}

// 1始まりの列番号 → 列文字（3 -> 'C', 14 -> 'N'）
function colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

module.exports = { readCompanies, writeResults, colLetter };
