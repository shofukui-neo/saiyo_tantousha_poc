'use strict';
/**
 * ICP適合 × ATS未導入 × インテントシグナルあり → BALESCLOUD取込形式
 * =====================================================================
 * 層1（ICPハード条件＋ATS未導入）と層2（タイミングシグナル）を1本に結び、
 * 「今かけるべき社」だけを BALESCLOUD の266列構造で出す。
 *
 * 入力は「インテント採点列（intent-analyze.js）＋ATS判定列（enrich-ats.js）＋会社属性」を
 * 持つCSVを複数指定できる（経路の違いは '経路' 列に残す）。
 *
 *   node src/build-icp-ats-intent.js --in A.csv[,B.csv] [--tier C] [--out data/leads-icp-ats-intent.csv]
 *
 * 出力:
 *   data/leads-icp-ats-intent.csv              … 根拠つき詳細（営業が読む用）
 *   data/leads-bales-icp-ats-intent.csv        … BALES取込形式（既存被りなし＝完全新規のみ）★
 *   data/leads-bales-icp-ats-intent-withsf.csv … 同形式・SF既存リード被りを含む参考版
 *   data/leads-icp-ats-intent-report.md        … 件数の内訳と落ちた理由
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readCsv, toCsv, mergeKey, parseCsv } = require('./csv');
const { isExcludedIndustry, isGovernmentOrg, passesIcpFloor, classifyOrgType } = require('./icp-rules');

const ROOT = path.resolve(__dirname, '..');
const getArg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const INS = String(getArg('in', '')).split(',').map((s) => s.trim()).filter(Boolean).map((p) => path.resolve(ROOT, p));
const OUT = path.resolve(ROOT, getArg('out', 'data/leads-icp-ats-intent.csv'));
const TIER_MIN = getArg('tier', 'C'); // A/B/C のうち、ここまでを「シグナル確認できる」と見なす
const TIER_RANK = { A: 3, B: 2, C: 1, D: 0 };
const BALES_OUT = /leads-/.test(path.basename(OUT))
  ? path.join(path.dirname(OUT), path.basename(OUT).replace(/leads-/, 'leads-bales-'))
  : path.join(path.dirname(OUT), 'bales-' + path.basename(OUT)); // 詳細CSVと同名にならないよう必ず別名にする
const BALES_SF = BALES_OUT.replace(/\.csv$/, '-withsf.csv');
const REPORT = OUT.replace(/\.csv$/, '-report.md');
const g = (r, k) => String(r[k] == null ? '' : r[k]).trim();
const num = (v) => { const n = parseInt(String(v || '').replace(/[^0-9]/g, ''), 10); return Number.isFinite(n) && n > 0 ? n : null; };

// 新卒採用人数: 実績(直近年) > 年間新卒採用人数 > 採用予定人数 の順で「判明値」を取る
function hireOf(r) {
  const series = g(r, '採用実績(直近3年)');
  const m = series.match(/(\d{4})年(\d+)名/);
  if (m) return { n: parseInt(m[2], 10), src: `実績${m[1]}年` };
  const a = num(g(r, '年間新卒採用人数')); if (a) return { n: a, src: g(r, '採用人数の種別') || '年間新卒採用人数' };
  const p = num(g(r, '採用予定人数')); if (p) return { n: p, src: '採用予定' };
  return { n: null, src: '' };
}

function icpCheck(r) {
  const name = g(r, '企業名'); const ind = g(r, '業種');
  const reasons = [];
  if (isGovernmentOrg(name, ind)) return { pass: false, reasons: ['官公庁(3出口ブロック)'] };
  // 社名に法人格が付いていても公式URLが自治体ドメインなら官公庁（実例: 「愛知株式会社」= pref.aichi.jp）
  let host = ''; try { host = new URL(g(r, '公式URL')).host; } catch (_) {}
  if (/(^|\.)(pref|city|town|vill)\.[a-z]+\.jp$|\.lg\.jp$/.test(host)) return { pass: false, reasons: ['官公庁(自治体ドメイン ' + host + ')'] };
  if (isExcludedIndustry(ind)) return { pass: false, reasons: ['IT/ソフト=絶対除外(' + ind.slice(0, 20) + ')'] };
  const emp = num(g(r, '従業員数')); const hire = hireOf(r);
  const f = passesIcpFloor({ emp, hire: hire.n });
  if (!f.pass) return { pass: false, reasons: f.reasons };
  reasons.push('非IT(' + (ind.slice(0, 24) || '業種不明') + ')');
  reasons.push(emp ? `従業員${emp}名` : '従業員不明(通す)');
  reasons.push(hire.n ? `新卒${hire.n}名(${hire.src})` : '採用人数不明(要確認)');
  reasons.push(classifyOrgType(name).reason);
  return { pass: true, reasons, emp, hire };
}

const COLS = ['No', '経路', '企業名', '法人番号', '採用担当者名', '役職', '部署', '架電宛名', '電話番号', 'メール', '公式URL',
  '業種', '都道府県', '従業員数', '新卒採用人数', 'ICP根拠',
  'ATS判定', 'ATS確度', 'entry_type', 'entry_host', 'エントリー動線', 'ATSトーク指針', 'ATS根拠', 'ATS検査日',
  'インテントスコア', 'インテント階層', '推奨アクション', '最有力シグナル', 'シグナル強度', '検知シグナル', 'なぜ今', '根拠', '推奨トーク',
  'アポ期待度', '総合優先度', '既存被り', '採用ページURL', '観測日'];

const drop = { ATS未判定: 0, ATS導入済: 0, ATS要確認: 0, ATS不明: 0, インテントなし: 0, ICP不適合: 0, 重複: 0, 電話なし: 0 };
const dropReasons = {};
const seen = new Map();
const rows = [];
for (const file of INS) {
  if (!fs.existsSync(file)) { console.error('入力が見つかりません: ' + file); process.exit(1); }
  const route = path.basename(file, '.csv').replace(/^_tmp-/, '');
  const { records } = readCsv(fs.readFileSync(file, 'utf8'));
  for (const r of records) {
    const ats = g(r, 'ATS判定');
    if (!ats) { drop.ATS未判定++; continue; }
    if (ats !== '未導入') { drop['ATS' + ats] = (drop['ATS' + ats] || 0) + 1; continue; }
    const tier = g(r, 'インテント階層');
    if ((TIER_RANK[tier] || 0) < TIER_RANK[TIER_MIN]) { drop.インテントなし++; continue; }
    if (!g(r, '電話番号')) { drop.電話なし++; continue; }
    const icp = icpCheck(r);
    if (!icp.pass) { drop.ICP不適合++; const k = icp.reasons[0].replace(/\d+/g, 'N'); dropReasons[k] = (dropReasons[k] || 0) + 1; continue; }
    const key = mergeKey({ 法人番号: g(r, '法人番号'), 企業名: g(r, '企業名') });
    if (key && seen.has(key)) { drop.重複++; continue; }
    if (key) seen.set(key, true);
    const o = {};
    for (const c of COLS) o[c] = g(r, c);
    o.経路 = route;
    o.都道府県 = g(r, '都道府県') || g(r, '本社');
    o.新卒採用人数 = icp.hire.n ? String(icp.hire.n) : '';
    o.ICP根拠 = icp.reasons.join('｜');
    o.架電宛名 = g(r, '架電宛名') || (g(r, '採用担当者名') ? g(r, '採用担当者名') + ' 様' : 'ご採用ご担当者様');
    rows.push(o);
  }
}
rows.sort((a, b) => (parseFloat(b.総合優先度) || 0) - (parseFloat(a.総合優先度) || 0) || (parseFloat(b.インテントスコア) || 0) - (parseFloat(a.インテントスコア) || 0));
rows.forEach((r, i) => { r.No = String(i + 1); });
fs.writeFileSync(OUT, '﻿' + toCsv(COLS, rows), 'utf8');

// ── BALES形式（既存 format-bales.js に委譲＝列構造の単一真実源）。台帳追記はしない（--no-record）
const FMT = path.join(__dirname, 'format-bales.js');
execFileSync(process.execPath, [FMT, '--in', OUT, '--scope', 'fresh', '--out', BALES_OUT, '--no-record', '--no-dedupe-history'], { stdio: 'inherit' });
execFileSync(process.execPath, [FMT, '--in', OUT, '--scope', 'all', '--out', BALES_SF, '--no-record', '--no-dedupe-history'], { stdio: 'inherit' });

// ── BALESのカスタム情報欄に「なぜ今か」を載せる（架電者がBALES画面だけで文脈を持てるように）
const byName = new Map(rows.map((r) => [r.企業名, r]));
function annotate(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const { headers, records } = readCsv(text);
  const K = { name: '会社情報：会社名', now: 'カスタム情報：顧客の現状', issue: 'カスタム情報：顧客の課題感', memo: 'カスタム情報：活動予定コメント' };
  for (const rec of records) {
    const r = byName.get(rec[K.name]); if (!r) continue;
    if (K.now in rec) rec[K.now] = `ATS:${r.ATS判定}(${r.エントリー動線 || r.entry_type})／インテント${r.インテント階層}(${r.インテントスコア}) ${r.最有力シグナル}`.slice(0, 250);
    if (K.issue in rec) rec[K.issue] = (r.なぜ今 || '').slice(0, 250);
    if (K.memo in rec) rec[K.memo] = (r.推奨トーク || '').slice(0, 250);
  }
  fs.writeFileSync(file, '﻿' + toCsv(headers, records), 'utf8');
}
annotate(BALES_OUT); annotate(BALES_SF);

// ── レポート
const cnt = (f) => rows.filter(f).length;
const L = [];
L.push('# ICP適合 × ATS未導入 × インテントシグナルあり');
L.push('');
L.push(`作成: ${new Date().toISOString().slice(0, 10)} ／ 入力: ${INS.map((p) => path.relative(ROOT, p)).join(', ')} ／ インテント階層 ${TIER_MIN} 以上`);
L.push('');
L.push(`- 該当: **${rows.length}社**（既存被りなし ${cnt((r) => !r.既存被り)}社 ／ SF既存リード被り ${cnt((r) => r.既存被り)}社）`);
L.push(`- 階層: A ${cnt((r) => r.インテント階層 === 'A')} ／ B ${cnt((r) => r.インテント階層 === 'B')} ／ C ${cnt((r) => r.インテント階層 === 'C')}`);
L.push(`- 担当者名あり ${cnt((r) => r.採用担当者名)}社 ／ 電話 ${cnt((r) => r.電話番号)}社 ／ 公式URL ${cnt((r) => r.公式URL)}社`);
L.push(`- ATS未導入の内訳: ${Object.entries(rows.reduce((m, r) => { m[r.entry_type] = (m[r.entry_type] || 0) + 1; return m; }, {})).map(([k, v]) => `${k} ${v}`).join(' / ')}`);
L.push('');
L.push('## 落ちた理由（入力全行）');
for (const [k, v] of Object.entries(drop)) if (v) L.push(`- ${k}: ${v}`);
for (const [k, v] of Object.entries(dropReasons)) L.push(`  - ICP不適合の内訳 ${k}: ${v}`);
L.push('');
L.push('## 出力');
L.push(`- 詳細（根拠つき）: ${path.relative(ROOT, OUT)}`);
L.push(`- BALES取込（完全新規のみ）★: ${path.relative(ROOT, BALES_OUT)}`);
L.push(`- BALES取込（SF被り含む参考）: ${path.relative(ROOT, BALES_SF)}`);
L.push('');
L.push('## 上位20社');
L.push('');
L.push('| # | 企業名 | 階層 | 最有力シグナル | ATS動線 | 従業員 | 新卒 | 被り |');
L.push('|---|---|---|---|---|---|---|---|');
for (const r of rows.slice(0, 20)) L.push(`| ${r.No} | ${r.企業名} | ${r.インテント階層}(${r.インテントスコア}) | ${r.最有力シグナル} | ${r.エントリー動線 || r.entry_type} | ${r.従業員数} | ${r.新卒採用人数} | ${r.既存被り || '-'} |`);
fs.writeFileSync(REPORT, L.join('\n') + '\n', 'utf8');
console.log(L.slice(0, 12).join('\n'));
console.log(`[build-icp-ats-intent] 詳細 ${path.relative(ROOT, OUT)} / BALES ${path.relative(ROOT, BALES_OUT)} / レポート ${path.relative(ROOT, REPORT)}`);
