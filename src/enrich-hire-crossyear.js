'use strict';
/**
 * 「年間新卒採用予定人数」を別卒年ページのコース合算で確定させる層
 * ============================================================================
 * なぜ必要か（実測）:
 *   28卒(2028年卒)ページは選考が始まったばかりで「募集人数」を出していない社が多い。
 *   ICP完全適合1000件のうち 450社が採用予定人数=不明・236社が1名(1コース分だけ拾えた値)だった。
 *   28卒ページを課程まで辿り直しても回復は 0/24。ところが同じ corpID の 27卒ページには
 *   募集コース(displayEmployment)が並び、コースごとの「募集人数 X～Y名」を合算できる
 *   （実測 24社中17社=71%で判明、うち9社=37.5%が下限和6名以上）。
 *
 * 取り方:
 *   ① 27卒ページの outline を引いて h1 の社名が同一社であることを必ず突合（corpIDは卒年をまたいで安定
 *      だが取り違えは致命的）。
 *   ② employment.html → 各募集コース面の「募集人数」を合算。**下限和**を採用人数とする（保守側）。
 *      例: 8コース × 1～5名 → 23～55名 なら「23名」として扱う。
 *   ③ 27卒で取れなければ 28卒でも同じことを試す。両方取れたら大きい方（＝直近の実掲載）を採る。
 *
 * ICP判定（規模/業種/電話/新規性）には一切触らない。採用人数だけを台帳(JSON)に持ち帰る。
 *
 * 使い方:
 *   node src/enrich-hire-crossyear.js [--files a.csv,b.csv] [--conc 3] [--limit 0] [--min 6]
 *   既定入力: data/leads-icp-fresh-perfect-1000.csv, data/icp-legacy-verified.csv, data/icp-fresh-pool.csv
 *   出力台帳: data/hire-count.json   { corpID: {企業名, 人数, レンジ, コース数, 卒年, 根拠, 取得日} }
 */
const fs = require('fs');
const path = require('path');
const { readCsv } = require('./csv');
const { MynaviScraper } = require('./scrape-mynavi');
const { mkey } = require('./build-icp-fresh-1000');

const ROOT = path.resolve(__dirname, '..');
const getArg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const FILES = getArg('files', 'data/leads-icp-fresh-perfect-1000.csv,data/icp-legacy-verified.csv,data/icp-fresh-pool.csv')
  .split(',').map((s) => path.resolve(ROOT, s.trim())).filter((f) => fs.existsSync(f));
const CONC = Math.max(1, parseInt(getArg('conc', '3'), 10));
const LIMIT = parseInt(getArg('limit', '0'), 10);
const MIN = parseInt(getArg('min', '6'), 10);
const LEDGER = path.resolve(ROOT, getArg('out', 'data/hire-count.json'));
const YEARS = getArg('years', '27,28').split(',').map((s) => s.trim()).filter(Boolean);
// corpIDが一致しない社を「社名検索」で引き直すか（高いが、実測2割の取りこぼしを回収できる）
const SEARCH_FALLBACK = process.argv.includes('--search-fallback');

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => { const n = parseInt(String(v || '').replace(/[^0-9]/g, ''), 10); return Number.isFinite(n) ? n : 0; };

function withTimeout(p, ms, onT) {
  return new Promise((res) => { const t = setTimeout(() => res(onT()), ms); p.then((v) => { clearTimeout(t); res(v); }, () => { clearTimeout(t); res(onT()); }); });
}
function safeWrite(abs, content) {
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, content);
  for (let i = 0; i < 5; i++) { try { fs.renameSync(tmp, abs); return; } catch (e) { if (e.code === 'EPERM' || e.code === 'EBUSY') { try { fs.writeFileSync(abs, content); fs.unlinkSync(tmp); return; } catch (_) {} } } }
  try { fs.writeFileSync(abs, content); fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch (_) {}
}

// 入力CSV群から「採用人数を確定させたい社」を集める（corpID単位・既に MIN 以上が判明している社は触らない）
function collectTargets(ledger) {
  const byCorp = new Map();
  for (const f of FILES) {
    let recs = [];
    try { recs = readCsv(fs.readFileSync(f, 'utf8')).records; } catch (e) { log(`読込失敗 ${f}: ${String(e).slice(0, 60)}`); continue; }
    let add = 0;
    for (const r of recs) {
      const id = String(r['corpID'] || '').trim();
      const name = String(r['企業名'] || '').trim();
      if (!id || !name) continue;
      const cur = byCorp.get(id);
      const known = num(r['採用予定人数']);
      if (!cur) { byCorp.set(id, { id, 企業名: name, known }); add++; }
      else if (known > cur.known) cur.known = known;
    }
    log(`  ${path.basename(f)}: ${recs.length}行 → corpID ${add}件を新規に把握`);
  }
  const all = [...byCorp.values()];
  const todo = all.filter((c) => {
    const l = ledger[c.id];
    if (l && (l.確定 === true || num(l.人数) > 0)) return false;       // 台帳で確定済（数値あり）
    // 取れないと判っている社は再訪しない。ただし「社名検索で引き直す」モードでは、
    // まだ検索経路を試していない社（corpID不一致で諦めた社）だけ1回だけ再訪する。
    if (l && l.試行済 && !num(l.人数)) return SEARCH_FALLBACK && !l.検索済;
    return c.known < MIN;                                              // 既に6名以上が判っている社は触らない
  });
  return { all, todo };
}

