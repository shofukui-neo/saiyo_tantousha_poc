'use strict';
/**
 * build-ats-shinsotsu-list — 卒年別「新卒でATSを使っている企業」の横断一覧
 * =====================================================================
 * enrich-ats-all のスキャン結果から、**新卒での利用が確認できた（判定グレード=確定）**行だけを取り、
 * 卒年（27卒／28卒…）で絞ってツール横断の一覧を作る。
 *
 * 「27卒でかんりくんを使っている会社」「28卒でAOLの会社」を1枚で見たい、という用途。
 * 競合ATSごとにトークが変わるうえ、卒年で商談タイミング（切替検討の時期）が変わるため、
 * ATS×卒年の2軸で並べられる形にしておく。
 *
 * ■ 入れないもの（誤って架電させないため）
 *   - 判定グレードが確定でない行（中途用・要確認・新卒採用なし）
 *   - MOCHICA自身（＝既存顧客）
 *   確定でも卒年が読めなかった行は既定で除外し、`--include-unknown-year` で別枠に出せる。
 *
 * ■ BALESとの突合
 *   ホスト一致 → 会社名一致（company-match）の順で照合し、電話・担当者・従業員規模・
 *   採用人数・リードURL・CRMの利用中ATSを付ける。**架電可否の判断材料は落とさず列で持つ**
 *   （アプローチ禁止・架電拒否・ペンディング理由）。行は消さずフラグで示し、
 *   架電可の部分集合を別ファイルにも出す。
 *
 * 使い方:
 *   node src/build-ats-shinsotsu-list.js                       # 27卒・28卒（既定）
 *   node src/build-ats-shinsotsu-list.js --years 27,28,29
 *   node src/build-ats-shinsotsu-list.js --include-unknown-year # 卒年不明の確定行も別ファイルで出す
 *   node src/build-ats-shinsotsu-list.js --scan data/ats-scan/ats-scan-all.csv
 *   node src/build-ats-shinsotsu-list.js --outdir data/ats-shinsotsu
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, normCompanyName } = require('./csv');
const { getArg, log, atomicWrite } = require('./cli-util');
const { hostOfUrl, normalizeAtsName } = require('./ats');
const { createMatchIndex } = require('./company-match');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const SCAN = path.resolve(String(getArg('scan', path.join(DATA, 'ats-scan', 'ats-scan-確定.csv'))));
const OUTDIR = path.resolve(String(getArg('outdir', path.join(DATA, 'ats-shinsotsu'))));
const YEARS = String(getArg('years', '27,28')).split(',').map((y) => y.trim().replace(/卒$/, '')).filter(Boolean);
const INCLUDE_UNKNOWN = !!getArg('include-unknown-year', false);
const TODAY = new Date().toISOString().slice(0, 10);

const g = (r, k) => (r[k] == null ? '' : String(r[k]).trim());

// ── BALES（連絡先・架電可否の出どころ）───────────────────────────
const C = {
  id: 'システム管理情報：ID', url: 'システム管理情報：リードURL', name: '会社情報：会社名',
  phone: '会社情報：電話', phone2: '担当者情報：電話', web: '会社情報：Webサイト',
  industry: '会社情報：業種', emp: '会社情報：従業員規模', pref: '会社情報：住所：都道府県',
  dept: '担当者情報：部署', title: '担当者情報：役職', sei: '担当者情報：姓', mei: '担当者情報：名',
  mail: '担当者情報：メール', stage: 'リード関連情報：最終リードステージ',
  pending: 'カスタム情報：ペンディング理由', ats: 'カスタム情報：利用中ATS',
  hire: 'カスタム情報：採用人数(選択リスト)', kento: 'カスタム情報：検討開始時期',
  banned: 'カスタム情報：アプローチ禁止の種類', callResult: 'コール結果1：結果',
};
/** BALESの最新エクスポート（ファイル名に日時が入るので固定できない）。 */
function latestBales() {
  const hit = fs.readdirSync(DATA).filter((f) => /BALESCLOUD.*leadList.*\.csv$/i.test(f)).sort();
  return hit.length ? path.join(DATA, hit[hit.length - 1]) : '';
}

