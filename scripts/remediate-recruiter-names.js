'use strict';
/**
 * 誤抽出された採用担当者名を、改善後のゲートで全成果物CSVから一括除去するリメディエーション。
 * ============================================================================
 * 背景（2026-07 ユーザー報告8社）: 実在しない/誤った担当者名が成果物（BALES call-list含む）に残存:
 *   山形県庁=任用 / (株)新出光=面接 / 国立成育医療研究センター=験申込書  … 非人名語（採用/選考/書類/庶務語）
 *   (株)コナカ=次長                                                    … 役職語
 *   三和スーパー=浅井 / JAいしのまき=佐藤                               … インタビュー話者注記（HR帰属なし）
 *   上田工業=江藤までお                                                … 助詞glue
 *   ヨロズSMC（閉鎖）=志藤 昭彦（代表）                                  … 閉鎖企業に代表者名を採用担当と誤用
 *
 * 抽出コード側は src/jp-names.js の isNonPersonWord 等で恒久修正済み（test/mynavi-extract.test.js で固定）。
 * 本スクリプトは既に出力済みのCSV群を走査し、下記4ルールに該当する担当者名を空にする（データ側の追随）。
 *   Rule1 非人名語   : isNonPersonWord（面接/任用/験申込書/次長…）
 *   Rule2 助詞glue   : splitName の mei が助詞glue（江藤 までお…）
 *   Rule3 話者注記   : 行のパターン列＝'インタビュー話者注記' もしくは recruiter-mynavi-1000 の同社×同名と一致
 *   Rule4 閉鎖×代表  : 社名に「（閉鎖）」を含み、役職が代表/会長/社長/取締役（代表者名の誤用）
 *
 * 2種のレイアウトを自動判別:
 *   A) 採用担当者名 列（recruiter/leads 系）
 *   B) 担当者情報：姓 / 名 列（BALESCLOUD 形式）
 *
 * 使い方:
 *   node scripts/remediate-recruiter-names.js          （実書換え＋レポート）
 *   node scripts/remediate-recruiter-names.js --dry     （変更せずレポートのみ）
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, normCompanyName } = require('../src/csv');
const { splitName, isParticleGlueMei, isNonPersonWord } = require('../src/jp-names');

const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry');
const EXEC_ROLE_RE = /代表|会長|社長|取締役/;      // Rule4: 代表者系の役職
const SPEAKER_PATTERN = 'インタビュー話者注記';
const EMAIL_GUESS_PATTERN = 'メール推定';           // Rule5: 採用メールのローカル部からの姓推定（誤名率高）
// Rule6: 個別NG（弱シグナルで採った実在姓が公式の採用担当と食い違う。伝言板の名乗り等は他社では有効なので個別指定）。
const NG_PAIRS = [
  { companyIncludes: '新岩手農業協同組合', name: '瀬川' }, // 伝言板の名乗り0.85。公式フォームの担当は工藤。
];

// 走査対象（存在するものだけ処理）。BOM/引用符は readCsv が吸収。
const TARGETS = [
  // A) 採用担当者名 列
  'data/recruiter-mynavi-1000.csv',
  'data/leads-named-mochica-max.csv',
  'data/leads-consolidated-all.csv',
  'leads-mochica-named-consolidated.csv',
  'leads-mochica-named-consolidated-clean.csv',
  'leads-mochica-named-consolidated-excluded.csv',
  'data/leads-mochica-mynavi-named.csv',
  'data/leads-mochica-mynavi-callable.csv',
  'data/leads-mochica-named-callable.csv',
  'data/leads-mochica-named-select.csv',
  'data/leads-recruiter-acquired-1000.csv',
  'data/leads-mochica-target-namedonly.csv',
  // B) BALESCLOUD 形式（担当者情報：姓/名）
  'data/leads-bales-icp-clean.csv',
  'data/leads-bales-icp.csv',
  'data/leads-bales-callable-pure.csv',
  'data/leads-bales-callable.csv',
  'data/leads-bales-format.csv',
];

const compact = (s) => String(s || '').replace(/[\s　]/g, '');

// recruiter-mynavi-1000 から「話者注記/メール推定で採った氏名」の (社名→名) 除外集合を作る。
// 抽出コードは話者注記を撤去・メール推定を氏名欄から外したので、これらは全て誤採用。派生ファイルからも消す。
// 派生ファイル（consolidated-all/mochica-max/BALES）はパターン列を保持しないため、この突合で識別する。
function buildPatternRejectSets() {
  const p = path.join(ROOT, 'data/recruiter-mynavi-1000.csv');
  const speaker = new Set(), email = new Set();
  if (!fs.existsSync(p)) return { speaker, email };
  let recs;
  try { recs = readCsv(fs.readFileSync(p, 'utf8')).records; } catch (_) { return { speaker, email }; }
  for (const r of recs) {
    const nm = compact(r['採用担当者名']);
    if (!nm) continue;
    const pat = String(r['パターン'] || r['抽出パターン'] || '').trim();
    const key = normCompanyName(r['企業名']) + '|' + nm;
    if (pat === SPEAKER_PATTERN) speaker.add(key);
    else if (pat === EMAIL_GUESS_PATTERN) email.add(key);
  }
  return { speaker, email };
}

/**
 * 氏名が除去対象か判定し、理由を返す（対象外なら null）。
 * @param {string} name  担当者名（A:採用担当者名 / B:姓+名）
 * @param {{pattern?:string, company?:string, role?:string}} ctx
 * @param {{speaker:Set<string>, email:Set<string>}} sets
 */
