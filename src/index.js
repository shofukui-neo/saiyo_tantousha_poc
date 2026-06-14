'use strict';
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { getRobots, isAllowed } = require('./robots');
const { fetchPage, fetchText, discoverPages, guessContactPaths, extractText, closeBrowser } = require('./fetch');
const { extractContact } = require('./extract');
const { validateHit } = require('./validate');
const { discoverUrl, companyCore } = require('./search');
const { discoverCompanies } = require('./discover');
const gbiz = require('./gbizinfo');
const structured = require('./structured');
const { extractPhones, normalizeJpPhone } = require('./phone');
const { summarize, printSummary } = require('./metrics');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- 簡易引数パース ----
function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}

// ---- 簡易CSVパース（company_name 必須, homepage_url 任意。#始まりはコメント） ----
function parseCsv(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  let header = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cols = splitCsvLine(line);
    if (!header) { header = cols.map(c => c.toLowerCase()); continue; }
    const obj = {};
    header.forEach((h, i) => { obj[h] = (cols[i] || '').trim(); });
    const name = obj.company_name || obj.name || '';
    const homepage = obj.homepage_url || obj.url || '';
    if (name || homepage) rows.push({ name: name || '(no name)', homepage_url: homepage });
  }
  return rows;
}
function splitCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else { if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; }
  }
  out.push(cur);
  return out;
}
function writeCsv(outPath, rows) {
  const cols = ['company', 'resolved_url', 'status', 'phone', 'name', 'role', 'department', 'confidence',
    'url_source', 'phone_source_url', 'name_source_url', 'evidence', 'engine', 'pages_checked', 'elapsed_ms', 'error'];
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map(c => esc(r[c])).join(','));
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
}

// ---- 発見した企業名だけを company_name 列のCSVに書き出す（--discover-only 用） ----
function writeCompaniesCsv(outPath, names) {
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = ['company_name,homepage_url', ...names.map(n => esc(n) + ',')];
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
}

// ---- 並列実行プール（企業をまたいだ並列） ----
async function pool(items, n, worker) {
  const ret = new Array(items.length);
  let idx = 0;
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; ret[i] = await worker(items[i], i); }
  });
  await Promise.all(runners);
  return ret;
}

