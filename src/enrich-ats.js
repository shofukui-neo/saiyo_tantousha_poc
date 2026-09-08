'use strict';
/**
 * エントリーページURLから利用ATS（採用管理システム）を判定して列を付ける。
 *
 *   単発:   node src/enrich-ats.js --url "https://www.career-cloud.asia/27/form/entry?id=168..." [--live] [--json]
 *   一括:   node src/enrich-ats.js --in data/leads.csv --out data/leads-ats.csv [--live] [--conc 3] [--limit N]
 *
 * オプション:
 *   --url-col <列名>  エントリーURLの列（既定: エントリーURL/採用ページURL/URL… を自動検出）
 *   --live            URLだけで判定できない行だけページを取得して埋め込みを見る（robots遵守・polite.js経由）
 *   --live-all        ATS判明済みの行も取得する（媒体併用や埋め込みの取りこぼしを潰したい時）
 *   --only-unknown    既にATS列が埋まっている行はスキップ（再実行時の差分埋め）
 *   --fill-col <列名> 既存列（例「カスタム情報：利用中ATS」）の空セルだけ判定結果で埋める（既存値は上書きしない）
 *
 * 判定ロジックは src/ats.js。ネットワークを使うのはこのCLIだけ。
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv } = require('./csv');
const { getArg, getIntArg, log, atomicWrite } = require('./cli-util');
const { detectAts, detectAtsByUrl, salesHint, hostOfUrl, stripTags } = require('./ats');
const { scopeOf, gradeEvidence, GRADE } = require('./ats-scope');

// 出力に足す列（既存列の後ろに付く）
// ATS列は「新卒での利用が確認できた（判定グレード=確定）」時だけ埋める。
// 中途採用のATSを新卒リストに載せないため（2026-08-28の目視監査で誤判定の主因だった）。
const OUT_COLS = ['ATS', 'ATSベンダー', 'ATS種別', 'ATS確度', 'ATS根拠',
  '判定グレード', '新卒根拠', '用途', 'ATS URL', '候補ATS', 'ATS併用', '営業メモ', 'ATS判定日'];
// エントリーURLらしき列の候補（左ほど優先）
const URL_COL_CANDIDATES = [
  'エントリーURL', 'エントリーページURL', 'エントリーフォームURL', '応募URL', '応募フォームURL',
  '採用ページURL', '採用URL', 'マイページURL', '求人URL', '公式URL', 'URL', 'ホームページ', 'WebサイトURL',
];

/** ヘッダからURL列を選ぶ。候補に無ければ「URL」を含む列 → 値がhttpの列の順で拾う。 */
function pickUrlColumn(headers, records) {
  for (const c of URL_COL_CANDIDATES) if (headers.includes(c)) return c;
  const byName = headers.find((h) => /url|ＵＲＬ/i.test(h));
  if (byName) return byName;
  const sample = records.slice(0, 50);
  return headers.find((h) => sample.some((r) => /^https?:\/\//i.test(String(r[h] || '')))) || '';
}

/**
 * 1URLを判定する。live時はURLで決まらなければページを取得して埋め込みまで見る。
 * @returns {object} detectAts の戻り + { fetched:boolean, error:string }
 */
async function detectOne(url, opts = {}) {
  const first = detectAts(url);
  // URLだけで新卒の証拠まで取れる場合（career-cloud.asia/27/… のように卒年がパスに出る）は取得不要。
  const firstGrade = grade(first, url, '');
  const needFetch = (opts.live || opts.liveAll)
    && (opts.liveAll || firstGrade.grade !== GRADE.CONFIRMED);
  if (!needFetch) return { ...first, grade: firstGrade, fetched: false, error: '' };

  const { politeGet } = require('./polite');   // 遅延require（オフライン一括時にPlaywrightを触らない）
  try {
    const p = await politeGet(url, { render: 'static' });
    if (!p || p.blocked || !p.html) {
      return { ...first, fetched: false, error: (p && (p.reason || p.error)) || 'fetch-failed' };
    }
    const merged = detectAts(url, { html: p.html, finalUrl: p.finalUrl });
    const text = stripTags(p.html).slice(0, 20000);
    return { ...merged, grade: grade(merged, p.finalUrl || url, text), fetched: true, error: '' };
  } catch (e) {
    return { ...first, grade: firstGrade, fetched: false, error: String((e && e.message) || e) };
  }
}

/**
 * 判定結果を採否ゲート（ats-scope）にかける。
 * 取得したページがATSホスト自身なら、その本文を「新卒か中途か」の直接証拠として渡す。
 * @param {object} det detectAts の戻り
 * @param {string} pageUrl 取得したページのURL
 * @param {string} text ページ本文（タグを落としたもの・未取得なら空）
 */
function grade(det, pageUrl, text) {
  if (!det || !det.found) return { grade: GRADE.NONE, reason: '', scope: '', confidence: 0 };
  const atsUrl = det.url || (detectAtsByUrl(pageUrl) ? pageUrl : '');
  const onAtsHost = !!atsUrl && hostOfUrl(atsUrl) === hostOfUrl(pageUrl);
  return gradeEvidence({
    kind: det.kind, source: det.source, atsUrl, linkContext: det.context || '',
    atsPageText: onAtsHost ? text : '',
    pageScope: text ? scopeOf({ text, url: pageUrl }) : null,
  });
}

/** 判定結果 → 出力列。 */
function toColumns(det, today) {
  // grade が付いていなければここで判定する（detectAts の生の戻りを渡されても安全に）
  const g = det.grade || grade(det, det.url || '', '');
  // ATS種別が採用管理システムの時だけゲートを効かせる。媒体/フォームは従来どおり事実を出す。
  const isAts = det.found && det.kind === 'ats';
  const ok = det.found && (!isAts || g.grade === GRADE.CONFIRMED);
  return {
    ATS: ok ? det.name : '',
    ATSベンダー: ok ? det.vendor : '',
    ATS種別: ok ? det.kindLabel : '',
    ATS確度: ok ? (isAts ? (g.confidence || det.confidence) : det.confidence).toFixed(2) : '',
    ATS根拠: ok ? det.evidence : (det.error ? `取得失敗:${det.error}` : ''),
    判定グレード: isAts ? g.grade : (det.found ? '—' : GRADE.NONE),
    新卒根拠: isAts ? (g.reason || '') : '',
    用途: isAts ? (g.scope || '') : '',
    'ATS URL': det.url || '',
    候補ATS: (isAts && !ok) ? `${det.name}(${g.grade}:${g.reason})` : '',
    ATS併用: (det.others || []).map((o) => o.name).join(' / '),
    営業メモ: ok ? (isAts && !det.own ? `新卒で競合ATS導入済み（${det.vendor}）＝リプレイス提案` : salesHint(det)) : atsMemo(det, g),
    ATS判定日: today,
  };
}

/** 確定しなかった時の営業メモ（「使うな」と読める文言にする）。 */
function atsMemo(det, g) {
  if (!det.found) return '判定不能（要目視）';
  if (g.grade === GRADE.CHUTO) return `中途のみ（${det.name}）＝新卒は別。新卒の運用を要ヒアリング`;
  if (g.grade === GRADE.NO_SHINSOTSU) return '新卒採用の記載なし＝対象外の可能性';
  return `要目視（${det.name}の疑い・証拠不十分）`;
}

async function runSingle(url, asJson) {
  const det = await detectOne(url, { live: !!getArg('live', false), liveAll: !!getArg('live-all', false) });
  if (asJson) { console.log(JSON.stringify(det, null, 2)); return; }
  if (!det.found) {
    console.log(`ATS: 判定不能  ${det.error ? '(取得失敗: ' + det.error + ')' : ''}`);
    if (det.fetched) console.log('  ページ取得済みだが該当なし（未登録ベンダー or 自社製フォームの可能性）');
    else if (!det.error) console.log('  ヒント: --live を付けるとページを取得して埋め込みフォームまで見ます');
    return;
  }
  console.log(`ATS      : ${det.name}`);
  console.log(`ベンダー : ${det.vendor}`);
  console.log(`種別     : ${det.kindLabel}${det.own ? '（自社サービス）' : ''}`);
  console.log(`確度     : ${det.confidence.toFixed(2)}（${det.source}）`);
  console.log(`根拠     : ${det.evidence}`);
  if (det.grade && det.kind === 'ats') {
    console.log(`判定     : ${det.grade.grade}（${det.grade.reason}）`);
    console.log(`用途     : ${det.grade.scope}`);
    if (det.grade.grade !== GRADE.CONFIRMED) console.log('  ※ 新卒での利用が確認できていないためリストには載せません');
  }
  if (det.note) console.log(`備考     : ${det.note}`);
  if (det.others && det.others.length) console.log(`併用     : ${det.others.map((o) => `${o.name}(${o.evidence})`).join(' / ')}`);
  // 営業メモはゲート後の判断に合わせる（中途用・要確認で「リプレイス提案」と出さない）
  console.log(`営業メモ : ${toColumns(det, '').営業メモ}`);
}

async function runBatch() {
  const IN = String(getArg('in', ''));
  const OUT = String(getArg('out', IN.replace(/\.csv$/i, '') + '-ats.csv'));
  const LIMIT = getIntArg('limit', 0);
  const CONC = Math.max(1, getIntArg('conc', 3));
  const LIVE = !!getArg('live', false);
  const LIVE_ALL = !!getArg('live-all', false);
  const ONLY_UNKNOWN = !!getArg('only-unknown', false);
  // 既存の「カスタム情報：利用中ATS」等へ流し込む用（空セルのみ埋める。原本の値は上書きしない）
  const fillArg = getArg('fill-col', '');
  const FILL_COL = (fillArg && fillArg !== true) ? String(fillArg) : '';

  const { headers, records } = readCsv(fs.readFileSync(path.resolve(IN), 'utf8'));
  const urlColArg = getArg('url-col', '');
  const urlCol = (urlColArg && urlColArg !== true) ? String(urlColArg) : pickUrlColumn(headers, records);
  if (!urlCol) { console.error('エントリーURLの列が見つかりません。--url-col で指定してください。'); process.exitCode = 1; return; }
  log(`入力 ${records.length}行 ｜ URL列「${urlCol}」｜ ${(LIVE || LIVE_ALL) ? (LIVE_ALL ? 'ライブ取得: 全行' : 'ライブ取得: URLで決まらない行のみ') : 'オフライン判定のみ'}`);

  const outHeaders = headers.concat(OUT_COLS.filter((c) => !headers.includes(c)));
  if (FILL_COL && !outHeaders.includes(FILL_COL)) outHeaders.push(FILL_COL);
  const today = new Date().toISOString().slice(0, 10);
  const rows = records.map((r) => ({ ...r }));
  const targets = [];
  for (let i = 0; i < rows.length; i++) {
    const url = String(rows[i][urlCol] || '').trim();
    if (!url) continue;
    if (ONLY_UNKNOWN && String(rows[i].ATS || '').trim()) continue;
    targets.push(i);
  }
  if (LIMIT) targets.length = Math.min(targets.length, LIMIT);
  log(`判定対象 ${targets.length}行`);

  const OUTABS = path.resolve(OUT);
  const flush = () => atomicWrite(OUTABS, toCsv(outHeaders, rows));
  const tally = new Map();
  let idx = 0, done = 0, hit = 0, fetched = 0;

  async function worker() {
    while (true) {
      const my = idx++;
      if (my >= targets.length) return;
      const ri = targets[my];
      const det = await detectOne(String(rows[ri][urlCol]).trim(), { live: LIVE, liveAll: LIVE_ALL });
      Object.assign(rows[ri], toColumns(det, today));
      // 空セルのみ補完（CRM由来の既存値は絶対に上書きしない）
      if (FILL_COL && det.found && !String(rows[ri][FILL_COL] || '').trim()) rows[ri][FILL_COL] = det.name;
      if (det.found) { hit++; tally.set(det.name, (tally.get(det.name) || 0) + 1); }
      else tally.set('（判定不能）', (tally.get('（判定不能）') || 0) + 1);
      if (det.fetched) fetched++;
      if (++done % 20 === 0) { flush(); log(`  ${done}/${targets.length}（判明 ${hit}・取得 ${fetched}）`); }
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));
  flush();

  log(`完了: ${done}行判定 ｜ 判明 ${hit}（${(100 * hit / Math.max(1, done)).toFixed(0)}%）｜ ページ取得 ${fetched}件`);
  const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  for (const [name, n] of sorted) console.log(`   ${String(n).padStart(5)}  ${name}`);
  log(`出力 ${OUTABS}`);
}

async function run() {
  const url = getArg('url', '');
  if (getArg('help', false)) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^'use strict';\n/, ''));
    return;
  }
  if (url && url !== true) return runSingle(String(url), !!getArg('json', false));
  if (getArg('in', '')) return runBatch();
  console.log('使い方: node src/enrich-ats.js --url <エントリーURL> [--live]');
  console.log('        node src/enrich-ats.js --in <入力csv> --out <出力csv> [--live]');
  console.log('        （詳細は --help）');
}

if (require.main === module) run().catch((e) => { console.error('FATAL', (e && e.stack) || e); process.exitCode = 1; });
module.exports = { detectOne, toColumns, grade, pickUrlColumn, OUT_COLS };
