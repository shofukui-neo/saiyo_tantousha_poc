'use strict';
/**
 * 「年間新卒採用“実績”人数」をマイナビ会社概要から確定させる層（採用人数6名以上の一次情報）
 * ============================================================================
 * 会社概要(outline.html)の末尾には、募集人数(＝予定)とは別に **実績** が載っている:
 *   ① 過去3年間の新卒採用者数（男女別）      … 「2024年 15名 0名 15名」（男 女 計）
 *   ② 過去3年間の新卒採用者数・離職者数・定着率 … 「2024年 15名 2名 86.7%」（採用者 離職者 定着率）
 *   ③ 採用実績（人数）                        … 「　 2024年 2025年 2026年(予) ／ 大卒 3名 2名 3名 …」
 * 実測: 募集人数が「1～5名」でも実績は年15～20名という社が普通にある（NTPトヨタ信州）。
 * 「採用人数6名以上」の判定は、予定より **実績** の方が確かで取りこぼしも少ない。
 *
 * 判定値: 直近年（最も新しい“実績”年。(予)は使わない）の新卒採用者数。
 *   ①②③の順に信頼して採る。①②は行単位で年と人数が対応しているので誤読しない。
 *   ③は年ヘッダの列数と各行の数値の個数が一致するときだけ採る（列ズレを弾く）。
 *
 * 出力: data/hire-count.json に 実績人数/実績年/実績根拠/実績3年 を追記（採用人数台帳を一本化）
 * 使い方: node src/enrich-hire-record.js [--conc 3] [--limit 0] [--years 28,27]
 */
const fs = require('fs');
const path = require('path');
const { readCsv } = require('./csv');
const { MynaviScraper } = require('./scrape-mynavi');
const { mkey } = require('./build-icp-fresh-1000');

const ROOT = path.resolve(__dirname, '..');
const getArg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const FILES = getArg('files', 'data/leads-icp-fresh-perfect-1000.csv,data/icp-legacy-verified.csv,data/icp-fresh-pool.csv,data/icp-hire6-pool-27.csv')
  .split(',').map((s) => path.resolve(ROOT, s.trim())).filter((f) => fs.existsSync(f));
const CONC = Math.max(1, parseInt(getArg('conc', '3'), 10));
const LIMIT = parseInt(getArg('limit', '0'), 10);
const YEARS = getArg('years', '28,27').split(',').map((s) => s.trim()).filter(Boolean);
const LEDGER = path.resolve(ROOT, getArg('out', 'data/hire-count.json'));

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

/**
 * 会社概要の本文から「年間新卒採用実績」を取り出す。
 * @returns {{年: number, 人数: number, 出所: string, 系列: Array<{年:number,人数:number}>}|null}
 */
function extractHireRecord(text) {
  const t = String(text || '').replace(/[０-９]/g, (d) => '０１２３４５６７８９'.indexOf(d)).replace(/[ \t　]+/g, ' ');
  const pick = (series, src) => {
    const valid = [];
    const seenYear = new Set();
    for (const s of series) {
      if (!(s.年 >= 2015 && s.年 <= 2035) || !Number.isFinite(s.人数)) continue;
      if (seenYear.has(s.年)) continue;          // 同じ年が2度出るのは隣接表の混入。先に出た方（当該表）を採る
      seenYear.add(s.年); valid.push(s);
    }
    if (!valid.length) return null;
    valid.sort((a, b) => b.年 - a.年);
    return { 年: valid[0].年, 人数: valid[0].人数, 出所: src, 系列: valid.slice(0, 3) };
  };
  // 表のブロックは「次の表の見出し」で必ず切る（隣の離職者数表の行を読み込まないため）
  const cut = (s) => { const j = s.search(/離職者数|定着率|会社概要|採用実績（学校）/); return j > 0 ? s.slice(0, j) : s; };

  // ① 過去3年間の新卒採用者数（男女別）: 「2024年 15名 0名 15名」（男 女 計）／「2024年 8名 4名」（男 女）
  let i = t.indexOf('過去3年間の新卒採用者数（男女別）');
  if (i >= 0) {
    const blk = cut(t.slice(i + 18, i + 600));
    const s = [];
    const re = /(20\d{2})年\s*(\d{1,4})名\s*(\d{1,4})名(?:\s*(\d{1,4})名)?/g;
    let m;
    while ((m = re.exec(blk))) s.push({ 年: +m[1], 人数: m[4] != null ? +m[4] : (+m[2] + +m[3]) });
    const got = pick(s, 'マイナビ会社概要 過去3年間の新卒採用者数（男女別）');
    if (got) return got;
  }

  // ② 過去3年間の新卒採用者数・離職者数・定着率: 「2024年 15名 2名 86.7%」（採用者 離職者 定着率）
  i = t.indexOf('離職者数');
  if (i >= 0) {
    const blk = t.slice(i, i + 600);
    const s = [];
    const re = /(20\d{2})年\s*(\d{1,4})名\s*(\d{1,4})名\s*[\d.]+\s*%/g;
    let m;
    while ((m = re.exec(blk))) s.push({ 年: +m[1], 人数: +m[2] });
    const got = pick(s, 'マイナビ会社概要 過去3年間の新卒採用者数・定着率');
    if (got) return got;
  }

  // ③ 採用実績（人数）: 年ヘッダ「2024年 2025年 2026年(予)」＋ 学歴別の行「大卒 3名 2名 3名」
  //    列数が一致する行だけを足し込む（ズレたら採らない）。(予)の列は実績ではないので除外。
  i = t.indexOf('採用実績（人数）');
  if (i >= 0) {
    const blk = t.slice(i, i + 900);
    const head = blk.match(/(20\d{2})年(\(予\))?/g) || [];
    const cols = head.map((h) => ({ 年: +h.slice(0, 4), 予定: /\(予\)/.test(h) }));
    if (cols.length >= 1) {
      const sums = new Array(cols.length).fill(0);
      let rows = 0;
      for (const line of blk.split('\n')) {
        if (/^\s*20\d{2}年/.test(line)) continue;                 // ヘッダ行
        const nums = line.match(/(\d{1,4})名/g);
        if (!nums || nums.length !== cols.length) continue;        // 列ズレは採らない
        if (!/[大短高専修院卒業]/.test(line)) continue;            // 学歴行だけ
        nums.forEach((v, k) => { sums[k] += num(v); });
        rows++;
      }
      if (rows) {
        const s = cols.map((c, k) => ({ 年: c.年, 人数: sums[k], 予定: c.予定 })).filter((x) => !x.予定);
        const got = pick(s, 'マイナビ会社概要 採用実績（人数・学歴別合計）');
        if (got) return got;
      }
    }
  }
  return null;
}

