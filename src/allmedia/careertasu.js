'use strict';
/**
 * キャリタス就活 全掲載企業ハーベスト（マイナビ非依存の母集団・構造値つき）
 * =====================================================================
 * 実地調査（2026-10-15）で分かったこと:
 *   - 「企業を探す」の結果一覧 /condition-search/result/?p=N は SSR で、条件なし＝全掲載 27,853社。
 *     1面40社。カードに corpID・社名・本社県・業種・**フォロワー数**（その社をフォローした学生数）が載る。
 *   - 企業ページ /corp/{id}/ も SSR。従業員数・上場区分・本社所在地・最終更新日に加え、
 *     若者雇用促進法の「新卒採用者数と離職者数（過去3年間）」＝**採用実績**が構造値で載る。
 *   - 本選考詳細 /corp/{id}/employment/detail/{n}/ に「採用連絡先 TEL／Mail」「今年度採用予定数」。
 *   - robots: /corp/*\/entry/ と ?cv= は Disallow。取りに行かない（allowed() で毎回判定）。
 *
 * 段階（--phase）:
 *   list   … 一覧を全面取得 → data/allmedia/careertasu-list.json（面番号→カード配列）
 *   corp   … 一覧の全社の企業ページ → data/allmedia/careertasu-corp.json（corpID→構造値）
 *   detail … 採用実績6名以上 or 不明 かつ本選考詳細ありの社だけ詳細1面 → careertasu-detail.json
 *
 * 使い方: node src/allmedia/careertasu.js --phase list|corp|detail [--conc 4] [--delay 200] [--limit 0]
 */
const path = require('path');
const { fetchHtml, allowed, toText, oneLine, ent, Journal, runPool, log, getArg } = require('./http');
const { normalizeJpPhone } = require('../phone');

const ROOT = path.resolve(__dirname, '..', '..');
const DIR = path.join(ROOT, 'data', 'allmedia');
const BASE = 'https://job.career-tasu.jp';
const PHASE = getArg('phase', 'list');
const CONC = parseInt(getArg('conc', '4'), 10);
const DELAY = parseInt(getArg('delay', '200'), 10);
const LIMIT = parseInt(getArg('limit', '0'), 10);

const LIST_FILE = path.join(DIR, 'careertasu-list.json');
const CORP_FILE = path.join(DIR, 'careertasu-corp.json');
const DETAIL_FILE = path.join(DIR, 'careertasu-detail.json');

