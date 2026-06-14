'use strict';
// L4: メール推定。ドメインの MX レコードを篩いに使い、役割アドレスをパターン生成する。
//  - 既定: MX が引ければ役割アドレス（info@/recruit@ 等）を確度0.4で提示（送信は要検証）。
//  - DO_EMAIL_VERIFY=true かつ HUNTER_KEY があれば Hunter.io で実在検証して確度を更新。
// 外部送信は行わない。MX 解決は Node 標準の dns モジュールのみ（API不要）。
const dns = require('dns').promises;
const cfg = require('./config');
const { normalizeDomain } = require('./score');

// ドメインの MX レコードを取得（無ければ空配列）
async function mxRecords(domain) {
  if (!domain) return [];
  try {
    const recs = await dns.resolveMx(domain);
    return (recs || []).sort((a, b) => a.priority - b.priority).map((r) => r.exchange);
  } catch (_) {
    return [];
  }
}

// 役割アドレス候補を生成
function guessEmails(domain, c = cfg) {
  return c.EMAIL_ROLES.map((r) => r + '@' + domain);
}

// Hunter.io で1件検証（任意）
async function hunterVerify(email, c = cfg) {
  if (!c.HUNTER_KEY) return null;
  try {
    const url = 'https://api.hunter.io/v2/email-verifier?email=' +
      encodeURIComponent(email) + '&api_key=' + encodeURIComponent(c.HUNTER_KEY);
    const res = await fetch(url);
    if (!res.ok) return null;
    const d = (await res.json()).data;
    const map = { deliverable: 0.95, risky: 0.6, undeliverable: 0.0, unknown: 0.4 };
    const status = d.result === 'deliverable' ? 'valid' : (d.result === 'undeliverable' ? 'invalid' : 'risky');
    return { status, score: (map[d.result] != null ? map[d.result] : 0.4) };
  } catch (_) {
    return null;
  }
}

/**
 * 企業のメールを推定する。
 * @param {{domain?:string, websiteUrl?:string}} company
 * @returns {Promise<{email:string, score:number, mx:string, note?:string}>}
 */
async function enrichEmail(company, c = cfg) {
  const domain = normalizeDomain(company.domain || company.websiteUrl || '');
  if (!domain) return { email: '', score: 0, mx: '', note: 'ドメイン不明' };

  const mx = await mxRecords(domain);
  if (!mx.length) return { email: '', score: 0, mx: '', note: 'MXなし' };

  const candidates = guessEmails(domain, c);
  let best = candidates[0] || '';
  let score = 0.4; // パターン推測のみ（送信は要検証）

  if (c.DO_EMAIL_VERIFY && c.HUNTER_KEY && best) {
    const v = await hunterVerify(best, c);
    if (v) { score = v.score; if (v.status === 'invalid') { best = ''; score = 0; } }
  }
  return { email: best, score, mx: mx[0] || '' };
}

module.exports = { enrichEmail, mxRecords, guessEmails, hunterVerify };
