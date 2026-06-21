/**
 * 新卒鮮度モニタリング → スプレッドシート追記用 Webアプリ（サービスアカウント不要）。
 *
 * 【設置手順】
 *  1. 対象スプレッドシートを開く →「拡張機能」→「Apps Script」
 *  2. このコードを全部貼り付けて保存
 *  3. 下の SECRET を好きな文字列に変更（例: ランダムな英数字）
 *  4. 右上「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *       - 次のユーザーとして実行: 自分
 *       - アクセスできるユーザー: 全員（社内制限があれば「組織内の全員」）
 *  5. 発行された「ウェブアプリのURL（.../exec で終わる）」をコピー
 *  6. PC側のシステム環境変数に設定:
 *       MONITOR_SHEET_WEBHOOK = コピーしたURL
 *       MONITOR_SHEET_TOKEN   = 3で決めた SECRET と同じ文字列
 *  7. 確認: poc で  npm run monitor:sheets-check
 */

// ★ここを推測されにくい文字列に変更（PC側 MONITOR_SHEET_TOKEN と一致させる）
var SECRET = 'CHANGE_ME_秘密の合言葉';

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents || '{}');
    if (SECRET && body.token !== SECRET) {
      return _json({ ok: false, error: 'unauthorized' });
    }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var tab = body.tab || '鮮度モニタリング';
    var sh = ss.getSheetByName(tab) || ss.insertSheet(tab);
    if (sh.getLastRow() === 0 && body.headers && body.headers.length) {
      sh.appendRow(body.headers);
    }
    var rows = body.rows || [];
    if (rows.length) {
      // まとめて書き込み（高速）
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    }
    return _json({ ok: true, appended: rows.length, tab: tab });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  }
}

// 動作確認用（ブラウザでURLを開くと表示）
function doGet() {
  return _json({ ok: true, msg: 'sheets-webhook alive. POST JSON to append.' });
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
