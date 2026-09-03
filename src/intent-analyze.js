'use strict';
/**
 * インテントデータ分析（層2: タイミングシグナル）— オーケストレータ
 * ============================================================================
 * 層1（ATS未導入 × ICP適合）で残った母集団に対し、「いま採用が回っていない／いま投資した」
 * 痕跡を集めてスコア化し、架電の順番を作る。
 *
 *   入力: 既存の納品リスト（企業名/corpID/採用実績3年/メール/公式URL/採用ページURL があれば使う）
 *   出力: data/leads-intent-scored.csv（インテントスコア順）＋ data/intent-hot.md（上位の根拠つき）
 *   台帳: data/intent/observations.json（次回の“新設/切替”判定に使う観測履歴）
 *
 * 使い方:
 *   npm run intent            … 既定リストをオフライン＋マイナビで採点
 *   npm run intent:offline    … ネットワーク0（CSVが持つ事実だけ。主に④採用予定数の前年比増）
 *   node src/intent-analyze.js --in data/leads-icp-hire6-500.csv --sources csv,mynavi,site,jobs --limit 200
 *
 * 主なオプション:
 *   --in <csv>        入力リスト（既定 data/leads-fresh-top2000.csv）
 *   --out <csv>       出力（既定 data/leads-intent-scored.csv）
 *   --sources a,b,c   csv|mynavi|site|jobs（既定 csv,mynavi）
 *   --limit N         先頭N社だけ処理（0=全件）
 *   --conc N          並列数（既定 4。site/jobs は polite.js がホスト単位で直列化する）
 *   --min-score N     出力に載せる下限スコア（既定 0）
 *   --seed <csv>      観測台帳に baseline を敷く（初回から"新設"を言えるようにする）
 *   --reset-store     観測台帳を捨てて採り直す（判定ルールを変えた後は必須。誤検知が持ち越されるため）
 *   --no-store        台帳に書かない（試し打ち用）
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv } = require('./csv');
const { collectCompany } = require('./intent/collect');
const { detectAll, SIGNAL_LIST } = require('./intent/signals');
const { scoreIntent, combineWithFit, talkGuide, whyNow } = require('./intent/score');
const store = require('./intent/store');

const ROOT = path.resolve(__dirname, '..');
const getArg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const hasFlag = (n) => process.argv.includes('--' + n);

const IN = path.resolve(ROOT, getArg('in', 'data/leads-fresh-top2000.csv'));
const OUT = path.resolve(ROOT, getArg('out', 'data/leads-intent-scored.csv'));
const REPORT = path.resolve(ROOT, getArg('report', 'data/intent-hot.md'));
const LIMIT = parseInt(getArg('limit', '0'), 10);
const CONC = Math.max(1, parseInt(getArg('conc', '4'), 10));
const MIN_SCORE = parseFloat(getArg('min-score', '0'));
const DELAY = parseInt(getArg('delay', '150'), 10);
const TOP = parseInt(getArg('top', '80'), 10);
const SOURCES = (hasFlag('offline') ? 'csv' : getArg('sources', 'csv,mynavi')).split(',').map((s) => s.trim()).filter(Boolean);
const SEED = getArg('seed', '');
const NO_STORE = hasFlag('no-store');

const log = (m) => console.log('[' + new Date().toISOString() + '] ' + m);
const NOW = new Date();
const TODAY = NOW.toISOString().slice(0, 10);

const BASE_COLS = ['No', '企業名', '架電宛名', '採用担当者名', '電話番号', 'メール', '業種', '従業員数', '本社', '卒年',
  'インテントスコア', 'インテント階層', '推奨アクション', '最有力シグナル', 'シグナル強度', '検知シグナル',
  'なぜ今', '根拠', '推奨トーク', 'アポ期待度', '総合優先度'];
const SIG_COLS = SIGNAL_LIST.map((s) => s.列);
const TAIL_COLS = ['採用実績(直近3年)', '採用ページURL', '公式URL', 'corpID', '法人番号', '取得ソース', '観測日', '観測回数'];
const COLS = [...BASE_COLS, ...SIG_COLS, ...TAIL_COLS];

function safeWrite(abs, content) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, content);
  try { fs.renameSync(tmp, abs); return; } catch (_) {}
  try { fs.writeFileSync(abs, content); if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
}

function buildRow(rec, ev, res, 観測回数) {
  const o = {
    企業名: ev.企業名 || rec['企業名'] || '',
    架電宛名: rec['架電宛名'] || 'ご採用ご担当者様',
    採用担当者名: rec['採用担当者名'] || '',
    電話番号: rec['電話番号'] || '',
    メール: (ev.メール && ev.メール.length ? ev.メール[0].email : rec['メール']) || '',
    業種: rec['業種'] || '', 従業員数: rec['従業員数'] || '', 本社: rec['本社'] || rec['都道府県'] || '',
    卒年: rec['卒年'] || '',
    インテントスコア: String(res.スコア),
    インテント階層: res.階層,
    推奨アクション: res.行動,
    最有力シグナル: res.最有力 || '—',
    シグナル強度: res.最有力レベル || '',
    検知シグナル: res.検知シグナル || '',
    なぜ今: whyNow(res),
    根拠: res.根拠 || '',
    推奨トーク: talkGuide(res),
    アポ期待度: rec['アポ期待度'] || '',
    総合優先度: String(combineWithFit(res.スコア, rec['アポ期待度'])),
    '採用実績(直近3年)': ev.採用実績系列 || rec['採用実績(直近3年)'] || '',
    採用ページURL: (ev.採用ページ && ev.採用ページ.url) || rec['採用ページURL'] || '',
    公式URL: ev.公式URL || '',
    corpID: ev.corpID || '',
    法人番号: rec['法人番号'] || '',
    取得ソース: (ev.取得ソース || []).join('+') + ((ev.エラー || []).length ? '｜失敗:' + ev.エラー.slice(0, 2).join(',') : ''),
    観測日: TODAY,
    観測回数: String(観測回数 || 1),
  };
  for (const s of SIGNAL_LIST) o[s.列] = '';
  for (const d of res.内訳) o[d.列] = `${d.level}(${d.点数})`;
  return o;
}

function writeReport(rows, stats) {
  const top = rows.slice(0, TOP);
  const L = [];
  L.push('# いま刺すべき企業（層2: タイミングシグナル）');
  L.push('');
  L.push(`- 生成: ${new Date().toISOString()}`);
  L.push(`- 入力: ${path.relative(ROOT, IN)} ／ 取得系統: ${SOURCES.join('+')} ／ 処理 ${stats.処理}社`);
  L.push(`- シグナル検知: ${stats.検知}社（A:${stats.A} B:${stats.B} C:${stats.C} D:${stats.D}）`);
  L.push('');
  L.push('## シグナル別の検知数');
  L.push('');
  L.push('| # | シグナル | 重み | 検知社数 | 備考 |');
  L.push('|---|---|---|---|---|');
  for (const s of SIGNAL_LIST) {
    L.push(`| ${s.順位} | ${s.名称} | ${s.weight} | ${stats.signals[s.id] || 0} | ${s.要履歴 ? '“新設”は履歴が要る（初回は保有止まり）' : s.説明} |`);
  }
  L.push('');
  L.push(`## 上位${top.length}社`);
  L.push('');
  for (let i = 0; i < top.length; i++) {
    const r = top[i];
    L.push(`### ${i + 1}. ${r['企業名']}　［${r['インテント階層']}／${r['インテントスコア']}点］`);
    L.push(`- 電話: ${r['電話番号'] || '—'}　宛名: ${r['採用担当者名'] || r['架電宛名']}　従業員: ${r['従業員数'] || '—'}名　業種: ${r['業種'] || '—'}`);
    L.push(`- なぜ今: ${r['なぜ今']}`);
    L.push(`- 根拠: ${r['根拠']}`);
    if (r['推奨トーク']) L.push(`- トーク: ${r['推奨トーク']}`);
    L.push('');
  }
  safeWrite(REPORT, L.join('\n'));
}

async function main() {
  if (!fs.existsSync(IN)) { log('入力が見つかりません: ' + IN); process.exitCode = 1; return; }
  const { records } = readCsv(fs.readFileSync(IN, 'utf8'));
  const batch = LIMIT > 0 ? records.slice(0, LIMIT) : records;
  log(`入力 ${records.length}社 → 処理 ${batch.length}社 ／ 取得系統: ${SOURCES.join('+')} ／ 並列${CONC}`);

  // 判定ルールを変えた後は台帳を捨てて採り直す。
  // （台帳は未検知シグナルを持ち越すので、誤検知だった分は消さない限り生き残る）
  const state = hasFlag('reset-store') ? { version: 1, updatedAt: null, companies: {} } : store.loadObservations();
  if (hasFlag('reset-store')) log('--reset-store: 観測台帳を捨てて採り直す（過去の検知は失われる）');
  const 既知社数 = Object.keys(state.companies).length;
  if (SEED) {
    const f = path.resolve(ROOT, SEED);
    if (fs.existsSync(f)) {
      const n = store.seedBaseline(state, readCsv(fs.readFileSync(f, 'utf8')).records, { source: path.basename(f), now: NOW });
      log(`baseline を ${n}社ぶん敷いた（${path.basename(f)}）＝次回から“新設”を判定できる`);
    } else log('seed が見つかりません: ' + f);
  }
  log(`観測台帳: 既知 ${既知社数}社（${store.OBS}）`);

  const out = [];
  const stats = { 処理: 0, 検知: 0, A: 0, B: 0, C: 0, D: 0, signals: {} };
  let idx = 0;

  const worker = async () => {
    for (;;) {
      const i = idx++;
      if (i >= batch.length) return;
      const rec = batch[i];
      const key = store.companyKey(rec);
      if (!key) continue;
      const prev = store.prevOf(state, key);
      let ev;
      try {
        ev = await collectCompany(rec, { sources: SOURCES, delay: DELAY });
      } catch (e) {
        ev = { 企業名: rec['企業名'] || '', 取得ソース: [], エラー: ['collect:' + String(e && e.message || e).slice(0, 60)], メール: [] };
      }
      const hits = detectAll(ev, prev, { 検知日: TODAY, now: NOW });
      // 台帳に記録し、過去に検知して“まだ生きている”シグナルも合わせて採点する
      const merged = NO_STORE ? null : store.record(state, key, ev, hits, { now: NOW });
      const scoreHits = merged ? store.signalsToHits(merged) : hits;
      const res = scoreIntent(scoreHits, { now: NOW });

      stats.処理++;
      if (res.内訳.length) stats.検知++;
      stats[res.階層] = (stats[res.階層] || 0) + 1;
      for (const d of res.内訳) stats.signals[d.signal] = (stats.signals[d.signal] || 0) + 1;
      if (res.スコア >= MIN_SCORE) out.push(buildRow(rec, ev, res, (state.companies[key] || {}).観測回数));

      if (stats.処理 % 50 === 0) {
        log(`  …${stats.処理}/${batch.length} 検知${stats.検知}社（A${stats.A} B${stats.B} C${stats.C}）`);
        flush();
      }
    }
  };

  const flush = () => {
    const sorted = out.slice().sort((a, b) => parseFloat(b['総合優先度']) - parseFloat(a['総合優先度']));
    safeWrite(OUT, toCsv(COLS, sorted.map((r, i) => ({ ...r, No: String(i + 1) }))));
  };

  await Promise.all(Array.from({ length: CONC }, () => worker()));

  out.sort((a, b) => parseFloat(b['総合優先度']) - parseFloat(a['総合優先度'])
    || parseFloat(b['インテントスコア']) - parseFloat(a['インテントスコア']));
  out.forEach((r, i) => { r.No = String(i + 1); });
  safeWrite(OUT, toCsv(COLS, out));
  if (!NO_STORE) {
    store.saveObservations(state);
    store.saveRun({ cycle: NOW.toISOString(), 入力: path.relative(ROOT, IN), 系統: SOURCES, 統計: stats });
  }
  writeReport(out, stats);

  log('---- 結果 ----');
  log(`処理 ${stats.処理}社／シグナル検知 ${stats.検知}社（${Math.round(stats.検知 / Math.max(1, stats.処理) * 100)}%）`);
  log(`階層 A(即架電) ${stats.A || 0} ／ B ${stats.B || 0} ／ C ${stats.C || 0} ／ D ${stats.D || 0}`);
  for (const s of SIGNAL_LIST) log(`  ${s.順位}. ${s.名称}: ${stats.signals[s.id] || 0}社`);
  log('出力: ' + OUT);
  log('レポート: ' + REPORT);
  if (!NO_STORE) log('観測台帳: ' + store.OBS + '（次回この差分で“新設/切替”が立つ）');
}

if (require.main === module) main().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });

module.exports = { buildRow, COLS };
