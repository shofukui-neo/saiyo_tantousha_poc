'use strict';
/**
 * build-ats-lists — 利用中ATS（採用管理システム）別の架電リスト ビルダー
 * =====================================================================
 * BALESCLOUD の既存リードを「**どの管理ツールを使っているか**」で切り分け、
 * ツールごとに1本ずつリストを吐く。競合ごとに刺さるトークが違うため、
 * 「かんりくん向け」「sonar向け」…と束ねて渡せる形にするのが目的。
 *
 * ■ ATSの出どころ（2系統・上が優先）
 *   1) CRMの実測値 `カスタム情報：利用中ATS`（手入力・表記ゆれあり）
 *      → src/ats.js の normalizeAtsName() で「sonarATS/SONAR」「採用一括かんりくん/管理くん」を名寄せ
 *   2) --enrich <csv>（enrich-ats.js の出力）でエントリーURLから機械判定した結果を合流
 *      → CRMが空の行だけを埋める。CRMの実測値は上書きしない
 *
 * ■ パイプライン
 *   1) ATS名寄せ → ツール別にバケット化（「無し」「空」は既定で対象外）
 *   2) 除外   : アプローチ禁止／架電拒否／新卒なし・担当外／採用1~2名／電話なし
 *               ／商談進行中・受注済み／MOCHICA既存顧客／IT業種／従業員100名未満(判明時)
 *   3) 名寄せ : company-match で1社1行
 *   4) 採点   : 到達性＋ICP適合＋タイミング＋母集団課題ニーズ で 0-100 → A/B/C
 *   5) 出力   : ツールごとに ①BALES取込用（原本列そのまま） ②根拠つきレビューCSV
 *               ＋ 全ツール横断のレビューCSV ＋ サマリCSV
 *
 * 使い方:
 *   node src/build-ats-lists.js
 *   node src/build-ats-lists.js --min 5                 # 5社未満のツールはファイルを作らない
 *   node src/build-ats-lists.js --include-none          # 「無し（ATS未導入）」層のリストも出す
 *   node src/build-ats-lists.js --enrich data/leads-ats.csv   # URL判定の結果も合流
 *   node src/build-ats-lists.js --keep-it --keep-small  # ICP除外を外す（母数を見たい時）
 *   node src/build-ats-lists.js --outdir data/ats-lists
 */
const fs = require('fs');
const path = require('path');
const { parseCsv, rowsToRecords, toCsv, readCsv, normCompanyName } = require('./csv');
const { normalizeAtsName, KIND_LABEL } = require('./ats');
const { detectBoshudanNeeds } = require('./boshudan-needs');
const { classifyRefusal } = require('./talk-analysis');
const { createMatchIndex } = require('./company-match');
const { buildExclusionIndex } = require('./exclusion-index');
const { isExcludedIndustry, ICP } = require('./icp-rules');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const has = (k) => args.includes(k);

/** BALESの最新エクスポートを拾う（ファイル名に日時が入るため固定できない）。 */
function latestBales() {
  const hit = fs.readdirSync(DATA)
    .filter((f) => /BALESCLOUD.*leadList.*\.csv$/i.test(f))
    .sort();
  return hit.length ? path.join(DATA, hit[hit.length - 1]) : path.join(DATA, 'BALESCLOUD-leadList.csv');
}

const BALES = path.resolve(getArg('--bales', latestBales()));
const CUSTOMERS = path.resolve(getArg('--customers', path.join(DATA, 'MOCHICAの既存顧客リスト - mochica-companies-list.csv')));
const OUTDIR = path.resolve(getArg('--outdir', path.join(DATA, 'ats-lists')));
const ENRICH = getArg('--enrich', '');
const MIN_ROWS = parseInt(getArg('--min', '1'), 10) || 1;
const INCLUDE_NONE = has('--include-none');
const KEEP_IT = has('--keep-it');
const KEEP_SMALL = has('--keep-small');
const TODAY = new Date();

