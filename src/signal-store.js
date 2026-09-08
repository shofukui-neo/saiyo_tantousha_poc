'use strict';
/**
 * signal-store — 採用シグナルの時系列台帳（差分シグナルの土台）
 * =====================================================================
 * 「求人が3件→12件に増えた」「120日間ずっと掲載されている（＝採れていない）」は、
 * **その日のページを見ただけでは絶対に分からない**。前回いつ・何件だったかを
 * 自分で覚えておく必要がある。本モジュールがその記憶層。
 *
 * 2つのファイルを持つ:
 *   data/hot-signals/state.json          … 企業ごとの最新状態＋観測履歴（差分の元）
 *   data/hot-signals/snapshots/YYYY-MM-DD.json … その日の生スナップショット（再計算・監査用）
 *
 * state.json の1企業:
 *   {
 *     name, key,                       // 社名・正規化キー（company-match の looseKey）
 *     firstSeen, lastSeen,             // 初回/最終観測日（長期掲載の判定に使う）
 *     jobs, hire, emp, phone, ...,     // 最新の観測値
 *     history: [{date, jobs, hire}]    // 直近30回まで
 *   }
 *
 * 使い方（ドライバから）:
 *   const store = loadStore();
 *   const deltas = applySnapshot(store, rows, { date: '2026-09-08', source: 'mynavi' });
 *   saveStore(store);   // deltas は企業キー → 差分シグナル配列
 *
 * CLI:
 *   node src/signal-store.js show                 # 台帳の統計
 *   node src/signal-store.js ingest <csv> [--source mynavi] [--date YYYY-MM-DD]
 *     CSV の列は「企業名/求人数/採用人数/従業員数/電話番号/担当者名/業種/都道府県」を見る
 *     （マイナビ合説CSV・BALES書式など既存の成果物をそのまま食える）
 */
const fs = require('fs');
const path = require('path');
const { readCsv } = require('./csv');
const { looseKey, pickName } = require('./company-match');
const { detectDeltaSignals } = require('./hot-signal');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'data', 'hot-signals');
const STATE = path.join(DIR, 'state.json');
const SNAPDIR = path.join(DIR, 'snapshots');
const HISTORY_MAX = 30;                         // 1社あたりの保持観測数

const ymd = (d = new Date()) => new Date(d).toISOString().slice(0, 10);

/** 台帳を読む（無ければ空で作る）。 */
function loadStore(file = STATE) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && j.companies) return j;
  } catch (_) { /* 初回は空から */ }
  return { version: 1, updated: '', companies: {} };
}

/** 台帳を保存（一時ファイル経由の原子的置換＝途中終了で壊さない）。 */
function saveStore(store, file = STATE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  store.updated = new Date().toISOString();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 1), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

