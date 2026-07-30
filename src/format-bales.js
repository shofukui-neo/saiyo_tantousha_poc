'use strict';
/**
 * 統合リスト → BALESCLOUD 既存リスト構造への整形
 * =====================================================================
 * data/leads-consolidated-all.csv を BALESCLOUD のリードリストCSVと同一の
 * カラム構造（266列）に変換して出力する。取込用途を想定し、既定では
 * 「既存被りなし（SF/BALES/MOCHICA顧客と被らない完全新規）」のみを出力する。
 *
 * - ヘッダはBALES実ファイルの1行目をそのまま採用（列順・列名を完全一致）
 * - 統合リストの値を該当BALES列にマッピング、それ以外は空
 * - 住所は都道府県/市区郡/町名・番地に分解、従業員数はBALES規模ブラケットへ丸め
 * - 採用担当者名は姓・名に分割（スペース区切り、無ければ全体を姓へ）
 *
 * ★最終ゲート（2026-07-30）: 入力の「既存被り」列は信用せず、MOCHICA顧客/BALES既存CRM/
 *   SF全リード と**必ず突合し直す**（exclusion-index.js）。加えて納品済み台帳・自己重複・
 *   突合キー無し行も落とし、除外明細を <out>.excluded.csv に出す。
 *
 * 使い方:
 *   node src/format-bales.js
 *   node src/format-bales.js --scope all           # 全30,290社（被り含む・再検証OFF）
 *   node src/format-bales.js --scope named         # 既存被りなし かつ 担当者名あり
 *   node src/format-bales.js --scope callable      # 既存被りなし かつ 担当者名あり かつ 電話番号あり（★架電可能）
 *   node src/format-bales.js --out data/xxx.csv
 *   node src/format-bales.js --no-verify-masters   # 再検証OFF（従来動作・非推奨）
 *   node src/format-bales.js --no-fuzzy            # 長音ゆれ突合(tier5)を無効化
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, parseCsv } = require('./csv');
const { loadLedger, isDelivered, appendRecords, DEFAULT_LEDGER } = require('./delivered-ledger');
const { createMatchIndex, hasKey } = require('./company-match');
const { buildExclusionIndex } = require('./exclusion-index');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const IN = path.resolve(getArg('--in', path.join(ROOT, 'data', 'leads-consolidated-all.csv')));
const BALES = path.resolve(getArg('--bales', path.join(ROOT, 'data', 'BALESCLOUDの既存リスト - 202607062007_leadList_utf-8.csv')));
const OUT = path.resolve(getArg('--out', path.join(ROOT, 'data', 'leads-bales-format.csv')));
const SCOPE = getArg('--scope', 'fresh'); // fresh | all | named | callable
const EXCLUDE_REP = args.includes('--exclude-rep'); // 代表者名の流用を除外し「本物の採用担当者名」だけに絞る
const ICP_ONLY = args.includes('--icp-only');       // ICPハード条件合致(呼べる条件=OK)のみに絞る
                                                    // = 担当者名+電話+新卒6名以上+従業員100名以上+非IT（icp-rules.js準拠）
const CLEAN_NAMES = args.includes('--clean-names'); // 採用担当者名のスクレイプ断片を除去、非氏名語の行は落とす
// ── 過去作成企業（納品済み台帳）との重複防止 ────────────────────────
const LEDGER = path.resolve(getArg('--ledger', DEFAULT_LEDGER));
const DEDUPE_HISTORY = !args.includes('--no-dedupe-history'); // 既定ON：台帳に載る過去作成企業を除外
const RECORD = !args.includes('--no-record');                 // 既定ON：今回の出力企業を台帳へ追記
const BATCH = getArg('--batch', '');                          // 台帳に残すバッチ名（既定は出力ファイル名）
// ── 既存被りの再検証（2026-07-30）───────────────────────────────────
// 以前は入力の「既存被り」列を信用していたため、その列を持たない入力
// （マイナビ由来の完全新規パイプライン等）は**無検証**で通り、実測で納品リストの
// 80〜85%が既存顧客/既存CRM/SFリードだった。ここが全成果物の最終ゲートなので、
// 列を信用せず必ずマスタと突合し直す。--no-verify-masters で従来動作。
const VERIFY_MASTERS = !args.includes('--no-verify-masters') && SCOPE !== 'all';
const FUZZY = !args.includes('--no-fuzzy');                   // 長音ゆれ(tier5)突合
const EXCL_OUT = path.resolve(getArg('--out-excluded', OUT.replace(/\.csv$/i, '') + '.excluded.csv'));

// 氏名として使えない語（丸ごと一致で行を落とす）
const NON_NAME_WHOLE_RE = /^(窓口|ご担当|担当者|採用担当|人事担当|総務担当|人事|総務|受付|不明|なし|未定|未記入|御中|担当)$/;
// 氏名に紛れ込むスクレイプ断片トークン（助詞＋動詞など。トークン単位で除去）
const NAME_JUNK_TOKEN_RE = /^(が|を|は|に|へ|と|の|も|で)?(聞く|聞き|問い合わせ|問合せ|について|に関する|宛|より|御中|窓口|係|様|さん|氏|殿)$/;
// スクレイプ断片を落とし、本物の氏名だけ返す（使えなければ ''）
function cleanRecruiterName(name) {
  let n = String(name || '').replace(/　/g, ' ').trim();
  if (!n) return '';
  if (NON_NAME_WHOLE_RE.test(n)) return '';
  const toks = n.split(/\s+/).filter(Boolean).filter((t) => !NAME_JUNK_TOKEN_RE.test(t));
  n = toks.join(' ').trim();
  if (!n || NON_NAME_WHOLE_RE.test(n)) return '';
  return n;
}

// 採用担当者名が実は代表者名（＝担当者ではない）と判定できる行か。
//   ① 採用担当者名 == 代表者名（代表を担当欄に流用） ② 役職が代表/社長/取締役系
const REP_TITLE_RE = /代表|社長|会長|取締役|理事長|監査役|オーナー|創業|CEO|COO|CFO|President|Founder/i;
function isRepName(row) {
  const name = g(row, '採用担当者名');
  const rep = g(row, '代表者名');
  const title = g(row, '役職');
  if (!name) return false;
  if (rep && name === rep) return true;      // 代表者名をそのまま担当欄にコピー
  if (REP_TITLE_RE.test(title)) return true; // 役職が代表・社長・取締役系
  return false;
}

// ── 都道府県分解 ──────────────────────────────────────────────
const PREFS = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
  '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];
// 市区郡の切れ目: 最初の 郡/市/区 まで（政令市の「市＋区」は市までを市区郡にまとめる簡易処理）
function splitAddress(full) {
  let addr = String(full || '').trim();
  if (!addr) return { pref: '', city: '', town: '' };
  // 先頭に句読点等のゴミが付くケースがあるため、県名を文字列内から検出し
  // その位置から住所を切り出す（最も早く出現する県名を採用）
  let pref = '';
  let at = Infinity;
  for (const p of PREFS) {
    const i = addr.indexOf(p);
    if (i >= 0 && i < at) { at = i; pref = p; }
  }
  if (pref) addr = addr.slice(at);
  let rest = pref ? addr.slice(pref.length) : addr;
  // 郡→町村, 市→（区）まで を市区郡に。最初の区切り記号までを拾う。
  const m = rest.match(/^(.+?[郡])(.+?[町村])|^(.+?市.+?区)|^(.+?[市区町村])/);
  let city = '';
  if (m) {
    city = m[1] ? m[1] + m[2] : (m[3] || m[4] || '');
    rest = rest.slice(city.length);
  }
  return { pref, city, town: rest };
}

// ── 従業員数 → BALES規模ブラケット ───────────────────────────
const BRACKETS = [10, 30, 50, 100, 150, 200, 300, 500, 1000, 3000, 5000, 10000];
function toSizeBracket(n) {
  const v = parseInt(String(n).replace(/[^0-9]/g, ''), 10);
  if (!v) return '';
  let b = '';
  for (const t of BRACKETS) { if (v >= t) b = String(t); }
  return b || String(BRACKETS[0]);
}

// ── 氏名分割 ─────────────────────────────────────────────────
function splitName(name) {
  const n = String(name || '').trim().replace(/　/g, ' ');
  if (!n) return { sei: '', mei: '' };
  const parts = n.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return { sei: parts[0], mei: parts.slice(1).join('') };
  return { sei: n, mei: '' };
}

// ── メイン ───────────────────────────────────────────────────
const balesHeaderLine = fs.readFileSync(BALES, 'utf8').split(/\r?\n/)[0];
const HEADERS = parseCsv(balesHeaderLine)[0]; // 266列の正準ヘッダ

const { records: src } = readCsv(fs.readFileSync(IN, 'utf8'));
const g = (row, k) => (row[k] == null ? '' : String(row[k]).trim());

function want(row) {
  if (EXCLUDE_REP && isRepName(row)) return false;      // 代表者名の流用は除外（本物の採用担当者名のみ）
  if (ICP_ONLY && g(row, '呼べる条件') !== 'OK') return false; // ICPハード条件合致のみ
  const overlap = g(row, '既存被り');
  if (SCOPE === 'all') return true;
  if (SCOPE === 'named') return overlap === '' && g(row, '採用担当者名') !== '';
  if (SCOPE === 'callable') return overlap === '' && g(row, '採用担当者名') !== '' && g(row, '電話番号') !== '';
  return overlap === ''; // fresh: 既存被りなしのみ
}

// 台帳（過去作成企業）をロード。DEDUPE_HISTORY=OFF なら空インデックス扱い。
const ledgerIdx = DEDUPE_HISTORY ? loadLedger(LEDGER) : createMatchIndex({ fuzzy: FUZZY });
// 既存被りマスタ（MOCHICA顧客/BALES既存CRM/SF全リード）。台帳は上の ledgerIdx で別集計。
const exclIdx = VERIFY_MASTERS ? buildExclusionIndex({ masters: true, ledger: false, fuzzy: FUZZY }).idx : null;
// 出力内の自己重複（同一企業が複数行）を防ぐ生きた索引
const outIdx = createMatchIndex({ fuzzy: FUZZY });

const out = [];
const emitted = []; // 台帳追記用の元レコード（企業名/法人番号を保持）
const dropped = []; // 除外明細（何がなぜ落ちたかを必ず可視化＝silent drop を作らない）
let seq = 0;
let histDupe = 0, masterDupe = 0, selfDupe = 0, noKey = 0;
const byLabel = new Map(), byTier = new Map();
for (const row of src) {
  if (!want(row)) continue;
  const cname = g(row, '企業名');
  // 突合キーが無い行（社名も法人番号も無い）は「新規」と判定できない＝出さない
  if (!hasKey(row)) { noKey += 1; dropped.push({ 企業名: cname, 除外理由: 'キー無し（突合不能）', 一致マスタ: '', 突合tier: '', 一致相手: '' }); continue; }
  if (DEDUPE_HISTORY && isDelivered(ledgerIdx, row)) { // 過去作成済み＝再出力しない
    histDupe += 1;
    const d = ledgerIdx.matchDetail(row);
    dropped.push({ 企業名: cname, 除外理由: '納品済み台帳', 一致マスタ: d.label, 突合tier: d.tier, 一致相手: d.master });
    continue;
  }
  if (exclIdx) { // 既存被りの再検証（入力列は信用しない）
    const d = exclIdx.matchDetail(row);
    if (d.matched) {
      masterDupe += 1;
      byLabel.set(d.label, (byLabel.get(d.label) || 0) + 1);
      byTier.set(d.tier, (byTier.get(d.tier) || 0) + 1);
      dropped.push({ 企業名: cname, 除外理由: '既存被り（再検証）', 一致マスタ: d.label, 突合tier: d.tier, 一致相手: d.master });
      continue;
    }
  }
  { // 同一成果物内の重複（表記ゆれ含む）
    const s = outIdx.matchDetail(row);
    if (s.matched) { selfDupe += 1; dropped.push({ 企業名: cname, 除外理由: '自己重複', 一致マスタ: '同ファイル', 突合tier: s.tier, 一致相手: s.master }); continue; }
  }
  let recruiter = g(row, '採用担当者名');
  if (CLEAN_NAMES) { recruiter = cleanRecruiterName(recruiter); if (!recruiter) continue; } // 非氏名語は行ごと除外
  outIdx.addRecord(row, cname);
  emitted.push({ 企業名: cname, 法人番号: g(row, '法人番号') });
  seq += 1;
  const { pref, city, town } = splitAddress(g(row, '都道府県'));
  const { sei, mei } = splitName(recruiter);
  const rec = {};
  for (const h of HEADERS) rec[h] = ''; // 全列空で初期化 → 構造完全一致
  rec['システム管理情報：No'] = String(seq);
  rec['会社情報：会社名'] = g(row, '企業名');
  rec['会社情報：電話'] = g(row, '電話番号');
  rec['会社情報：Webサイト'] = g(row, '公式URL');
  rec['会社情報：業種'] = g(row, '業種');
  rec['会社情報：従業員規模'] = toSizeBracket(g(row, '従業員数'));
  rec['会社情報：住所：国'] = pref ? '日本' : '';
  rec['会社情報：住所：都道府県'] = pref;
  rec['会社情報：住所：市区郡'] = city;
  rec['会社情報：住所：町名・番地'] = town;
  rec['担当者情報：部署'] = g(row, '部署');
  rec['担当者情報：役職'] = g(row, '役職');
  rec['担当者情報：姓'] = sei;
  rec['担当者情報：名'] = mei;
  rec['担当者情報：敬称'] = sei ? '様' : '';
  rec['担当者情報：メール'] = g(row, 'メール');
  out.push(rec);
}

fs.writeFileSync(OUT, '﻿' + toCsv(HEADERS, out), 'utf8');
console.log(`[format-bales] scope=${SCOPE}  入力 ${src.length}件 → 出力 ${out.length}件`);
console.log(`[format-bales] 列数 ${HEADERS.length}（BALES構造一致）`);
if (DEDUPE_HISTORY) console.log(`[format-bales] 過去作成企業を除外: ${histDupe}件（台帳 ${ledgerIdx.size}社と突合）`);
if (VERIFY_MASTERS) {
  console.log(`[format-bales] 既存被り 再検証で除外: ${masterDupe}件（マスタ ${exclIdx.size}社と突合）`);
  if (byLabel.size) console.log('              マスタ別: ' + [...byLabel.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' / '));
  if (byTier.size) console.log('              tier別  : ' + [...byTier.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' / '));
} else {
  console.log('[format-bales] ⚠ 既存被りの再検証: OFF（--no-verify-masters/scope=all）＝入力の「既存被り」列を信用しています');
}
console.log(`[format-bales] 自己重複を除外: ${selfDupe}件｜キー無し行: ${noKey}件`);
if (dropped.length) {
  fs.mkdirSync(path.dirname(EXCL_OUT), { recursive: true });
  fs.writeFileSync(EXCL_OUT, '﻿' + toCsv(['企業名', '除外理由', '一致マスタ', '突合tier', '一致相手'], dropped), 'utf8');
  console.log(`[format-bales] 除外明細: ${path.relative(ROOT, EXCL_OUT)}（${dropped.length}件・表記ゆれ誤爆の確認用）`);
}

// 今回の出力企業を台帳へ追記（次回作成時の重複防止）。--no-record で無効化。
if (RECORD && emitted.length) {
  const r = appendRecords(LEDGER, emitted, { batch: BATCH || path.basename(OUT, '.csv'), source: path.basename(OUT) });
  console.log(`[format-bales] 台帳へ追記: 新規 ${r.added}社 / 既出 ${r.skipped}社 → 累計 ${r.total}社（${path.relative(ROOT, LEDGER)}）`);
} else if (!RECORD) {
  console.log('[format-bales] 台帳追記: スキップ（--no-record）');
}
console.log(`[format-bales] out: ${path.relative(ROOT, OUT)}`);