/**
 * 統合マスタ（leads-consolidated-all.csv ほか）をホスト＋会社名で引ける索引にする。
 * BALES未登録の会社（＝完全新規）でも、ここに電話・担当者名があることが多い。
 * BALESに無いから連絡先が空、では架電に回せないので第2の突合元として使う。
 */
function buildMasterIndex() {
  const files = [
    { file: path.join(DATA, 'leads-consolidated-all.csv'), src: '統合マスタ' },
    { file: path.join(DATA, 'leads-mochica-target.csv'), src: 'ターゲット' },
  ].filter((f) => fs.existsSync(f.file));
  if (!files.length) return null;
  const byHost = new Map();
  const byName = new Map();
  const idx = createMatchIndex();
  for (const { file, src } of files) {
    const { records } = readCsv(fs.readFileSync(file, 'utf8'));
    for (const r of records) {
      const row = { ...r, _src: src };
      const h = hostOfUrl(g(r, '公式URL') || g(r, '採用ページURL'));
      if (h && (!byHost.has(h) || (!g(byHost.get(h), '電話番号') && g(r, '電話番号')))) byHost.set(h, row);
      const key = normCompanyName(g(r, '企業名'));
      if (key && !byName.has(key)) { byName.set(key, row); idx.addName(g(r, '企業名'), key); }
    }
    log(`  ${path.basename(file)} ${records.length}行`);
  }
  return {
    lookup(host, name) {
      if (host && byHost.has(host)) return { rec: byHost.get(host), how: '統合マスタ（ホスト）' };
      const hit = name ? idx.matchDetail({ 企業名: name }) : null;
      if (hit && hit.matched) return { rec: byName.get(hit.label), how: '統合マスタ（社名）' };
      return { rec: null, how: '' };
    },
  };
}

/**
 * BALESをホスト＋会社名の2系統で引ける索引にする。
 * 会社名は表記ゆれ（（株）／株式会社／全角）が激しいのでホスト一致を先に試す。
 */
function buildBalesIndex() {
  const file = latestBales();
  if (!file) { log('  （BALESエクスポートが見つからないので連絡先は付きません）'); return null; }
  const { records } = readCsv(fs.readFileSync(file, 'utf8'));
  const byHost = new Map();
  const byName = new Map();
  const idx = createMatchIndex();
  for (const r of records) {
    const h = hostOfUrl(g(r, C.web));
    // 同じ会社が複数行ある。電話が入っている行を優先して1行に畳む
    if (h && (!byHost.has(h) || (!g(byHost.get(h), C.phone) && g(r, C.phone)))) byHost.set(h, r);
    const key = normCompanyName(g(r, C.name));
    if (key && !byName.has(key)) { byName.set(key, r); idx.addName(g(r, C.name), key); }
  }
  log(`  ${path.basename(file)} ${records.length}行（ホスト${byHost.size}・社名${byName.size}）`);
  return {
    lookup(host, name) {
      if (host && byHost.has(host)) return { rec: byHost.get(host), how: 'ホスト一致' };
      const hit = name ? idx.matchDetail({ 企業名: name }) : null;
      if (hit && hit.matched) return { rec: byName.get(hit.label), how: '社名一致' };
      return { rec: null, how: '' };
    },
  };
}

// ── 架電可否（行は消さずに理由を持つ）────────────────────────────
const PENDING_BLOCK = new Set(['新卒やってない', '新卒担当ではない', '従業員数49名以下', '接触人数が30人以下', '採用人数が1~2名']);
/**
 * 架電してよいか。ダメな理由を返す（空文字＝架電可）。
 * 一覧からは消さない。「27卒でかんりくんを使っている会社」の全体像が知りたい用途なので、
 * 架電可否は別の軸として列に置く。
 */
