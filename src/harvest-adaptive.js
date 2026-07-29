'use strict';
/**
 * 適応型・全ページ探索ハーベスター（自己強化）
 * =====================================================================
 * ユーザー要件:
 *   ・各企業サイトの「全てのWEBページ」を、採用担当者名が取れるまで探索する
 *   ・一度取得できたら、その“手法（どのページ・どの抽出箇所で取れたか）”を真似て次に活かす
 *   ・採用担当者名 取得リスト 1000件 を目指す
 *
 * 仕組み:
 *   1. 母集団URL: leads-mochica-target.csv ＋ data/*-records.json から公式URLを名寄せ重複排除して集約。
 *   2. 各社をBFSで深く巡回（トップ→採用→配下…内部リンクを氏名が眠るヒントで辿る, 最大 --max-pages）。
 *      抽出は probe-recruit-deep の extractFromPage（構造表→下部連絡先ブロック→本文）を再利用。
 *   3. 自己強化: 「成功したURLのパス署名(例 recruit/message, company/contact)」の的中率を学習(state)し、
 *      次サイト以降は“過去に当たったパス署名”を優先して探索する＝成功手法を真似る。
 *   4. 中断/再開: 処理済み企業 journal＋出力CSVアトミック書込＋学習state を永続化。--target 到達で終了。
 *
 *   node src/harvest-adaptive.js [--target 1000] [--max-pages 30] [--limit 99999]
 */
const fs = require('fs');
const path = require('path');
const { politeGet } = require('./polite');
const { findRecruitLinks } = require('./recruit-page');
const { extractFromPage, deepLinks, GUESS_PATHS } = require('./probe-recruit-deep');
const { looksJsRendered } = require('./fetch');
const { readCsv, toCsv, normCompanyName, normCorpNumber } = require('./csv');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const getArg = (n, d) => { const i = process.argv.indexOf('--' + n); if (i < 0) return d; const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; };
const OUT = path.join(DATA, 'recruiter-adaptive.csv');
const JOURNAL = path.join(DATA, 'harvest-adaptive.journal.json');
const STATE = path.join(DATA, 'harvest-adaptive.state.json');
const TARGET = parseInt(getArg('target', '1000'), 10);
const MAX_PAGES = parseInt(getArg('max-pages', '30'), 10);

