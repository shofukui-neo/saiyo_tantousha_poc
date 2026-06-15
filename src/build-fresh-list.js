'use strict';
// 「上場企業を含まない・完全新規」の1000件ビルダー（gBizINFO API のみ）。
//  build-gbiz.js を土台に、2系統の除外フィルタを候補/詳細の両段階で適用する:
//   ① 上場企業の除外 … EDINETコードリスト（金融庁・上場区分=上場）の法人番号＋正規化社名で完全一致除外
//   ② 完全新規の担保 … 既存生成リスト（leads-*.csv）の法人番号を除外
//  代表者名が取れた非上場・新規企業だけを採用し、目標(1000)に到達するまで詰める。
//
//   1) data/listed-bango.json / data/listed-names.json … EDINETから生成（上場除外）
//   2) data/existing-bango.json                         … 既存CSVから生成（重複除外）
//
//   node src/build-fresh-list.js --target 1000 --concurrency 8 --out leads-fresh-1000.csv
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { normalizeIcp } = require('./icp');
const { gbizAvailable, gbizSearch, gbizGet } = require('./gbiz');
const { enrichEmail } = require('./email');
const { normalizeDomain, tierOf, callScript } = require('./score');
const { writeMasterCsv } = require('./master-io');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}

const TARGET = parseInt(getArg('target', '1000'), 10) || 1000;
const CONC = parseInt(getArg('concurrency', '8'), 10) || 8;
const WITH_EMAIL = !process.argv.includes('--no-email');
const OUT = getArg('out', 'leads-fresh-1000.csv');
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const CAND_JSON = path.join(DATA_DIR, 'fresh-candidates.json');
const REC_JSON = path.join(DATA_DIR, 'fresh-records.json');
const LOG = path.resolve(__dirname, '..', 'build-fresh.log');
fs.mkdirSync(DATA_DIR, { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (_) {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 除外セットの読み込み ----
function loadJsonSet(file) {
  try { const a = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); return new Set(a.map(String)); }
  catch (_) { return new Set(); }
}
// 社名の正規化（法人格・空白・全角半角の揺れを吸収して突合精度を上げる）
function normName(s) {
  return String(s || '')
    .replace(/[\s　]+/g, '')
    .replace(/株式会社|有限会社|合同会社|合資会社|合名会社|（株）|\(株\)|（有）|\(有\)/g, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .toLowerCase().trim();
}

const LISTED_BANGO = loadJsonSet('listed-bango.json');
const EXISTING_BANGO = loadJsonSet('existing-bango.json');
const LISTED_NAMES = (() => {
  const set = new Set();
  try { for (const n of JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'listed-names.json'), 'utf8'))) { const k = normName(n); if (k) set.add(k); } }
  catch (_) {}
  return set;
})();

// 除外判定（法人番号 or 正規化社名のいずれかが上場/既存に当たれば除外）
function isExcluded(corporateNumber, name) {
  const b = String(corporateNumber || '');
  if (b && (LISTED_BANGO.has(b) || EXISTING_BANGO.has(b))) return true;
  const nk = normName(name);
  if (nk && LISTED_NAMES.has(nk)) return true;
  return false;
}

function cleanRepName(raw) {
  let s = String(raw || '').replace(/[　\s]+/g, ' ').trim();
  s = s.replace(/^(代表取締役社長|代表取締役会長|代表取締役|取締役社長|取締役会長|取締役副社長|代表理事|理事長|代表社員|代表者|社長|会長|取締役|CEO|ＣＥＯ)\s*/u, '').trim();
  return s || String(raw || '').trim();
}

