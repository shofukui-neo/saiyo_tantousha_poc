'use strict';
// スプシ自動保存シンク: 毎サイクルの「今アツい」top-N を Google スプレッドシートに時系列で追記する。
// 既存 sheets.js と同じサービスアカウント方式（GOOGLE_APPLICATION_CREDENTIALS）。
// 設定（MONITOR_SHEET_ID と認証）が無ければ何もせずスキップ＝監視本体は止めない（プロジェクトの設計思想）。
//
// 必要設定（.env もしくはシステム環境変数）:
//   GOOGLE_APPLICATION_CREDENTIALS = サービスアカウントJSONの絶対パス
//   MONITOR_SHEET_ID               = 書き込み先スプレッドシートID（URLの /d/＜ここ＞/edit）
//   MONITOR_SHEET_TAB              = タブ名（既定: 鮮度モニタリング）
//   ※対象スプレッドシートを、サービスアカウントのメールアドレスに「編集者」で共有しておくこと。
//
// 単体確認:  node src/monitor/sheets-sink.js --selftest   （設定の有無と接続を確認し、テスト行を1行追記）

const HEADERS = ['集計時刻', '順位', '企業名', '熱量', '鮮度日数', '直近イベント', '求人件数', '卒年', '観測媒体'];

function cfg() {
  return {
    creds: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
    sheetId: process.env.MONITOR_SHEET_ID || process.env.SHEET_ID || '',
    tab: process.env.MONITOR_SHEET_TAB || '鮮度モニタリング',
  };
}
function configured() { const c = cfg(); return !!(c.sheetId && c.creds); }

let _sheets = null;
async function client(c) {
  if (_sheets) return _sheets;
  let google;
  try { ({ google } = require('googleapis')); }
  catch (_) { throw new Error('googleapis 未インストール（npm install）'); }
  const auth = new google.auth.GoogleAuth({
    keyFile: c.creds || undefined,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  _sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
  return _sheets;
}

// タブが無ければ作成し、ヘッダが無ければ1行目に入れる
async function ensureSheet(sheets, c) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: c.sheetId });
  const exists = (meta.data.sheets || []).some((s) => s.properties && s.properties.title === c.tab);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: c.sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: c.tab } } }] },
    });
  }
  const head = await sheets.spreadsheets.values.get({ spreadsheetId: c.sheetId, range: `${c.tab}!A1:I1` });
  if (!head.data.values || !head.data.values.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: c.sheetId, range: `${c.tab}!A1`, valueInputOption: 'RAW',
      requestBody: { values: [HEADERS] },
    });
  }
}

// ランキングを行配列へ（snap から観測媒体を補う）
function toRows(ranked, cycle, snap) {
  return ranked.map((s, i) => {
    const comp = snap && snap.companies ? snap.companies[s.key] : null;
    const media = comp ? Object.keys(comp.sources || {}).join('/') : '';
    return [
      cycle, i + 1, s.企業名 || '',
      Number((s.heat || 0).toFixed(1)),
      (s.recencyDays == null ? '' : s.recencyDays),
      (s.lastEvents || []).join('|'),
      (s.totalJobs || ''),
      (s.gradYears || []).join('/'),
      media,
    ];
  });
}

// 毎サイクル呼ぶ本体。設定が無ければ {skipped:true}。成功で {appended:n, tab}。
async function appendHottest(ranked, { cycle, snap } = {}) {
  const c = cfg();
  if (!c.sheetId || !c.creds) return { skipped: true };
  if (!ranked || !ranked.length) return { appended: 0, tab: c.tab };
  const sheets = await client(c);
  await ensureSheet(sheets, c);
  const rows = toRows(ranked, cycle, snap);
  await sheets.spreadsheets.values.append({
    spreadsheetId: c.sheetId, range: `${c.tab}!A1`,
    valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
  return { appended: rows.length, tab: c.tab };
}

module.exports = { appendHottest, configured, cfg, HEADERS };

// ---- 単体確認 ----
if (require.main === module) {
  (async () => {
    require('dotenv').config();
    const c = cfg();
    console.log('GOOGLE_APPLICATION_CREDENTIALS:', c.creds || '(未設定)');
    console.log('MONITOR_SHEET_ID:', c.sheetId || '(未設定)');
    console.log('タブ:', c.tab);
    if (!configured()) { console.log('→ 未設定のためスキップされます（監視は通常どおり動作）。'); process.exit(0); }
    try {
      const ts = new Date().toISOString();
      const r = await appendHottest(
        [{ key: 'k', 企業名: '【接続テスト】', heat: 0, recencyDays: 0, lastEvents: ['TEST'], totalJobs: 0, gradYears: [] }],
        { cycle: ts, snap: { companies: { k: { sources: { selftest: {} } } } } }
      );
      console.log('接続OK: テスト行を追記しました →', r.tab);
    } catch (e) { console.error('接続/書込エラー:', e && e.message || e); process.exit(1); }
  })();
}
