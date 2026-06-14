'use strict';
// L5: 出力アダプタ「担当者マスタ」。
//  - 常にローカルCSV（既定 leads.csv）へ出力（キー無し・SA無しでも結果を必ず残す）。
//  - SHEET_ID＋サービスアカウント認証があれば Google スプレッドシートの
//    「担当者マスタ」タブへ法人番号/企業名で upsert（無ければタブを自動作成）。
const fs = require('fs');
const cfg = require('./config');

// レコード（オブジェクト）→ MASTER_HEADERS 順の配列
function recordToRow(rec, headers = cfg.MASTER_HEADERS) {
  rec = rec || {};
  return headers.map((h) => (rec[h] != null ? rec[h] : ''));
}

// upsert キー（法人番号優先・無ければ企業名）
function keyOfRecord(rec) {
  const corp = String(rec['法人番号'] || '').trim();
  return corp ? 'c:' + corp : 'n:' + String(rec['企業名'] || '').trim();
}

// ---- CSV 出力 ----
function writeMasterCsv(outPath, records, headers = cfg.MASTER_HEADERS) {
  const esc = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [headers.join(',')];
  for (const rec of records) lines.push(recordToRow(rec, headers).map(esc).join(','));
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  return outPath;
}

// ---- Google スプレッドシート出力（Sheets API・サービスアカウント）----
let _sheets = null;
async function getClient(c) {
  if (_sheets) return _sheets;
  let google;
  try { ({ google } = require('googleapis')); }
  catch (_) { throw new Error('googleapis 未インストール（`npm install` 後に再実行）'); }
  const auth = new google.auth.GoogleAuth({
    keyFile: c.GOOGLE_APPLICATION_CREDENTIALS || undefined,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  _sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
  return _sheets;
}

// 1始まりの列番号 → 列文字
function colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// 「担当者マスタ」タブが無ければ作成
async function ensureTab(sheets, c) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: c.SHEET_ID });
  const exists = (meta.data.sheets || []).some((s) => s.properties && s.properties.title === c.MASTER_TAB);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: c.SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: c.MASTER_TAB } } }] },
    });
  }
}

/**
 * 担当者マスタへ upsert（法人番号/企業名キー）。既存行を読み込み、メモリ上で
 * マージしてからシート全体を書き戻す（重複を作らない）。
 */
async function writeMasterSheet(c, records) {
  const sheets = await getClient(c);
  await ensureTab(sheets, c);
  const H = c.MASTER_HEADERS;
  const lastCol = colLetter(H.length);

  // 既存読み込み
  const got = await sheets.spreadsheets.values.get({
    spreadsheetId: c.SHEET_ID, range: `${c.MASTER_TAB}!A1:${lastCol}`,
  });
  const rows = got.data.values || [];
  const map = new Map(); // key -> record(array)
  const order = [];
  for (let i = 1; i < rows.length; i++) {
    const arr = rows[i];
    const rec = {}; H.forEach((h, j) => { rec[h] = arr[j] != null ? arr[j] : ''; });
    const k = keyOfRecord(rec);
    if (!map.has(k)) order.push(k);
    map.set(k, recordToRow(rec, H));
  }
  // 新規をマージ
  for (const rec of records) {
    const k = keyOfRecord(rec);
    if (!map.has(k)) order.push(k);
    map.set(k, recordToRow(rec, H));
  }
  // 書き戻し（ヘッダ＋全行）
  const values = [H, ...order.map((k) => map.get(k))];
  await sheets.spreadsheets.values.update({
    spreadsheetId: c.SHEET_ID,
    range: `${c.MASTER_TAB}!A1:${lastCol}${values.length}`,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
  return values.length - 1;
}

/**
 * 出力の総合関数。CSV は必ず書き、シート設定があればシートにも upsert。
 * @returns {Promise<{csvPath:string, sheetWritten:number|null, sheetError:string}>}
 */
async function writeMaster(c, records, opt = {}) {
  const csvPath = opt.csvPath || 'leads.csv';
  writeMasterCsv(csvPath, records, c.MASTER_HEADERS);

  let sheetWritten = null, sheetError = '';
  if (c.SHEET_ID && (c.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
    try { sheetWritten = await writeMasterSheet(c, records); }
    catch (e) { sheetError = e && e.message ? e.message : String(e); }
  }
  return { csvPath, sheetWritten, sheetError };
}

module.exports = { writeMaster, writeMasterCsv, writeMasterSheet, recordToRow, keyOfRecord, colLetter };
