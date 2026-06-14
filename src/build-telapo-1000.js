'use strict';
// テレアポ用「電話番号100%・1000件」ビルダー。
//  方針: 各社サイトをクロールして電話番号を取得し、「電話が取れた社だけ」を採用 → 構造的に電話100%。
//  供給源の優先順:
//   1) 統合済みユニークCSV(data/merged-records.json) … 代表者名つき＋URL保有を優先
//   2) URL未保有社は Bing で公式URLを発見してからクロール
//   3) それでも1000に満たなければ gBizINFO から company_url 保有社を追加発掘（employee_number_from で良質母集団）
//  同じクロールで採用担当者名(Gemini, ベストエフォート)・代表者名・メールも付与。
//  数件ごとにCSV＋ジャーナルをフラッシュ（再開可能）。
//
//   node src/build-telapo-1000.js --target 1000 --concurrency 8 --out leads-telapo-1000.csv
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { normalizeIcp } = require('./icp');
const { getRobots, isAllowed } = require('./robots');
const { fetchPage, fetchText, discoverPages, guessContactPaths, extractText, closeBrowser } = require('./fetch');
const structured = require('./structured');
const { extractPhones, normalizeJpPhone } = require('./phone');
const { extractRecruiterFromText } = require('./recruiter');
const { enrichEmail } = require('./email');
const { discoverUrl, companyCore } = require('./search');
const { gbizAvailable, gbizSearch, gbizGet } = require('./gbiz');
const { geminiAvailable } = require('./gemini');
const { normalizeDomain, tierOf, callScript } = require('./score');
const { writeMasterCsv } = require('./master-io');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
const TARGET = parseInt(getArg('target', '1000'), 10) || 1000;
const CONC = parseInt(getArg('concurrency', '8'), 10) || 8;
const OUT = getArg('out', 'leads-telapo-1000.csv');
const MERGED = path.resolve(__dirname, '..', 'data', 'merged-records.json');
const JOURNAL = path.resolve(__dirname, '..', 'data', 'telapo-journal.json');
const LOG = path.resolve(__dirname, '..', 'telapo.log');

