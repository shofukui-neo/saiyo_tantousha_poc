'use strict';
/**
 * split-boshudan-region — 母集団課題ニーズリストを 東日本／西日本 に分割
 * =====================================================================
 * `npm run boshudan` の成果物（BALES 266列 取込用 ＋ 根拠つきレビュー）を
 * 所在地で東西に割り、そのまま架電チームへ配れる形で出し直す。
 *
 * ■ 東西の境界（既定 = NTT東西型）
 *   東日本: 北海道・東北・関東・甲信越（新潟/長野/山梨）
 *   西日本: 北陸・東海（静岡・愛知含む）以西
 *   → --boundary chubu  で東海・北陸まで東日本（西＝近畿以西）
 *   → --boundary shizuoka で静岡までを東日本（西＝北陸・愛知以西）
 *
 * ■ 都道府県の決め方（BALESの住所欄は欠損・表記ゆれが多い）
 *   1) 「会社情報：住所：都道府県」を正規化（"大阪"→大阪府／住所丸ごと入りも先頭一致で拾う）
 *   2) 空欄なら市外局番から推定（src/areacode.js）。先頭0が落ちた9桁番号も補正。
 *   3) それでも不明な社（IP電話のみ等）は東西どちらにも入れず「地域不明」に隔離する。
 *
 * 使い方:
 *   node src/split-boshudan-region.js
 *   node src/split-boshudan-region.js --boundary chubu
 */
const fs = require('fs');
const path = require('path');
const { parseCsv, rowsToRecords, toCsv } = require('./csv');
const { prefectureForNumber } = require('./areacode');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const SRC_BALES = path.resolve(getArg('--in', path.join(DATA, 'leads-bales-boshudan.csv')));
const SRC_REVIEW = path.resolve(getArg('--review', path.join(DATA, 'bales-母集団課題-根拠.csv')));
const OUT_DIR = path.resolve(getArg('--out-dir', DATA));
const BOUNDARY = getArg('--boundary', 'ntt'); // ntt | chubu | shizuoka

const C = { name: '会社情報：会社名', phone: '会社情報：電話', phone2: '担当者情報：電話', pref: '会社情報：住所：都道府県', no: 'システム管理情報：No' };
const g = (r, k) => (r[k] == null ? '' : String(r[k]).trim());

// ── 都道府県 → 地方 ───────────────────────────────────────────────
const REGION = {
  北海道: '北海道',
  青森県: '東北', 岩手県: '東北', 宮城県: '東北', 秋田県: '東北', 山形県: '東北', 福島県: '東北',
  茨城県: '関東', 栃木県: '関東', 群馬県: '関東', 埼玉県: '関東', 千葉県: '関東', 東京都: '関東', 神奈川県: '関東',
  新潟県: '甲信越', 山梨県: '甲信越', 長野県: '甲信越',
  富山県: '北陸', 石川県: '北陸', 福井県: '北陸',
  岐阜県: '東海', 静岡県: '東海', 愛知県: '東海', 三重県: '東海',
  滋賀県: '近畿', 京都府: '近畿', 大阪府: '近畿', 兵庫県: '近畿', 奈良県: '近畿', 和歌山県: '近畿',
  鳥取県: '中国', 島根県: '中国', 岡山県: '中国', 広島県: '中国', 山口県: '中国',
  徳島県: '四国', 香川県: '四国', 愛媛県: '四国', 高知県: '四国',
  福岡県: '九州', 佐賀県: '九州', 長崎県: '九州', 熊本県: '九州', 大分県: '九州', 宮崎県: '九州', 鹿児島県: '九州', 沖縄県: '九州',
};
const PREFS = Object.keys(REGION);
// 地方の並び（北→南）。出力の都道府県内訳もこの順で見せる。
const REGION_ORDER = ['北海道', '東北', '関東', '甲信越', '北陸', '東海', '近畿', '中国', '四国', '九州'];