// クラッシュ耐性: undici(Node20)のHTTP/1パーサが TLSソケットend時に投げる
// `assert(!this.paused)` は await の try/catch では捕まらない非同期throw（プロセスごと落ちる既知バグ）。
// 進捗はjournal/CSV/stateに永続化済みなので、ここで最後にflushしてからexit(1)し、外側ランナーで再開する。
let _flush = null;
function bail(tag, e) {
  console.error(`[${tag}] ${e && (e.stack || e.message) || e}`.slice(0, 300));
  try { if (_flush) _flush(); } catch (_) {}
  process.exit(1);
}
process.on('uncaughtException', (e) => bail('uncaughtException', e));
process.on('unhandledRejection', (e) => bail('unhandledRejection', e));
const LIMIT = parseInt(getArg('limit', '99999'), 10);
const HEAD = ['企業名', '公式URL', '採用担当者名', '役職', '部署', '確度', '取得元', '根拠URL', '根拠', '手法'];
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const atomic = (p, t) => { const tmp = p + '.tmp'; fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(tmp, t); fs.renameSync(tmp, p); };
const loadJson = (p) => { if (!fs.existsSync(p)) return null; try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

// ── 母集団URLの集約（社名/法人番号で重複排除）──
function buildPool() {
  const seen = new Set(); const pool = [];
  const add = (name, url, num) => {
    const k = normCorpNumber(num) || normCompanyName(name || '');
    const u = String(url || '').trim();
    if (!k || seen.has(k) || !/^https?:\/\//i.test(u)) return;
    seen.add(k); pool.push({ name, url: u, key: k });
  };
  for (const r of (fs.existsSync(path.join(ROOT, 'leads-mochica-target.csv')) ? readCsv(fs.readFileSync(path.join(ROOT, 'leads-mochica-target.csv'), 'utf8')).records : [])) add(r['企業名'], r['公式URL'], r['法人番号']);
  for (const f of ['merged-records.json', 'fresh-records.json', 'records-1000.json']) {
    const j = loadJson(path.join(DATA, f)); const recs = Array.isArray(j) ? j : (j && j.records) || [];
    for (const r of recs) add(r['企業名'], r['公式URL'], r['法人番号']);
  }
  // 媒体→企業母集団（harvest-catalog --media-companies の出力）も取り込む
  const mp = path.join(DATA, 'media-company-pool.csv');
  if (fs.existsSync(mp)) for (const r of readCsv(fs.readFileSync(mp, 'utf8')).records) add(r['企業名'] || r['公式URL'], r['公式URL'], '');
  return pool;
}

// ── 学習state（パス署名→的中率）──
function pathSig(u) { try { const p = new URL(u).pathname.toLowerCase().split('/').filter(Boolean); return p.slice(0, 2).join('/') || '(root)'; } catch { return '(root)'; } }
function sigScore(state, sig) {
  const s = state.pathStats[sig] || { hit: 0, try: 0 };
  const learned = (s.hit + 0.3) / (s.try + 1);                 // ラプラス平滑（実績の的中率）
  const prior = /message|entry|contact|inquiry|saiyo|recruit|staff|member|youkou|要項|採用|問|応募/.test(sig) ? 1 : 0;
  return learned * 0.8 + prior * 0.2;                          // 学習を主、ヒントを従でブレンド
}

// ── 1社を全ページ探索（採用担当者名が取れるまで）──
async function crawlCompany(state, company) {
  let start = company.url; if (!/^https?:\/\//i.test(start)) start = 'https://' + start;
  const visited = new Set(); const queue = []; const jsPages = [];
  const enqueue = (arr) => { for (const u of arr) { if (!u) continue; const c = u.replace(/#.*$/, ''); if (!visited.has(c) && !queue.includes(c)) queue.push(c); } };

  async function getPage(u) {
    const r = await politeGet(u, { render: 'static' });
    if (!r || r.blocked || r.error || !r.html) return null;
    if (looksJsRendered(r.html) && jsPages.length < 2) jsPages.push(u);
    return { html: r.html, baseUrl: r.finalUrl || u };
  }
  function tryExtract(html, u) {
    const sig = pathSig(u);
    const st = state.pathStats[sig] || (state.pathStats[sig] = { hit: 0, try: 0 });
    st.try++;
    const hit = extractFromPage(html);
    if (hit && hit.name) { st.hit++; state.extractorStats[hit.where] = (state.extractorStats[hit.where] || 0) + 1; return { ...hit, sourceUrl: u, sig }; }
    return null;
  }

  const top = await getPage(start);
  if (!top) return null;
  let origin = ''; try { origin = new URL(top.baseUrl).origin; } catch {}
  let hit = tryExtract(top.html, top.baseUrl);
  if (hit) return hit;
  visited.add(start); visited.add(top.baseUrl);
  enqueue(findRecruitLinks(top.baseUrl, top.html).filter((l) => !l.external).map((l) => l.url));
  enqueue(deepLinks(top.baseUrl, top.html));
  if (origin) enqueue(GUESS_PATHS.map((p) => origin + p));

  let fetched = 1;
  while (queue.length && fetched < MAX_PAGES) {
    // 自己強化：成功実績のあるパス署名を優先（成功手法を真似る）
    queue.sort((a, b) => sigScore(state, pathSig(b)) - sigScore(state, pathSig(a)));
    const u = queue.shift(); if (visited.has(u)) continue; visited.add(u);
    const pg = await getPage(u); fetched++;
    if (!pg) continue;
    hit = tryExtract(pg.html, u);
    if (hit) return hit;
    enqueue(deepLinks(pg.baseUrl, pg.html)); // 全ページ探索：配下リンクを継続展開
  }
  // 描画フォールバック（静的で空だったページを1つだけPlaywright描画）
  for (const ju of jsPages.slice(0, 1)) {
    const r = await politeGet(ju, { render: 'auto' });
    if (r && r.html && !r.blocked && !r.error) { hit = tryExtract(r.html, ju); if (hit) return hit; }
  }
  return null;
}

async function main() {
  const pool = buildPool();
  const processed = new Set((loadJson(JOURNAL) || []).map(String));
  const state = loadJson(STATE) || { pathStats: {}, extractorStats: {} };
  const out = [];
  if (fs.existsSync(OUT)) for (const r of readCsv(fs.readFileSync(OUT, 'utf8')).records) out.push(r);
  const named = () => out.filter((r) => r['採用担当者名']).length;

  // 同じ“企業サイト探索”系の既取得名のみ合算（Wantedlyは別手法・別母集団なので除外＝この探索を走らせる）。
  const otherNamed = (() => { const s = new Set(); for (const f of ['recruiter-deep-harvest.csv', 'recruiter-probe-harvest.csv', 'recruiter-gemini.csv', 'recruiter-fresh.csv', 'recruiter-recruitpage-full.csv']) { const p = path.join(DATA, f); if (!fs.existsSync(p)) continue; for (const r of readCsv(fs.readFileSync(p, 'utf8')).records) if (r['採用担当者名']) s.add(normCompanyName(r['企業名'] || '')); } return s; })();

  const todo = pool.filter((c) => !processed.has(c.key)).slice(0, LIMIT);
  log(`母集団 ${pool.length}社（未処理 ${todo.length}）｜既取得(本file) ${named()}｜企業サイト系既取得 ${otherNamed.size}｜目標 ${TARGET}（企業サイト系合算・Wantedly除く）`);

  const flush = () => { atomic(OUT, toCsv(HEAD, out)); atomic(JOURNAL, JSON.stringify([...processed])); atomic(STATE, JSON.stringify(state)); };
  _flush = flush; // クラッシュ時ハンドラからも保存できるよう公開
  let n = 0, got = 0;
  for (const c of todo) {
    if (named() + otherNamed.size >= TARGET) { log(`目標 ${TARGET}（合算）到達。終了。`); break; }
    n++;
    // 先にjournal登録（クラッシュ時もbail()のflushで永続化＝同じ問題サイトの無限再試行を防ぐ）。
    processed.add(c.key);
    let hit = null;
    try { hit = await crawlCompany(state, c); } catch (e) { hit = null; }
    if (hit && hit.name) {
      out.push({ 企業名: c.name, 公式URL: c.url, 採用担当者名: hit.name, 役職: hit.role || '', 部署: hit.department || '', 確度: hit.confidence || 0.7, 取得元: hit.source || '自社採用ページ', 根拠URL: hit.sourceUrl || '', 根拠: (hit.evidence || '').slice(0, 80), 手法: `${hit.where}@${hit.sig}` });
      got++;
    }
    if (n % 10 === 0) {
      flush();
      const top = Object.entries(state.pathStats).filter(([, s]) => s.hit > 0).sort((a, b) => b[1].hit - a[1].hit).slice(0, 4).map(([k, s]) => `${k}:${s.hit}/${s.try}`).join(' ');
      log(`${n}/${todo.length} | 本file取得 ${named()} 合算 ${named() + otherNamed.size}/${TARGET} | 学習上位[ ${top} ] 最新:${c.name}${hit && hit.name ? '→' + hit.name + '(' + hit.where + ')' : '×'}`);
    }
  }
  flush();
  const L = '──────────────────────────────────────────────';
  console.log('\n' + L);
  console.log('  適応型 全ページ探索ハーベスター サマリ');
  console.log(L);
  console.log(`  処理              : ${n}社`);
  console.log(`  本file 取得       : ${named()}社（今回 +${got}）`);
  console.log(`  合算 取得(全ソース): ${named() + otherNamed.size}社 / 目標 ${TARGET}`);
  console.log('  学習した有効手法（パス署名 hit/try, 上位）:');
  Object.entries(state.pathStats).filter(([, s]) => s.hit > 0).sort((a, b) => b[1].hit - a[1].hit).slice(0, 10).forEach(([k, s]) => console.log(`    ${k.padEnd(22)} ${s.hit}/${s.try}`));
  console.log('  有効だった抽出箇所:', JSON.stringify(state.extractorStats));
  console.log(`  出力: ${OUT}\n`);
}

// 正常完了=exit0（ランナーが停止）/ クラッシュ=exit1（ランナーが再開）。
main().then(() => { try { if (_flush) _flush(); } catch (_) {} process.exit(0); }).catch((e) => bail('FATAL', e));
