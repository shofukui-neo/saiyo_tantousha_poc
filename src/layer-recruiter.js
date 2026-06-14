'use strict';
// 採用担当者名レイヤリング（エンジン非依存）。
//  既に作成済みの代表者名つきリスト(data/gbiz-records.json)のうち「公式URL」がある社をクロールし、
//  採用担当者名（＋取れれば電話番号）を上乗せする。
//  抽出エンジンは recruiter.js が自動選択： GEMINI_KEY → Gemini ／ OLLAMA_URL → ローカルLLM ／ どちらも無ければ 正規表現。
//  → 後から .env に GEMINI_KEY(AIza...) か OLLAMA_URL を入れるだけで、コード無改修でAI経路に切替わる。
//
//   node src/layer-recruiter.js --concurrency 4 --limit 0 --out leads-daihyou-1000-recruiter.csv
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { normalizeIcp } = require('./icp');
const { getRobots, isAllowed } = require('./robots');
const { fetchPage, fetchText, discoverPages, guessContactPaths, extractText, closeBrowser } = require('./fetch');
const structured = require('./structured');
const { extractPhones, normalizeJpPhone } = require('./phone');
const { extractRecruiterFromText } = require('./recruiter');
const { geminiAvailable } = require('./gemini');
const { tierOf, callScript, normalizeDomain } = require('./score');
const { writeMasterCsv } = require('./master-io');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}

const IN = getArg('in', 'data/gbiz-records.json');
const OUT = getArg('out', 'leads-daihyou-1000-recruiter.csv');
const CONC = parseInt(getArg('concurrency', '4'), 10) || 4;
const LIMIT = parseInt(getArg('limit', '0'), 10) || 0; // 0=全件
const REC_JSON = path.resolve(__dirname, '..', 'data', 'recruiter-journal.json');
const LOG = path.resolve(__dirname, '..', 'layer-recruiter.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (_) {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function engineLabel() {
  if (geminiAvailable(cfg)) return 'Gemini(AI)';
  if (cfg.OLLAMA_URL) return `Ollama(${cfg.OLLAMA_MODEL}) ※失敗時は正規表現`;
  return '正規表現（AI未設定）';
}

function locatePaths(homepageUrl) {
  try { const origin = new URL(homepageUrl).origin; return cfg.LOCATE_PATHS.map((p) => origin + p); }
  catch (_) { return []; }
}

// 1社クロール → { recruiter, phone }
async function crawlOne(homepageUrl, cand) {
  const start = new URL(homepageUrl);
  const robots = await getRobots(start.origin).catch(() => null);
  if (robots && !isAllowed(robots, cfg.USER_AGENT, start.pathname)) return { skipped: 'robots' };

  const home = await fetchPage(homepageUrl);
  const htmlByUrl = { [homepageUrl]: home.html };
  const discovered = discoverPages(homepageUrl, home.html);
  let sitemapPages = [];
  if (cfg.USE_SITEMAP) { try { sitemapPages = await structured.discoverFromSitemap(start.origin, { fetchText }); } catch (_) {} }
  const ordered = [homepageUrl, ...discovered, ...sitemapPages, ...guessContactPaths(homepageUrl), ...locatePaths(homepageUrl)];
  const pages = [...new Set(ordered)].slice(0, cfg.MAX_PAGES_PER_SITE);

  let recruiterHit = null, bestPhone = null, pagesChecked = 0;
  for (const url of pages) {
    if (!htmlByUrl[url]) {
      let u; try { u = new URL(url); } catch (_) { continue; }
      if (robots && !isAllowed(robots, cfg.USER_AGENT, u.pathname)) continue;
      await sleep(cfg.POLITE_DELAY_MS);
      try { const p = await fetchPage(url); htmlByUrl[url] = p.html; } catch (_) { continue; }
    }
    pagesChecked++;
    const html = htmlByUrl[url];
    const text = extractText(html);
    if (!text || text.length < 40) continue;

    if (cfg.USE_STRUCTURED) {
      const org = structured.extractOrganization(html);
      if (org && org.telephone) { const n = normalizeJpPhone(org.telephone); if (n && !bestPhone) bestPhone = { phone: n, source: 'json-ld' }; }
    }
    const pageBoost = /company|contact|about|corporate|profile|outline|会社|問い合わせ|問合/i.test(url) ? 2 : 0;
    const ph = extractPhones({ html, text, pageBoost });
    if (ph.phone && (!bestPhone || bestPhone.source !== 'json-ld')) bestPhone = { phone: ph.phone, source: 'regex' };

    if (!recruiterHit) {
      const hit = await extractRecruiterFromText(text, cand, cfg);
      if (hit) recruiterHit = { ...hit, sourceUrl: url };
    }
    if (recruiterHit && bestPhone) break;
  }
  return { recruiter: recruiterHit, phone: bestPhone, pagesChecked };
}

