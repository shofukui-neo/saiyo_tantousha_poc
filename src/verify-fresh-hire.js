'use strict';
/**
 * 完全新規プールの「年間新卒採用人数」を一次情報で厳格検証する層
 * ============================================================================
 * 目的: 「完全新規（既存CRM＋過去納品のいずれにも不在）× 採用6名以上を厳格に」の
 *       6名以上を、媒体の“募集人数”ではなく **マイナビ会社概要の実績**（過去3年間の
 *       新卒採用者数）で確定させる。実績が取れない社は「未確定」として扱う。
 *
 * 入力: data/leads-consolidated-all.csv の 既存被り空欄 × 過去納品CSVに社名なし
 * 経路: corpID を URL から抽出（無ければマイナビcorpusと社名一致で解決）→
 *       https://job.mynavi.jp/<gy>/pc/search/corp<id>/outline.html を素のHTTPで取得（実測0.3秒）
 *       1枚に 業種／従業員数／本社／電話番号／過去3年間の新卒採用者数 が載る。
 *       片方の卒年で欠けたらもう一方の卒年面を1回だけ引く（h1の社名一致時のみ採用）。
 * 出力: data/fresh-verify.json（社名キーの検証台帳・再開可）
 *
 * 使い方: node src/verify-fresh-hire.js [--conc 6] [--limit 0] [--delay 120]
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { readCsv } = require('./csv');
const { createMatchIndex } = require('./company-match');
const { extractOutlineFacts } = require('./scrape-mynavi');
const { extractHireRecord } = require('./enrich-hire-record');
const { extractPhones, normalizeJpPhone } = require('./phone');
const { mkey, cleanDisplay } = require('./build-icp-fresh-1000');

const ROOT = path.resolve(__dirname, '..');
const getArg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const CONC = Math.max(1, parseInt(getArg('conc', '6'), 10));
const LIMIT = parseInt(getArg('limit', '0'), 10);
const DELAY = parseInt(getArg('delay', '120'), 10);
const OUT = path.resolve(ROOT, getArg('out', 'data/fresh-verify.json'));
const MASTER = path.join(ROOT, 'data/leads-consolidated-all.csv');
// 過去に渡した成果物（統合マスタの中/外を問わず、社名が載っていたら完全新規ではない）
const PAST = ['data/leads-bales-callable.csv', 'data/leads-bales-named.csv', 'data/leads-bales-format.csv',
  'data/leads-icp-fresh-10000.csv', 'data/leads-icp-fresh-named-1000.csv', 'data/leads-icp-fresh-perfect-1000.csv',
  'data/leads-icp-hire6-500.csv', 'data/leads-icp-nooverlap-130.csv', 'data/leads-icp-nooverlap-all-215.csv',
  'data/leads-icp-perfect-named-1000.csv', 'data/leads-named-mochica-max.csv', 'data/leads-mochica-target.csv',
  'leads-mochica-named-consolidated.csv', 'data/icp-wide-pool.csv', 'data/icp-gakujo-pool.csv', 'data/icp-fresh-pool.csv'];
const CORPORA = [['data/mynavi-2028-corpus.csv', '28'], ['data/mynavi-2027-corpus.csv', '27']];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const log = (m) => console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const g = (r, k) => String(r[k] == null ? '' : r[k]).trim();

function fetchUrl(url, redirects) {
  if (redirects == null) redirects = 3;
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch (e) { return resolve(''); }
    const req = https.get(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8' }, timeout: 20000 }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects > 0) {
        r.resume(); return resolve(fetchUrl(new URL(r.headers.location, u).href, redirects - 1));
      }
      if (r.statusCode !== 200) { r.resume(); return resolve(''); }
      let b = ''; r.setEncoding('utf8');
      r.on('data', (c) => { b += c; if (b.length > 3e6) { req.destroy(); resolve(b); } });
      r.on('end', () => resolve(b));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}
const ent = (s) => String(s || '')
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d))
  .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"');
function toText(h) {
  let t = String(h || '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '\n');
  t = ent(t).replace(/\n\s*\n+/g, '\n');
  return t.replace(/(\d)\s*名/g, '$1名').replace(/(\d)\s*%/g, '$1%');
}
function phoneFrom(html, t) {
  const raw = (t.match(/電話番号[^0-9０-９]{0,8}([0-9０-９][0-9０-９\-‐－―ー()（） ]{8,21})/) || [])[1] || '';
  let phone = normalizeJpPhone(raw);
  if (phone) return phone;
  try {
    const pr = extractPhones({ html: html, text: t }) || {};
    const list = (pr.candidates && pr.candidates.length) ? pr.candidates : (pr.phone ? [pr] : []);
    for (const c of list) { if (c.isFax) continue; const nz = normalizeJpPhone(c.phone); if (nz) return nz; }
  } catch (e) {}
  return '';
}
function safeWrite(abs, content) {
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, content);
  for (let i = 0; i < 5; i++) { try { fs.renameSync(tmp, abs); return; } catch (e) { if (e.code === 'EPERM' || e.code === 'EBUSY') { try { fs.writeFileSync(abs, content); fs.unlinkSync(tmp); return; } catch (e2) {} } } }
  try { fs.writeFileSync(abs, content); if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
}

/** 完全新規候補（既存被りなし × 過去納品に社名なし）を統合マスタから取り出す */
function freshCandidates() {
  const idx = createMatchIndex();
  for (const rel of PAST) {
    const f = path.join(ROOT, rel);
    if (!fs.existsSync(f)) continue;
    try { for (const r of readCsv(fs.readFileSync(f, 'utf8')).records) idx.addRecord(r, 'past'); } catch (e) {}
  }
  const ng = new Set();
  const ngFile = path.join(ROOT, 'data', 'ng-companies.txt');
  if (fs.existsSync(ngFile)) for (const l of fs.readFileSync(ngFile, 'utf8').split(/\r?\n/)) { const k = mkey(l); if (k) ng.add(k); }

  // 社名→corpID（マイナビcorpus）。28卒を優先し、無ければ27卒。
  const corpByName = new Map();
  for (const [rel, gy] of CORPORA) {
    const f = path.join(ROOT, rel);
    if (!fs.existsSync(f)) continue;
    for (const r of readCsv(fs.readFileSync(f, 'utf8')).records) {
      const k = mkey(r['企業名']); const id = String(r.corpID || '').trim();
      if (k && id && !corpByName.has(k)) corpByName.set(k, { id, gy });
    }
  }

  const out = []; const seen = new Set();
  for (const r of readCsv(fs.readFileSync(MASTER, 'utf8')).records) {
    const name = g(r, '企業名'); if (!name) continue;
    if (g(r, '既存被り')) continue;              // BALES/MOCHICA顧客/SF と被る社は除外
    if (idx.has(name)) continue;                 // 過去納品に載っている社は除外
    const k = mkey(name); if (!k || ng.has(k) || seen.has(k)) continue;
    const u = g(r, '採用ページURL') + ' ' + g(r, '根拠URL') + ' ' + g(r, '公式URL');
    const m = u.match(/job\.mynavi\.jp\/(\d{2})\/pc\/search\/corp(\d+)/);
    const ref = m ? { id: m[2], gy: m[1] } : corpByName.get(k);
    if (!ref) continue;                          // マイナビ面が引けない社は厳格検証できない
    seen.add(k);
    out.push({ key: k, name, id: ref.id, gy: ref.gy, row: r });
  }
  return out;
}

