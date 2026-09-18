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
 *   --qualified-only MOCHCA適合が確認できた企業だけを出力（欠損・対象外は含めない）
 *   --evidence <mode> 根拠本文の置き場: auto（既定）|inline|sidecar|none
 *                     auto は母集団が --evidence-auto-limit（既定3000社）を超えたら sidecar。
 *                     inline は1社あたり実測11KBで、2万社だとCSVが200MB超になる。
 *   --resume          作業ファイル（<out>.work.csv）に済みがある社を飛ばして続きから流す
 *   --store-every N   観測台帳の途中保存の間隔（既定2000社。0で無効）。
 *                     長時間実行が落ちてもその回の観測を失わないため。
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv } = require('./csv');
const { collectCompany } = require('./intent/collect');
const { detectAll, SIGNAL_LIST, assessFunding } = require('./intent/signals');
const { scoreIntent, talkGuide, whyNow, TIERS, TOP_WEIGHT } = require('./intent/score');
const { targetFit, TARGET_COLS, BUDGET_COLS } = require('./intent/target-fit');
const { sortedFaces } = require('./intent/face-signals');
const { buildReport } = require('./intent/report');
const { finalizeFromWork } = require('./intent/finalize');
const ngGuard = require('./ng-guard');
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
const QUALIFIED_ONLY = hasFlag('qualified-only');
// 根拠本文の置き場。inline は1社あたり実測11KBあり、2万社だと出力CSVが200MB超・
// 全行メモリ保持で落ちる。大きい母集団では既定で sidecar（JSONL別ファイル）に逃がす。
const EVIDENCE = getArg('evidence', 'auto');       // auto | inline | sidecar | none
const EVIDENCE_AUTO_LIMIT = parseInt(getArg('evidence-auto-limit', '3000'), 10);
const RESUME = hasFlag('resume');
const STORE_EVERY = parseInt(getArg('store-every', '2000'), 10);   // 観測台帳の途中保存の間隔
const WORK = OUT.replace(/\.csv$/i, '') + '.work.csv';
const EVIDENCE_FILE = OUT.replace(/\.csv$/i, '') + '.evidence.jsonl';

const log = (m) => console.log('[' + new Date().toISOString() + '] ' + m);
const T0 = Date.now();
const NOW = new Date();
const TODAY = NOW.toISOString().slice(0, 10);

const BASE_COLS = ['No', '企業名', '架電宛名', '採用担当者名', '電話番号', 'メール', '業種', '従業員数', '本社', '卒年',
  'インテントスコア', 'インテント階層', '推奨アクション', '最有力シグナル', 'シグナル強度', '検知シグナル',
  'なぜ今', '根拠', '推奨トーク', 'アポ期待度', '総合優先度'];
const SIG_COLS = SIGNAL_LIST.map((s) => s.列);
const TAIL_COLS = ['採用実績(直近3年)', '採用ページURL', '公式URL', 'corpID', '法人番号', '取得ソース', '観測日', '観測回数'];
const PASS_COLS = ['ATS判定', 'ATS確度', 'ATS根拠', 'ATS検査日', 'ATSトーク指針', 'entry_type', 'entry_host', 'エントリー動線',
  '年間新卒採用人数', '採用予定人数', 'エントリー人数', '応募者数', '既存被り', '既存顧客', 'DNC', '架電拒否', '除外フラグ', '役職', '部署'];
// 卒年面（S17〜S21の一次情報）を営業がそのまま読める列にする。
// シグナルが立たなかった社でも「今年は何人募集で、選考が何段か」は架電の材料になる。
const FACE_COLS = ['卒年面', '募集人数(最新卒年)', '募集人数(前卒年)', '選考段数', '面接回数', '応募受付経路',
  '募集コース数', '初任給(大卒)', '掲載面更新日'];