async function main() {
  const t0 = Date.now();
  const icp = normalizeIcp({ source: 'manual' }, cfg);
  log(`===== 採用担当者名レイヤリング開始 ｜ 抽出エンジン: ${engineLabel()} ｜ 並列${CONC} =====`);

  const inPath = path.isAbsolute(IN) ? IN : path.resolve(__dirname, '..', IN);
  const records = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const byKey = new Map(records.map((r) => [String(r['法人番号'] || r['企業名']), r]));

  // 再開ジャーナル（処理済み法人番号→更新後レコード）
  if (fs.existsSync(REC_JSON)) {
    try { for (const r of JSON.parse(fs.readFileSync(REC_JSON, 'utf8'))) byKey.set(String(r['法人番号'] || r['企業名']), r); log('再開ジャーナルを反映'); } catch (_) {}
  }
  const processed = new Set(); // この実行で処理した／既にdoneのキー
  for (const r of byKey.values()) if (r.__recruiterDone) processed.add(String(r['法人番号'] || r['企業名']));

  // 対象 = 公式URLあり & 未処理
  let targets = [...byKey.values()].filter((r) => String(r['公式URL'] || '').trim() && !processed.has(String(r['法人番号'] || r['企業名'])));
  if (LIMIT > 0) targets = targets.slice(0, LIMIT);
  const totalWithUrl = [...byKey.values()].filter((r) => String(r['公式URL'] || '').trim()).length;
  log(`対象: ${targets.length}社（公式URL保有 ${totalWithUrl}社中・未処理分）`);

  let done = 0, hit = 0, phoneAdd = 0, flushPending = 0;
  const flush = () => {
    const arr = [...byKey.values()];
    writeMasterCsv(OUT, arr, cfg.MASTER_HEADERS);
    fs.writeFileSync(REC_JSON, JSON.stringify(arr));
  };

  let idx = 0;
  async function worker() {
    while (idx < targets.length) {
      const rec = targets[idx++];
      const url = rec['公式URL'];
      try {
        const r = await crawlOne(url, { name: rec['企業名'], prefecture: rec['都道府県'] });
        if (r && r.recruiter) {
          rec['採用担当者名'] = r.recruiter.name; rec['役職'] = r.recruiter.role || '';
          rec['部署'] = r.recruiter.department || ''; rec['担当者確度'] = r.recruiter.confidence || '';
          rec['取得元媒体'] = r.recruiter.engine === 'gemini' ? 'AI抽出(Gemini)'
            : r.recruiter.engine === 'ollama' ? 'AI抽出(Ollama)' : '正規表現抽出';
          rec['根拠URL'] = r.recruiter.sourceUrl || rec['根拠URL'];
          hit++;
        }
        if (r && r.phone && !String(rec['電話番号'] || '').trim()) { rec['電話番号'] = r.phone.phone; phoneAdd++; }
        // Tier 再計算
        rec['Tier'] = tierOf(Number(rec['担当者確度'] || 0), Number(rec['メール確度'] || 0), !!String(rec['代表者名'] || '').trim(), cfg);
      } catch (e) { /* 個社失敗は黙ってスキップ（代表者名は残る） */ }
      rec.__recruiterDone = true;
      done++;
      if (++flushPending >= 5) { flushPending = 0; flush(); }
      if (done % 10 === 0) {
        const el = (Date.now() - t0) / 1000, rate = done / el;
        const eta = rate > 0 ? ((targets.length - done) / rate / 60).toFixed(1) : '?';
        log(`進捗 ${done}/${targets.length}（採用担当者HIT ${hit} / 電話補完 ${phoneAdd}）｜ETA約${eta}分`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONC, targets.length) }, () => worker()));
  flush();
  await closeBrowser();

  const arr = [...byKey.values()];
  const recruiterCnt = arr.filter((r) => String(r['採用担当者名'] || '').trim()).length;
  const tier = arr.reduce((a, r) => { a[r.Tier] = (a[r.Tier] || 0) + 1; return a; }, {});
  log(`===== 完了 ｜ 採用担当者名 ${recruiterCnt}件 / 電話 ${arr.filter((r) => String(r['電話番号'] || '').trim()).length}件 =====`);
  log(`Tier内訳: A=${tier.A || 0} B=${tier.B || 0} C=${tier.C || 0} D=${tier.D || 0}`);
  log(`出力: ${path.resolve(OUT)}（所要 ${((Date.now() - t0) / 60000).toFixed(1)}分・エンジン ${engineLabel()}）`);
}

main().catch((e) => { log('FATAL ' + (e && e.stack ? e.stack : e)); closeBrowser().finally(() => process.exit(1)); });