async function main() {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  let ledger = {};
  if (fs.existsSync(LEDGER)) { try { ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8')) || {}; } catch (_) {} }

  // 対象: 入力CSV群の全社（corpID単位）。実績が既に台帳にある社は触らない。
  const byCorp = new Map();
  for (const f of FILES) {
    let recs = [];
    try { recs = readCsv(fs.readFileSync(f, 'utf8')).records; } catch (_) { continue; }
    for (const r of recs) {
      const id = String(r['corpID'] || '').trim();
      const name = String(r['企業名'] || '').trim();
      if (!id || !name || byCorp.has(id)) continue;
      byCorp.set(id, { id, 企業名: name });
    }
    log(`  ${path.basename(f)}: ${recs.length}行`);
  }
  const all = [...byCorp.values()];
  const todo = all.filter((c) => !(ledger[c.id] && ledger[c.id].実績照会済));
  const targets = LIMIT ? todo.slice(0, LIMIT) : todo;
  log(`対象: 全 ${all.length}社中 ${targets.length}社の会社概要を照会（卒年 ${YEARS.join('→')} ／並列${CONC}）`);
  if (!targets.length) { log('照会対象なし。終了。'); return; }

  const stat = { ok: 0, ge6: 0, none: 0, mismatch: 0 };
  const flush = () => safeWrite(LEDGER, JSON.stringify(ledger, null, 1));

  for (const gy of YEARS) {
    const rest = targets.filter((c) => !(ledger[c.id] && ledger[c.id].実績照会済));
    if (!rest.length) break;
    log(`── ${gy}卒の会社概要で照会: ${rest.length}社 ──`);
    const sc = new MynaviScraper({ gradYear: gy });
    await sc.launch();
    const pages = [];
    for (let i = 0; i < CONC; i++) pages.push(await sc.context.newPage());
    let idx = 0, done = 0;
    const worker = async (page) => {
      while (true) {
        const i = idx++;
        if (i >= rest.length) return;
        const c = rest[i];
        try {
          const url = `https://job.mynavi.jp/${gy}/pc/search/corp${c.id}/outline.html`;
          const got = await withTimeout(sc._fetchPage(page, url, false), 40000, () => null);
          if (got && got.text) {
            // 同一社であることを本文で確認（社名がページに出ていること）
            const nk = mkey(c.企業名);
            const ok = !nk || mkey(got.text.slice(0, 400)).includes(nk) || got.text.includes(c.企業名);
            if (!ok) { stat.mismatch++; }
            else {
              const rec = extractHireRecord(got.text);
              const prev = ledger[c.id] || {};
              if (rec) {
                stat.ok++;
                if (rec.人数 >= 6) stat.ge6++;
                ledger[c.id] = Object.assign(prev, {
                  企業名: c.企業名, 実績人数: String(rec.人数), 実績年: String(rec.年),
                  実績3年: rec.系列.map((x) => `${x.年}年${x.人数}名`).join('/'),
                  実績根拠: `${rec.出所}（マイナビ${gy}卒面）｜${rec.系列.map((x) => `${x.年}年${x.人数}名`).join('・')}`,
                  実績照会済: true,
                });
              } else {
                stat.none++;
                ledger[c.id] = Object.assign(prev, { 企業名: c.企業名, 実績照会済: YEARS.indexOf(gy) === YEARS.length - 1 ? true : undefined, 実績: '記載なし' });
              }
            }
          }
        } catch (_) { /* 1社の失敗は無視 */ }
        if (++done % 50 === 0) { flush(); log(`  …${gy}卒 ${done}/${rest.length} ｜ 実績判明${stat.ok}（6名以上${stat.ge6}） 記載なし${stat.none} 別社${stat.mismatch}`); }
        await sleep(120);
      }
    };
    await Promise.all(pages.map((p) => worker(p)));
    await sc.close().catch(() => {});
    flush();
    log(`✔ ${gy}卒 完了 ｜ 累計 実績判明${stat.ok}（6名以上${stat.ge6}） 記載なし${stat.none}`);
  }
  flush();
  const ge = Object.values(ledger).filter((v) => Math.max(num(v.人数), num(v.実績人数)) >= 6).length;
  log(`完了: 台帳 ${Object.keys(ledger).length}社 ／ 予定or実績で6名以上 ${ge}社 → ${path.relative(ROOT, LEDGER)}`);
}

if (require.main === module) main().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
module.exports = { extractHireRecord };