// ---- 一覧カード ----
function parseListPage(html) {
  const cards = [];
  const parts = html.split(/<li><a class="c_panelLink[^"]*" href="\/corp\//).slice(1);
  for (const p of parts) {
    const id = (p.match(/^(\d{8})\//) || [])[1];
    if (!id) continue;
    const name = oneLine(ent(((p.match(/<h2 class="c_panelCompanyInfoMain__ttl">([\s\S]*?)<\/h2>/) || [])[1] || '').replace(/<[^>]+>/g, '')));
    const txt = (p.match(/<p class="c_panelCompanyInfoMain__txt">([\s\S]*?)<\/p>/) || [])[1] || '';
    const pref = oneLine(ent(((txt.match(/<span>([\s\S]*?)<\/span>/) || [])[1] || '')));
    const industry = oneLine(ent(txt.replace(/<span>[\s\S]*?<\/span>/, '').replace(/<[^>]+>/g, '')));
    const fol = (p.match(/followerNum\d+">\s*([\d,]+)\s*</) || [])[1];
    cards.push({ id, 企業名: name, 本社県: pref, 業種: industry, フォロワー: fol ? parseInt(fol.replace(/,/g, ''), 10) : null });
  }
  const total = parseInt(((toText(html).match(/\d+\s*-\s*\d+\s*\/\s*([\d,]+)\s*社/) || [])[1] || '0').replace(/,/g, ''), 10);
  return { cards, total };
}

async function phaseList() {
  const j = new Journal(LIST_FILE);
  const first = await fetchHtml(BASE + '/condition-search/result/?p=1');
  const { total, cards } = parseListPage(first);
  if (!total) { log('一覧の総数が読めない（構造変更の可能性）'); process.exitCode = 1; return; }
  j.set('1', cards);
  const pages = Math.ceil(total / 40);
  log(`キャリタス 掲載 ${total}社 → ${pages}面`);
  const todo = [];
  for (let p = 2; p <= pages; p++) if (!j.has(String(p))) todo.push(p);
  await runPool(todo, async (p) => {
    const url = BASE + '/condition-search/result/?p=' + p;
    if (!(await allowed(url))) return;
    let html = await fetchHtml(url);
    if (!html) html = await fetchHtml(url); // 1回だけ取り直す
    const r = parseListPage(html);
    if (r.cards.length) j.set(String(p), r.cards);
  }, { conc: CONC, delay: DELAY, every: 25, onFlush: () => j.flush(), onProgress: (d, t) => log(`  一覧 ${d}/${t}面 ｜ 台帳 ${j.size}面`) });
  const ids = new Set(); for (const arr of j.values()) for (const c of arr) ids.add(c.id);
  log(`一覧完了: ${j.size}/${pages}面・ユニーク ${ids.size}社 → ${path.relative(ROOT, LIST_FILE)}`);
}

// ---- 企業ページ ----
function tableMap(html) {
  const m = {};
  for (const r of html.matchAll(/<th class="c_table__ttl">([\s\S]*?)<\/th>\s*<td class="c_table__txt">([\s\S]*?)<\/td>/g)) {
    const k = oneLine(ent(r[1].replace(/<[^>]+>/g, '')));
    const v = oneLine(ent(r[2].replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, ' ')));
    if (k && !(k in m)) m[k] = v;
  }
  return m;
}
// 「2026年度：採用人数16名」/「2025年度：男性436名、女性497名」→ [{年,人数}]（新しい順）
function parseHireBlock(text) {
  const out = []; const seen = new Set();
  const i = text.indexOf('新卒採用者数と離職者数');
  if (i >= 0) {
    const seg = text.slice(i, i + 400);
    for (const m of seg.matchAll(/(20\d{2})年度[：:]\s*採用人数\s*(\d{1,5})\s*名/g)) {
      if (!seen.has(+m[1])) { seen.add(+m[1]); out.push({ 年: +m[1], 人数: +m[2] }); }
    }
  }
  if (!out.length) {
    const k = text.indexOf('新卒採用者数の男女別人数');
    if (k >= 0) {
      const seg = text.slice(k, k + 400);
      for (const m of seg.matchAll(/(20\d{2})年度[：:]\s*男性\s*(\d{1,5})\s*名[、,，]\s*女性\s*(\d{1,5})\s*名/g)) {
        if (!seen.has(+m[1])) { seen.add(+m[1]); out.push({ 年: +m[1], 人数: +m[2] + +m[3] }); }
      }
    }
  }
  return out.sort((a, b) => b.年 - a.年);
}
function parseCorpPage(html, id) {
  const title = ent((html.match(/<title>([^<]*)<\/title>/) || [])[1] || '');
  const name = oneLine(title.replace(/の企業情報[\s\S]*$/, '').replace(/[|｜][\s\S]*$/, ''));
  const t = toText(html);
  const tb = tableMap(html);
  const head = (html.match(/<p class="c_panelCompanyInfoMain__txt">([\s\S]*?)<\/p>/) || [])[1] || '';
  const pref = oneLine(ent(((head.match(/<span>([\s\S]*?)<\/span>/) || [])[1] || '')));
  const industry = oneLine(ent(head.replace(/<span>[\s\S]*?<\/span>/, '').replace(/<[^>]+>/g, '')));
  const fol = (html.match(new RegExp('followerNum' + id + '">\\s*([\\d,]+)')) || [])[1];
  const dates = [...t.matchAll(/最終更新日[：:]\s*(20\d{2})年(\d{1,2})月(\d{1,2})日/g)].map((m) => `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`).sort();
  const uniq = (re) => new Set([...html.matchAll(re)].map((m) => m[1])).size;
  const detailIds = [...new Set([...html.matchAll(new RegExp('/corp/' + id + '/employment/detail/(\\d+)/', 'g'))].map((m) => m[1]))];
  const hire = parseHireBlock(t);
  return {
    id, 企業名: name, 本社県: pref, 業種: industry,
    従業員数: tb['従業員数'] || '', 上場区分: tb['上場区分'] || '', 本社所在地: tb['本社所在地1'] || tb['本社所在地'] || '',
    資本金: tb['資本金'] || '', 売上高: tb['売上高'] || '', 設立: tb['創業/設立'] || '',
    フォロワー: fol ? parseInt(fol.replace(/,/g, ''), 10) : null,
    採用実績: hire, 最終更新日: dates.length ? dates[dates.length - 1] : '',
    インターン件数: uniq(new RegExp('/corp/' + id + '/intern/entry/(IN\\d+)/', 'g')),
    説明会件数: uniq(new RegExp('/corp/' + id + '/seminar/entry/(SE\\d+)/', 'g')),
    本選考件数: uniq(new RegExp('/corp/' + id + '/employment/entry/(EN\\d+)/', 'g')),
    本選考詳細: detailIds,
    合説出展: /\/corp\/\d+\/event-information\//.test(html) || /出展情報/.test(t),
    url: BASE + '/corp/' + id + '/',
  };
}

function listIds() {
  const j = new Journal(LIST_FILE);
  const byId = new Map();
  for (const arr of j.values()) for (const c of arr) if (!byId.has(c.id)) byId.set(c.id, c);
  return byId;
}

async function phaseCorp() {
  const byId = listIds();
  if (!byId.size) { log('先に --phase list を流す'); process.exitCode = 1; return; }
  const j = new Journal(CORP_FILE);
  // 入口は2種類ある（2026-10-15 実測）:
  //   /corp/{id}/          … 通常掲載の企業トップ（従業員数・採用実績つき）。簡易掲載の社では404。
  //   /corp/{id}/default/  … 簡易掲載の社では基本情報（社名・業種・所在地・設立のみ）。
  //                          通常掲載の社では記事ページ（「◯◯のepisode.1」）になり、企業データが無い。
  // だから /corp/{id}/ を先に引き、404の時だけ /default/ に落ちる。
  // 取り直し対象: 未取得・失敗・ページ種別が無い（＝旧ロジックで /default/ の記事ページを掴んだ可能性がある）のに企業データが空の社。
  const stale = (r) => r && !r.ページ種別 && !r.従業員数 && !(r.採用実績 && r.採用実績.length);
  let todo = [...byId.keys()].filter((id) => !j.has(id) || (j.get(id).失敗 && j.get(id).失敗 !== 'robots') || stale(j.get(id)));
  if (LIMIT) todo = todo.slice(0, LIMIT);
  log(`企業ページ: 一覧 ${byId.size}社 → 未取得・取り直し ${todo.length}社（並列${CONC}）`);
  const st = { ok: 0, ng: 0, hire: 0, hire6: 0, basic: 0 };
  await runPool(todo, async (id) => {
    const full = BASE + '/corp/' + id + '/';
    if (!(await allowed(full))) { j.set(id, { id, 失敗: 'robots' }); return; }
    let html = await fetchHtml(full);
    let kind = '通常掲載';
    if (!html) {
      const basic = BASE + '/corp/' + id + '/default/';
      html = await fetchHtml(basic);
      kind = '簡易掲載';
    }
    if (!html) { j.set(id, { id, 失敗: '取得できず' }); st.ng++; return; }
    const r = parseCorpPage(html, id);
    r.ページ種別 = kind;
    if (kind === '簡易掲載') { r.url = BASE + '/corp/' + id + '/default/'; st.basic++; } else r.url = full;
    j.set(id, r); st.ok++;
    if (r.採用実績.length) { st.hire++; if (r.採用実績[0].人数 >= 6) st.hire6++; }
  }, { conc: CONC, delay: DELAY, every: 200, onFlush: () => j.flush(), onProgress: (d, t) => log(`  企業 ${d}/${t} 取得${st.ok}(うち簡易掲載${st.basic}) 失敗${st.ng} ｜実績判明${st.hire} 6名以上${st.hire6}`) });
  log(`企業ページ完了: 台帳 ${j.size}社 → ${path.relative(ROOT, CORP_FILE)}`);
}

// ---- 本選考詳細（電話・メール・採用予定数）----
function parseDetail(html) {
  const t = toText(html);
  // 「採用連絡先」はタブ名としても出る。TEL/Mail を伴う出現（＝本体の連絡先欄）を選ぶ。
  let seg = '';
  for (let i = t.indexOf('採用連絡先'); i >= 0; i = t.indexOf('採用連絡先', i + 1)) {
    const s = t.slice(i, i + 500);
    if (/(TEL|ＴＥＬ|Tel|電話|Mail|@)/.test(s.slice(0, 300))) { seg = s; break; }
  }
  // 「TEL：03-6628-4495（9:00～20:00）」の受付時間を番号に巻き込まないよう、桁と区切りの形で切る
  const telRaw = (seg.match(/(?:TEL|ＴＥＬ|Tel|電話)[：:\s]*([0-9０-９]{2,5}[-‐－―ー(（)） ]{0,2}[0-9０-９]{1,4}[-‐－―ー(（)） ]{0,2}[0-9０-９]{3,4})/) || [])[1] || '';
  const mail = (seg.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [])[0] || '';
  const k = t.indexOf('今年度採用予定数');
  const planSeg = k >= 0 ? oneLine(t.slice(k, k + 160)) : '';
  const plan = (planSeg.match(/(\d{1,4})\s*名/) || [])[1];
  const p = t.indexOf('昨年度採用実績');
  const prevSeg = p >= 0 ? oneLine(t.slice(p, p + 200)) : '';
  const prev = (prevSeg.match(/(\d{1,4})\s*名/) || [])[1];
  return {
    電話: normalizeJpPhone(telRaw) || '', メール: mail, 連絡先本文: oneLine(seg).slice(0, 200),
    採用予定数: plan ? +plan : null, 採用予定本文: planSeg.slice(0, 120), 昨年度実績: prev ? +prev : null,
    本文: oneLine(t).slice(0, 4000),
  };
}

async function phaseDetail() {
  const corp = new Journal(CORP_FILE);
  const j = new Journal(DETAIL_FILE);
  // 詳細面のIDは企業トップではなく本選考一覧 /corp/{id}/employment/ に載る（実測）。
  // --ids で対象を絞れる（統合側で「電話がまだ無い候補」だけ渡す用途）。
  const idsFile = getArg('ids', '');
  const only = idsFile ? new Set(require('fs').readFileSync(idsFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) : null;
  let todo = corp.values().filter((r) => r && !r.失敗 && r.本選考件数 > 0 && !j.has(r.id))
    .filter((r) => (only ? only.has(r.id) : (!r.採用実績.length || r.採用実績[0].人数 >= 6)));
  if (LIMIT) todo = todo.slice(0, LIMIT);
  log(`本選考詳細: 対象 ${todo.length}社（${only ? '--ids 指定' : '採用実績6名以上 or 不明'}・本選考あり）`);
  let tel = 0;
  await runPool(todo, async (r) => {
    const listUrl = BASE + '/corp/' + r.id + '/employment/';
    if (!(await allowed(listUrl))) { j.set(r.id, { 失敗: 'robots' }); return; }
    const lh = await fetchHtml(listUrl);
    const did = (lh.match(new RegExp('/corp/' + r.id + '/employment/detail/(\\d+)/')) || [])[1];
    if (!did) { j.set(r.id, { 失敗: '詳細面なし' }); return; }
    const url = BASE + '/corp/' + r.id + '/employment/detail/' + did + '/';
    if (!(await allowed(url))) { j.set(r.id, { 失敗: 'robots' }); return; }
    const html = await fetchHtml(url);
    if (!html) { j.set(r.id, { 失敗: '取得できず' }); return; }
    const d = parseDetail(html); d.url = url;
    if (d.電話) tel++;
    j.set(r.id, d);
  }, { conc: CONC, delay: DELAY, every: 200, onFlush: () => j.flush(), onProgress: (d, t) => log(`  詳細 ${d}/${t} 電話判明${tel}`) });
  log(`本選考詳細完了: 台帳 ${j.size}社 → ${path.relative(ROOT, DETAIL_FILE)}`);
}

async function main() {
  if (PHASE === 'list') return phaseList();
  if (PHASE === 'corp') return phaseCorp();
  if (PHASE === 'detail') return phaseDetail();
  log('--phase は list|corp|detail'); process.exitCode = 1;
}
if (require.main === module) main().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });

module.exports = { parseListPage, parseCorpPage, parseHireBlock, parseDetail, LIST_FILE, CORP_FILE, DETAIL_FILE };