// ---- フェーズ1: 法人番号の過剰収集（上場/既存を候補段階で除外）----
async function collectCandidates(overfetch) {
  if (fs.existsSync(CAND_JSON)) {
    try {
      const c = JSON.parse(fs.readFileSync(CAND_JSON, 'utf8'));
      if (Array.isArray(c) && c.length >= overfetch) { log(`候補: キャッシュ ${c.length}社 を再利用`); return c; }
    } catch (_) {}
  }
  const prefs = (cfg.ICP_PREFECTURES && cfg.ICP_PREFECTURES.length) ? cfg.ICP_PREFECTURES : ['13'];
  const seen = new Set();
  const cands = [];
  let exListed = 0, exExisting = 0;
  log(`候補収集開始: 目標 ${overfetch}社 / 都道府県コード ${prefs.length}件 / 上場除外${LISTED_BANGO.size}・既存除外${EXISTING_BANGO.size}`);
  let page = 1;
  let active = prefs.slice();
  while (cands.length < overfetch && active.length) {
    const next = [];
    for (const pref of active) {
      if (cands.length >= overfetch) break;
      let hits = [];
      try { hits = await gbizSearch({ prefecture: pref, corporateType: cfg.GBIZ_CORPORATE_TYPE, employeeFrom: cfg.ICP_EMP_MIN, page, limit: cfg.GBIZ_LIMIT }, cfg); }
      catch (e) { log(`  検索失敗 pref=${pref} page=${page}: ${e.message}`); continue; }
      if (!hits.length) continue;
      let added = 0;
      for (const h of hits) {
        if (!h.corporateNumber || seen.has(h.corporateNumber)) continue;
        seen.add(h.corporateNumber);
        // 上場/既存はここで弾く（詳細APIを無駄打ちしない）
        if (LISTED_BANGO.has(String(h.corporateNumber)) || LISTED_NAMES.has(normName(h.name))) { exListed++; continue; }
        if (EXISTING_BANGO.has(String(h.corporateNumber))) { exExisting++; continue; }
        cands.push({ corporateNumber: h.corporateNumber, name: h.name, prefecture: h.prefecture || '', prefCode: pref });
        added++;
      }
      if (added > 0 || hits.length >= cfg.GBIZ_LIMIT) next.push(pref);
    }
    active = next;
    fs.writeFileSync(CAND_JSON, JSON.stringify(cands));
    log(`  候補 ${cands.length}/${overfetch}（page=${page}, 継続県=${active.length}, 除外:上場${exListed}/既存${exExisting}）`);
    page++;
    await sleep(120);
  }
  log(`候補収集完了: ${cands.length}社（上場除外${exListed}・既存除外${exExisting}）`);
  return cands;
}

