'use strict';
/**
 * 母集団拡張：ICP完全適合 × 年間新卒採用6名以上 を「27卒コーパス」から新規発掘する
 * ============================================================================
 * 背景:
 *   28卒(2028年卒)コーパス30,016社は探索済で、完全新規×ICP完全適合は1,099社が上限だった。
 *   そのうち「採用6名以上」が確定するのは半数以下なので、500件に届かせるには母集団の追加が要る。
 *   27卒(2027年卒)は選考サイクルが終盤で **募集人数がコース別に出揃っている**（＝6名以上を判定できる）。
 *   27卒にしか掲載していない社＝28卒コーパスに居ない社が、そのまま新しい母集団になる。
 *
 * 安い順に落とすパイプライン（1社あたりの実測コスト順）:
 *   0) 社名で既存除外          … 0秒   統合マスタ/BALES/MOCHICA顧客/SF全リード/NG/既存プール
 *   1) outline.html            … 約1.5秒 h1社名で既存除外を引き直し＋従業員100-2000名＋非IT
 *   2) employment→各募集コース … 約5秒   「募集人数」の**下限和**が6名以上か（今回のハード条件）
 *   3) 全面巡回(scrapeByCorp)  … 約12秒  電話/担当者名/部署/募集職種（到達性の確定はここ）
 *   ＝ 高い工程は「6名以上が確定した社」にしか払わない。
 *
 * 出力: data/icp-hire6-pool-27.csv（icp-fresh-pool.csv と同じ列＝build-icp-hire6-500.js がそのまま食える）
 *       data/hire-count.json にも採用人数を追記（台帳を一本化）
 * 使い方: `npm run icp:hire6:harvest`   HIRE6_TARGET / HIRE6_CONCURRENCY / HIRE6_LIMIT で調整
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv } = require('./csv');
const { MynaviScraper } = require('./scrape-mynavi');
const { scoreMochica, parseEmployees } = require('./mochica-fit');
const { isExcludedIndustry } = require('./icp-rules');
const { buildExclusion, evaluate, mkey, cleanDisplay, EMP_MIN, EMP_MAX } = require('./build-icp-fresh-1000');
const { POOL_COLS, TIER_LABEL } = require('./build-icp-fresh-v2');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.HIRE6_OUT || path.join(ROOT, 'data', 'icp-hire6-pool-27.csv');
const SEEN = OUT.replace(/\.csv$/, '') + '.seen.txt';
const LEDGER = path.join(ROOT, 'data', 'hire-count.json');
const CORPUS27 = process.env.HIRE6_CORPUS || path.join(ROOT, 'data', 'mynavi-2027-corpus.csv');
const CORPUS28 = path.join(ROOT, 'data', 'mynavi-2028-corpus.csv');
const GRAD_YEAR = process.env.HIRE6_GRAD_YEAR || '27';
const TARGET = parseInt(process.env.HIRE6_TARGET || '400', 10);
const LIMIT = parseInt(process.env.HIRE6_LIMIT || '0', 10);
const CONC = Math.max(1, parseInt(process.env.HIRE6_CONCURRENCY || '3', 10));
const HIRE_MIN = parseInt(process.env.HIRE6_MIN || '6', 10);
const DELAY = parseInt(process.env.HIRE6_DELAY_MS || '150', 10);

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
const readIds = (f) => { const s = new Set(); if (!fs.existsSync(f)) return s; try { for (const l of fs.readFileSync(f, 'utf8').split(/\r?\n/)) { const t = l.trim(); if (t) s.add(t); } } catch (_) {} return s; };

function run() { return main(); }

async function main() {
  if (!fs.existsSync(CORPUS27)) { log(`27卒コーパスが無い: ${CORPUS27}（先に MYNAVI_GRAD_YEAR=27 で npm run mynavi:corpus）`); process.exitCode = 1; return; }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  log('除外索引（統合マスタ＋BALES＋MOCHICA顧客＋SF全リード）を構築中…');
  const excl = buildExclusion();
  const ng = new Set();
  const ngFile = path.join(ROOT, 'data', 'ng-companies.txt');
  if (fs.existsSync(ngFile)) for (const l of fs.readFileSync(ngFile, 'utf8').split(/\r?\n/)) { const k = mkey(l); if (k) ng.add(k); }

  // 既存プールの社名/corpID（二重計上を防ぐ）
  const collected = new Set();
  const knownCorp = new Set();
  for (const rel of ['data/leads-icp-fresh-perfect-1000.csv', 'data/icp-legacy-verified.csv', 'data/icp-fresh-pool.csv', 'data/leads-icp-fresh-10000.csv']) {
    const f = path.join(ROOT, rel);
    if (!fs.existsSync(f)) continue;
    try { for (const r of readCsv(fs.readFileSync(f, 'utf8')).records) { const k = mkey(r['企業名']); if (k) collected.add(k); if (r['corpID']) knownCorp.add(String(r['corpID']).trim()); } } catch (_) {}
  }
  // 28卒側で既に探索済み（＝規模/業種/電話で落ちた社を含む）corpID は年に依らないので触らない
  const seen = new Set([
    ...readIds(SEEN),
    ...readIds(path.join(ROOT, 'data', 'icp-fresh-pool.seen.txt')),
    ...readIds(path.join(ROOT, 'data', 'leads-icp-fresh-10000.seen.txt')),
  ]);
  const c28 = new Set();
  if (fs.existsSync(CORPUS28)) { try { for (const r of readCsv(fs.readFileSync(CORPUS28, 'utf8')).records) if (r.corpID) c28.add(String(r.corpID)); } catch (_) {} }

  // 再開: 出力プール
  const rows = [];
  if (fs.existsSync(OUT)) {
    try { for (const r of readCsv(fs.readFileSync(OUT, 'utf8')).records) { rows.push(r); const k = mkey(r['企業名']); if (k) collected.add(k); if (r.corpID) knownCorp.add(String(r.corpID)); } } catch (_) {}
  }
  let ledger = {};
  if (fs.existsSync(LEDGER)) { try { ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8')) || {}; } catch (_) {} }

  // 候補: 27卒コーパス − 28卒コーパス − 探索済 − 既存プール − 社名で既存
  const corpus = readCsv(fs.readFileSync(CORPUS27, 'utf8')).records;
  const cand = [];
  let skipC28 = 0, skipSeen = 0, skipName = 0;
  for (const c of corpus) {
    const id = String(c.corpID || '').trim();
    if (!id) continue;
    if (c28.has(id) || knownCorp.has(id)) { skipC28++; continue; }
    if (seen.has(id)) { skipSeen++; continue; }
    const k = mkey(c['企業名']);
    if (k && (excl.names.has(k) || ng.has(k) || collected.has(k))) { skipName++; seen.add(id); continue; }
    cand.push({ id, name: c['企業名'] });
  }
  const batch = LIMIT ? cand.slice(0, LIMIT) : cand;
  log(`27卒コーパス ${corpus.length}社 → 28卒既知/既存プール ${skipC28} ／ 探索済 ${skipSeen} ／ 社名で既存 ${skipName} ＝ 探索対象 ${batch.length}社（目標 +${TARGET}社・並列${CONC}）`);
  if (!batch.length) { log('探索対象なし。終了。'); return; }

  const stat = { outline: 0, dropEmp: 0, dropIT: 0, dropDup: 0, hire: 0, dropHire: 0, dropPhone: 0, ok: 0 };
  const flush = () => { safeWrite(OUT, toCsv(POOL_COLS, rows)); safeWrite(SEEN, [...seen].join('\n')); safeWrite(LEDGER, JSON.stringify(ledger, null, 1)); };

  const sc = new MynaviScraper({ gradYear: GRAD_YEAR });
  await sc.launch();
  let idx = 0, done = 0;

  async function processOne(f) {
    // ① 会社概要（安い）で 規模／業種／実社名 を確定
    const o = await withTimeout(sc.scrapeOutline(f.id), 30000, () => ({ ok: false }));
    stat.outline++;
    if (!o.ok) return;
    const disp = cleanDisplay(o.企業名 || f.name);
    const k = mkey(disp);
    if (k && (excl.names.has(k) || ng.has(k) || collected.has(k))) { stat.dropDup++; return; }
    const emp = parseEmployees(o.従業員数);
    if (emp == null || emp < EMP_MIN || emp > EMP_MAX) { stat.dropEmp++; return; }
    if (isExcludedIndustry(o.業種)) { stat.dropIT++; return; }

    // ② 採用6名以上（募集コース別「募集人数」の下限和）— ここで落とせば高い工程を払わずに済む
    const h = await withTimeout(sc.scrapeHireByCorp(f.id, disp), 120000, () => null);
    const hire = h ? num(h.採用予定人数) : 0;
    if (hire > 0) {
      ledger[f.id] = Object.assign(ledger[f.id] || {}, {
        企業名: disp, 人数: String(hire), レンジ: h.採用予定人数レンジ || '', コース数: String(h.募集コース数 || ''),
        卒年: `${GRAD_YEAR}卒`, 根拠: `マイナビ${GRAD_YEAR}卒 採用データ ${h.募集コース数}コース合算 ${h.採用予定人数レンジ}（下限和を採用）`,
        取得日: new Date().toISOString().slice(0, 10), 試行済: true, 確定: true,
      });
      stat.hire++;
    }
    if (hire < HIRE_MIN) { stat.dropHire++; return; }

    // ③ 到達性・担当者名（高い工程は6名以上が確定した社にだけ払う）
    const r = await withTimeout(sc.scrapeByCorp(f.id, disp), 90000, () => null);
    if (!r) return;
    const rec = {
      企業名: disp, corpID: f.id, 法人番号: '',
      採用担当者名: r.採用担当者名 || '', 担当者確度: r.担当者確度 || '', パターン: r.パターン || '',
      役職: r.役職 || '', 部署: r.部署 || '', メール: r.メール || '', 電話番号: r.電話番号 || '',
      従業員数: o.従業員数, 業種: o.業種, 本社: o.本社 || '', 上場: o.上場 || '',
      募集職種: r.募集職種 || '', 採用予定人数: String(hire), 卒年: `${GRAD_YEAR}卒(20${GRAD_YEAR}年卒)`,
      採用ページURL: `https://job.mynavi.jp/${GRAD_YEAR}/pc/search/corp${f.id}/outline.html`,
      掲載媒体: 'マイナビ', 新卒フラグ: '新',
      検証: 'outline実取得＋募集コース合算', 取得日: new Date().toISOString().slice(0, 10),
    };
    const ev = evaluate(rec);
    if (!ev.qualifies) { if (!ev.m.flags.callable) stat.dropPhone++; return; }
    if (collected.has(k)) { stat.dropDup++; return; }

    rec.採用担当者名 = ev.nameOk ? ev.clean : '';
    rec.代表者名 = ev.repOk ? ev.rep : '';
    rec.連絡先区分 = TIER_LABEL[ev.tier];
    rec.架電宛名 = ev.contact ? ((rec.部署 ? rec.部署 + ' ' : '') + ev.contact + ' 様') : (rec.部署 ? rec.部署 + ' ご採用ご担当者様' : 'ご採用ご担当者様');
    rec.アポ期待度 = ev.m.total; rec.優先度 = ev.m.priority; rec.確信度 = ev.m.confidence;
    rec.MOCHICA適合 = ev.m.total >= 80 ? '◎' : ev.m.total >= 65 ? '○' : '△';
    rec.フィットティア = 'S:完全適合(採用6名以上)';
    rec.完全適合根拠 = `完全新規｜${TIER_LABEL[ev.tier]}${ev.contact ? '(' + ev.contact + ')' : ''}｜マイナビ${GRAD_YEAR}卒掲載｜従業員${ev.emp}名(${EMP_MIN}-${EMP_MAX})｜非IT(${o.業種})｜電話妥当｜年間新卒${hire}名以上(${h.採用予定人数レンジ})`;
    const out = {}; for (const c of POOL_COLS) out[c] = rec[c] != null ? String(rec[c]) : '';
    rows.push(out);
    collected.add(k);
    stat.ok++;
    log(`  ✅ ${disp} / 従${ev.emp} / ${o.業種} / 採用${h.採用予定人数レンジ} / ${TIER_LABEL[ev.tier]}${ev.contact ? '(' + ev.contact + ')' : ''} → ${rows.length}`);
  }

  const worker = async () => {
    while (true) {
      if (rows.length >= TARGET) return;
      const i = idx++;
      if (i >= batch.length) return;
      const f = batch[i];
      seen.add(String(f.id));
      try { await processOne(f); } catch (_) { /* 1社の失敗は無視 */ }
      if (++done % 50 === 0) {
        flush();
        log(`  …${done}/${batch.length} outline${stat.outline} ｜ 規模外${stat.dropEmp} IT${stat.dropIT} 既存${stat.dropDup} 人数判明${stat.hire} 6名未満${stat.dropHire} 電話無${stat.dropPhone} ｜ 確保${rows.length}/${TARGET}`);
      }
      await sleep(DELAY);
    }
  };
  try { await Promise.all(Array.from({ length: CONC }, () => worker())); } finally { flush(); await sc.close().catch(() => {}); }
  log(`完了: 新規確保 ${rows.length}社（outline${stat.outline} 規模外${stat.dropEmp} IT${stat.dropIT} 6名未満${stat.dropHire} 電話無${stat.dropPhone}）`);
  log(`出力: ${OUT}`);
}

if (require.main === module) main().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
module.exports = { run };
