'use strict';
// gBizINFO ベースの「代表者名つき1000件」高速ビルダー（APIのみ・Webクロールなし）
//  1) 都道府県コード(ICP_PREFECTURES)で gbizSearch 法人番号を過剰収集（株式会社/合同会社）
//  2) gbizGet 詳細で 代表者名・公式URL・従業員数・設立年・事業概要 を取得
//  3) 代表者名が取れた行だけを採用し、目標(1000)に到達するまで詰める
//  4) 任意でメール(MX篩い)を付与。数件ごとにCSV＋ジャーナルをフラッシュ（再開可能）
//
//   node src/build-gbiz.js --target 1000 --concurrency 6 --out leads-daihyou-1000.csv
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
const CONC = parseInt(getArg('concurrency', '6'), 10) || 6;
const WITH_EMAIL = !process.argv.includes('--no-email');
const OUT = getArg('out', 'leads-daihyou-1000.csv');
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const CAND_JSON = path.join(DATA_DIR, 'gbiz-candidates.json');
const REC_JSON = path.join(DATA_DIR, 'gbiz-records.json');
const LOG = path.resolve(__dirname, '..', 'build-gbiz.log');
fs.mkdirSync(DATA_DIR, { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (_) {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pool(items, n, worker) {
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; await worker(items[i], i); }
  }));
}

// 代表者名から先頭の役職語を落として氏名らしさを上げる（表示はrawも保持）
function cleanRepName(raw) {
  let s = String(raw || '').replace(/[　\s]+/g, ' ').trim();
  s = s.replace(/^(代表取締役社長|代表取締役会長|代表取締役|取締役社長|取締役会長|取締役副社長|代表理事|理事長|代表社員|代表者|社長|会長|取締役|CEO|ＣＥＯ)\s*/u, '').trim();
  return s || String(raw || '').trim();
}

// ---- フェーズ1: 法人番号の過剰収集 ----
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
  log(`候補収集開始: 目標 ${overfetch}社 / 都道府県コード ${prefs.join(',')}`);
  // 都道府県をラウンドロビンしてページング（地域分散）
  let page = 1;
  let active = prefs.slice();
  while (cands.length < overfetch && active.length) {
    const next = [];
    for (const pref of active) {
      if (cands.length >= overfetch) break;
      let hits = [];
      try { hits = await gbizSearch({ prefecture: pref, corporateType: cfg.GBIZ_CORPORATE_TYPE, employeeFrom: cfg.ICP_EMP_MIN, page, limit: cfg.GBIZ_LIMIT }, cfg); }
      catch (e) { log(`  検索失敗 pref=${pref} page=${page}: ${e.message}`); continue; }
      if (!hits.length) continue; // この都道府県は打ち止め
      let added = 0;
      for (const h of hits) {
        if (!h.corporateNumber || seen.has(h.corporateNumber)) continue;
        seen.add(h.corporateNumber);
        cands.push({ corporateNumber: h.corporateNumber, name: h.name, prefecture: h.prefecture || '', prefCode: pref });
        added++;
      }
      if (added > 0 || hits.length >= cfg.GBIZ_LIMIT) next.push(pref); // まだ取れる都道府県は継続
    }
    active = next;
    fs.writeFileSync(CAND_JSON, JSON.stringify(cands));
    log(`  候補 ${cands.length}/${overfetch}（page=${page}, 継続県=${active.length}）`);
    page++;
    await sleep(120);
  }
  log(`候補収集完了: ${cands.length}社`);
  return cands;
}

// ---- フェーズ2: 詳細取得（代表者名）→ 採用 ----
async function main() {
  const t0 = Date.now();
  if (!gbizAvailable(cfg)) { log('GBIZ_TOKEN 未設定。中止。'); process.exit(1); }
  log(`===== 代表者名つき${TARGET}件ビルド開始（並列${CONC}, email=${WITH_EMAIL}）=====`);
  const icp = normalizeIcp({ source: 'manual' }, cfg);

  const overfetch = Math.ceil(TARGET * 4.5);
  const cands = await collectCandidates(overfetch);

  // 再開: 既存ジャーナル
  const recordsByKey = new Map(); // 法人番号 -> record
  if (fs.existsSync(REC_JSON)) {
    try { for (const r of JSON.parse(fs.readFileSync(REC_JSON, 'utf8'))) recordsByKey.set(String(r['法人番号']), r); }
    catch (_) {}
    log(`再開: 既存 ${recordsByKey.size}件を復元`);
  }

  let kept = [...recordsByKey.values()].filter((r) => String(r['代表者名'] || '').trim()).length;
  let processed = recordsByKey.size;
  let flushPending = 0;
  const flush = () => {
    const records = [...recordsByKey.values()];
    writeMasterCsv(OUT, records, cfg.MASTER_HEADERS);
    fs.writeFileSync(REC_JSON, JSON.stringify(records));
  };

  // 未処理の候補だけ詳細取得（代表者名つきが TARGET に達したら停止）
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
      if (!String(rep).trim()) continue; // 代表者名が無い行は不採用（次の候補へ）

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
        log(`採用 ${kept}/${TARGET}（詳細取得${processed}件、代表者名率${(kept / processed * 100).toFixed(0)}%）｜ETA約${eta}分`);
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
  log(`===== 完了: ${records.length}件 ｜ 代表者名${withRep} ｜ URL${withUrl} ｜ メール${withEmail} =====`);
  log(`Tier内訳: A=${tier.A || 0} B=${tier.B || 0} C=${tier.C || 0} D=${tier.D || 0}`);
  log(`出力: ${path.resolve(OUT)}（所要 ${((Date.now() - t0) / 60000).toFixed(1)}分、詳細API ${processed}回）`);
}

main().catch((e) => { log('FATAL ' + (e && e.stack ? e.stack : e)); process.exit(1); });