// 昨年度の採用結果と会社の体力。シグナルが立たなかった社でも、この素の数字が架電の材料になる。
// （「昨年8名採って3名辞めています」はそれ自体が話の入り口になる）
const PROFILE_COLS = ['昨年度入社数', '昨年度定着率', '定着率(3年)', '売上高', '従業員数(掲載)', '拠点数', '都道府県数', '上場区分', '特徴タグ'];
function profileCells(ev) {
  const empty = Object.fromEntries(PROFILE_COLS.map((c) => [c, '']));
  const ret = ev.定着;
  const d = ev.会社データ;
  const o = ev.拠点;
  if (!ret && !d && !o) return empty;
  const 最新 = ret && ret.系列 && ret.系列[0];
  return {
    ...empty,
    昨年度入社数: 最新 ? `${最新.年}年${最新.採用者}名` : '',
    昨年度定着率: 最新 ? `${最新.定着率}%` : '',
    '定着率(3年)': ret ? ret.系列.map((r) => `${r.年}:${r.採用者}名/離職${r.離職者}名/${r.定着率}%`).join(' ') : '',
    売上高: d && d.売上高 ? String(d.売上高) : '',
    '従業員数(掲載)': d && d.従業員数 ? String(d.従業員数) : '',
    拠点数: o && o.拠点規模 ? String(o.拠点規模) : '',
    都道府県数: o && o.都道府県数 ? String(o.都道府県数) : '',
    上場区分: ev.上場 || '',
    特徴タグ: (ev.特徴 || []).slice(0, 6).join('／'),
  };
}
function faceCells(ev) {
  const faces = sortedFaces(ev.卒年面);
  if (!faces.length) return Object.fromEntries(FACE_COLS.map((c) => [c, '']));
  const [next, prev] = faces;
  const f = faces.find((x) => x.選考フロー) || next;
  const e = faces.find((x) => x.エントリー) || next;
  const c = faces.find((x) => x.募集コース) || next;
  const p = faces.find((x) => x.初任給) || next;
  return {
    卒年面: faces.map((x) => x.gy + '卒').join('+'),
    '募集人数(最新卒年)': next.募集人数 ? next.募集人数.表記 : '',
    '募集人数(前卒年)': prev && prev.募集人数 ? prev.募集人数.表記 : '',
    選考段数: f.選考フロー ? String(f.選考フロー.選考段数) : '',
    面接回数: f.選考フロー ? String(f.選考フロー.面接回数) : '',
    応募受付経路: e.エントリー ? ((e.エントリー.手作業 || []).join('・') || (e.エントリー.媒体経由 ? 'マイナビ経由のみ' : '')) : '',
    募集コース数: c.募集コース ? String(c.募集コース.コース数) : '',
    '初任給(大卒)': p.初任給 ? String(p.初任給.大卒月額) : '',
    掲載面更新日: next.更新日 || '',
  };
}

const COLS = [...BASE_COLS, ...BUDGET_COLS, ...SIG_COLS, ...FACE_COLS, ...PROFILE_COLS, ...TAIL_COLS, ...TARGET_COLS, ...PASS_COLS];

function safeWrite(abs, content) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, content);
  try { fs.renameSync(tmp, abs); return; } catch (_) {}
  fs.writeFileSync(abs, content);
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
}

function buildRow(rec, ev, res, 観測回数) {
  const fit = targetFit(rec, ev, res);
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
    推奨アクション: fit.action,
    最有力シグナル: res.最有力 || '—',
    シグナル強度: res.最有力レベル || '',
    検知シグナル: res.検知シグナル || '',
    なぜ今: whyNow(res),
    根拠: res.根拠 || '',
    推奨トーク: talkGuide(res),
    アポ期待度: rec['アポ期待度'] || '',
    総合優先度: String(fit.priority),
    // 資金面。点にはせず、順番（総合優先度の係数）と次の一手だけに効かせている。
    予算状態: res.予算状態 || '未判定',
    予算係数: String(res.予算係数 != null ? res.予算係数 : 1),
    資金リスク: res.予算根拠 || '',
    検討時期: res.検討時期 || '',
    予算トーク: res.予算トーク || '',
    MOCHCA適合判定: fit.status,
    MOCHCA適合根拠: fit.reasons,
    要確認項目: fit.missing,
    提案ルート: fit.route,
    優先度モデル: 'intent-v2（営業仮説・受注確率ではない）',
    根拠URL一覧: [...new Set(res.内訳.map(d => d.詳細 && d.詳細.url).filter(Boolean))].join(' '),
    インテント資料JSON: JSON.stringify(ev.インテント資料 || []),
    シグナル内訳JSON: JSON.stringify(res.内訳),
    '採用実績(直近3年)': ev.採用実績系列 || rec['採用実績(直近3年)'] || '',
    採用ページURL: (ev.採用ページ && ev.採用ページ.url) || rec['採用ページURL'] || '',
    公式URL: ev.公式URL || '',
    corpID: ev.corpID || '',
    法人番号: rec['法人番号'] || '',
    取得ソース: (ev.取得ソース || []).join('+') + ((ev.エラー || []).length ? '｜失敗:' + ev.エラー.slice(0, 2).join(',') : ''),
    観測日: TODAY,
    観測回数: String(観測回数 || 1),
  };
  Object.assign(o, faceCells(ev), profileCells(ev));
  for (const c of PASS_COLS) o[c] = rec[c] ?? '';
  for (const s of SIGNAL_LIST) o[s.列] = '';
  for (const d of res.内訳) o[d.列] = `${d.level}(${d.点数})`;
  return o;
}