const g = (r, k) => (r[k] == null ? '' : String(r[k]).trim());

// ── 列名（BALES 270列構造）──────────────────────────────────────
const C = {
  id: 'システム管理情報：ID', no: 'システム管理情報：No', created: 'システム管理情報：リード作成日時',
  url: 'システム管理情報：リードURL', name: '会社情報：会社名', phone: '会社情報：電話',
  phone2: '担当者情報：電話', web: '会社情報：Webサイト', industry: '会社情報：業種',
  emp: '会社情報：従業員規模', pref: '会社情報：住所：都道府県',
  dept: '担当者情報：部署', title: '担当者情報：役職', sei: '担当者情報：姓', mei: '担当者情報：名',
  mail: '担当者情報：メール', stage: 'リード関連情報：最終リードステージ', owner: 'リード関連情報：リード所有者',
  pending: 'カスタム情報：ペンディング理由', ats: 'カスタム情報：利用中ATS',
  hire: 'カスタム情報：採用人数(選択リスト)', kento: 'カスタム情報：検討開始時期',
  banned: 'カスタム情報：アプローチ禁止の種類',
  callAt: 'コール結果1：開始日時', callResult: 'コール結果1：結果', callComment: 'コール結果1：コメント',
  lostAt: 'カスタム情報：失注商談失注日', lostWhy: 'カスタム情報：失注商談失注理由大',
};

// 架電しても新卒ATSの話にならない／してはいけない構造的ブロッカー（build-boshudan-list と同じ基準）
const PENDING_BLOCK = new Set(['新卒やってない', '新卒担当ではない', '従業員数49名以下', '接触人数が30人以下', '採用人数が1~2名']);
const REFUSAL_BLOCK = new Set(['アプローチ禁止・架電拒否', '新規営業を一律お断り']);
const LOST_BLOCK = new Set(['接触人数不足']);
const PLACEHOLDER_SEI = /^(\[.*\]|担当者|採用担当者?|人事担当|ご?担当者?様?|不明|未定|なし|御中|Unknown)$/i;

