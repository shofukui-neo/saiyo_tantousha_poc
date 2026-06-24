'use strict';
// Google Workspace（Gmail/Drive）への正規OAuth2アクセス。
// 個人メールボックス/個人ドライブの参照なので、サービスアカウントではなく
// 「ユーザー同意のOAuth2（デスクトップ/インストールアプリ）」が正しい方式。
//
// セットアップ（本人＝sho.fukui@neo-career.co.jp が1回だけ実施）:
//   1) Google Cloud Console でプロジェクト作成 →「OAuth クライアントID」を“デスクトップアプリ”で発行
//   2) ダウンロードした JSON を data/google-oauth-client.json に置く（または GOOGLE_OAUTH_CLIENT で別パス指定）
//   3) Gmail API / Google Drive API を有効化
//   4) npm run google:auth   → 表示URLをブラウザで開き、本人アカウントで同意
//      （ローカルの戻りURLでコードを自動受領し data/google-token.json に保存）
//
// セキュリティ: 参照系スコープのみ（readonly）。トークンは data/ にローカル保存。
//   data/google-token.json と client.json は機密。リポジトリにコミットしないこと（.gitignore推奨）。
const fs = require('fs');
const path = require('path');
const http = require('http');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const CLIENT_PATH = process.env.GOOGLE_OAUTH_CLIENT || path.join(DATA_DIR, 'google-oauth-client.json');
const TOKEN_PATH = process.env.GOOGLE_OAUTH_TOKEN || path.join(DATA_DIR, 'google-token.json');

// 参照のみ（最小権限）。社内資産の名寄せに必要な範囲だけ。
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
];

function configured() {
  return fs.existsSync(CLIENT_PATH);
}

function loadClientCreds() {
  if (!fs.existsSync(CLIENT_PATH)) {
    throw new Error(`OAuthクライアント未設定: ${CLIENT_PATH} を置いてください（google-auth.js 冒頭の手順参照）`);
  }
  const raw = JSON.parse(fs.readFileSync(CLIENT_PATH, 'utf8'));
  const c = raw.installed || raw.web || raw;
  if (!c.client_id || !c.client_secret) throw new Error('OAuthクライアントJSONの形式が不正（client_id/secret なし）');
  return { clientId: c.client_id, clientSecret: c.client_secret };
}

function newOAuth2(google, redirectUri) {
  const { clientId, clientSecret } = loadClientCreds();
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// 保存済みトークンがあれば読んでクライアントに載せる
function loadToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')); } catch (_) { return null; }
}
function saveToken(tokens) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
}

// ローカルループバックでリダイレクトを受けて認可コードを取得する（OOB廃止後の正規フロー）。
function interactiveConsent(google) {
  return new Promise((resolve, reject) => {
    // 任意ポートで待ち受け、そのURLを redirect_uri にする（デスクトップクライアントは loopback を許可）。
    const server = http.createServer();
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
      const oAuth2 = newOAuth2(google, redirectUri);
      const authUrl = oAuth2.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
      console.log('\n▼ 本人アカウントで同意してください（ブラウザで開く）:\n' + authUrl + '\n');
      server.on('request', async (req, res) => {
        try {
          const u = new URL(req.url, redirectUri);
          if (!u.pathname.startsWith('/oauth2callback')) { res.end('待機中…'); return; }
          const code = u.searchParams.get('code');
          if (!code) { res.end('認可コードが取得できませんでした'); return; }
          const { tokens } = await oAuth2.getToken(code);
          oAuth2.setCredentials(tokens);
          saveToken(tokens);
          res.end('認証完了。このタブは閉じて構いません。');
          server.close();
          resolve(oAuth2);
        } catch (e) { res.end('エラー: ' + e.message); server.close(); reject(e); }
      });
    });
    server.on('error', reject);
  });
}

// 認可済みクライアントを返す。トークンが無ければ interactive=true のとき同意フローを起動。
async function authorize({ interactive = false } = {}) {
  let google;
  try { ({ google } = require('googleapis')); }
  catch (_) { throw new Error('googleapis 未インストール（npm install）'); }

  const token = loadToken();
  if (token) {
    const oAuth2 = newOAuth2(google, 'http://127.0.0.1');
    oAuth2.setCredentials(token);
    // refresh_token があれば自動更新される。保存し直して有効期限を伸ばす。
    oAuth2.on('tokens', (t) => { saveToken({ ...token, ...t }); });
    return oAuth2;
  }
  if (!interactive) {
    throw new Error('未認証です。先に `npm run google:auth` で本人同意を済ませてください。');
  }
  return interactiveConsent(google);
}

module.exports = { authorize, configured, SCOPES, CLIENT_PATH, TOKEN_PATH };

// 単体: 認証だけ実施（npm run google:auth）
if (require.main === module) {
  (async () => {
    if (!configured()) {
      console.error(`OAuthクライアント未設定: ${CLIENT_PATH} を置いてください（手順は google-auth.js 冒頭）`);
      process.exit(1);
    }
    try { await authorize({ interactive: true }); console.log('✓ トークン保存:', TOKEN_PATH); }
    catch (e) { console.error('認証失敗:', e.message); process.exit(1); }
  })();
}
