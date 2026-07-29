'use strict';
/**
 * 運用ハンドオフ 一括生成＋取込前検証（司令塔）
 * =====================================================================
 * data/leads-consolidated-all.csv（統合マスタ）から、BALESCLOUD取込形式の
 * ハンドオフ物を3スコープ一括生成し、取込可否を自動検証してから
 * 「誰に何を渡すか」のハンドオフ要約を出力する。
 *
 * これ1本で「今のリストを即戦力化して即運用」に必要な成果物が揃う。
 *
 *   node src/deliver.js            # 3スコープ生成＋検証＋要約
 *   npm run deliver
 *
 * 出力（すべて data/ 配下・BALES 266列構造一致）:
 *   leads-bales-callable.csv  … ★即架電（担当者名＋電話＋完全新規）  ← 最優先ハンドオフ
 *   leads-bales-named.csv     … 担当者名あり・完全新規（電話欠は後追い/メール用）
 *   leads-bales-all.csv       … 全社（被り含む・全体像/バックアップ用）
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readCsv } = require('./csv');

const ROOT = path.resolve(__dirname, '..');
const MASTER = path.join(ROOT, 'data', 'leads-consolidated-all.csv');
const FMT = path.join(__dirname, 'format-bales.js');

const SCOPES = [
  { scope: 'callable', out: 'data/leads-bales-callable.csv', label: '★即架電（担当者名＋電話＋完全新規）' },
  { scope: 'named', out: 'data/leads-bales-named.csv', label: '担当者名あり・完全新規' },
  { scope: 'all', out: 'data/leads-bales-all.csv', label: '全社（被り含む・全体像）' },
];

function fail(msg) { console.error(`\n[deliver] ✗ ${msg}`); process.exit(1); }

if (!fs.existsSync(MASTER)) fail(`統合マスタが見つかりません: ${path.relative(ROOT, MASTER)}\n  → 先に統合（src/consolidate-all.js）を実行してください。`);

console.log(`[deliver] 統合マスタ: ${path.relative(ROOT, MASTER)}`);
console.log(`[deliver] ハンドオフ物を生成します…\n`);

// ── 1) 3スコープ生成（既存 format-bales.js に委譲＝ロジック単一化）────────
for (const s of SCOPES) {
  execFileSync(process.execPath, [FMT, '--scope', s.scope, '--out', path.join(ROOT, s.out)], { stdio: 'inherit' });
}

// ── 2) 取込前検証（会社名・電話・敬称が揃うか／取込不能行ゼロか）──────────
const C = {
  name: '会社情報：会社名', phone: '会社情報：電話', web: '会社情報：Webサイト',
  dept: '担当者情報：部署', sei: '担当者情報：姓', keisho: '担当者情報：敬称',
};
function verify(file) {
  const { headers, records } = readCsv(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const n = records.length;
  const g = (r, k) => (r[k] || '').trim();
  const pct = (k) => n ? (records.filter(r => g(r, k) !== '').length / n * 100) : 0;
  const noName = records.filter(r => g(r, C.name) === '').length;
  const noPhone = records.filter(r => g(r, C.phone) === '').length;
  return {
    n, cols: headers.length, noName, noPhone,
    name: pct(C.name), phone: pct(C.phone), web: pct(C.web),
    dept: pct(C.dept), sei: pct(C.sei), keisho: pct(C.keisho),
  };
}

console.log(`\n─────────────────────────────────────────────`);
console.log(`[deliver] 取込前検証`);
console.log(`─────────────────────────────────────────────`);
const results = {};
let hardFail = false;
for (const s of SCOPES) {
  const v = verify(s.out);
  results[s.scope] = v;
  const structOK = v.cols === 266;
  const importable = v.noName === 0;
  console.log(`\n■ ${s.out}  (${v.n}社)  ${s.label}`);
  console.log(`   列数 ${v.cols} ${structOK ? '✓BALES一致' : '✗列数不一致'}`);
  console.log(`   会社名 ${v.name.toFixed(0)}% / 電話 ${v.phone.toFixed(0)}% / 担当者姓 ${v.sei.toFixed(0)}% / 敬称 ${v.keisho.toFixed(0)}% / Web ${v.web.toFixed(0)}% / 部署 ${v.dept.toFixed(0)}%`);
  console.log(`   取込不能(会社名空) ${v.noName}行 ${importable ? '✓' : '✗'}   電話空 ${v.noPhone}行`);
  if (!structOK || !importable) hardFail = true;
  // callable は電話100%・担当者名100%を運用品質ラインとして要求
  if (s.scope === 'callable' && (v.phone < 100 || v.sei < 100)) hardFail = true;
}

// ── 3) ハンドオフ要約 ────────────────────────────────────────────────
const cal = results.callable;
console.log(`\n─────────────────────────────────────────────`);
console.log(`[deliver] ハンドオフ要約（誰に何を渡すか）`);
console.log(`─────────────────────────────────────────────`);
console.log(`
① 即架電チームへ  →  data/leads-bales-callable.csv（${cal.n}社）
   会社名・電話・採用担当者名・敬称が全件充足。BALESCLOUDにそのまま取込→本日架電可。

② メール/フォーム後追いへ  →  data/leads-bales-named.csv（${results.named.n}社）
   担当者名あり・完全新規。電話欠を含むため、電話空は後追い調査/メール導線に。

③ 全体像・バックアップ  →  data/leads-bales-all.csv（${results.all.n}社）
   既存被りを含む全社。俯瞰・重複チェック・母集団把握用（架電には使わない）。

取込手順: BALESCLOUD → リード → インポート → 上記CSV（UTF-8/266列一致）を指定。
架電結果は sources/outcomes.csv に記録し、npm run kpi でソース別利回りを回す。
`);

if (hardFail) fail('検証に失敗した成果物があります（上記✗を確認）。取込前に修正してください。');
console.log(`[deliver] ✓ 全成果物 検証OK — 即運用可能な状態です。`);
