'use strict';
/**
 * 媒体カタログ駆動の採用担当者名ハーベスター
 * =====================================================================
 * data/media-catalog.json（約110媒体）を起点に、採用担当者「個人名」を収穫する。
 * 既存資産（polite.js / probe-recruit-page / harvest-wantedly / jp-names）の上に薄く重ねる。
 *
 * モード:
 *   --probe
 *      全媒体トップを robots遵守で軽量取得し、reachability / robots / sitemap有無 /
 *      「個人名が表に出るか(nameLikely)」/ 外部企業リンク数 を実測 → カタログを較正。
 *      出力: data/media-probe-report.csv（媒体ごとの収穫見込みを“言い切る”ための実データ）
 *
 *   --recruit-pages [--list <csv>] [--limit N] [--empty-only]
 *      公式URLを持つ企業（既定 leads-mochica-target.csv の713社＝既にMOCHICA採点済）に対し
 *      probe-recruit-page を回し、各社“自社採用ページ”から採用担当者名を抽出。
 *      ＝媒体を介さず、既にMOCHICAターゲットと分かっている企業の REACH を直接底上げする最短経路。
 *      出力: data/recruiter-probe-harvest.csv（企業名,公式URL,採用担当者名,役職,部署,確度,取得元,根拠URL,根拠）
 *
 * robots/レート制限/キャッシュは polite.js が担保。中断耐性: CSVはアトミック書込。
 */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { politeGet, allowedByRobots } = require('./polite');
const { fetchText } = require('./fetch');
const { pageCorpus, extractFromRecruitText, probeRecruitPage } = require('./probe-recruit-page');
const { probeRecruitDeep } = require('./probe-recruit-deep');
const { registrableDomain } = require('./fetch');
const { readCsv, toCsv, normCompanyName } = require('./csv');
const cfg = require('./config');

const ROOT = path.resolve(__dirname, '..');
const CATALOG = path.join(ROOT, 'data', 'media-catalog.json');
const getArg = (n, d) => { const i = process.argv.indexOf('--' + n); if (i < 0) return d; const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

// ホストが異なる媒体間は並列可（polite.jsが同一ホストは直列化）。簡易プール。
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx).catch((e) => ({ error: String(e && e.message || e) })); }
  });
  await Promise.all(workers);
  return out;
}

function loadCatalog() { return JSON.parse(fs.readFileSync(CATALOG, 'utf8')); }
function atomicWrite(p, text) { const tmp = p + '.tmp'; fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(tmp, text); fs.renameSync(tmp, p); }