// 東日本に入る地方（境界の定義）
const EAST_REGIONS = {
  ntt: new Set(['北海道', '東北', '関東', '甲信越']),
  chubu: new Set(['北海道', '東北', '関東', '甲信越', '北陸', '東海']),
  shizuoka: new Set(['北海道', '東北', '関東', '甲信越']), // ＋静岡県（下の例外で拾う）
}[BOUNDARY];
if (!EAST_REGIONS) { console.error(`--boundary は ntt / chubu / shizuoka のいずれか（指定: ${BOUNDARY}）`); process.exit(1); }
const EAST_PREF_EXTRA = BOUNDARY === 'shizuoka' ? new Set(['静岡県']) : new Set();
const BOUNDARY_LABEL = {
  ntt: 'NTT東西型（東=北海道・東北・関東・甲信越／西=北陸・東海以西）',
  chubu: '中部まで東（東=～北陸・東海／西=近畿以西）',
  shizuoka: '静岡までが東（東=～甲信越＋静岡／西=北陸・愛知以西）',
}[BOUNDARY];

// ── 都道府県の正規化 ─────────────────────────────────────────────
// "大阪" → 大阪府 / "大阪府富田林市向陽台2-2-15 K1ビル"（住所丸ごと）→ 大阪府
function normPref(raw) {
  const s = String(raw || '').replace(/[\s　]/g, '');
  if (!s) return '';
  for (const p of PREFS) {
    if (s.startsWith(p)) return p;
    if (s.startsWith(p.replace(/[都道府県]$/, ''))) return p; // 接尾辞なし表記
  }
  return '';
}
// BALESには先頭0が落ちた9桁番号が混ざる（例 523618515 = 052-361-8515）
function prefFromPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  const fixed = d.length === 9 && d[0] !== '0' ? '0' + d : d;
  return prefectureForNumber(fixed);
}

// ── 読み込み ─────────────────────────────────────────────────────
const balesParsed = parseCsv(fs.readFileSync(SRC_BALES, 'utf8'));
const B_HEADERS = balesParsed[0];
const bales = rowsToRecords(balesParsed).records;
const reviewParsed = parseCsv(fs.readFileSync(SRC_REVIEW, 'utf8'));
const R_HEADERS = reviewParsed[0];
const review = rowsToRecords(reviewParsed).records;
console.log(`[split] 母集団課題リスト ${bales.length}社（BALES ${B_HEADERS.length}列）／レビュー ${review.length}行を読込`);
if (bales.length !== review.length) console.warn(`[split] 警告: 取込用とレビューの行数が不一致（${bales.length} vs ${review.length}）。会社名で突合します。`);

// ── 地域判定（1社ずつ）───────────────────────────────────────────
const decided = bales.map((rec) => {
  let pref = normPref(g(rec, C.pref));
  let src = pref ? '住所' : '';
  if (!pref) { pref = prefFromPhone(g(rec, C.phone) || g(rec, C.phone2)); if (pref) src = '市外局番'; }
  const region = REGION[pref] || '';
  const side = !region ? '地域不明'
    : (EAST_REGIONS.has(region) || EAST_PREF_EXTRA.has(pref)) ? '東日本' : '西日本';
  return { rec, pref, region, side, src: src || '不明' };
});
// レビュー行は会社名で引き当てる（同名衝突は出現順で消費する）
const reviewQueue = new Map();
for (const r of review) {
  const k = g(r, '会社名');
  if (!reviewQueue.has(k)) reviewQueue.set(k, []);
  reviewQueue.get(k).push(r);
}
for (const d of decided) {
  const q = reviewQueue.get(g(d.rec, C.name));
  d.review = q && q.length ? q.shift() : null;
}
const orphan = decided.filter((d) => !d.review).length;
if (orphan) console.warn(`[split] 警告: レビュー行に突合できなかった社 ${orphan}件（取込用CSVのみ出力）`);