function callBlockReason(rec) {
  if (!rec) return '';
  if (g(rec, C.banned)) return `アプローチ禁止（${g(rec, C.banned)}）`;
  const p = g(rec, C.pending);
  if (PENDING_BLOCK.has(p)) return `ペンディング（${p}）`;
  if (/拒否|お断り/.test(g(rec, C.callResult))) return `架電拒否（${g(rec, C.callResult)}）`;
  if (!g(rec, C.phone) && !g(rec, C.phone2)) return '電話番号なし';
  return '';
}

const PLACEHOLDER_SEI = /^(\[.*\]|担当者|採用担当者?|人事担当|ご?担当者?様?|不明|未定|なし|御中|Unknown)$/i;

const HEADERS = ['卒年', 'ATS', 'ATSベンダー', '企業名', '電話', '都道府県', '業種', '従業員規模',
  '採用人数', '担当部署', '担当役職', '担当者', 'メール', '検討開始時期', '最終リードステージ',
  '架電可否', 'CRM利用中ATS', 'CRMとの一致', '新卒根拠', 'ATS URL', 'ホスト', '起点URL',
  '判定経路', 'BALES突合', 'リードURL', '判定日', '作成日'];

/**
 * 1行を組み立てる。連絡先は **BALES優先 → 統合マスタで補完**。
 * BALESは架電履歴（＝架電可否の根拠）を持つので優先し、空欄だけをマスタで埋める。
 * @param {object} s   スキャン結果の行
 * @param {object} hit BALES突合の結果 { rec, how }
 * @param {object} mhit 統合マスタ突合の結果 { rec, how }
 */
function toRow(s, hit, mhit) {
  const rec = hit.rec;
  const m = mhit && mhit.rec;
  const sei = rec ? g(rec, C.sei) : '';
  const mei = rec ? g(rec, C.mei) : '';
  const named = sei && !PLACEHOLDER_SEI.test(sei);
  const mName = m ? g(m, '採用担当者名') : '';
  const pick = (a, b) => (a || b || '');
  const blocked = callBlockReason(rec);
  const phone = pick(rec ? (g(rec, C.phone) || g(rec, C.phone2)) : '', m ? g(m, '電話番号') : '');
  return {
    卒年: g(s, '卒年') || '（卒年不明）',
    ATS: g(s, 'ATS'), ATSベンダー: g(s, 'ATSベンダー'),
    企業名: g(s, '企業名') || (rec ? g(rec, C.name) : '') || (m ? g(m, '企業名') : ''),
    電話: phone,
    都道府県: pick(rec ? g(rec, C.pref) : '', m ? g(m, '都道府県') : ''),
    業種: pick(rec ? g(rec, C.industry) : '', m ? g(m, '業種') : ''),
    従業員規模: pick(rec ? g(rec, C.emp) : '', m ? g(m, '従業員数') : ''),
    採用人数: pick(rec ? g(rec, C.hire) : '', m ? g(m, '採用予定人数') : ''),
    担当部署: pick(rec ? g(rec, C.dept) : '', m ? g(m, '部署') : ''),
    担当役職: pick(rec ? g(rec, C.title) : '', m ? g(m, '役職') : ''),
    担当者: pick(named ? `${sei} ${mei}`.trim() : '', mName),
    メール: pick(rec ? g(rec, C.mail) : '', m ? g(m, 'メール') : ''),
    検討開始時期: rec ? g(rec, C.kento) : '', 最終リードステージ: rec ? g(rec, C.stage) : '',
    // 架電可否はBALESの履歴が正。BALES未登録でも電話があれば架電できるので「新規」と書き分ける
    架電可否: blocked || (rec ? '架電可' : (phone ? '架電可（BALES未登録＝新規）' : '電話番号なし（BALES未登録）')),
    CRM利用中ATS: g(s, 'CRM利用中ATS') || (rec ? g(rec, C.ats) : ''),
    CRMとの一致: g(s, 'CRMとの一致'),
    新卒根拠: g(s, '新卒根拠'), 'ATS URL': g(s, 'ATS URL'), ホスト: g(s, 'ホスト'),
    起点URL: g(s, '起点URL'), 判定経路: g(s, '判定経路'),
    BALES突合: hit.how || (mhit && mhit.how) || '未突合',
    リードURL: rec ? g(rec, C.url) : '',
    判定日: g(s, '判定日'), 作成日: TODAY,
  };
}