// ---- 1社の処理：①公式URL発見 → ②サイト巡回 → ③電話番号＋採用担当者名の抽出 ----
// status は「採用担当者名」のHIT/MISSを表す（従来どおりHIT率の主指標）。
// URL・電話番号の取得可否は resolved_url / phone 列の有無と、集計の各取得率で把握する。
// ※ 抽出はすべてローカル処理（正規表現＋人名判定）。外部AI APIは使用しない。
async function processCompany(c) {
  const t0 = Date.now();
  const res = {
    company: c.name, status: 'MISS',
    resolved_url: '', phone: '', name: '', role: '', department: '', confidence: 0,
    url_source: '', phone_source_url: '', name_source_url: '', evidence: '', engine: '',
    pages_checked: 0, elapsed_ms: 0, error: '',
  };
    // gBizINFO（任意・無料トークン時のみ）で正式名称・所在地・公式HPを公的データから取得。
    // 同名企業の取り違え防止と発見精度の底上げに使う。トークン未設定なら null。
    const gb = gbiz.enabled() ? await gbiz.lookup(c.name) : null;
    const addressHint = gb && gb.location ? gb.location : '';
    res._prefecture = gb && gb.prefecture ? gb.prefecture : '';   // 電話の市外局番整合に使用（内部用）

    // ① 入力URLがあればそれを使用。無ければ gBizINFO の企業HP → 検索発見 の順。
    let homepageUrl = (c.homepage_url || '').trim();
    if (homepageUrl) {
      res.url_source = 'input';
    } else if (gb && gb.url) {
      homepageUrl = gb.url;
      res.url_source = 'gbizinfo';                                 // 公的データ由来＝高信頼
    } else {
      await sleep(cfg.SEARCH_DELAY_MS);
      const d = await discoverUrl(c.name, { fetchPage, extractText }, { addressHint });
      if (!d.url) { res.status = 'NO_URL'; res.error = ('URL未発見: ' + (d.error || '')).slice(0, 200); return finalize(res, t0); }
      homepageUrl = d.url;
      res.url_source = d.source;
    }
    res.resolved_url = homepageUrl;

    const start = new URL(homepageUrl);
    const robots = await getRobots(start.origin);
    if (!isAllowed(robots, cfg.USER_AGENT, start.pathname)) { res.status = 'SKIP_ROBOTS'; return finalize(res, t0); }

    // ② サイト巡回（トップ→採用/会社概要/お問い合わせ等の候補ページ）
    const home = await fetchPage(homepageUrl);
    res.resolved_url = home.finalUrl || homepageUrl;
    res.pages_checked++;
    const htmlByUrl = { [homepageUrl]: home.html };

    // ナビ発見 ＋ sitemap発見 ＋ 推測パス を統合してMAX_PAGESまで充填。
    const discovered = discoverPages(homepageUrl, home.html);
    let sitemapPages = [];
    if (cfg.USE_SITEMAP) {
      try { sitemapPages = await structured.discoverFromSitemap(start.origin, { fetchText }); } catch (_) {}
    }
    const ordered = [homepageUrl, ...discovered, ...sitemapPages, ...guessContactPaths(homepageUrl)];
    const candidates = [...new Set(ordered)].slice(0, cfg.MAX_PAGES_PER_SITE);

    let bestPhone = null; // { phone, score, evidence, isFax, sourceUrl }
    let nameHit = false;

    for (const url of candidates) {
      if (!htmlByUrl[url]) {
        const u = new URL(url);
        if (!isAllowed(robots, cfg.USER_AGENT, u.pathname)) continue;
        await sleep(cfg.POLITE_DELAY_MS);
        try {
          const p = await fetchPage(url);    // 推測パスは404もあり得るので個別に握り潰して続行
          htmlByUrl[url] = p.html;
          res.pages_checked++;
        } catch (_) { continue; }
      }
      const html = htmlByUrl[url];
      const text = extractText(html);
      if (!text || text.length < 40) continue;

      // ③-a 電話番号。JSON-LD(schema.org)の telephone を最優先（正規表現より正確）。
      if (cfg.USE_STRUCTURED) {
        const org = structured.extractOrganization(html);
        if (org && org.telephone) {
          const norm = normalizeJpPhone(org.telephone);
          if (norm && (!bestPhone || bestPhone.source !== 'json-ld')) {
            bestPhone = { phone: norm, score: 100, source: 'json-ld', evidence: ('JSON-LD telephone: ' + org.telephone).slice(0, 120), isFax: false, sourceUrl: url };
          }
        }
      }
      // 正規表現＋tel: からも収集し、最良を保持（JSON-LDが取れていればそちらを優先）。
      // 会社概要/お問い合わせ/会社情報 等のページは代表番号が載りやすいので加点。
      const pageBoost = /company|contact|about|corporate|profile|outline|会社|問い合わせ|問合/i.test(url) ? 2 : 0;
      const ph = extractPhones({ html, text, pageBoost });
      if (ph.phone && (!bestPhone || (bestPhone.source !== 'json-ld' && ph.score > bestPhone.score))) {
        bestPhone = { ...ph, sourceUrl: url };
      }

      // ③-b 採用担当者名（検証ゲート通過で確定。確定後は名前抽出をスキップして電話探索のみ継続）
      if (!nameHit) {
        const ext = await extractContact({ text, companyName: c.name });
        const v = validateHit(ext);
        if (v.hit) {
          nameHit = true;
          res.status = 'HIT';
          res.name = ext.name;
          res.role = ext.role || '';
          res.department = ext.department || '';
          res.confidence = ext.confidence || 0;
          res.name_source_url = url;
          res.evidence = String(ext.evidence || '').slice(0, 160);
          res.engine = ext.engine || '';
        } else {
          res.engine = ext.engine || res.engine;
        }
      }

      // 担当者名HIT かつ 電話番号取得済みなら早期終了
      if (nameHit && bestPhone) break;
    }

    if (bestPhone) {
      res.phone = bestPhone.phone;
      res.phone_source_url = bestPhone.sourceUrl;
      if (!res.evidence) res.evidence = String(bestPhone.evidence || '').slice(0, 160);
      // 電話の市外局番(都道府県)とgBizINFOの所在地が食い違う＝同名取り違え/支店番号の疑い。ソフトに注意表示。
      if (res._prefecture && bestPhone.prefecture && bestPhone.prefecture !== res._prefecture) {
        res.evidence = (`⚠所在地(${res._prefecture})と市外局番(${bestPhone.prefecture})不一致 ` + (res.evidence || '')).slice(0, 160);
      }
    }
  } catch (e) {
    res.status = 'ERROR';
    res.error = String(e && e.message ? e.message : e).slice(0, 200);
  }
  return finalize(res, t0);
}
function finalize(res, t0) { res.elapsed_ms = Date.now() - t0; return res; }