// 観測行 → 正規化した1件（列名のゆらぎをここで吸収する）
const g = (r, keys) => { for (const k of keys) { const v = r[k]; if (v != null && String(v).trim() !== '') return String(v).trim(); } return ''; };
const z2h = (s) => String(s == null ? '' : s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

/**
 * 「550」「1,234名」「約120名(2026年4月)」→ 最初の数値。
 * 非数字を全部剥がして parseInt すると「550名(2026年4月)」が 5502026 になるので、
 * 必ず最初の数値だけを取る。
 */
function toInt(v) {
  const m = z2h(v).replace(/,/g, '').match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

/**
 * 採用人数はレンジ表記で来る（実測: マイナビは「11～15名」「31～35名 / 16～20名」）。
 * 数字を連結すると 1115 / 31352025 になり、ICPの採用フロア判定を丸ごと壊す。
 * コース区切りごとに**下限**を取り、合計する（scrape-mynavi の sumHireCourses と同じ保守的な数え方）。
 */
function toHire(v) {
  const s = z2h(v).replace(/,/g, '');
  if (!s.trim()) return null;
  let sum = 0; let found = false;
  for (const part of s.split(/[/／、,]/)) {
    const m = part.match(/(\d+)\s*[～~〜-]?\s*(\d+)?\s*[名人]/) || part.match(/^\s*(\d+)\s*$/);
    if (!m) continue;
    sum += parseInt(m[1], 10);
    found = true;
  }
  return found ? sum : null;
}

function normalizeRow(r) {
  const name = pickName(r) || g(r, ['企業名', '会社名', '社名', '掲載社名']);
  if (!name) return null;
  return {
    name,
    key: looseKey(name),
    jobs: toInt(g(r, ['求人数', '掲載求人数', '募集職種数', '募集件数'])),
    hire: toHire(g(r, ['採用人数', '採用予定人数', '募集人数', '新卒採用人数'])),
    emp: toInt(g(r, ['従業員数', '従業員規模', '社員数'])),
    phone: g(r, ['電話番号', '本社電話番号', 'TEL', '電話']),
    contactName: g(r, ['担当者名', '採用担当者名', '担当者']),
    industry: g(r, ['業種', '業界']),
    pref: g(r, ['都道府県', '所在地']),
    url: g(r, ['マイナビURL', '公式URL', 'URL', 'Webサイト', '根拠URL']),
  };
}

/**
 * その日の観測を台帳へ反映し、企業ごとの差分シグナルを返す。
 * @param {object} store loadStore() の戻り
 * @param {object[]} rows 観測行（CSVレコードそのままでよい）
 * @param {{date?:string, source?:string, longDays?:number}} opt
 * @returns {Map<string, {name:string, signals:Array, rec:object}>} キー→差分シグナル
 */
function applySnapshot(store, rows, opt = {}) {
  const date = opt.date || ymd();
  const source = opt.source || '';
  const out = new Map();
  const seenToday = new Set();

  for (const raw of rows) {
    const r = normalizeRow(raw);
    if (!r || !r.key) continue;
    const prevRec = store.companies[r.key];
    // 同日2行目以降（重複行 or 同日再取込）は「前回」ではない。差分は出さず値のマージだけ行う。
    const sameDay = seenToday.has(r.key) || (prevRec && prevRec.lastSeen === date);
    seenToday.add(r.key);
    // prev = 前回観測。未観測 or 前回掲載が消えていた場合は null（＝「新規掲載開始」の条件）
    const prev = (prevRec && !sameDay && prevRec.seen !== false)
      ? { jobs: prevRec.jobs, hire: prevRec.hire, seen: true }
      : null;

    const cur = {
      name: r.name,
      key: r.key,
      // 一度消えた掲載が復活した場合は掲載期間を数え直す（古い firstSeen を引きずると
      // 「120日間ずっと募集中」という架電理由が事実と食い違う）
      firstSeen: (prevRec && prevRec.seen !== false && prevRec.firstSeen) || date,
      lastSeen: date,
      source: source || (prevRec && prevRec.source) || '',
      jobs: r.jobs != null ? r.jobs : (prevRec ? prevRec.jobs : null),
      hire: r.hire != null ? r.hire : (prevRec ? prevRec.hire : null),
      emp: r.emp != null ? r.emp : (prevRec ? prevRec.emp : null),
      phone: r.phone || (prevRec && prevRec.phone) || '',
      contactName: r.contactName || (prevRec && prevRec.contactName) || '',
      industry: r.industry || (prevRec && prevRec.industry) || '',
      pref: r.pref || (prevRec && prevRec.pref) || '',
      url: r.url || (prevRec && prevRec.url) || '',
      history: (prevRec && prevRec.history) || [],
      seen: true,
    };
    if (sameDay) {
      // 同日の重複行は合算せず最大値を残す（同じ求人を2度数えない）。履歴も1日1点に保つ。
      if (prevRec && prevRec.jobs != null && (cur.jobs == null || prevRec.jobs > cur.jobs)) cur.jobs = prevRec.jobs;
      if (prevRec && prevRec.hire != null && (cur.hire == null || prevRec.hire > cur.hire)) cur.hire = prevRec.hire;
      if (cur.history.length && cur.history[cur.history.length - 1].date === date) cur.history[cur.history.length - 1] = { date, jobs: cur.jobs, hire: cur.hire };
      else cur.history = [...cur.history, { date, jobs: cur.jobs, hire: cur.hire }].slice(-HISTORY_MAX);
      store.companies[r.key] = cur;
      continue;                                  // 差分は初回行で既に出している
    }
    cur.history = [...cur.history, { date, jobs: cur.jobs, hire: cur.hire }].slice(-HISTORY_MAX);

    const signals = detectDeltaSignals(prev, cur, { asOf: date, longDays: opt.longDays });
    store.companies[r.key] = cur;
    if (signals.length) out.set(r.key, { name: cur.name, signals, rec: cur });
  }

  // 今日は観測されなかった＝掲載が終わった可能性。次に現れたら「新規掲載開始」として扱う。
  for (const [k, c] of Object.entries(store.companies)) {
    if (!seenToday.has(k)) c.seen = false;
  }
  return out;
}

/** その日の生スナップショットを残す（後から規則を変えて再計算できるように）。 */
function writeSnapshot(rows, opt = {}) {
  const date = opt.date || ymd();
  fs.mkdirSync(SNAPDIR, { recursive: true });
  const file = path.join(SNAPDIR, `${date}${opt.source ? '-' + opt.source : ''}.json`);
  const norm = rows.map(normalizeRow).filter(Boolean);
  fs.writeFileSync(file, JSON.stringify({ date, source: opt.source || '', count: norm.length, rows: norm }, null, 1), 'utf8');
  return file;
}

// ── CLI ──────────────────────────────────────────────────────
if (require.main === module) {
  const cmd = process.argv[2] || 'show';
  const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
  const store = loadStore();

  if (cmd === 'show') {
    const cs = Object.values(store.companies);
    const withJobs = cs.filter((c) => c.jobs != null).length;
    const dates = [...new Set(cs.map((c) => c.lastSeen))].sort();
    console.log(`[signal-store] ${STATE}`);
    console.log(`  企業数        ${cs.length}社（求人数を観測 ${withJobs}社）`);
    console.log(`  観測日        ${dates.length}日分（${dates[0] || '—'} 〜 ${dates[dates.length - 1] || '—'}）`);
    const ages = cs.map((c) => Math.floor((new Date(ymd()) - new Date(c.firstSeen)) / 86400000)).filter(Number.isFinite);
    console.log(`  長期掲載90日+ ${ages.filter((a) => a >= 90).length}社`);
    console.log(`  更新          ${store.updated || '—'}`);
    if (cs.length < 2) console.log('\n  ※ 差分シグナル（求人急増/長期掲載）は2回以上の観測が必要です。日次で ingest してください。');
  } else if (cmd === 'ingest') {
    const file = process.argv[3];
    if (!file || !fs.existsSync(file)) { console.error('使い方: node src/signal-store.js ingest <csv> [--source mynavi] [--date YYYY-MM-DD]'); process.exit(1); }
    const { records } = readCsv(fs.readFileSync(file, 'utf8'));
    const date = arg('date', ymd());
    const source = arg('source', path.basename(file, '.csv'));
    const snap = writeSnapshot(records, { date, source });
    const deltas = applySnapshot(store, records, { date, source });
    saveStore(store);
    console.log(`[signal-store] 取込 ${records.length}行 / 台帳 ${Object.keys(store.companies).length}社`);
    console.log(`[signal-store] 差分シグナル ${deltas.size}社`);
    const tally = {};
    for (const { signals } of deltas.values()) for (const s of signals) tally[s.key] = (tally[s.key] || 0) + 1;
    for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(4)}社  ${k}`);
    console.log(`[signal-store] snapshot: ${path.relative(ROOT, snap)}`);
  } else {
    console.error(`不明なコマンド: ${cmd}（show | ingest）`);
    process.exit(1);
  }
}

module.exports = { loadStore, saveStore, applySnapshot, writeSnapshot, normalizeRow, toInt, toHire, STATE, SNAPDIR, ymd };
