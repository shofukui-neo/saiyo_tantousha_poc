'use strict';
// Google Workspace（Gmail/Drive）から「社内に既にある」採用担当者の手がかりを抽出する。
// ＝[[multi-source-merge-kpi]] の系統D（ネットワーク/既存資産）。外部スクレイピングではなく、
//   本人が正規に閲覧できる自社メール/ドライブから、対象社の担当者名・メール・役職を名寄せする。
//
// 抽出ロジック（既存資産を再利用・精度優先）:
//   - Gmail: 対象社名で検索 → 相手の表示名(From) と 署名ブロック から個人名候補を取り、姓辞書で検証。
//            メールのローカル部からは romaji-name.nameFromEmail で姓を推定（中堅大手の数少ないレバー）。
//   - Drive: 対象社名を含むファイル名/本文をメタ検索（手がかりの所在として根拠URLに残す）。
//   - 会社一致は「検索クエリが社名」かつ「相手ドメイン or 本文に社名コア」で担保。
const { google } = require('googleapis');
const { normCompanyName } = require('./csv');
const { firstFullName, namesMatch } = require('./scrape-names');
const { heuristicExtract, looksLikePersonName } = require('./extract');
const { nameFromEmail } = require('./romaji-name');

// base64url(Gmail本文) をデコード
function decodeB64(data) {
  try { return Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }
  catch (_) { return ''; }
}

// Gmailのpayloadから text/plain 本文を集める（multipart再帰）
function collectPlainText(payload, acc = []) {
  if (!payload) return acc;
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) acc.push(decodeB64(payload.body.data));
  for (const p of payload.parts || []) collectPlainText(p, acc);
  return acc;
}

// "山田太郎 <taro@x.co.jp>" → { display, email }
function parseFrom(from) {
  const s = String(from || '');
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { display: m[1].trim(), email: m[2].trim().toLowerCase() };
  if (/@/.test(s)) return { display: '', email: s.trim().toLowerCase() };
  return { display: s.trim(), email: '' };
}

// 1通から担当者候補を作る。氏名は姓辞書で検証し、確証なしは捨てる（精度優先）。
//   戻り値: { name, role, dept, email, where } | null
function contactFromMessage(headers, bodyText, targetName) {
  const get = (n) => (headers.find((h) => h.name && h.name.toLowerCase() === n) || {}).value || '';
  const { display, email } = parseFrom(get('from'));

  // (1) 表示名が日本語フルネームなら最優先（姓辞書ゲート）
  let name = display ? firstFullName(display) : '';
  let where = name ? 'from-display' : '';

  // (2) 署名ブロック（本文末尾）から採用文脈の氏名/役職/部署
  let role = '', dept = '';
  const h = heuristicExtract(String(bodyText || '').slice(-1500)); // 署名は末尾に出やすい
  if (h.found && looksLikePersonName(String(h.name).replace(/[ 　]/g, ''))) {
    const hn = String(h.name).replace(/[ 　]/g, '');
    if (firstFullName(hn)) { if (!name) { name = firstFullName(hn); where = 'signature'; } role = h.role || ''; dept = h.department || ''; }
  }

  // (3) メールのローカル部から姓を推定（表示名/署名で取れない場合の最後のレバー）
  if (!name && email) {
    const fromEmail = nameFromEmail(email);
    if (fromEmail && fromEmail.surname) { name = fromEmail.surname; where = 'email-localpart'; }
  }
  if (!name) return null;

  // 会社一致: 相手メールのドメインに社名英字が出る or 本文に社名コア。検索が社名スコープなので緩めで可。
  const target = normCompanyName(targetName);
  const domain = email.split('@')[1] || '';
  const bodyHasCompany = target && namesMatch(bodyText.slice(0, 4000), targetName);
  const domainHit = target && /^[a-z0-9.-]+$/.test(domain); // ドメインは常に手がかりとして保持
  if (!bodyHasCompany && !domainHit) return null;

  return { name, role, dept, email, where };
}

// Gmailを社名で検索し、担当者候補を集める（上位 maxMessages 通）。
async function fromGmail(auth, companyName, { maxMessages = 8 } = {}) {
  const gmail = google.gmail({ version: 'v1', auth });
  const q = `"${companyName}" (採用 OR 人事 OR 担当 OR ご担当)`;
  let ids = [];
  try {
    const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: maxMessages });
    ids = (list.data.messages || []).map((m) => m.id);
  } catch (e) { return { contacts: [], status: 'gmail-error:' + (e.message || '').slice(0, 40) }; }
  if (!ids.length) return { contacts: [], status: 'no-mail' };

  const contacts = [];
  for (const id of ids) {
    try {
      const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      const headers = (msg.data.payload && msg.data.payload.headers) || [];
      const body = collectPlainText(msg.data.payload).join('\n');
      const c = contactFromMessage(headers, body, companyName);
      if (c) contacts.push({ ...c, threadId: msg.data.threadId, msgId: id });
    } catch (_) { /* 次へ */ }
  }
  return { contacts, status: contacts.length ? 'hit' : 'no-name' };
}

// Driveを社名で検索し、手がかりファイルのURLを返す（氏名抽出はファイル本文取得が要るので根拠URLのみ）。
async function fromDrive(auth, companyName, { maxFiles = 3 } = {}) {
  const drive = google.drive({ version: 'v3', auth });
  try {
    const res = await drive.files.list({
      q: `fullText contains '${companyName.replace(/'/g, "\\'")}' and trashed = false`,
      fields: 'files(id,name,webViewLink,mimeType)', pageSize: maxFiles,
    });
    return (res.data.files || []).map((f) => ({ name: f.name, url: f.webViewLink || '' }));
  } catch (_) { return []; }
}

// 1社について Gmail＋Drive から最良の担当者候補を返す。findRecruiterName と同形。
async function findContactInWorkspace(auth, companyName, opts = {}) {
  const detail = {};
  const g = await fromGmail(auth, companyName, opts);
  detail['Gmail'] = g.status;
  const drive = await fromDrive(auth, companyName, opts);
  detail['Drive'] = drive.length ? `${drive.length}件` : 'no-file';

  // 採用窓口らしさ（役割語つき＞表示名＞署名＞メール推定）で最良を選ぶ
  const rank = { 'from-display': 3, 'signature': 2, 'email-localpart': 1 };
  const best = g.contacts.sort((a, b) =>
    (b.role ? 1 : 0) - (a.role ? 1 : 0) || (rank[b.where] || 0) - (rank[a.where] || 0))[0];

  if (best) {
    const url = best.threadId ? `https://mail.google.com/mail/u/0/#all/${best.threadId}` : (drive[0] && drive[0].url) || '';
    return {
      採用担当者名: best.name, 役職: best.role || '', 部署: best.dept || '',
      メール: best.email || '', 取得元媒体: 'Google Workspace', チャネル: 'workspace',
      根拠URL: url, 確度: best.role ? 0.65 : 0.55, 詳細: detail,
    };
  }
  return {
    採用担当者名: '', 役職: '', 部署: '', メール: '', 取得元媒体: '', チャネル: '',
    根拠URL: (drive[0] && drive[0].url) || '', 確度: 0, 詳細: detail,
  };
}

module.exports = { findContactInWorkspace, contactFromMessage, parseFrom, collectPlainText, fromGmail, fromDrive };