async function run() {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  let ledger = {};
  if (fs.existsSync(LEDGER)) { try { ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8')) || {}; } catch (_) { ledger = {}; } }
  log(`台帳: 既知 ${Object.keys(ledger).length}社 ← ${path.relative(ROOT, LEDGER)}`);

  const { all, todo } = collectTargets(ledger);
  const targets = LIMIT ? todo.slice(0, LIMIT) : todo;
  log(`対象: 全 ${all.length}社中 ${targets.length}社を照会（既に${MIN}名以上判明・照会済は除外）｜卒年 ${YEARS.join('→')} ｜並列 ${CONC}`);
  if (!targets.length) { log('照会対象なし。終了。'); return; }

  const stat = { checked: 0, hit: 0, ge: 0, mismatch: 0, none: 0, fallback: 0 };
  const flush = () => safeWrite(LEDGER, JSON.stringify(ledger, null, 1));

  for (const gy of YEARS) {
    const rest = targets.filter((c) => !(ledger[c.id] && num(ledger[c.id].人数) > 0));
    if (!rest.length) break;
    log(`── ${gy}卒ページで照会: ${rest.length}社 ──`);
    const sc = new MynaviScraper({ gradYear: gy });
    await sc.launch();
    let idx = 0, done = 0;
    const worker = async () => {
      while (true) {
        const i = idx++;
        if (i >= rest.length) return;
        const c = rest[i];
        try {
          // ① 同一社の確認（h1社名）。取れない/別社なら以降の数字は使わない。
          const o = await withTimeout(sc.scrapeOutline(c.id), 30000, () => ({ ok: false }));
          if (!o.ok || !o.企業名 || mkey(o.企業名) !== mkey(c.企業名)) {
            // corpID が卒年をまたいで一致しない社（実測2割）。社名検索で引き直せば拾えることがあるので、
            // 「その卒年に居ない」と断ずる前に1回だけ検索経路を試す（高いので mismatch のときだけ）。
            stat.mismatch++;
            let rec = null;
            if (SEARCH_FALLBACK) rec = await withTimeout(sc.scrapeHireByName(c.企業名), 120000, () => null);
            const n2 = rec ? num(rec.採用予定人数) : 0;
            if (n2 > num((ledger[c.id] || {}).人数)) {
              stat.hit++; stat.fallback++;
              ledger[c.id] = Object.assign(ledger[c.id] || {}, {
                企業名: c.企業名, 人数: String(n2), レンジ: rec.採用予定人数レンジ || '', コース数: String(rec.募集コース数 || ''),
                卒年: `${gy}卒`, 根拠: `マイナビ${gy}卒 採用データ（社名検索で再特定 corp${rec.corpID}） ${rec.募集コース数}コース合算 ${rec.採用予定人数レンジ}（下限和を採用）`,
                取得日: new Date().toISOString().slice(0, 10), 試行済: true, 確定: true,
              });
              if (n2 >= MIN) { stat.ge++; log(`  ✅(検索再特定) ${c.企業名} … ${rec.採用予定人数レンジ}（${rec.募集コース数}コース・下限${n2}名）`); }
            } else {
              ledger[c.id] = Object.assign(ledger[c.id] || {}, { 企業名: c.企業名, 試行済: true, 検索済: SEARCH_FALLBACK || undefined, [`${gy}卒`]: '別社/未掲載' });
            }
          } else {
            // ② 募集コースを辿って募集人数を合算（下限和）
            const x = await withTimeout(sc.scrapeHireByCorp(c.id, c.企業名), 120000, () => null);
            const n = x ? num(x.採用予定人数) : 0;
            stat.checked++;
            if (n > 0) {
              const prev = ledger[c.id] || {};
              if (n > num(prev.人数)) {
                ledger[c.id] = Object.assign(prev, {
                  企業名: c.企業名, 人数: String(n), レンジ: x.採用予定人数レンジ || '', コース数: String(x.募集コース数 || ''),
                  卒年: `${gy}卒`, 根拠: `マイナビ${gy}卒 採用データ ${x.募集コース数}コース合算 ${x.採用予定人数レンジ}（下限和を採用）`,
                  取得日: new Date().toISOString().slice(0, 10), 試行済: true, 確定: true,
                });
              }
              stat.hit++;
              if (n >= MIN) { stat.ge++; log(`  ✅ ${c.企業名} … ${x.採用予定人数レンジ}（${x.募集コース数}コース・下限${n}名）`); }
            } else {
              stat.none++;
              ledger[c.id] = Object.assign(ledger[c.id] || {}, { 企業名: c.企業名, 試行済: true, [`${gy}卒`]: '募集人数の記載なし' });
            }
          }
        } catch (_) { /* 1社の失敗は無視 */ }
        if (++done % 20 === 0) { flush(); log(`  …${gy}卒 ${done}/${rest.length} ｜ 判明${stat.hit}（${MIN}名以上${stat.ge}／検索再特定${stat.fallback}） 記載なし${stat.none} 別社${stat.mismatch}`); }
        await sleep(150);
      }
    };
    await Promise.all(Array.from({ length: CONC }, () => worker()));
    await sc.close().catch(() => {});
    flush();
    log(`✔ ${gy}卒 完了 ｜ 累計 判明${stat.hit}（${MIN}名以上${stat.ge}） 記載なし${stat.none} 別社${stat.mismatch}`);
  }
  flush();
  const ge = Object.values(ledger).filter((v) => num(v.人数) >= MIN).length;
  log(`完了: 台帳 ${Object.keys(ledger).length}社 ／ ${MIN}名以上 ${ge}社 → ${path.relative(ROOT, LEDGER)}`);
}

if (require.main === module) run().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
module.exports = { LEDGER };
