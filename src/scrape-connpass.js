'use strict';
// connpass 経由の採用イベント主催者/登壇者の氏名取得。IT/Web企業に強い新手。
//
// 着眼: 企業が主催する勉強会・もくもく会・採用イベントの「主催者」は、人事/技術広報/採用担当のことが多い。
//   connpass APIは event ごとに owner_display_name（主催者表示名＝実名のことが多い）を返し、
//   description（HTML）には登壇者名が「登壇者：山田太郎（人事）」等で載る。社名一致で誤帰属を排除する。
//
// 認証: connpass は2025年以降 API キー必須（無料・要登録）。CONNPASS_API_KEY を .env に置くと点火。
//   未設定なら configured()=false で安全スキップ（プロジェクトの設計思想）。
//   ※ キーはヘッダ X-API-Key で送る（connpass v2 仕様）。
const cheerio = require('cheerio');
const { normCompanyName } = require('./csv');
const { firstFullName } = require('./scrape-names');
const cfg = require('./config');

const API = process.env.CONNPASS_API_BASE || 'https://connpass.com/api/v2';

function configured() { return !!(process.env.CONNPASS_API_KEY || '').trim(); }

async function cpGet(path) {
  try {
    const res = await fetch(API + path, {
      headers: { 'User-Agent': cfg.USER_AGENT, 'Accept': 'application/json', 'X-API-Key': (process.env.CONNPASS_API_KEY || '').trim() },
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (_) {}
    return { status: res.status, json };
  } catch (e) { return { status: 0, json: null, error: e.message }; }
}

// description(HTML/テキスト)から「登壇者：氏名」「スピーカー 氏名」等を姓辞書ゲートで抽出。
function presentersFromDescription(html) {
  const text = cheerio.load(String(html || '')).root().text().replace(/\s+/g, ' ');
  const names = new Set();
  const reList = [
    /(?:登壇者|スピーカー|発表者|講師|主催|担当)\s*[:：]?\s*([一-龥々]{2,4}(?:[ 　][一-龥々]{1,3})?)/g,
    /([一-龥々]{2,4}[ 　][一-龥々]{1,3})\s*(?:（|\()(?:人事|採用|広報|CTO|エンジニア|HR)/g,
  ];
  for (const re of reList) {
    for (const m of text.matchAll(re)) { const n = firstFullName(m[1]); if (n) names.add(n); }
  }
  return [...names];
}

// 1社について connpass イベントを社名で検索し、主催者/登壇者の氏名候補を返す。
async function findConnpassContacts(companyName, { maxEvents = 10 } = {}) {
  const detail = {};
  if (!configured()) { detail['connpass'] = 'skip(no-key)'; return { contacts: [], 詳細: detail }; }
  const q = encodeURIComponent(companyName);
  const r = await cpGet(`/events/?keyword=${q}&count=${maxEvents}`);
  if (r.status !== 200 || !r.json) { detail['connpass'] = 'http' + r.status; return { contacts: [], 詳細: detail }; }
  const events = r.json.events || r.json.results || [];
  const target = normCompanyName(companyName);
  const contacts = [];
  const seen = new Set();
  let matched = 0;
  for (const ev of events) {
    // 社名一致（イベントタイトル/主催シリーズ/説明に社名コアが出ること）で誤帰属を排除
    const hay = `${ev.title || ''} ${(ev.series && ev.series.title) || ''} ${ev.catch || ''} ${ev.description || ''}`;
    if (target && !normCompanyName(hay).includes(target)) continue;
    matched++;
    // 主催者表示名（実名のことが多い）
    const owner = ev.owner_display_name || '';
    const ownerName = firstFullName(owner) || (looksJp(owner) ? owner.replace(/[ 　]/g, '') : '');
    if (ownerName && !seen.has(ownerName)) { seen.add(ownerName); contacts.push({ name: ownerName, role: '主催', kind: 'イベント主催', url: ev.url || '', confidence: 0.5 }); }
    // 登壇者
    for (const p of presentersFromDescription(ev.description)) {
      if (!seen.has(p)) { seen.add(p); contacts.push({ name: p, role: '登壇者', kind: 'イベント登壇', url: ev.url || '', confidence: 0.5 }); }
    }
  }
  detail['connpass'] = matched ? `events:${matched}` : 'no-match';
  return { contacts, 詳細: detail };
}

function looksJp(s) { return /^[一-龥々ぁ-んァ-ヶ 　]{2,8}$/.test(String(s || '').trim()); }

module.exports = { findConnpassContacts, presentersFromDescription, configured };