const empNum = (v) => { const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10); return Number.isFinite(n) && n > 0 ? n : null; };
const hireNum = (v) => { const m = String(v || '').match(/([0-9]+)/); return m ? parseInt(m[1], 10) : null; };
function monthsAhead(kento) {
  const m = String(kento || '').match(/^([0-9]{1,2})月$/);
  if (!m) return null;
  const mon = parseInt(m[1], 10);
  return (mon >= 1 && mon <= 12) ? (mon - (TODAY.getMonth() + 1) + 12) % 12 : null;
}
const toTime = (s) => { const t = Date.parse(String(s || '').replace(/\//g, '-')); return Number.isFinite(t) ? t : 0; };

// ── 採点（0-100・透明な加点式）────────────────────────────────────
// 競合ATS利用中の層に対しては「いつ切り替え検討に入るか（タイミング）」と
// 「MOCHICAが売れる規模か（ICP）」が読める順に並べたい。
function scoreLead(rec, needs) {
  const why = [];
  let s = 0;

  const hire = hireNum(g(rec, C.hire));
  if (hire != null && hire >= ICP.HIRE_MIN) { s += 22; why.push(`新卒${ICP.HIRE_MIN}名以上+22`); }
  else if (hire != null && hire >= 3) { s += 10; why.push('新卒3~5名+10'); }

  const emp = empNum(g(rec, C.emp));
  if (emp != null && emp >= ICP.EMP_SWEET_MIN && emp <= ICP.EMP_SWEET_MAX) { s += 18; why.push(`従業員${ICP.EMP_SWEET_MIN}-${ICP.EMP_SWEET_MAX}名(スイート)+18`); }
  else if (emp != null && emp >= ICP.EMP_MIN && emp <= ICP.EMP_MAX) { s += 10; why.push('従業員が有効レンジ+10'); }

  const sei = g(rec, C.sei);
  const named = !!sei && !PLACEHOLDER_SEI.test(sei);
  if (named) { s += 12; why.push('担当者を名指しできる+12'); }

  // 母集団課題を自ら語っている＝ATS入替の動機が既に言語化されている
  if (needs.level === '強') { s += 18; why.push('母集団課題を明言+18'); }
  else if (needs.level) { s += 10; why.push('母集団が薄い実態+10'); }

  const ma = monthsAhead(g(rec, C.kento));
  if (ma != null && ma <= 3) { s += 14; why.push(`検討開始が${ma}ヶ月以内+14`); }
  else if (ma != null && ma <= 6) { s += 7; why.push('検討開始が半年以内+7'); }

  if (g(rec, C.lostAt)) { s += 8; why.push('過去商談あり(失注リサイクル)+8'); }

  const last = Math.max(toTime(g(rec, C.callAt)), toTime(g(rec, C.created)));
  if (last && (Date.now() - last) < 365 * 24 * 3600 * 1000) { s += 8; why.push('直近1年以内に接点+8'); }

  return { score: Math.min(100, s), why: why.join('／'), named, hire, emp, recency: last };
}
// 閾値は実分布に合わせる（1,178社の実測で A=上位約1割・B=上位約4割）。
// 満点は「新卒6名+規模スイート+名指し可+母集団課題明言+検討時期が目前+過去商談+直近接点」が揃った時だけ。
const priorityOf = (s) => (s >= 60 ? 'A：今週架電' : s >= 44 ? 'B：次点' : 'C：ナーチャリング');

// ── URL判定の合流（enrich-ats.js の出力）──────────────────────────
// CRMが空の行だけを埋める。CRMの実測値（人間が聞いた事実）は上書きしない。
function loadEnrichIndex(file) {
  const idx = createMatchIndex();
  const byKey = new Map();
  const { records } = readCsv(fs.readFileSync(path.resolve(file), 'utf8'));
  let n = 0;
  for (const r of records) {
    const name = r['企業名'] || r['会社名'] || r['会社情報：会社名'] || '';
    const ats = String(r['ATS'] || '').trim();
    if (!name || !ats) continue;
    const key = normCompanyName(name);
    if (!key || byKey.has(key)) continue;
    idx.addName(name, key);
    byKey.set(key, { ats, kind: r['ATS種別'] || '', evidence: r['ATS根拠'] || '' });
    n++;
  }
  return { lookup: (name) => { const h = idx.matchDetail({ 企業名: name }); return h.matched ? byKey.get(h.label) : null; }, size: n };
}

// ── メイン ───────────────────────────────────────────────────────
const parsed = parseCsv(fs.readFileSync(BALES, 'utf8'));
const HEADERS = parsed[0];
const { records } = rowsToRecords(parsed);
console.log(`[ats-lists] BALES既存リード ${records.length}件（${HEADERS.length}列）を走査`);
console.log(`[ats-lists] 入力 ${path.basename(BALES)}`);

const custIdx = buildExclusionIndex({ layers: ['customers'], files: { customers: CUSTOMERS }, quiet: true }).idx;
console.log(`[ats-lists] MOCHICA既存顧客 ${custIdx.size}社を除外対象に読込`);

let enrich = null;
if (ENRICH) {
  enrich = loadEnrichIndex(ENRICH);
  console.log(`[ats-lists] URL判定の合流元 ${enrich.size}社を読込（${path.basename(ENRICH)}）`);
}

const drop = {};
const bump = (k) => { drop[k] = (drop[k] || 0) + 1; };
const srcTally = { CRM: 0, URL判定: 0 };
const cand = [];
let atsNamed = 0, atsNone = 0, atsEmpty = 0;

for (const rec of records) {
  // ① 利用中ATSの確定（CRM優先・空ならURL判定）
  let norm = normalizeAtsName(g(rec, C.ats));
  let source = 'CRM（利用中ATS）';
  if (norm.status === 'empty' && enrich) {
    const e = enrich.lookup(g(rec, C.name));
    if (e) { norm = normalizeAtsName(e.ats); source = 'エントリーURL判定'; }
  }
  if (norm.status === 'empty') { atsEmpty++; continue; }
  if (norm.status === 'none') { atsNone++; if (!INCLUDE_NONE) continue; }
  else atsNamed++;
  if (norm.own) { bump('MOCHICA利用中（自社顧客）'); continue; }

  // ② 除外（架電不能・アプローチ不可・ICP不適合）
  if (g(rec, C.banned)) { bump('アプローチ禁止'); continue; }
  const refusal = classifyRefusal({ comment: g(rec, C.callComment), pending: g(rec, C.pending) });
  if (REFUSAL_BLOCK.has(refusal)) { bump('架電拒否・新規営業お断り'); continue; }
  if (PENDING_BLOCK.has(g(rec, C.pending))) { bump('ペンディング理由：' + g(rec, C.pending)); continue; }
  if (g(rec, C.hire) === '1～2名') { bump('採用1~2名（採用フロア未満）'); continue; }
  const phone = g(rec, C.phone) || g(rec, C.phone2);
  if (!phone) { bump('電話番号なし（架電不能）'); continue; }
  const lostAt = g(rec, C.lostAt);
  if (/コンバート/.test(g(rec, C.stage)) && !lostAt) { bump('商談進行中/受注済み（失注日なし）'); continue; }
  if (LOST_BLOCK.has(g(rec, C.lostWhy))) { bump('失注理由：' + g(rec, C.lostWhy)); continue; }
  if (custIdx.has(rec)) { bump('MOCHICA既存顧客'); continue; }
  if (!KEEP_IT && isExcludedIndustry(g(rec, C.industry))) { bump('IT/ソフト（ICP絶対除外）'); continue; }
  const emp = empNum(g(rec, C.emp));
  if (!KEEP_SMALL && emp != null && emp < ICP.EMP_MIN) { bump(`従業員${ICP.EMP_MIN}名未満（判明分のみ）`); continue; }

  const needs = detectBoshudanNeeds(rec) || { level: '', categories: [], evidence: '' };
  const sc = scoreLead(rec, needs);
  srcTally[source === 'CRM（利用中ATS）' ? 'CRM' : 'URL判定']++;
  cand.push({ rec, norm, source, needs, sc, phone, recency: sc.recency });
}

// ── 1社1行に名寄せ（同一社の複数リードは最良の1件を残す）──────────
const best = new Map();
const bucketIdx = createMatchIndex();
for (const x of cand) {
  const name = g(x.rec, C.name);
  const hitDetail = bucketIdx.matchDetail({ 企業名: name });
  const key = hitDetail.matched ? hitDetail.label : (normCompanyName(name) || ('id:' + g(x.rec, C.id)));
  if (!hitDetail.matched) bucketIdx.addName(name, key);
  const prev = best.get(key);
  if (!prev || x.sc.score > prev.sc.score || (x.sc.score === prev.sc.score && x.recency > prev.recency)) best.set(key, x);
}
const rows = [...best.values()].sort((a, b) => b.sc.score - a.sc.score || b.recency - a.recency);
const dupeMerged = cand.length - rows.length;

// ── ツール別にバケット化 ─────────────────────────────────────────
const buckets = new Map();   // 正規名 -> { norm, items[] }
for (const x of rows) {
  const k = x.norm.name;
  if (!buckets.has(k)) buckets.set(k, { norm: x.norm, items: [] });
  buckets.get(k).items.push(x);
}
const ordered = [...buckets.entries()].sort((a, b) => b[1].items.length - a[1].items.length);

// ── 出力 ─────────────────────────────────────────────────────────
fs.mkdirSync(OUTDIR, { recursive: true });
const safe = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '');

const R_HEADERS = ['利用中ATS', 'ATSベンダー', 'ATS判定元', '優先度', 'スコア', '会社名', '電話', '担当者姓', '担当者名',
  '名指し可否', '役職', '部署', '採用人数', '従業員規模', '業種', '都道府県', '検討開始時期',
  '母集団ニーズ', '母集団ニーズ根拠', '最終リードステージ', 'ペンディング理由', '接点区分', '失注日', '失注理由',
  '直近コール日時', '直近コール結果', 'リード所有者', 'スコア根拠', 'Webサイト', 'リードURL', 'リードID'];

const toReview = (x) => ({
  利用中ATS: x.norm.name,
  ATSベンダー: x.norm.vendor || (x.norm.status === 'unknown' ? '（未登録の製品名）' : ''),
  ATS判定元: x.source,
  優先度: priorityOf(x.sc.score),
  スコア: String(x.sc.score),
  会社名: g(x.rec, C.name),
  電話: x.phone,
  担当者姓: g(x.rec, C.sei),
  担当者名: g(x.rec, C.mei),
  名指し可否: x.sc.named ? '実名' : '窓口名のみ',
  役職: g(x.rec, C.title),
  部署: g(x.rec, C.dept),
  採用人数: g(x.rec, C.hire),
  従業員規模: g(x.rec, C.emp),
  業種: g(x.rec, C.industry),
  都道府県: g(x.rec, C.pref),
  検討開始時期: g(x.rec, C.kento),
  母集団ニーズ: x.needs.level || '',
  母集団ニーズ根拠: String(x.needs.evidence || '').replace(/\s+/g, ' ').slice(0, 300),
  最終リードステージ: g(x.rec, C.stage),
  ペンディング理由: g(x.rec, C.pending),
  接点区分: g(x.rec, C.lostAt) ? '過去商談あり（失注リサイクル）' : '未商談（架電接点のみ）',
  失注日: g(x.rec, C.lostAt).replace(/ 0:00:00$/, ''),
  失注理由: g(x.rec, C.lostWhy),
  直近コール日時: g(x.rec, C.callAt),
  直近コール結果: g(x.rec, C.callResult),
  リード所有者: g(x.rec, C.owner),
  スコア根拠: x.sc.why,
  Webサイト: g(x.rec, C.web),
  リードURL: g(x.rec, C.url),
  リードID: g(x.rec, C.id),
});

const written = [];
for (const [name, b] of ordered) {
  if (b.items.length < MIN_ROWS) continue;
  const stem = path.join(OUTDIR, `ATS別-${safe(name)}`);
  // ① BALES取込用（原本の値そのまま／Noだけ振り直し）
  const importRecs = b.items.map((x, i) => {
    const o = {};
    for (const h of HEADERS) o[h] = x.rec[h] == null ? '' : x.rec[h];
    o[C.no] = String(i + 1);
    return o;
  });
  fs.writeFileSync(`${stem}-取込用.csv`, '﻿' + toCsv(HEADERS, importRecs), 'utf8');
  // ② 根拠つきレビューCSV
  fs.writeFileSync(`${stem}-根拠.csv`, '﻿' + toCsv(R_HEADERS, b.items.map(toReview)), 'utf8');
  written.push({ name, n: b.items.length, stem });
}

// 全ツール横断（1枚で見比べる用）
fs.writeFileSync(path.join(OUTDIR, '_全ツール横断-根拠.csv'), '﻿' + toCsv(R_HEADERS, rows.map(toReview)), 'utf8');

// サマリ
const S_HEADERS = ['利用中ATS', 'ベンダー', '種別', '社数', 'A：今週架電', 'B：次点', 'C：ナーチャリング',
  '名指し可', '新卒6名以上', '母集団ニーズあり', '過去商談あり', '定義登録', 'ファイル'];
const summary = ordered.map(([name, b]) => {
  const it = b.items;
  const cnt = (f) => it.filter(f).length;
  return {
    利用中ATS: name,
    ベンダー: b.norm.vendor || '',
    種別: KIND_LABEL[b.norm.kind] || (b.norm.status === 'none' ? 'ATS未導入' : '不明（CRMの製品名を特定できず）'),
    社数: String(it.length),
    'A：今週架電': String(cnt((x) => priorityOf(x.sc.score).startsWith('A'))),
    'B：次点': String(cnt((x) => priorityOf(x.sc.score).startsWith('B'))),
    'C：ナーチャリング': String(cnt((x) => priorityOf(x.sc.score).startsWith('C'))),
    名指し可: String(cnt((x) => x.sc.named)),
    新卒6名以上: String(cnt((x) => (x.sc.hire || 0) >= ICP.HIRE_MIN)),
    母集団ニーズあり: String(cnt((x) => !!x.needs.level)),
    過去商談あり: String(cnt((x) => !!g(x.rec, C.lostAt))),
    定義登録: b.norm.status === 'known' ? '済' : (b.norm.status === 'none' ? '—' : '未登録（CRM表記のまま）'),
    ファイル: it.length >= MIN_ROWS ? `ATS別-${safe(name)}-根拠.csv` : '（社数不足で未出力）',
  };
});
fs.writeFileSync(path.join(OUTDIR, '_ATS別サマリ.csv'), '﻿' + toCsv(S_HEADERS, summary), 'utf8');

// ── コンソールサマリ ─────────────────────────────────────────────
console.log(`\n─────────────────────────────────────────────`);
console.log(`[ats-lists] 利用中ATSの記録状況（BALES全${records.length}件）`);
console.log(`─────────────────────────────────────────────`);
console.log(`  ツール名あり  ${atsNamed}件`);
console.log(`  「無し」      ${atsNone}件${INCLUDE_NONE ? '（--include-none で対象に含めた）' : '（対象外。--include-none で出力可）'}`);
console.log(`  未記入        ${atsEmpty}件${enrich ? '（URL判定でも埋まらなかった分）' : '（--enrich でURL判定を合流可）'}`);
console.log(`\n[ats-lists] 除外（架電不能・アプローチ不可・ICP不適合）`);
for (const [k, v] of Object.entries(drop).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}件  ${k}`);
console.log(`  ${String(dupeMerged).padStart(4)}件  同一社の重複リードを統合（1社1行）`);
console.log(`\n[ats-lists] ツール別リスト（計 ${rows.length}社 / ${ordered.length}ツール）`);
console.log(`  ${'ツール'.padEnd(22)} 社数   A/B/C        名指し可 新卒6名+ ニーズ有 判定元`);
for (const [name, b] of ordered) {
  const it = b.items;
  const cnt = (f) => it.filter(f).length;
  const abc = `${cnt((x) => priorityOf(x.sc.score).startsWith('A'))}/${cnt((x) => priorityOf(x.sc.score).startsWith('B'))}/${cnt((x) => priorityOf(x.sc.score).startsWith('C'))}`;
  const url = cnt((x) => x.source !== 'CRM（利用中ATS）');
  console.log(`  ${name.padEnd(22)} ${String(it.length).padStart(4)}  ${abc.padEnd(12)} ${String(cnt((x) => x.sc.named)).padStart(6)} ${String(cnt((x) => (x.sc.hire || 0) >= ICP.HIRE_MIN)).padStart(8)} ${String(cnt((x) => !!x.needs.level)).padStart(7)}  ${url ? `URL判定${url}社` : 'CRM'}`);
}
console.log(`\n[ats-lists] 出力 ${OUTDIR}`);
console.log(`  ツール別 ${written.length}種 × 2ファイル（取込用／根拠）`);
console.log(`  _全ツール横断-根拠.csv ・ _ATS別サマリ.csv`);
if (ordered.length > written.length) console.log(`  ※ ${ordered.length - written.length}ツールは ${MIN_ROWS}社未満のため個別ファイル未出力（横断CSVには含まれる）`);
console.log(`\n  ※ 個人情報を含みます。取り扱いは SECURITY.md に従い、納品時はダウンロードフォルダへ移動してください。`);
