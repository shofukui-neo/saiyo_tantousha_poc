'use strict';
/**
 * ICP完全適合 × 採用担当者名判明 × かぶりなし の 1000件リストを生成
 * =====================================================================
 * ユーザー指定（2026-07）: 「ICP完全適合かつ、採用担当者名の判明している、かぶりのない
 * リストを1000件」。統合マスタ data/leads-consolidated-all.csv（30,290社）から、
 * 現行 MOCHICA アポ取得期待値モデル（src/mochica-fit.js）で再採点し、下記を全て満たす
 * 「完全適合（検証済）」だけを抽出して アポ期待度降順で上位1000社を確定する。
 *
 * ── ICP完全適合（検証済）の定義 ─────────────────────────────
 *   ① かぶりなし     : 既存被り 列が空（BALES/MOCHICA顧客/SF全リードに存在しない）
 *   ② 担当者名判明   : 採用担当者名 が非空（テレアポで名指しできる）
 *   ③ 新卒インテント : 新卒フラグ or 新卒媒体掲載 を実データで確認（verifiedIntent）
 *   ④ 規模フィット   : 従業員数が判明し 100〜2000名（実成約率の有効域）
 *   ⑤ 非IT           : IT/ソフトウェア（構造的に成約率6%＝絶対除外）でない
 *   ⑥ 到達性         : 電話番号が妥当（架電できる）
 *
 * ③〜⑥は全て「判明した実データ」で満たすことを要求する＝スコアが代理推定で嵩上げ
 * された社を排除し、上位1000社が“検証済みシグナルで完全適合”だと言い切れるようにする。
 * （年間新卒6名以上の hire フロアは 採用予定人数 の充足率が低く1000規模で両立不能なため、
 *   ここでは新卒媒体掲載インテントで代替し、hire判明社は 採用予定人数 列で明示する。）
 *
 * 純ロジック・ネットワーク不要。`npm run icp:perfect` → data/leads-icp-perfect-named-1000.csv
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, truthy } = require('./csv');
const { scoreMochica, parseEmployees } = require('./mochica-fit');
const { isExcludedIndustry } = require('./icp-rules');
const { cleanCrossRefName } = require('./enrich-crossref');

// 担当者名の品質ゲート: 連結/ふりがな/住所断片を姓へ濾過し、実在しうる人名だけ通す。
// 1文字姓・断片は架電宛名にならないので落とす（1335候補>1000なのでバックフィルで補える）。
function cleanName(raw) {
  const c = cleanCrossRefName(raw);
  if (!c) return null;
  const t = String(c).trim();
  if (t.replace(/\s/g, '').length < 2) return null; // 1文字は不採用
  return t;
}

const IN = process.env.ICP_PERFECT_IN || 'data/leads-consolidated-all.csv';
const OUT = process.env.ICP_PERFECT_OUT || 'data/leads-icp-perfect-named-1000.csv';
const TARGET = parseInt(process.env.ICP_PERFECT_N || '1000', 10);
const EMP_MIN = 100, EMP_MAX = 2000; // 実成約率の有効域（scoreSize: 100-2000=score88-100）

const has = (v) => v && String(v).trim() && String(v).trim() !== '-';

// 出力カラム（営業がそのまま架電できる順）
const OUT_COLS = [
  '企業名', '法人番号', '採用担当者名', '役職', '部署', '架電宛名', '代表者名',
  '電話番号', 'メール', '公式URL', '業種', '都道府県', '従業員数', '設立年', '上場',
  '新卒フラグ', '採用予定人数', '採用職種', '掲載媒体', '採用ページURL',
  'アポ期待度', '優先度', '確信度', 'MOCHICA適合', 'フィットティア', '完全適合根拠',
  '提案プラン', 'セグメント区分', '根拠URL', '取得日', '統合ソース数',
];

function fitEval(rec) {
  const m = scoreMochica(rec);
  const emp = parseEmployees(rec['従業員数']);
  const inBand = emp != null && emp >= EMP_MIN && emp <= EMP_MAX;
  const notIT = !isExcludedIndustry(String(rec['業種'] || ''));
  const perfect = m.flags.verifiedIntent && inBand && m.flags.callable && m.flags.named && notIT;
  return { m, emp, inBand, notIT, perfect };
}

function reasonText(rec, ev) {
  const parts = [];
  parts.push('かぶりなし');
  parts.push('担当者名判明');
  parts.push(ev.m.flags.verifiedIntent ? '新卒インテント検証済' : '新卒インテント代理');
  if (ev.emp != null) parts.push(`従業員${ev.emp}名(有効域100-2000)`);
  parts.push(ev.notIT ? '非IT' : 'IT');
  parts.push('電話妥当');
  if (has(rec['採用予定人数'])) parts.push(`採用予定${String(rec['採用予定人数']).trim()}`);
  return parts.join('｜');
}

function main() {
  const root = path.resolve(__dirname, '..');
  const inPath = path.isAbsolute(IN) ? IN : path.join(root, IN);
  const outPath = path.isAbsolute(OUT) ? OUT : path.join(root, OUT);
  const rows = readCsv(fs.readFileSync(inPath, 'utf8')).records;

  const fresh = rows.filter((r) => !has(r['既存被り']));
  const named = fresh.filter((r) => has(r['採用担当者名']));

  const scored = [];
  let droppedName = 0;
  for (const r of named) {
    const ev = fitEval(r);
    if (!ev.perfect) continue;
    const clean = cleanName(r['採用担当者名']);
    if (!clean) { droppedName++; continue; } // 品質ゲート未通過の担当者名は除外
    r['採用担当者名'] = clean;
    scored.push({ r, ev });
  }
  // アポ期待度降順 → 確信度降順 → 従業員数がスイート(300-500)に近い順
  scored.sort((a, b) => {
    if (b.ev.m.total !== a.ev.m.total) return b.ev.m.total - a.ev.m.total;
    if (b.ev.m.confidence !== a.ev.m.confidence) return b.ev.m.confidence - a.ev.m.confidence;
    const da = Math.abs((a.ev.emp || 400) - 400), db = Math.abs((b.ev.emp || 400) - 400);
    return da - db;
  });

  const picked = scored.slice(0, TARGET);
  const outRecords = picked.map(({ r, ev }) => {
    const o = {};
    for (const c of OUT_COLS) o[c] = r[c] != null ? r[c] : '';
    o['アポ期待度'] = ev.m.total;
    o['優先度'] = ev.m.priority;
    o['確信度'] = ev.m.confidence;
    o['MOCHICA適合'] = ev.m.total >= 80 ? '◎' : ev.m.total >= 65 ? '○' : '△';
    o['フィットティア'] = 'S:完全適合(検証済)';
    o['完全適合根拠'] = reasonText(r, ev);
    o['提案プラン'] = ev.m.plan || r['提案プラン'] || '';
    o['セグメント区分'] = ev.m.segment || r['セグメント区分'] || '';
    return o;
  });

  fs.writeFileSync(outPath, toCsv(OUT_COLS, outRecords), 'utf8');

  // ── サマリ ──
  const availPerfect = scored.length;
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);
  const totals = picked.map((p) => p.ev.m.total);
  const confs = picked.map((p) => p.ev.m.confidence);
  const withEmp = picked.filter((p) => p.ev.emp != null).length;
  const withHire = picked.filter((p) => has(p.r['採用予定人数'])).length;
  const withMail = picked.filter((p) => has(p.r['メール'])).length;
  const pri = picked.reduce((acc, p) => { acc[p.ev.m.priority] = (acc[p.ev.m.priority] || 0) + 1; return acc; }, {});
  console.log('=== ICP完全適合×担当者名判明×かぶりなし リスト ===');
  console.log(`入力(統合マスタ)        : ${rows.length}社`);
  console.log(`かぶりなし              : ${fresh.length}社`);
  console.log(`＋担当者名判明          : ${named.length}社`);
  console.log(`  担当者名 品質ゲート除外: ${droppedName}社（連結/1文字/断片）`);
  console.log(`＋完全適合(検証済)候補  : ${availPerfect}社  ← ここから上位抽出`);
  console.log(`確定リスト              : ${picked.length}社 → ${path.relative(root, outPath)}`);
  console.log(`  アポ期待度 平均/最小   : ${avg(totals)} / ${Math.min(...totals)}`);
  console.log(`  確信度 平均            : ${avg(confs)}`);
  console.log(`  従業員数 判明          : ${withEmp}/${picked.length} (100%＝規模検証済)`);
  console.log(`  採用予定人数 判明      : ${withHire}/${picked.length}`);
  console.log(`  メールあり             : ${withMail}/${picked.length}`);
  console.log(`  優先度内訳             : ${JSON.stringify(pri)}`);
  if (availPerfect < TARGET) {
    console.log(`⚠ 完全適合候補が${TARGET}件に不足（${availPerfect}件）。母集団拡大が必要。`);
  }
}

if (require.main === module) main();
module.exports = { fitEval, EMP_MIN, EMP_MAX };