// ---- フェーズ2: 詳細取得（代表者名）→ 採用 ----
async function main() {
  const t0 = Date.now();
  if (!gbizAvailable(cfg)) { log('GBIZ_TOKEN 未設定。中止。'); process.exit(1); }
  if (!LISTED_BANGO.size) { log('警告: data/listed-bango.json が空。上場除外が効きません。中止。'); process.exit(1); }
  log(`===== 上場除外・完全新規${TARGET}件ビルド開始（並列${CONC}, email=${WITH_EMAIL}）=====`);
  const icp = normalizeIcp({ source: 'manual' }, cfg);

  const overfetch = Math.ceil(TARGET * 10); // 除外＋低代表者名率のため過剰収集を厚めに
  const cands = await collectCandidates(overfetch);

  const recordsByKey = new Map();
  if (fs.existsSync(REC_JSON)) {
    try { for (const r of JSON.parse(fs.readFileSync(REC_JSON, 'utf8'))) recordsByKey.set(String(r['法人番号']), r); }
    catch (_) {}
    log(`再開: 既存 ${recordsByKey.size}件を復元`);
  }

  let kept = [...recordsByKey.values()].filter((r) => String(r['代表者名'] || '').trim()).length;
  let processed = recordsByKey.size;
  let exDetail = 0;
  let flushPending = 0;
  const flush = () => {
    const records = [...recordsByKey.values()];
    writeMasterCsv(OUT, records, cfg.MASTER_HEADERS);
    fs.writeFileSync(REC_JSON, JSON.stringify(records));
  };

  const todo = cands.filter((c) => !recordsByKey.has(String(c.corporateNumber)));
  let stop = kept >= TARGET;

  let idx = 0;
  async function worker() {
    while (idx < todo.length && !stop) {
      const cand = todo[idx++];
      let rep = '', url = '', emp = '', estab = '', biz = '', pref = cand.prefecture, name = cand.name;
      try {
        const gb = await gbizGet(cand.corporateNumber, cfg);
        if (gb) {
          rep = gb.representativeName || '';
          url = gb.websiteUrl || '';
          emp = gb.employees != null ? gb.employees : '';
          estab = gb.establishmentYear || '';
          biz = gb.businessSummary || '';
          if (gb.prefecture) pref = gb.prefecture;
          if (gb.name) name = gb.name;
        }
      } catch (_) {}
      processed++;
      // 詳細で判明した正式名でも上場名と再突合（二重の安全網）
      if (isExcluded(cand.corporateNumber, name)) { exDetail++; continue; }
      if (!String(rep).trim()) continue; // 代表者名が無い行は不採用

      const domain = normalizeDomain(url);
      let email = '', emailScore = '';
      if (WITH_EMAIL && (domain || url)) {
        try { const em = await enrichEmail({ domain, websiteUrl: url }, cfg); email = em.email || ''; emailScore = em.score != null ? em.score : ''; }
        catch (_) {}
      }
      const rec = {
        '企業名': name, '法人番号': cand.corporateNumber,
        '採用担当者名': '', '役職': '', '部署': '',
        '代表者名': cleanRepName(rep), 'メール': email, 'メール確度': emailScore,
        '担当者確度': '', '電話番号': '', '公式URL': url,
        'Tier': tierOf(0, Number(emailScore || 0), true, cfg),
        '取得元媒体': 'gBizINFO', '根拠URL': 'https://info.gbiz.go.jp/hojin/ichiran?hojinBango=' + cand.corporateNumber,
        '架電呼称': callScript(icp, cfg),
        '業種': String(biz || '').slice(0, 60), '都道府県': pref,
        '従業員数': emp, '補助金': '', '設立年': estab,
        '取得日': new Date().toISOString(),
        '代表者名_raw': rep,
      };
      recordsByKey.set(String(cand.corporateNumber), rec);
      kept++;
      if (++flushPending >= 10) { flushPending = 0; flush(); }
      if (kept % 25 === 0) {
        const el = (Date.now() - t0) / 1000;
        const rate = kept / el;
        const eta = rate > 0 ? ((TARGET - kept) / rate / 60).toFixed(1) : '?';
        log(`採用 ${kept}/${TARGET}（詳細${processed}件、代表者名率${(kept / processed * 100).toFixed(0)}%、詳細除外${exDetail}）｜ETA約${eta}分`);
      }
      if (kept >= TARGET) stop = true;
    }
  }

  await Promise.all(Array.from({ length: CONC }, () => worker()));
  flush();

  const records = [...recordsByKey.values()];
  const withRep = records.filter((r) => String(r['代表者名'] || '').trim()).length;
  const withUrl = records.filter((r) => String(r['公式URL'] || '').trim()).length;
  const withEmail = records.filter((r) => String(r['メール'] || '').trim()).length;
  const tier = records.reduce((a, r) => { a[r.Tier] = (a[r.Tier] || 0) + 1; return a; }, {});
  log(`===== 完了: ${records.length}件 ｜ 代表者名${withRep} ｜ URL${withUrl} ｜ メール${withEmail} ｜ 詳細除外${exDetail} =====`);
  log(`Tier内訳: A=${tier.A || 0} B=${tier.B || 0} C=${tier.C || 0} D=${tier.D || 0}`);
  log(`出力: ${path.resolve(OUT)}（所要 ${((Date.now() - t0) / 60000).toFixed(1)}分、詳細API ${processed}回）`);
}

main().catch((e) => { log('FATAL ' + (e && e.stack ? e.stack : e)); process.exit(1); });
