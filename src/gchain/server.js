'use strict';
/**
 * G-Chain OS v2.0 — ローカルWebサーバ（フロントエンド）。
 * ブラウザで開く営業リアルタイム分析UI。データは localhost のみ・外部送信なし（設計 §14）。
 *
 *   node src/gchain/server.js         # http://localhost:5180
 *   npm run gchain:web
 *   PORT=8090 node src/gchain/server.js
 *
 * エンドポイント:
 *   GET /                 UI（webui.html）
 *   GET /api/queue        本日のコールキュー（?type=&q=&limit=）
 *   GET /api/brief        企業ブリーフ（?q=会社名）
 *   GET /api/analytics    全体分析（接続/リフト/失注/規律）
 *   GET /api/train        再学習
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const api = require('./api');

const PORT = parseInt(process.env.PORT || '5180', 10);
const HTML = path.join(__dirname, 'webui.html');

function json(res, obj, code) {
  const body = JSON.stringify(obj);
  res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  const q = u.query;
  try {
    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(HTML));
    }
    if (u.pathname === '/api/queue') {
      return json(res, api.queue({ type: q.type, q: q.q, limit: Math.min(2000, Number(q.limit) || 100) }));
    }
    if (u.pathname === '/api/brief') {
      return json(res, api.search(q.q || '', 20));
    }
    if (u.pathname === '/api/analytics') {
      return json(res, api.analytics());
    }
    if (u.pathname === '/api/train') {
      return json(res, api.retrain());
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  } catch (e) {
    console.error(e);
    json(res, { error: String(e && e.message || e) }, 500);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  // 起動時にモデル/データを温める（初回リクエストを速く）
  try { api.context(); } catch (e) { console.error('データ読込エラー:', e.message); }
  console.log(`\n  G-Chain OS v2.0 — 営業リアルタイム分析`);
  console.log(`  ▶ http://localhost:${PORT}  （localhostのみ・PIIは外部送信しません）`);
  console.log(`  停止: Ctrl+C\n`);
});
