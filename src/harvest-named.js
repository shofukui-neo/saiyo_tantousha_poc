'use strict';
// Wantedly に頼らない採用担当者名ハーベスタ（カスケード・再開可能・並列）。
// =====================================================================
// ユーザー方針: WANTEDLY を使わず、自社採用ページ / Webインタビュー記事・採用ブログ / マイナビ から
//   採用担当者名を取得し、新たな1000件を実現する。複数ページ・リンク先まで入念に探索する。
//
// カスケード（確度の高い順に試し、氏名が取れた時点で打ち切り）:
//   1. 自社採用ページ深掘り  probeRecruitPage（staff/member/interview/message を6面まで＋Gemini）
//   2. Webインタビュー記事    probeInterview（検索→記事→リンク先1段→正規表現/Gemini, 社名ゲート）
//   3.（任意）マイナビ is.html MynaviScraper（問合せ先の構造化担当者名）  --with-mynavi
//
// 設計（build-mynavi-names と同形）:
//   - 再開: 既存出力の処理済みキーをスキップ / アトミック書込 / 1社タイムアウト
//   - 並列: 企業ごとにホストが異なるため少数並列(既定3)。politeGet がホスト別に直列化＆間隔調整。
//   - 目標件数 --target に達したら打ち切り（既定 1000）。
//
//   node src/harvest-named.js --in leads-recruiter-acquired-1000.csv \
//        --out data/recruiter-nonwantedly.csv --target 1000 --concurrency 3
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, mergeKey } = require('./csv');
const { probeRecruitPage, visibleText } = require('./probe-recruit-page');
const { probeInterview } = require('./probe-interview');
const { discoverUrl } = require('./search');
const { politeGet } = require('./polite');

// discoverUrl 用の取得/抽出デップ（politeGet で礼儀正しく取得、本文抽出は visibleText）。
const DISCOVER_DEPS = {
  fetchPage: async (u) => { const r = await politeGet(u, { render: 'static' }); return { html: (r && r.html) || '', finalUrl: (r && r.finalUrl) || u }; },
  extractText: (html) => visibleText(html || ''),
};

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
const IN = getArg('in', 'leads-recruiter-acquired-1000.csv');
const OUT = getArg('out', path.join('data', 'recruiter-nonwantedly.csv'));
const LIMIT = parseInt(getArg('limit', '0'), 10) || 0;          // 0=全件
const TARGET = parseInt(getArg('target', '1000'), 10) || 0;     // 0=目標なし（全件処理）
const CONCURRENCY = Math.max(1, parseInt(getArg('concurrency', '3'), 10) || 3);
const PER_COMPANY_MS = parseInt(getArg('company-timeout', '120000'), 10) || 120000;
const WITH_MYNAVI = process.argv.includes('--with-mynavi');
const ORDER = String(getArg('order', 'own,interview')).split(',').map((s) => s.trim());

function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }
function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(onTimeout()), ms);
    Promise.resolve(promise).then((v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(onTimeout()); });
  });
}
function pick(rec, keys) { for (const k of keys) if (rec[k]) return rec[k]; return ''; }

// 1社のカスケード実行。氏名が取れたら { name, ... , 取得手法, 取得元 } を返す（無ければ null）。
async function harvestOne(rec, mynavi) {
  const name = pick(rec, ['企業名', 'company_name', '会社名']);
  let url = pick(rec, ['公式URL', 'official_url', 'url']);
  if (!name) return null;
  const pref = pick(rec, ['都道府県', 'prefecture']);

  // 公式URLが無ければ検索で発見（同名取り違え防止に都道府県をヒントに渡す）。
  // Wantedly由来の母集団は公式URL未保持が大半 → ここで補完して自社ページ深掘りを発火させる。
  let discoveredUrl = '';
  const ensureUrl = async () => {
    if (url) return url;
    try {
      const d = await discoverUrl(name, DISCOVER_DEPS, { addressHint: pref });
      if (d && d.url) { url = d.url; discoveredUrl = d.url; }
    } catch (_) {}
    return url;
  };

  const steps = {
    own: async () => {
      await ensureUrl();
      if (!url) return null;
      const r = await probeRecruitPage(url, { companyName: name });
      return r && r.name ? { ...r, 取得手法: discoveredUrl ? '自社採用ページ深掘り(URL発見)' : '自社採用ページ深掘り', _discoveredUrl: discoveredUrl } : null;
    },
    interview: async () => {
      const r = await probeInterview(name);
      return r && r.name ? { ...r, 取得手法: 'Webインタビュー記事' } : null;
    },
    mynavi: async () => {
      if (!mynavi) return null;
      const r = await mynavi.scrapeCompany(name);
      return r && r.採用担当者名
        ? { name: r.採用担当者名, role: r.役職 || '', department: r.部署 || '',
            confidence: r.担当者確度 || 0.7, evidence: r.根拠 || '',
            sourceUrl: r.採用ページURL || '', source: 'マイナビ問合せ先', 取得手法: 'マイナビis.html' }
        : null;
    },
  };
  const order = [...ORDER];
  if (WITH_MYNAVI && !order.includes('mynavi')) order.push('mynavi');
  for (const s of order) {
    if (!steps[s]) continue;
    try { const hit = await steps[s](); if (hit && hit.name) return hit; } catch (_) {}
  }
  return null;
}