// 媒体ドメイン・既知の媒体/SNS/DBドメインでない外部リンク＝企業サイト候補
function isCompanyLink(href, mediaHost) {
  let u; try { u = new URL(href); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const h = u.host.replace(/^www\./, '');
  if (mediaHost && (h === mediaHost || h.endsWith('.' + mediaHost) || mediaHost.endsWith('.' + h))) return false;
  if (cfg.EXCLUDE_DOMAINS.some((d) => h === d || h.endsWith('.' + d))) return false;
  return true;
}

// ── モード1: 全媒体プローブ（収穫見込みの実測較正）─────────────────
async function probeMedia(m) {
  const res = { name: m.name, cat: m.cat, role: m.role, strategy: m.strategy, url: m.url,
    robots: '', reachable: '', http: '', sitemap: '', nameLikely: '', companyLinks: '', loginWall: '', note: '' };
  if (!m.url) { res.note = 'URL未確定(要確認)'; return res; }
  let host = ''; try { host = new URL(m.url).host.replace(/^www\./, ''); } catch {}

  // robots
  try { res.robots = (await allowedByRobots(m.url)) ? 'allow' : 'disallow'; } catch { res.robots = '?'; }

  // sitemap（robots.txtのSitemap宣言を実測）
  let origin = ''; try { origin = new URL(m.url).origin; } catch {}
  if (origin) {
    try { const rt = await fetchText(origin + '/robots.txt'); res.sitemap = /(^|\n)\s*sitemap\s*:/i.test(rt) ? 'yes' : 'no'; }
    catch { res.sitemap = '?'; }
  }

  // トップ取得（静的）
  const r = await politeGet(m.url, { render: 'static' });
  if (!r || r.blocked) { res.reachable = 'no'; res.note = (r && r.reason) || 'blocked'; return res; }
  if (r.error || !r.html) { res.reachable = 'no'; res.note = r && r.error ? r.error.slice(0, 40) : 'no-html'; return res; }
  res.reachable = 'yes';

  const $ = cheerio.load(r.html);
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  res.loginWall = /会員登録|ログインして|新規登録して|ログインが必要|アカウントを作成/.test(bodyText) && bodyText.length < 1500 ? 'likely' : '';
  // 個人名が表に出るか（採用文脈の人名を1つでも抽出できるか）
  const corpus = pageCorpus(r.html);
  const hit = extractFromRecruitText(corpus);
  res.nameLikely = hit && hit.name ? hit.name : '';
  // 外部の企業サイト候補リンク数（recruit-page-link戦略の見込み）
  const links = new Set();
  $('a[href]').each((_, a) => { const href = $(a).attr('href'); if (!href) return; let abs; try { abs = new URL(href, r.finalUrl || m.url).href; } catch { return; } if (isCompanyLink(abs, host)) links.add(abs.replace(/[#?].*$/, '')); });
  res.companyLinks = links.size;
  return res;
}

async function runProbe() {
  const cat = loadCatalog();
  const targets = cat.media;
  log(`プローブ開始: ${targets.length}媒体（robots/到達/サイトマップ/個人名露出/企業リンク）`);
  const limit = parseInt(getArg('concurrency', '6'), 10);
  let done = 0;
  const results = await pool(targets, limit, async (m) => {
    const r = await probeMedia(m);
    done++; if (done % 10 === 0) log(`  ${done}/${targets.length}`);
    return r;
  });
  // カタログに probe を書き戻し
  const byName = new Map(results.map((r) => [r.name, r]));
  for (const m of cat.media) { const r = byName.get(m.name); if (r) m.probe = { robots: r.robots, reachable: r.reachable, sitemap: r.sitemap, nameLikely: r.nameLikely ? 1 : 0, companyLinks: r.companyLinks, loginWall: r.loginWall, note: r.note }; }
  atomicWrite(CATALOG, JSON.stringify(cat, null, 2));
  const headers = ['name', 'cat', 'role', 'strategy', 'url', 'robots', 'reachable', 'http', 'sitemap', 'nameLikely', 'companyLinks', 'loginWall', 'note'];
  const outP = path.join(ROOT, 'data', 'media-probe-report.csv');
  atomicWrite(outP, toCsv(headers, results));

  // サマリ
  const c = (pred) => results.filter(pred).length;
  const L = '──────────────────────────────────────────────';
  console.log('\n' + L);
  console.log('  媒体プローブ実測サマリ');
  console.log(L);
  console.log(`  対象媒体            : ${results.length}`);
  console.log(`  URL未確定           : ${c((r) => !r.url)}`);
  console.log(`  到達OK              : ${c((r) => r.reachable === 'yes')}`);
  console.log(`  robots許可          : ${c((r) => r.robots === 'allow')}`);
  console.log(`  robots禁止          : ${c((r) => r.robots === 'disallow')}`);
  console.log(`  ログイン壁の疑い    : ${c((r) => r.loginWall === 'likely')}`);
  console.log(`  トップで個人名露出  : ${c((r) => r.nameLikely)}（媒体トップに採用担当者名が出る稀ケース）`);
  console.log(`  企業リンク10+を保持 : ${c((r) => (+r.companyLinks || 0) >= 10)}（recruit-page-link経路の見込み）`);
  console.log(L);
  console.log(`  出力: ${outP}`);
  console.log(`        ${CATALOG}（probe較正済み）\n`);
}

// ── モード2: 自社採用ページから氏名収穫（既にMOCHICA採点済の企業を直接底上げ）───
async function runRecruitPages() {
  const listPath = path.resolve(ROOT, getArg('list', 'leads-mochica-target.csv'));
  const limit = parseInt(getArg('limit', '120'), 10);
  const emptyOnly = !!getArg('empty-only', false);
  const deep = !!getArg('deep', false);
  const maxPages = parseInt(getArg('max-pages', '8'), 10);
  const prober = deep ? (u, o) => probeRecruitDeep(u, { ...o, maxPages }) : (u, o) => probeRecruitPage(u, { ...o, maxPages: 3 });
  const outP = path.join(ROOT, 'data', deep ? 'recruiter-deep-harvest.csv' : 'recruiter-probe-harvest.csv');
  const HEAD = ['企業名', '公式URL', '採用担当者名', '役職', '部署', '確度', '取得元', '根拠URL', '根拠'];
  log(`プローバ: ${deep ? 'deep（JSレンダ＋複数ページ＋構造/連絡先抽出, max ' + maxPages + 'p）' : 'shallow（静的3p）'}`);

  if (!fs.existsSync(listPath)) { console.error('リストが見つかりません: ' + listPath); process.exit(1); }
  const recs = readCsv(fs.readFileSync(listPath, 'utf8')).records;

  // 再開: 既存出力を読み、処理済み社をスキップ
  const out = [];
  const doneCo = new Set();
  if (fs.existsSync(outP)) { for (const r of readCsv(fs.readFileSync(outP, 'utf8')).records) { out.push(r); doneCo.add(normCompanyName(r['企業名'] || '')); } }

  // 公式URLあり・未処理・（empty-onlyなら担当者名が空の社）を対象に。アポ期待度の高い順に処理（最も使える社から氏名を埋める）。
  let targets = recs.filter((r) => String(r['公式URL'] || '').trim() && !doneCo.has(normCompanyName(r['企業名'] || '')));
  if (emptyOnly) targets = targets.filter((r) => !String(r['採用担当者名'] || '').trim());
  targets.sort((a, b) => (parseFloat(b['アポ期待度']) || 0) - (parseFloat(a['アポ期待度']) || 0));
  targets = targets.slice(0, limit);
  log(`採用ページ収穫: 対象 ${targets.length}社（公式URLあり・未処理${emptyOnly ? '・担当者名空のみ' : ''}）`);

  let got = 0, miss = 0, n = 0;
  const flush = () => atomicWrite(outP, toCsv(HEAD, out));
  for (const rec of targets) {
    n++;
    let hit = null;
    try { hit = await prober(rec['公式URL'], { companyName: rec['企業名'] }); }
    catch (e) { hit = null; }
    doneCo.add(normCompanyName(rec['企業名'] || ''));
    if (hit && hit.name) {
      out.push({ 企業名: rec['企業名'], 公式URL: rec['公式URL'], 採用担当者名: hit.name, 役職: hit.role || '', 部署: hit.department || '', 確度: hit.confidence || '', 取得元: hit.source || '自社採用ページ', 根拠URL: hit.sourceUrl || '', 根拠: hit.evidence || '' });
      got++;
    } else miss++;
    if (n % 10 === 0) { flush(); log(`  ${n}/${targets.length} | 取得 ${got} 取りこぼし ${miss}  最新: ${rec['企業名']} ${hit && hit.name ? '→' + hit.name : '—'}`); }
  }
  flush();
  const L = '──────────────────────────────────────────────';
  console.log('\n' + L);
  console.log('  自社採用ページ 氏名収穫サマリ');
  console.log(L);
  console.log(`  対象              : ${targets.length}社`);
  console.log(`  採用担当者名 取得 : ${got}社（yield ${targets.length ? Math.round((got / targets.length) * 100) : 0}%）`);
  console.log(`  取りこぼし        : ${miss}社`);
  console.log(`  出力: ${outP}（累計 ${out.length}社）\n`);
}

// ── モード3: マイナビ企業詳細の『問合せ先』から氏名＋新卒掲載＋電話を収穫 ───────────────
// ユーザー指摘の「採用ページ下部(=is.htmlの問合せ先ブロック)に担当者名」パターン。MynaviScraperを使用。
// 氏名が非公開でも マイナビ掲載○=新卒採用の最強実取得シグナル＋電話＋卒年 を持ち帰り intent を底上げ。
async function runMynavi() {
  const { MynaviScraper } = require('./scrape-mynavi');
  const listPath = path.resolve(ROOT, getArg('list', 'leads-mochica-target.csv'));
  const limit = parseInt(getArg('limit', '150'), 10);
  const outP = path.join(ROOT, 'data', 'recruiter-mynavi.csv');
  const HEAD = ['企業名', '公式URL', '採用担当者名', '役職', '部署', '確度', '取得元', '根拠URL', '根拠', 'マイナビ掲載', '電話番号', 'メール', '卒年', '募集職種数', '採用予定人数'];
  if (!fs.existsSync(listPath)) { console.error('リストが見つかりません: ' + listPath); process.exit(1); }
  const recs = readCsv(fs.readFileSync(listPath, 'utf8')).records;
  const out = []; const doneCo = new Set();
  if (fs.existsSync(outP)) for (const r of readCsv(fs.readFileSync(outP, 'utf8')).records) { out.push(r); doneCo.add(normCompanyName(r['企業名'] || '')); }
  let targets = recs.filter((r) => !doneCo.has(normCompanyName(r['企業名'] || '')));
  targets.sort((a, b) => (parseFloat(b['アポ期待度']) || 0) - (parseFloat(a['アポ期待度']) || 0));
  targets = targets.slice(0, limit);
  log(`マイナビ収穫: 対象 ${targets.length}社（problem? Playwright起動）`);
  const sc = new MynaviScraper(); await sc.launch();
  let name = 0, listed = 0, n = 0;
  const flush = () => atomicWrite(outP, toCsv(HEAD, out));
  try {
    for (const rec of targets) {
      n++;
      let r = null; try { r = await sc.scrapeCompany(rec['企業名']); } catch (e) { r = null; }
      doneCo.add(normCompanyName(rec['企業名'] || ''));
      if (r && (r.マイナビ掲載 || r.採用担当者名)) {
        if (r.採用担当者名) name++; if (r.マイナビ掲載) listed++;
        out.push({ 企業名: rec['企業名'], 公式URL: rec['公式URL'] || '', 採用担当者名: r.採用担当者名 || '', 役職: r.役職 || '', 部署: r.部署 || '', 確度: r.担当者確度 || (r.採用担当者名 ? 0.7 : ''), 取得元: 'マイナビ', 根拠URL: r.採用ページURL || '', 根拠: r.根拠 || '', マイナビ掲載: r.マイナビ掲載 || '', 電話番号: r.電話番号 || '', メール: r.メール || '', 卒年: r.卒年 || '', 募集職種数: r.募集職種数 || '', 採用予定人数: r.採用予定人数 || '' });
      }
      if (n % 10 === 0) { flush(); log(`  ${n}/${targets.length} | 氏名 ${name} 掲載 ${listed}  最新: ${rec['企業名']} ${r && r.採用担当者名 ? '→' + r.採用担当者名 : (r && r.マイナビ掲載 ? '(掲載のみ)' : '×')}`); }
    }
  } finally { await sc.close(); }
  flush();
  const L = '──────────────────────────────────────────────';
  console.log('\n' + L);
  console.log('  マイナビ収穫サマリ');
  console.log(L);
  console.log(`  対象              : ${targets.length}社`);
  console.log(`  採用担当者名 取得 : ${name}社（yield ${targets.length ? Math.round((name / targets.length) * 100) : 0}%）`);
  console.log(`  マイナビ掲載確認  : ${listed}社（新卒採用の実取得シグナル＝intent最強ティア）`);
  console.log(`  出力: ${outP}（累計 ${out.length}社）\n`);
}

// ── モード4: 各媒体から「企業母集団」を抽出 → 適応クローラのプールに供給 ───────────
// probe実測で媒体ページに個人名は出ない(1/106)。名前は媒体がリンクする"企業サイト側"にある。
// よって媒体ごとに違う"企業一覧の構造"を辿り、外部の企業公式URLを収集して母集団を拡張する。
const LISTING_HINT = /(company|companies|corp|kigyo|kaisha|会社|企業|一覧|list|search|result|area|pref|地域|業種|category|page=|recruit|job|member|参加|掲載)/i;
const CTA_WORDS = /^(詳細|もっと|一覧|エントリー|応募|もっと見る|続きを読む|see ?more|view|detail|map|地図|アクセス|もっとみる|お気に入り|ブックマーク|シェア|次へ|前へ|top|ホーム|ログイン|登録|会員)/i;
// 企業名らしさ（法人格を含む）。媒体のグループ送客リンクと掲載企業を分ける精度ゲート。
const COMPANY_NAME_RE = /(株式会社|有限会社|合同会社|合資会社|合名会社|（株）|\(株\)|㈱|㈲|医療法人|社会福祉法人|学校法人|協同組合|一般社団法人|一般財団法人|Inc\.?|Co\.,?\s?Ltd|Corp(?:oration)?\b|Ltd\.?)/;

async function crawlMediaForCompanies(media, maxPages) {
  const found = new Map(); // regDomain -> {name,url,media}
  let host = ''; try { host = new URL(media.url).host.replace(/^www\./, ''); } catch { return found; }
  const visited = new Set(); const queue = [media.url];
  let fetched = 0;
  while (queue.length && fetched < maxPages) {
    const u = queue.shift(); if (visited.has(u)) continue; visited.add(u);
    const r = await politeGet(u, { render: 'static' }); fetched++;
    if (!r || r.blocked || r.error || !r.html) continue;
    const $ = cheerio.load(r.html);
    $('a[href]').each((_, a) => {
      const href = $(a).attr('href'); if (!href) return;
      let abs; try { abs = new URL(href, r.finalUrl || u).href; } catch { return; }
      const clean = abs.replace(/[#?].*$/, '');
      if (isCompanyLink(abs, host)) {
        const reg = registrableDomain(new URL(abs).host);
        const txt = ($(a).text() || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        // 媒体トップのフッタ/グループ送客リンク（"結婚式ならゼクシィ"等）を排除し、
        // アンカーが企業名＝法人格を含むものだけ採用（＝掲載企業の一覧リンク）。精度優先。
        if (reg && !found.has(reg) && COMPANY_NAME_RE.test(txt) && !CTA_WORDS.test(txt)) {
          found.set(reg, { name: txt, url: clean.replace(/\/$/, '') + '/', media: media.name });
        }
      } else {
        // 媒体内の一覧/検索/カテゴリ/ページネーションを浅く辿って企業リンクを増やす
        let lu; try { lu = new URL(abs); } catch { return; }
        if (lu.host === new URL(media.url).host && LISTING_HINT.test(lu.pathname + lu.search) && !visited.has(clean) && queue.length < maxPages * 3) queue.push(clean);
      }
    });
  }
  return found;
}

async function runMediaCompanies() {
  const cat = loadCatalog();
  const maxPages = parseInt(getArg('media-max-pages', '15'), 10);
  const concurrency = parseInt(getArg('concurrency', '5'), 10);
  // 到達可能・ログイン壁でない媒体を対象（probe較正値を利用）
  const limitN = parseInt(getArg('limit', '999'), 10);
  const targets = cat.media.filter((m) => m.url && (!m.probe || (m.probe.reachable === 'yes' && m.probe.loginWall !== 'likely')) && m.strategy !== 'blocked-or-login').slice(0, limitN);
  log(`媒体→企業母集団 抽出: 対象 ${targets.length}媒体（各最大${maxPages}ページ巡回）`);
  const outP = path.join(ROOT, 'data', 'media-company-pool.csv');
  const HEAD = ['企業名', '公式URL', '取得元媒体'];
  // 既存プール（再開・累積）
  const pool = new Map();
  if (fs.existsSync(outP)) for (const r of readCsv(fs.readFileSync(outP, 'utf8')).records) { const reg = (() => { try { return registrableDomain(new URL(r['公式URL']).host); } catch { return r['公式URL']; } })(); if (reg) pool.set(reg, { name: r['企業名'] || '', url: r['公式URL'], media: r['取得元媒体'] || '' }); }

  let done = 0;
  const results = await pool2(targets, concurrency, async (m) => {
    const f = await crawlMediaForCompanies(m, maxPages).catch(() => new Map());
    done++; log(`  [${done}/${targets.length}] ${m.name}: 企業${f.size}件`);
    return f;
  });
  for (const f of results) if (f && f.forEach) f.forEach((v, k) => { if (!pool.has(k)) pool.set(k, v); });

  const rows = [...pool.values()].map((v) => ({ '企業名': v.name, '公式URL': v.url, '取得元媒体': v.media }));
  atomicWrite(outP, toCsv(HEAD, rows));
  const named = rows.filter((r) => r['企業名']).length;
  const L = '──────────────────────────────────────────────';
  console.log('\n' + L);
  console.log('  媒体→企業母集団 抽出サマリ');
  console.log(L);
  console.log(`  対象媒体          : ${targets.length}`);
  console.log(`  収集した企業(uniq): ${rows.length}社（社名つき ${named}）`);
  console.log(`  出力: ${outP}`);
  console.log('  → harvest-adaptive がこのプールも母集団に取り込み、自己学習クローラで氏名探索します。\n');
}
// 別名（runProbeのpoolと衝突しないよう同実装を再利用）
const pool2 = pool;

async function main() {
  if (getArg('probe', false)) return runProbe();
  if (getArg('recruit-pages', false)) return runRecruitPages();
  if (getArg('mynavi', false)) return runMynavi();
  if (getArg('media-companies', false)) return runMediaCompanies();
  console.log('使い方:');
  console.log('  node src/harvest-catalog.js --probe                              # 全媒体を分類プローブ');
  console.log('  node src/harvest-catalog.js --recruit-pages [--deep] [--list x.csv] [--limit 120] [--empty-only]');
  console.log('  node src/harvest-catalog.js --mynavi [--list x.csv] [--limit 150]   # マイナビ問合せ先から氏名+新卒掲載+電話');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