function log(m) { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); try { fs.appendFileSync(LOG, l + '\n'); } catch (_) {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RECRUIT_HINT = /recruit|saiyo|採用|career|jobs|entry|contact|問い合わせ|問合|company|about|会社/i;

function locatePaths(homepageUrl) {
  try { const o = new URL(homepageUrl).origin; return cfg.LOCATE_PATHS.map((p) => o + p); } catch (_) { return []; }
}

// 1社クロール: 電話（必須）＋採用担当者（Gemini, 最大2回まで）＋根拠
async function crawlCompany(homepageUrl, cand) {
  const start = new URL(homepageUrl);
  const robots = await getRobots(start.origin).catch(() => null);
  if (robots && !isAllowed(robots, cfg.USER_AGENT, start.pathname)) return null;
  let home;
  try { home = await fetchPage(homepageUrl); } catch (_) { return null; }
  const finalUrl = home.finalUrl || homepageUrl;
  const htmlByUrl = { [homepageUrl]: home.html };
  const ordered = [homepageUrl, ...discoverPages(homepageUrl, home.html), ...guessContactPaths(homepageUrl), ...locatePaths(homepageUrl)];
  const pages = [...new Set(ordered)].slice(0, cfg.MAX_PAGES_PER_SITE);

  let bestPhone = null, recruiterHit = null, geminiCalls = 0, phoneSrc = '';
  for (const url of pages) {
    if (!htmlByUrl[url]) {
      let u; try { u = new URL(url); } catch (_) { continue; }
      if (robots && !isAllowed(robots, cfg.USER_AGENT, u.pathname)) continue;
      await sleep(cfg.POLITE_DELAY_MS);
      try { const p = await fetchPage(url); htmlByUrl[url] = p.html; } catch (_) { continue; }
    }
    const html = htmlByUrl[url];
    const text = extractText(html);
    if (!text || text.length < 40) continue;

    if (cfg.USE_STRUCTURED) {
      const org = structured.extractOrganization(html);
      if (org && org.telephone) { const n = normalizeJpPhone(org.telephone); if (n && (!bestPhone || phoneSrc !== 'json-ld')) { bestPhone = n; phoneSrc = 'json-ld'; } }
    }
    if (phoneSrc !== 'json-ld') {
      const boost = /company|contact|about|corporate|profile|会社|問い合わせ|問合/i.test(url) ? 2 : 0;
      const ph = extractPhones({ html, text, pageBoost: boost });
      if (ph.phone) { bestPhone = ph.phone; phoneSrc = 'regex'; }
    }
    // 採用担当者（Gemini優先）。採用/問い合わせ系ページに限定し、呼び出し回数を抑制。
    if (!recruiterHit && RECRUIT_HINT.test(url) && geminiCalls < 2) {
      if (geminiAvailable(cfg)) geminiCalls++;
      const hit = await extractRecruiterFromText(text, cand, cfg).catch(() => null);
      if (hit) recruiterHit = { ...hit, sourceUrl: url };
    }
    if (bestPhone && recruiterHit) break;
  }
  return { phone: bestPhone, phoneSrc, recruiter: recruiterHit, finalUrl };
}

async function main() {
  const t0 = Date.now();
  const icp = normalizeIcp({ source: 'manual' }, cfg);
  const engine = geminiAvailable(cfg) ? `Gemini(${cfg.LLM_MODEL})` : (cfg.OLLAMA_URL ? `Ollama(${cfg.OLLAMA_MODEL})` : '正規表現');
  log(`===== テレアポ電話100%・${TARGET}件ビルド開始 ｜ 並列${CONC} ｜ 採用担当者抽出: ${engine} =====`);

  // 出力（採用済み）ジャーナル
  const accepted = new Map(); // key -> record（電話あり）
  if (fs.existsSync(JOURNAL)) {
    try { for (const r of JSON.parse(fs.readFileSync(JOURNAL, 'utf8'))) accepted.set(String(r['法人番号'] || companyCore(r['企業名'])), r); } catch (_) {}
    log(`再開: 既存 ${accepted.size}件（電話あり）を復元`);
  }
  const triedKeys = new Set([...accepted.keys()]);

  let flushPending = 0;
  const flush = () => { const arr = [...accepted.values()]; writeMasterCsv(OUT, arr, cfg.MASTER_HEADERS); fs.writeFileSync(JOURNAL, JSON.stringify(arr)); };

  // 1社処理: URL確定→クロール→電話あれば採用
  async function processCand(cand) {
    const key = String(cand['法人番号'] || companyCore(cand['企業名'] || cand.name || ''));
    if (!key || triedKeys.has(key)) return;
    triedKeys.add(key);
    const name = cand['企業名'] || cand.name || '';
    let url = cand['公式URL'] || cand.websiteUrl || '';
    if (!url) {
      try { await sleep(cfg.SEARCH_DELAY_MS); const d = await discoverUrl(name, { fetchPage, extractText }, { addressHint: cand['都道府県'] || '' }); url = d && d.url ? d.url : ''; } catch (_) {}
    }
    if (!url) return; // URLが無いと電話に到達不可
    let cr = null;
    try { cr = await crawlCompany(url, { name, prefecture: cand['都道府県'] || '' }); } catch (_) {}
    if (!cr || !cr.phone) return; // 電話が取れなければ不採用（=出力は電話100%）

    const domain = normalizeDomain(cr.finalUrl || url);
    let email = cand['メール'] || '', emailScore = cand['メール確度'] || '';
    if (!email) { try { const em = await enrichEmail({ domain, websiteUrl: cr.finalUrl || url }, cfg); email = em.email || ''; emailScore = em.score != null ? em.score : ''; } catch (_) {} }

    const rec = {
      '企業名': name, '法人番号': cand['法人番号'] || '',
      '採用担当者名': cr.recruiter ? cr.recruiter.name : '', '役職': cr.recruiter ? (cr.recruiter.role || '') : '',
      '部署': cr.recruiter ? (cr.recruiter.department || '') : '', '代表者名': cand['代表者名'] || '',
      'メール': email, 'メール確度': emailScore,
      '担当者確度': cr.recruiter ? (cr.recruiter.confidence || '') : '', '電話番号': cr.phone,
      '公式URL': cr.finalUrl || url, 'Tier': 'C',
      '取得元媒体': cr.recruiter ? (cr.recruiter.engine === 'gemini' ? 'AI抽出(Gemini)' : cr.recruiter.engine === 'ollama' ? 'AI抽出(Ollama)' : '正規表現抽出') : (cand['取得元媒体'] || 'クロール'),
      '根拠URL': cr.recruiter ? cr.recruiter.sourceUrl : (cr.finalUrl || url),
      '架電呼称': callScript(icp, cfg),
      '業種': cand['業種'] || '', '都道府県': cand['都道府県'] || '',
      '従業員数': cand['従業員数'] || '', '補助金': cand['補助金'] || '', '設立年': cand['設立年'] || '',
      '取得日': new Date().toISOString(),
    };
    rec['Tier'] = tierOf(Number(rec['担当者確度'] || 0), Number(rec['メール確度'] || 0), !!String(rec['代表者名'] || '').trim(), cfg);
    accepted.set(key, rec);
    if (++flushPending >= 5) { flushPending = 0; flush(); }
    if (accepted.size % 10 === 0) {
      const el = (Date.now() - t0) / 1000, rate = accepted.size / el;
      const eta = rate > 0 ? ((TARGET - accepted.size) / rate / 60).toFixed(1) : '?';
      const rc = [...accepted.values()].filter((r) => r['採用担当者名']).length;
      log(`採用 ${accepted.size}/${TARGET}（採用担当者名 ${rc}）｜ETA約${eta}分`);
    }
  }

  // 並列ワーカ（候補を共有キューから消費）
  async function runPool(cands) {
    let idx = 0;
    await Promise.all(Array.from({ length: CONC }, async () => {
      while (idx < cands.length && accepted.size < TARGET) { const c = cands[idx++]; await processCand(c); }
    }));
  }

  // --- 供給1+2: 統合ユニークリスト（代表者名+URL を優先）---
  let merged = [];
  try { merged = JSON.parse(fs.readFileSync(MERGED, 'utf8')); } catch (_) {}
  merged.sort((a, b) => {
    const s = (r) => (r['電話番号'] ? 4 : 0) + (r['公式URL'] ? 2 : 0) + (r['代表者名'] ? 1 : 0);
    return s(b) - s(a);
  });
  log(`供給1: 統合リスト ${merged.length}社をクロール（電話の取れた社のみ採用）`);
  await runPool(merged);
  flush();
  log(`統合リスト消化後: 採用 ${accepted.size}/${TARGET}`);

  // --- 供給3: gBizINFO 追加発掘（company_url 保有社）---
  if (accepted.size < TARGET && gbizAvailable(cfg)) {
    const prefs = (cfg.ICP_PREFECTURES && cfg.ICP_PREFECTURES.length) ? cfg.ICP_PREFECTURES : ['13'];
    const seenCorp = new Set([...accepted.values()].map((r) => String(r['法人番号'])).filter(Boolean));
    log(`供給3: gBizINFO追加発掘開始（残 ${TARGET - accepted.size}社・都道府県${prefs.length}）`);
    let page = 1, active = prefs.slice();
    while (accepted.size < TARGET && active.length && page <= 60) {
      const next = [];
      for (const pref of active) {
        if (accepted.size >= TARGET) break;
        let hits = [];
        try { hits = await gbizSearch({ prefecture: pref, corporateType: cfg.GBIZ_CORPORATE_TYPE, employeeFrom: cfg.ICP_EMP_MIN, page, limit: cfg.GBIZ_LIMIT }, cfg); } catch (_) {}
        if (!hits.length) continue;
        next.push(pref);
        // 詳細(company_url/代表者名)を取得 → URL保有社をクロール候補に
        const fresh = hits.filter((h) => h.corporateNumber && !seenCorp.has(String(h.corporateNumber)));
        fresh.forEach((h) => seenCorp.add(String(h.corporateNumber)));
        const cands = [];
        let j = 0;
        await Promise.all(Array.from({ length: Math.min(8, fresh.length) }, async () => {
          while (j < fresh.length) {
            const h = fresh[j++];
            const gb = await gbizGet(h.corporateNumber, cfg).catch(() => null);
            if (gb && gb.websiteUrl) cands.push({ '企業名': gb.name || h.name, '法人番号': h.corporateNumber, '代表者名': gb.representativeName || '', '公式URL': gb.websiteUrl, '都道府県': gb.prefecture || '', '従業員数': gb.employees != null ? gb.employees : '', '設立年': gb.establishmentYear || '', '業種': String(gb.businessSummary || '').slice(0, 60), '取得元媒体': 'gBizINFO' });
          }
        }));
        await runPool(cands);
        flush();
      }
      active = next; page++;
      log(`  gBiz発掘 page=${page - 1}: 採用 ${accepted.size}/${TARGET}`);
    }
  }

  flush();
  await closeBrowser();
  const arr = [...accepted.values()];
  const rc = arr.filter((r) => r['採用担当者名']).length;
  const tier = arr.reduce((a, r) => { a[r.Tier] = (a[r.Tier] || 0) + 1; return a; }, {});
  log(`===== 完了: ${arr.length}件（電話100%）｜ 採用担当者名 ${rc} ｜ 代表者名 ${arr.filter((r) => r['代表者名']).length} =====`);
  log(`Tier内訳: A=${tier.A || 0} B=${tier.B || 0} C=${tier.C || 0} D=${tier.D || 0}`);
  log(`出力: ${path.resolve(OUT)}（所要 ${((Date.now() - t0) / 60000).toFixed(1)}分）`);
}

main().catch((e) => { log('FATAL ' + (e && e.stack ? e.stack : e)); closeBrowser().finally(() => process.exit(1)); });