function removalReason(name, ctx, sets) {
  const c = compact(name);
  if (!c) return null;
  const company = ctx.company || '';
  const pat = (ctx.pattern || '').trim();
  const key = normCompanyName(company) + '|' + c;
  // Rule1 非人名語（採用/選考プロセス語・書類語・庶務語・役職語・連絡先ラベル語・職能語）
  if (isNonPersonWord(c)) return '非人名語(採用/選考/書類/庶務/役職/連絡先/職能)';
  // Rule2 助詞glue（江藤 までお 型）
  const sp = splitName(c);
  if (sp && sp.mei && isParticleGlueMei(sp.mei)) return '助詞glue';
  // Rule3 話者注記（自パターン or recruiter-mynavi-1000 突合）
  if (pat === SPEAKER_PATTERN) return '話者注記(HR帰属なし)';
  if (company && sets.speaker.has(key)) return '話者注記(mynavi-1000一致)';
  // Rule4 閉鎖企業 × 代表系役職（代表者名の誤用）
  if (/（閉鎖）|\(閉鎖\)/.test(company) && EXEC_ROLE_RE.test(ctx.role || '')) return '閉鎖企業×代表者名';
  // Rule5 メール推定（採用メールのローカル部からの姓推定＝誤名率が高い。ユーザー方針2026-07で氏名欄から除外）
  if (pat === EMAIL_GUESS_PATTERN) return 'メール推定(誤名率高)';
  if (company && sets.email.has(key)) return 'メール推定(mynavi-1000一致)';
  // Rule6 個別NG（弱シグナルで採った実在姓が公式担当と食い違う。伝言板の名乗り等は他社では維持）
  for (const ng of NG_PAIRS) {
    if (ng.name === c && company.includes(ng.companyIncludes)) return '個別NG(弱シグナル誤り)';
  }
  return null;
}

function processFile(rel, sets, report) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { console.log('skip (無し):', rel); return 0; }
  let headers, records;
  try { ({ headers, records } = readCsv(fs.readFileSync(p, 'utf8'))); }
  catch (e) { console.log('skip (読取失敗):', rel, e.message); return 0; }

  const has = (h) => headers.includes(h);
  const isBales = has('担当者情報：姓');
  const nameCol = isBales ? null : (has('採用担当者名') ? '採用担当者名' : null);
  if (!isBales && !nameCol) { console.log('skip (氏名列なし):', rel); return 0; }
  const compCol = isBales ? '会社情報：会社名' : '企業名';
  const roleCol = isBales ? '担当者情報：役職' : '役職';
  const patCol = has('抽出パターン') ? '抽出パターン' : (has('パターン') ? 'パターン' : null);

  let removed = 0;
  for (const rec of records) {
    const name = isBales
      ? (compact(rec['担当者情報：姓']) + compact(rec['担当者情報：名']))
      : rec[nameCol];
    if (!compact(name)) continue;
    const ctx = { pattern: patCol ? rec[patCol] : '', company: rec[compCol], role: rec[roleCol] };
    const reason = removalReason(name, ctx, sets);
    if (!reason) continue;
    report.push({ ファイル: rel, 企業名: rec[compCol] || '', 除去した担当者名: String(name).trim(), 理由: reason });
    if (isBales) {
      for (const col of ['担当者情報：姓', '担当者情報：名', '担当者情報：姓（カナ）', '担当者情報：名（カナ）']) {
        if (col in rec) rec[col] = '';
      }
    } else {
      rec[nameCol] = '';
      if ('氏名検証' in rec) rec['氏名検証'] = '';
      if ('担当者確度' in rec) rec['担当者確度'] = '';
    }
    removed++;
  }
  if (removed && !DRY) fs.writeFileSync(p, toCsv(headers, records), 'utf8');
  console.log(`${DRY ? '[dry] ' : ''}${rel}: ${removed} 件除去 / 全${records.length}行${isBales ? '（BALES形式）' : ''}`);
  return removed;
}

function main() {
  const sets = buildPatternRejectSets();
  console.log(`除外集合（recruiter-mynavi-1000 由来）: 話者注記 ${sets.speaker.size} 件 / メール推定 ${sets.email.size} 件\n`);
  const report = [];
  let total = 0;
  for (const rel of TARGETS) total += processFile(rel, sets, report);

  const repPath = path.join(ROOT, 'data', 'recruiter-name-remediation-report.csv');
  if (report.length && !DRY) {
    fs.writeFileSync(repPath, '﻿' + toCsv(['ファイル', '企業名', '除去した担当者名', '理由'], report), 'utf8');
  }
  console.log(`\n合計 ${total} 件の担当者名を除去。`);
  if (!DRY && report.length) console.log('レポート:', path.relative(ROOT, repPath));
  const byReason = {};
  for (const r of report) byReason[r.理由] = (byReason[r.理由] || 0) + 1;
  console.log('理由別:', JSON.stringify(byReason));
}

main();