// レポートの上位N社ぶんだけを読み直す。全行を開かないための小さな読み取り。
function readTopRows(csvPath, n) {
  const text = fs.readFileSync(csvPath, 'utf8');
  let cut = 0;
  for (let i = 0, q = false, seen = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') i++; else q = false; } }
    else if (c === '"') q = true;
    else if (c === '\n') { if (++seen > n) { cut = i; break; } }
  }
  return readCsv(cut ? text.slice(0, cut) : text).records;
}

function writeReport(rows, stats) {
  safeWrite(REPORT, buildReport(rows, stats, {
    signalList: SIGNAL_LIST, tiers: TIERS, topWeight: TOP_WEIGHT,
    入力: path.relative(ROOT, IN), 系統: SOURCES.join('+'), top: TOP,
  }));
}

async function main() {
  if (!fs.existsSync(IN)) { log('入力が見つかりません: ' + IN); process.exitCode = 1; return; }
  const { records } = readCsv(fs.readFileSync(IN, 'utf8'));
  const allowed = records.filter(r => !ngGuard.hit(r.企業名));
  const batch = LIMIT > 0 ? allowed.slice(0, LIMIT) : allowed;
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

  // 根拠本文の置き場を決める。1社あたり実測11KBあるため、母集団が大きいと
  // inline は出力CSVが数百MBになり、全行をメモリに持つ最終ソートで落ちる。
  const evidenceMode = EVIDENCE !== 'auto' ? EVIDENCE
    : (batch.length > EVIDENCE_AUTO_LIMIT ? 'sidecar' : 'inline');
  if (evidenceMode === 'sidecar') {
    log(`根拠本文は別ファイルに出す（${batch.length}社 > ${EVIDENCE_AUTO_LIMIT}社）: ${path.relative(ROOT, EVIDENCE_FILE)}`);
    log('  → CSVには根拠URLと引用だけが載る。本文を使う後段は --evidence inline で採り直すこと。');
  }

  // 完了した社はその場で作業ファイルに追記する。落ちても --resume で続きから再開でき、
  // メモリには“並べ替えに必要な軽い行”しか持たない（最終CSVは作業ファイルから作る）。
  const done = new Set();
  if (RESUME && fs.existsSync(WORK)) {
    for (const r of readCsv(fs.readFileSync(WORK, 'utf8')).records) {
      const k = store.companyKey(r);
      if (k) done.add(k);
    }
    log(`--resume: 作業ファイルに ${done.size}社ぶんの済みを確認（${path.relative(ROOT, WORK)}）`);
  } else if (fs.existsSync(WORK)) {
    fs.unlinkSync(WORK);
  }
  fs.mkdirSync(path.dirname(WORK), { recursive: true });
  // toCsv は末尾に改行を付けない。ヘッダに改行を足さずに追記すると1行目が壊れる。
  if (!fs.existsSync(WORK)) fs.appendFileSync(WORK, toCsv(COLS, [], { ngGuard: false }) + '\n');
  if (evidenceMode === 'sidecar' && !RESUME && fs.existsSync(EVIDENCE_FILE)) fs.unlinkSync(EVIDENCE_FILE);

  const appendRow = (row) => {
    // ヘッダ無しの1行だけを足す。toCsv のヘッダ行を落として使う。
    const body = toCsv(COLS, [row], { where: path.basename(WORK) }).split('\n').slice(1).join('\n');
    if (body.trim()) fs.appendFileSync(WORK, body.endsWith('\n') ? body : body + '\n');
  };

  const stats = { 処理: 0, 検知: 0, 資料あり: 0, A: 0, B: 0, C: 0, D: 0, 書出: 0, 再開スキップ: 0,
    卒年面あり: 0, 適合内訳: {}, signals: {} };
  let idx = 0;

  const worker = async () => {
    for (;;) {
      const i = idx++;
      if (i >= batch.length) return;
      const rec = batch[i];
      const key = store.companyKey(rec);
      if (!key) continue;
      if (done.has(key)) { stats.再開スキップ++; continue; }
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
      // 資金リスク（赤字・採用縮小・予算確定）は加点シグナルにしない。
      // 点はそのままに、総合優先度の係数と推奨アクション（ナーチャリング）に効かせる。
      // 今回取得した本文でしか判定できないので、台帳の持ち越しではなく毎回見る。
      const res = scoreIntent(scoreHits, { now: NOW, 資金: assessFunding(ev, scoreHits) });

      stats.処理++;
      if ((ev.インテント資料 || []).length) stats.資料あり++;
      if (res.内訳.length) stats.検知++;
      stats[res.階層] = (stats[res.階層] || 0) + 1;
      for (const d of res.内訳) stats.signals[d.signal] = (stats.signals[d.signal] || 0) + 1;
      const row = buildRow(rec, ev, res, (state.companies[key] || {}).観測回数);
      if (evidenceMode !== 'inline') {
        if (evidenceMode === 'sidecar' && (ev.インテント資料 || []).length) {
          fs.appendFileSync(EVIDENCE_FILE, JSON.stringify({ key, 企業名: row.企業名, corpID: row.corpID, 資料: ev.インテント資料 }) + '\n');
        }
        // CSVには「どのURLのどの一文か」だけを残す。本文は sidecar 側にある。
        row.インテント資料JSON = JSON.stringify((ev.インテント資料 || [])
          .map(d => ({ url: d.url, source: d.source, date: d.date, title: String(d.title || '').slice(0, 120) })));
      }
      if (res.スコア >= MIN_SCORE && (!QUALIFIED_ONLY || row.MOCHCA適合判定 === '適合')) {
        appendRow(row); stats.書出++;
        // 全行ぶんの集計はここで貯める（最後に全行を開かないため）
        stats.適合内訳[row.MOCHCA適合判定] = (stats.適合内訳[row.MOCHCA適合判定] || 0) + 1;
        if (String(row['卒年面'] || '').includes('+')) stats.卒年面あり++;
      }

      // 観測台帳は実行の最後にしか書かないと、2万社の長時間実行が落ちた時に
      // その回の観測が丸ごと消える。一定間隔で流しておく（19MB級なので毎回は書かない）。
      if (!NO_STORE && STORE_EVERY > 0 && stats.処理 > 0 && stats.処理 % STORE_EVERY === 0) {
        store.saveObservations(state);
        log(`  観測台帳を保存（${stats.処理}社時点）`);
      }
      if (stats.処理 % 100 === 0) {
        const 経過 = (Date.now() - T0) / 1000;
        const 残 = batch.length - stats.再開スキップ - stats.処理;
        log(`  …${stats.処理}/${batch.length - stats.再開スキップ} 検知${stats.検知}社（A${stats.A} B${stats.B} C${stats.C}）`
          + ` ${(stats.処理 / 経過).toFixed(1)}社/秒 残り約${Math.round(残 / Math.max(0.01, stats.処理 / 経過) / 60)}分`);
      }
    }
  };

  await Promise.all(Array.from({ length: CONC }, () => worker()));

  // 最終CSVは作業ファイルから作る。行をオブジェクトに開かずに並べ替えるので、
  // 2万行でもピークが200MB前後で収まる（開くと実測1.9GB要り、取得90分の後にOOMしうる）。
  log('作業ファイルを並べ替えて書き出し中…');
  if (fs.existsSync(WORK)) {
    const r = await finalizeFromWork(WORK, OUT);
    log(`  ${r.行数}行を書き出し` + (r.除外 ? `（架電禁止 ${r.除外}行を除外）` : ''));
  } else {
    fs.writeFileSync(OUT, toCsv(COLS, []));
  }
  // レポートは上位のみ使うので、ここだけ改めて読み直す（全行は開かない）。
  const out = readTopRows(OUT, Math.max(TOP, 1));
  // 作業ファイルは中断時の再開用。最終CSVを書けた時点で役目が終わるので片付ける。
  try { if (fs.existsSync(WORK)) fs.unlinkSync(WORK); } catch (_) {}
  if (!NO_STORE) {
    store.saveObservations(state);
    store.saveRun({ cycle: NOW.toISOString(), 入力: path.relative(ROOT, IN), 系統: SOURCES, 統計: stats });
  }
  writeReport(out, stats);

  log('---- 結果 ----');
  log(`処理 ${stats.処理}社／出力 ${out.length}行`
    + (stats.再開スキップ ? `／--resume で ${stats.再開スキップ}社をスキップ` : '')
    + `／所要 ${Math.round((Date.now() - T0) / 60000)}分`);
  log(`シグナル検知 ${stats.検知}社（${Math.round(stats.検知 / Math.max(1, stats.処理) * 100)}%）`);
  log(`階層 A(即架電) ${stats.A || 0} ／ B ${stats.B || 0} ／ C ${stats.C || 0} ／ D ${stats.D || 0}`);
  for (const s of SIGNAL_LIST) log(`  ${s.順位}. ${s.名称}: ${stats.signals[s.id] || 0}社`);
  log('出力: ' + OUT);
  log('レポート: ' + REPORT);
  if (!NO_STORE) log('観測台帳: ' + store.OBS + '（次回この差分で“新設/切替”が立つ）');
}

if (require.main === module) main().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });

module.exports = { buildRow, COLS };
