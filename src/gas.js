'use strict';
// 方式②: GASウェブアプリ橋渡し（GCP不要）。
// 付属の gas-bridge/Code.gs をスプレッドシートにバインドしてデプロイし、
// 発行されたウェブアプリURLを .env の GAS_URL に設定する。
// 読み込み = GET ?action=list / 書き戻し = POST {results:[{row,values}]}
const { resultToRow } = require('./io-common');

async function readJsonResponse(res, context) {
  const text = await res.text();
  const body = String(text || '').trim();
  const contentType = String(res.headers && res.headers.get ? res.headers.get('content-type') : '').toLowerCase();
  const finalUrl = String(res.url || '');
  const looksJson = contentType.includes('application/json') || body.startsWith('{') || body.startsWith('[');
  const snippet = body ? body.slice(0, 160) : '';
  const signinPage = /accounts\.google\.com\/v3\/signin/i.test(finalUrl) || /accounts\.google\.com\/v3\/signin/i.test(snippet);

  if (!looksJson) {
    if (signinPage) {
      throw new Error(`${context} がGoogleログイン画面にリダイレクトされました。GAS_URL のウェブアプリが「アクセスできるユーザー: 全員」になっているか、デプロイし直してください。${finalUrl ? ' finalUrl=' + finalUrl : ''}`.trim());
    }
    throw new Error(`${context} がJSON以外を返しました (${res.status} ${res.statusText || ''})${snippet ? ': ' + snippet : ''}`.trim());
  }

  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error(`${context} のJSON解析に失敗しました (${res.status} ${res.statusText || ''}): ${e.message}${snippet ? ' / body=' + snippet : ''}`.trim());
  }
}

async function readCompanies(cfg) {
  if (!cfg.GAS_URL) throw new Error('GAS_URL が未設定です（.env を設定してください）');
  const url = cfg.GAS_URL + (cfg.GAS_URL.includes('?') ? '&' : '?') + 'action=list';
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('GAS GET ' + res.status);
  const j = await readJsonResponse(res, 'GAS GET');
  return (j.companies || [])
    .filter(c => c && (c.name || c.homepage_url)) // 企業名 or URL があれば対象（URLは空でも企業名から自動発見）
    .map(c => ({ name: (c.name || '(no name)'), homepage_url: String(c.homepage_url || '').trim(), row: c.row, status: c.status || '' }));
}

async function writeResults(cfg, pairs) {
  if (!pairs || pairs.length === 0) return;
  const results = pairs.map(p => ({ row: p.row, values: resultToRow(p.result) }));
  for (let i = 0; i < results.length; i += 200) {
    const res = await fetch(cfg.GAS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      redirect: 'follow',
      body: JSON.stringify({ results: results.slice(i, i + 200) }),
    });
    if (!res.ok) {
      const text = await res.text();
      const snippet = String(text || '').trim().slice(0, 160);
      throw new Error(`GAS POST ${res.status}${snippet ? ': ' + snippet : ''}`);
    }
  }
}

module.exports = { readCompanies, writeResults, readJsonResponse };