// ── 出力 ─────────────────────────────────────────────────────────
// 取込用はBALES 266列を1列も足さずに維持（Noだけ各ファイル内で振り直し）。
// レビュー用には判定の内訳（地方／都道府県／判定根拠）を先頭に足す。
const RV_HEADERS = ['地方', '都道府県', '所在地判定', ...R_HEADERS];
const written = [];
function emit(side, group) {
  const tag = side === '東日本' ? '東日本' : side === '西日本' ? '西日本' : '地域不明';
  const outBales = path.join(OUT_DIR, `leads-bales-boshudan-${tag}.csv`);
  const outReview = path.join(OUT_DIR, `bales-母集団課題-根拠-${tag}.csv`);
  fs.writeFileSync(outBales, '﻿' + toCsv(B_HEADERS, group.map((d, i) => {
    const o = {};
    for (const h of B_HEADERS) o[h] = d.rec[h] == null ? '' : d.rec[h];
    o[C.no] = String(i + 1);
    return o;
  })), 'utf8');
  fs.writeFileSync(outReview, '﻿' + toCsv(RV_HEADERS, group.filter((d) => d.review).map((d) => ({
    地方: d.region || '（不明）', 都道府県: d.pref || '（不明）', 所在地判定: d.src, ...d.review,
  }))), 'utf8');
  written.push([tag, group.length, outBales, outReview]);
}
const east = decided.filter((d) => d.side === '東日本');
const west = decided.filter((d) => d.side === '西日本');
const unknown = decided.filter((d) => d.side === '地域不明');
emit('東日本', east);
emit('西日本', west);
if (unknown.length) emit('地域不明', unknown);

// ── サマリ ───────────────────────────────────────────────────────
const tally = (arr, fn) => { const m = {}; for (const x of arr) { const k = fn(x) || '(不明)'; m[k] = (m[k] || 0) + 1; } return m; };
const pri = (d) => (d.review ? g(d.review, '優先度') : '(不明)');
function report(label, group) {
  if (!group.length) return;
  const byRegion = tally(group, (d) => d.region);
  const byPref = tally(group, (d) => d.pref);
  const byPri = tally(group, pri);
  const strong = group.filter((d) => d.review && g(d.review, 'ニーズ強度') === '強').length;
  const named = group.filter((d) => d.review && g(d.review, '名指し可否') === '実名').length;
  const lost = group.filter((d) => d.review && /失注リサイクル/.test(g(d.review, '接点区分'))).length;
  console.log(`\n■ ${label}  ${group.length}社`);
  console.log(`  優先度      ${Object.entries(byPri).sort().map(([k, v]) => `${k}:${v}`).join(' / ')}`);
  console.log(`  ニーズ強度  強:${strong} / 中:${group.length - strong}`);
  console.log(`  名指し可能  ${named}社（${(named / group.length * 100).toFixed(0)}%）／過去商談あり ${lost}社`);
  for (const r of REGION_ORDER) {
    if (!byRegion[r]) continue;
    const prefs = PREFS.filter((p) => REGION[p] === r && byPref[p]).map((p) => `${p}${byPref[p]}`).join('・');
    console.log(`  ${r.padEnd(4, '　')} ${String(byRegion[r]).padStart(3)}社  ${prefs}`);
  }
}
console.log(`\n─────────────────────────────────────────────`);
console.log(`[split] 境界: ${BOUNDARY_LABEL}`);
console.log(`─────────────────────────────────────────────`);
report('東日本', east);
report('西日本', west);
if (unknown.length) {
  console.log(`\n■ 地域不明  ${unknown.length}社（住所欄が空＋固定電話なしで判定不能。東西どちらにも入れていない）`);
  for (const d of unknown) console.log(`    ${g(d.rec, C.name)}（${g(d.rec, C.phone) || g(d.rec, C.phone2) || '電話なし'}）`);
}
const bySrc = tally(decided, (d) => d.src);
console.log(`\n[split] 所在地の判定内訳  ${Object.entries(bySrc).map(([k, v]) => `${k}:${v}`).join(' / ')}`);
console.log(`[split] 出力`);
for (const [tag, n, a, b] of written) {
  console.log(`  ${tag}（${n}社）`);
  console.log(`    取込用   ${path.relative(ROOT, a)}（${B_HEADERS.length}列・BALES構造一致）`);
  console.log(`    レビュー ${path.relative(ROOT, b)}`);
}