// ---- 入出力アダプタ（source に応じて切替） ----
function makeIO(source, inputPath, outPath) {
  if (source === 'csv') {
    return {
      label: 'ローカルCSV',
      read: async () => parseCsv(fs.readFileSync(inputPath, 'utf8')).map((c, i) => ({ ...c, row: i + 2, status: '' })),
      write: async (pairs) => writeCsv(outPath, pairs.map(p => p.result)),
      done: () => `結果を書き出しました: ${path.resolve(outPath)}`,
    };
  }
  if (source === 'gas') {
    const g = require('./gas');
    return {
      label: 'GASウェブアプリ橋渡し',
      read: () => g.readCompanies(cfg),
      write: (pairs) => g.writeResults(cfg, pairs),
      done: () => 'スプレッドシートへ書き戻しました（GAS橋渡し）',
    };
  }
  const sh = require('./sheets'); // 既定: Sheets API
  return {
    label: 'Google Sheets API',
    read: () => sh.readCompanies(cfg),
    write: (pairs) => sh.writeResults(cfg, pairs),
    done: () => `スプレッドシートへ書き戻しました（${cfg.SHEET_TAB} / ${cfg.SHEET_ID}）`,
  };
}

async function main() {
  let source = String(getArg('source', cfg.SOURCE)).toLowerCase();
  const inputPath = getArg('input', 'companies.sample.csv'); // csv時のみ使用
  let outPath = getArg('out', 'results.csv');                 // csv時のみ使用
  const limit = parseInt(getArg('limit', '0'), 10) || 0;
  if (getArg('concurrency', null)) cfg.CONCURRENCY = parseInt(getArg('concurrency'), 10) || cfg.CONCURRENCY;
  if (process.argv.includes('--only-pending')) cfg.ONLY_PENDING = true;

  // ===== 発見モード：企業名そのものを自動収集（--discover <キーワード> / --discover-url <一覧URL>） =====
  const discoverQuery = getArg('discover', null);   // 例: --discover "東京 IT ベンチャー"
  const discoverUrlArg = getArg('discover-url', null);
  const discoverOnly = process.argv.includes('--discover-only');
  let discovered = null;
  if ((discoverQuery && discoverQuery !== true) || (discoverUrlArg && discoverUrlArg !== true)) {
    const seed = discoverUrlArg && discoverUrlArg !== true ? { listUrl: discoverUrlArg } : { query: discoverQuery };
    if (limit > 0) seed.limit = limit;
    console.log(`\n発見モード: ${seed.listUrl ? '一覧URL「' + seed.listUrl + '」' : 'キーワード「' + seed.query + '」'} から企業名を収集中…（外部AI API不使用）`);
    const d = await discoverCompanies(seed, { fetchPage, extractText });
    discovered = d.names;
    let srcLabel = d.source;
    // gBizINFO（任意）が有効なら、公的データからの企業名も併合して網羅性・精度を底上げ。
    if (gbiz.enabled() && seed.query) {
      const seenKeys = new Set(discovered.map(n => companyCore(n).toLowerCase()));
      const gbNames = await gbiz.discoverNames(seed.query, { limit: seed.limit || cfg.DISCOVER_LIMIT });
      let added = 0;
      for (const n of gbNames) { const k = companyCore(n).toLowerCase(); if (k && !seenKeys.has(k)) { seenKeys.add(k); discovered.push(n); added++; } }
      if (added) { srcLabel += `+gbizinfo(${added})`; if (seed.limit) discovered = discovered.slice(0, seed.limit); }
    }
    console.log(`→ ${discovered.length}社の企業名を発見（source=${srcLabel}）`);
    if (!discovered.length) { console.error('企業名を1件も発見できませんでした。キーワードを具体化するか、一覧ページURLを指定してください。'); await closeBrowser(); process.exit(1); }

    if (discoverOnly) {
      writeCompaniesCsv(outPath, discovered);
      console.log(`企業名リストを書き出しました: ${path.resolve(outPath)}（C列以降の取得を行う場合は --discover を付けずにこのCSVを --input に指定）\n`);
      discovered.slice(0, 15).forEach((n, i) => console.log(`  ${i + 1}. ${n}`));
      await closeBrowser();
      return;
    }
    // 発見した企業はそのままパイプラインへ。シート上書き事故を避けるため出力はCSVに固定。
    if (source !== 'csv') {
      console.warn(`⚠ 発見モードの結果は既存シートを上書きしないようCSVに出力します（--source ${source} は無視）。`);
      source = 'csv';
    }
  }

  const io = makeIO(source, inputPath, outPath);

  // 接続前チェック
  if (source === 'sheet' && !cfg.SHEET_ID) { console.error('SHEET_ID が未設定です。.env に設定するか、--source gas / csv を使用してください。'); process.exit(1); }
  if (source === 'gas' && !cfg.GAS_URL) { console.error('GAS_URL が未設定です。.env に設定するか、--source sheet / csv を使用してください。'); process.exit(1); }

  let companies;
  if (discovered) {
    // 発見した企業名を入力として扱う（URLは空＝後段で自動発見）
    companies = discovered.map((name, i) => ({ name, homepage_url: '', row: i + 2, status: '' }));
  } else {
    try {
      companies = await io.read();
    } catch (e) {
      console.error(`入力の読み込みに失敗 (${io.label}): ` + (e.message || e));
      process.exit(1);
    }
  }
  if (cfg.ONLY_PENDING && source !== 'csv') companies = companies.filter(c => !c.status);
  if (limit > 0) companies = companies.slice(0, limit);
  if (!companies || companies.length === 0) { console.error('対象企業が0件です（入力 or status 条件を確認）。'); process.exit(1); }

  const needSearch = companies.some(c => !c.homepage_url);
  console.log(`\n入出力: ${io.label} / 対象: ${companies.length}社 / 媒体: ${cfg.TARGET_MEDIA} / 並列: ${cfg.CONCURRENCY}`);
  console.log(`取得項目: 企業名 / 公式URL / 電話番号 / 採用担当者名（すべてローカル処理・外部AI API不使用）`);
  console.log(`URL発見: ${needSearch ? cfg.SEARCH_ENGINE + '（企業名→公式URL）' : '入力URLを使用'} ｜ 電話番号: 正規表現＋tel: ｜ 担当者名: 正規表現＋人名判定`
    + (cfg.ONLY_PENDING ? ' / ONLY_PENDING' : ''));
  console.log(`精度向上: gBizINFO=${gbiz.enabled() ? 'ON（公的データで同名照合）' : 'OFF（GBIZINFO_TOKEN未設定）'}`
    + ` ｜ 構造化抽出(JSON-LD/sitemap)=${cfg.USE_STRUCTURED ? 'ON' : 'OFF'}`
    + ` ｜ ローカルLLM(Ollama)=${cfg.OLLAMA_URL ? 'ON' : 'OFF'}`);

  const results = await pool(companies, cfg.CONCURRENCY, (c) => processCompany(c));
  await closeBrowser();

  const pairs = companies.map((c, i) => ({ row: c.row, result: results[i] }));
  try {
    await io.write(pairs);
  } catch (e) {
    console.error('結果の書き戻しに失敗: ' + (e.message || e));
    const fb = 'results.fallback.csv';
    writeCsv(fb, results);
    console.error('→ ' + path.resolve(fb) + ' に退避しました。');
  }

  const withUrl = results.filter(r => r.resolved_url);
  if (withUrl.length) {
    console.log('\n--- 取得サンプル（企業名｜URL｜電話｜担当者） ---');
    withUrl.slice(0, 8).forEach(h => console.log(
      `  ● ${h.company}｜${h.resolved_url || '-'}｜${h.phone || '-'}｜${h.name || '-'}${h.role ? '（' + h.role + '）' : ''}`));
  }

  printSummary(summarize(results));
  console.log(io.done() + '\n');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