async function run() {
  const text = fs.readFileSync(path.resolve(IN), 'utf8');
  let { records } = readCsv(text);
  if (LIMIT) records = records.slice(0, LIMIT);

  const headers = ['企業名', '法人番号', '採用担当者名', '担当者確度', '取得手法', '取得元',
    '役職', '部署', '根拠URL', '根拠', '電話番号', '従業員数', '業種', '都道府県', '新卒フラグ', '公式URL', '取得日'];
  const OUTABS = path.resolve(OUT);
  fs.mkdirSync(path.dirname(OUTABS), { recursive: true });

  // 再開: 既存出力をロードし処理済みキーをスキップ
  const out = [];
  const doneKeys = new Set();
  if (!process.argv.includes('--fresh') && fs.existsSync(OUTABS)) {
    try {
      for (const r of readCsv(fs.readFileSync(OUTABS, 'utf8')).records) {
        const k = mergeKey(r); if (k) { doneKeys.add(k); out.push(r); }
      }
      if (doneKeys.size) log(`再開: 既存 ${doneKeys.size}社をスキップ`);
    } catch (_) {}
  }
  let namedSoFar = out.filter((x) => x['採用担当者名']).length;
  const todo = records.filter((r) => { const k = mergeKey(r); return !k || !doneKeys.has(k); });
  log(`非Wantedly氏名取得: 未処理 ${todo.length}社（全 ${records.length}）｜既取得済 ${namedSoFar}名｜目標 ${TARGET || '全件'}`);

  const flush = () => { const tmp = OUTABS + '.tmp'; fs.writeFileSync(tmp, toCsv(headers, out)); fs.renameSync(tmp, OUTABS); };

  // マイナビ（任意）。Playwright は1ブラウザを共有して直列利用するため concurrency と相性が悪い→使う時は concurrency=1 推奨。
  let mynavi = null;
  if (WITH_MYNAVI) { const { MynaviScraper } = require('./scrape-mynavi'); mynavi = new MynaviScraper(); await mynavi.launch(); }

  let done = 0, idx = 0;
  const today = new Date().toISOString().slice(0, 10);
  let stop = false;

  async function worker() {
    while (!stop) {
      const myIdx = idx++;
      if (myIdx >= todo.length) return;
      const rec = todo[myIdx];
      const name = pick(rec, ['企業名', 'company_name', '会社名']);
      const hit = await withTimeout(harvestOne(rec, mynavi), PER_COMPANY_MS, () => null);
      const row = {
        企業名: name, 法人番号: pick(rec, ['法人番号', 'corporate_number']),
        採用担当者名: hit ? hit.name : '', 担当者確度: hit ? (hit.confidence || '') : '',
        取得手法: hit ? hit.取得手法 : '', 取得元: hit ? (hit.source || '') : '',
        役職: hit ? (hit.role || '') : '', 部署: hit ? (hit.department || '') : '',
        根拠URL: hit ? (hit.sourceUrl || '') : '', 根拠: hit ? String(hit.evidence || '').slice(0, 120) : '',
        電話番号: pick(rec, ['電話番号']), 従業員数: pick(rec, ['従業員数']),
        業種: pick(rec, ['業種']), 都道府県: pick(rec, ['都道府県']),
        新卒フラグ: pick(rec, ['新卒フラグ']),
        公式URL: pick(rec, ['公式URL', 'official_url', 'url']) || (hit && hit._discoveredUrl) || '',
        取得日: today,
      };
      out.push(row);
      if (hit && hit.name) namedSoFar++;
      done++;
      if (done % 5 === 0) {
        flush();
        log(`  ${done}/${todo.length}（氏名 ${namedSoFar}／目標 ${TARGET || '∞'}） 最新: ${name} → ${hit ? '★' + hit.name + ' [' + hit.取得手法 + ']' : '—'}`);
      }
      if (TARGET && namedSoFar >= TARGET) { stop = true; return; }
    }
  }

  try {
    // マイナビ併用時はブラウザ共有のため直列、それ以外は並列
    const n = (WITH_MYNAVI && mynavi) ? 1 : CONCURRENCY;
    await Promise.all(Array.from({ length: n }, () => worker()));
  } finally {
    flush();
    if (mynavi) await mynavi.close().catch(() => {});
  }
  const named = out.filter((x) => x['採用担当者名']).length;
  const byMethod = {};
  for (const r of out) if (r['採用担当者名']) byMethod[r['取得手法']] = (byMethod[r['取得手法']] || 0) + 1;
  log(`完了: 処理 ${out.length}社 ｜ 氏名取得 ${named}名（${(100 * named / Math.max(1, out.length)).toFixed(1)}%）`);
  log(`内訳: ${JSON.stringify(byMethod)}`);
  log(`出力: ${OUTABS}`);
}

run().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