/** 卒年セル（`27卒/28卒`）→ 2桁の配列。 */
const yearsOf = (cell) => String(cell || '').split('/').map((y) => y.trim().replace(/卒$/, '')).filter(Boolean);

/** ファイル名に使えない文字を落とす（ATS名に `（）` `/` が入る）。 */
const safeName = (s) => String(s).replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '');

function run() {
  if (!fs.existsSync(SCAN)) {
    console.error(`スキャン結果がありません: ${SCAN}`);
    console.error('  先に `npm run ats:all` を回してください（--scan で別のCSVも指定できます）。');
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(OUTDIR, { recursive: true });
  const { records } = readCsv(fs.readFileSync(SCAN, 'utf8'));
  log(`スキャン結果 ${records.length}行を読込（${path.basename(SCAN)}）`);
  log('BALESと突合中…');
  const bales = buildBalesIndex();
  const master = buildMasterIndex();

  // 確定行のみ。MOCHICA（自社）は既存顧客なので落とす。
  const confirmed = records.filter((r) => {
    const grade = g(r, '判定グレード');
    if (grade && grade !== '確定') return false;
    if (!g(r, 'ATS')) return false;
    return !normalizeAtsName(g(r, 'ATS')).own;
  });
  log(`  新卒での利用が確定 ${confirmed.length}社（MOCHICA自社を除く）`);

  const wanted = [], unknownYear = [], otherYear = [];
  const seen = new Set();
  for (const s of confirmed) {
    const host = g(s, 'ホスト');
    if (host && seen.has(host)) continue;      // 1社1行
    if (host) seen.add(host);
    const ys = yearsOf(g(s, '卒年'));
    const hit = bales ? bales.lookup(host, g(s, '企業名')) : { rec: null, how: '' };
    const mhit = master ? master.lookup(host, g(s, '企業名')) : { rec: null, how: '' };
    const row = toRow(s, hit, mhit);
    if (!ys.length) unknownYear.push(row);
    else if (ys.some((y) => YEARS.includes(y))) wanted.push(row);
    else otherYear.push(row);
  }

  // 卒年 → ATS → 企業名 の順に並べる（架電の束ね方に合わせる）
  const sortRows = (a, b) => (a.卒年.localeCompare(b.卒年) || a.ATS.localeCompare(b.ATS) || a.企業名.localeCompare(b.企業名));
  wanted.sort(sortRows); unknownYear.sort(sortRows); otherYear.sort(sortRows);

  const label = YEARS.map((y) => y + '卒').join('・');
  const main = path.join(OUTDIR, `${YEARS.join('-')}卒-ATS利用企業-横断一覧.csv`);
  atomicWrite(main, '﻿' + toCsv(HEADERS, wanted));

  // 実用版: 卒年の証拠が27/28のもの＋「新卒採用中だが卒年が書かれていない」もの。
  // 2026-09時点で動いている新卒採用は27卒(選考終盤)か28卒(立ち上がり)しかないので、
  // 卒年が読めないだけで落とすと架電先を大量に失う。卒年列で区別できる形で束ねる。
  const current = [...wanted, ...unknownYear].sort(sortRows);
  const currentFile = path.join(OUTDIR, '現行新卒-ATS利用企業-横断一覧.csv');
  atomicWrite(currentFile, '﻿' + toCsv(HEADERS, current));

  // 架電できる分だけの部分集合（そのまま架電に回せる形）
  const callable = current.filter((r) => r.架電可否.startsWith('架電可'));
  atomicWrite(path.join(OUTDIR, '現行新卒-ATS利用企業-架電可.csv'), '﻿' + toCsv(HEADERS, callable));

  // ツール別（競合ごとにトークが変わるので束ねて渡せるように）
  const byAts = new Map();
  for (const r of current) {
    if (!byAts.has(r.ATS)) byAts.set(r.ATS, []);
    byAts.get(r.ATS).push(r);
  }
  const toolDir = path.join(OUTDIR, 'ツール別');
  fs.mkdirSync(toolDir, { recursive: true });
  for (const [ats, rows] of byAts) {
    atomicWrite(path.join(toolDir, `${safeName(ats)}-${YEARS.join('-')}卒.csv`), '﻿' + toCsv(HEADERS, rows));
  }

  if (INCLUDE_UNKNOWN && unknownYear.length) {
    atomicWrite(path.join(OUTDIR, '卒年不明-新卒ATS確定.csv'), '﻿' + toCsv(HEADERS, unknownYear));
  }
  if (otherYear.length) {
    atomicWrite(path.join(OUTDIR, `対象外卒年-新卒ATS確定.csv`), '﻿' + toCsv(HEADERS, otherYear));
  }

  // サマリ（ATS×卒年）
  const summary = [];
  for (const [ats, rows] of [...byAts.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const per = new Map();
    for (const r of rows) for (const y of yearsOf(r.卒年)) per.set(y, (per.get(y) || 0) + 1);
    summary.push({
      ATS: ats, ATSベンダー: rows[0].ATSベンダー, 社数: rows.length,
      ...Object.fromEntries(YEARS.map((y) => [`${y}卒`, per.get(y) || 0])),
      卒年不明: rows.filter((r) => r.卒年 === '（卒年不明）').length,
      架電可: rows.filter((r) => r.架電可否.startsWith('架電可')).length,
      担当者名あり: rows.filter((r) => r.担当者).length,
      BALES未登録: rows.filter((r) => r.BALES突合 === '未突合').length,
    });
  }
  const sumHeaders = ['ATS', 'ATSベンダー', '社数', ...YEARS.map((y) => `${y}卒`), '卒年不明', '架電可', '担当者名あり', 'BALES未登録'];
  atomicWrite(path.join(OUTDIR, '_ATS別サマリ.csv'), '﻿' + toCsv(sumHeaders, summary));

  // ── 画面出力 ──────────────────────────────────────────────────
  console.log(`\n[${label}] ATS利用企業 横断一覧`);
  console.log('─'.repeat(66));
  console.log(`  ${String(current.length).padStart(5)}社  現行新卒（実用版。架電可 ${callable.length}社・担当者名あり ${current.filter((r) => r.担当者).length}社）`);
  console.log(`  ${String(wanted.length).padStart(5)}社    うち ${label} の卒年を証拠として確認`);
  console.log(`  ${String(unknownYear.length).padStart(5)}社    うち 新卒採用は確認したが卒年の記載なし`);
  console.log(`  ${String(otherYear.length).padStart(5)}社  対象外の卒年のみ（過年度ページ＝除外）`);
  console.log('\n  ツール別');
  for (const row of summary) {
    const per = YEARS.map((y) => `${y}卒 ${String(row[`${y}卒`]).padStart(4)}`).join(' / ') + ` / 卒年不明 ${String(row.卒年不明).padStart(4)}`;
    console.log(`    ${String(row.社数).padStart(5)}社  ${row.ATS.padEnd(24)} ${per}  架電可 ${row.架電可}`);
  }
  console.log(`
  出力 ${currentFile}  ← 実用版（27卒・28卒＋卒年の記載なし）`);
  console.log(`       ${path.join(OUTDIR, '現行新卒-ATS利用企業-架電可.csv')}`);
  console.log(`       ${main}  ← 厳密版（卒年の証拠がある分だけ）`);
  console.log(`       ${toolDir}\\（ツール別）`);
  console.log(`       ${path.join(OUTDIR, '_ATS別サマリ.csv')}`);
}

if (require.main === module) run();
module.exports = { toRow, callBlockReason, yearsOf, HEADERS };