async function verifyOne(c) {
  const tryYears = c.gy === '28' ? ['28', '27'] : ['27', '28'];
  let facts = null; let hire = null; let phone = ''; let canonical = ''; let usedGy = ''; let url = '';
  for (const gy of tryYears) {
    const u = 'https://job.mynavi.jp/' + gy + '/pc/search/corp' + c.id + '/outline.html';
    const html = await fetchUrl(u);
    if (!html) continue;
    const t = toText(html);
    const h1 = ent(((html.match(/<h1[^>]*>([\s\S]{0,120}?)<\/h1>/) || [])[1] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
    const nm = cleanDisplay(h1 || c.name);
    if (!nm) continue;
    // 別卒年に回るときは社名一致を必須にする（corpIDは卒年で安定だが取り違えは致命的）
    if (canonical && mkey(nm) !== mkey(canonical)) continue;
    if (!canonical) { canonical = nm; usedGy = gy; url = u; }
    const f = extractOutlineFacts(t);
    if (!facts) facts = f;
    else { for (const k of Object.keys(f)) if (!facts[k] && f[k]) facts[k] = f[k]; }
    if (!phone) phone = phoneFrom(html, t);
    if (!hire) hire = extractHireRecord(t);
    if (facts && facts.従業員数 && phone && hire) break;
  }
  if (!canonical) return { ok: false, reason: 'fetch失敗' };
  return {
    ok: true, 企業名: canonical, corpID: c.id, 卒年: usedGy, url,
    業種: (facts && facts.業種) || '', 従業員数: (facts && facts.従業員数) || '',
    本社: (facts && facts.本社) || '', 上場: (facts && facts.上場) || '', 電話番号: phone,
    実績人数: hire ? hire.人数 : null, 実績年: hire ? hire.年 : null,
    実績3年: hire ? hire.系列.map((x) => x.年 + '年' + x.人数 + '名').join('/') : '',
    実績根拠: hire ? hire.出所 + '（マイナビ' + usedGy + '卒 会社概要）' : '',
  };
}

async function main() {
  log('完全新規候補を構築中…');
  const cand = freshCandidates();
  log('完全新規かつマイナビ面あり: ' + cand.length + '社');
  let ledger = {};
  if (fs.existsSync(OUT)) { try { ledger = JSON.parse(fs.readFileSync(OUT, 'utf8')) || {}; } catch (e) {} }
  const todo = cand.filter((c) => !ledger[c.key]);
  const batch = LIMIT ? todo.slice(0, LIMIT) : todo;
  log('未検証 ' + batch.length + '社を検証（並列' + CONC + '・既済 ' + Object.keys(ledger).length + '）');
  if (!batch.length) { log('対象なし。終了。'); return; }

  const st = { ok: 0, ng: 0, hire: 0, hire6: 0 };
  let idx = 0; let done = 0;
  const flush = () => safeWrite(OUT, JSON.stringify(ledger));
  const worker = async () => {
    for (;;) {
      const i = idx++; if (i >= batch.length) return;
      const c = batch[i];
      try {
        const v = await verifyOne(c);
        if (!v.ok) { ledger[c.key] = { 企業名: c.name, corpID: c.id, 失敗: v.reason }; st.ng++; }
        else {
          ledger[c.key] = v; st.ok++;
          if (v.実績人数 != null) { st.hire++; if (v.実績人数 >= 6) st.hire6++; }
        }
      } catch (e) { ledger[c.key] = { 企業名: c.name, corpID: c.id, 失敗: String(e && e.message) }; st.ng++; }
      if (++done % 200 === 0) { flush(); log('  ...' + done + '/' + batch.length + ' 取得' + st.ok + ' 失敗' + st.ng + ' ｜実績判明' + st.hire + ' 6名以上' + st.hire6); }
      await sleep(DELAY);
    }
  };
  await Promise.all(Array.from({ length: CONC }, () => worker()));
  flush();
  log('完了: 取得' + st.ok + ' 失敗' + st.ng + ' ｜実績判明' + st.hire + ' 6名以上' + st.hire6 + ' → ' + path.relative(ROOT, OUT));
}
if (require.main === module) main().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });

module.exports = { freshCandidates, verifyOne, fetchUrl, toText, phoneFrom, PAST };
