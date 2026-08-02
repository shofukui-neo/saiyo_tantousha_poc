'use strict';
/**
 * ⚠️ 非推奨（2026-07）: 本スクリプトは scripts/remediate-recruiter-names.js に統合・置換されました。
 *   新スクリプトは 非人名語(isNonPersonWord)/助詞glue/話者注記/閉鎖×代表 の4ルールを、
 *   採用担当者名 列 と BALESCLOUD(担当者情報：姓/名) 形式の両方に適用し、全成果物を清掃します。
 *   → 今後は `node scripts/remediate-recruiter-names.js` を使うこと。
 * ---------------------------------------------------------------------------
 * 誤抽出された採用担当者名を、改善後のロジックで再検証して除去するリメディエーション。
 * ============================================================================
 * 背景（2026-07 ユーザー報告）: 三和=浅井 / いしのまき=佐藤 / 上田工業=江藤 までお 等、
 * 実在しない担当者名が混入していた。原因は2クラス:
 *   A. マイナビ「（○○さん）」話者注記 … 社員インタビューの被取材者・顧客敬称(荷主さん等)を
 *      採用担当と誤認。抽出パターン='インタビュー話者注記'（+ HR部署の裏付けが無い'インタビュー帰属'）。
 *   B. 助詞glue … 「江藤までお問合せ下さい」→「江藤 までお」。jp-namesが助詞"までお"を名として受理。
 *
 * 本スクリプトは既存の出力CSV群を走査し、
 *   - Rule1: 改善後 isPlausiblePersonName で却下される名（B: glue/壊れ名）を除去
 *   - Rule2: 抽出パターン='インタビュー話者注記'、または'インタビュー帰属'で部署にHR語が無い行（A）を除去
 * 該当行の「採用担当者名」「氏名検証」を空にし、変更内容を report に残す。
 *   ※スコア列（アポ期待度等）は再計算しない（名指し前提の加点が残る点は再スクレイプ時に解消）。
 *
 * 使い方: node scripts/fix-bad-recruiter-names.js            （実書き換え＋レポート出力）
 *         node scripts/fix-bad-recruiter-names.js --dry      （変更せずレポートのみ）
 */
const fs = require('path') && require('fs');
const path = require('path');
const { readCsv, toCsv, normCompanyName } = require('../src/csv');
const { splitName, isParticleGlueMei } = require('../src/jp-names');

const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry');
const HR_DEPT_RE = /人事|採用|人材|人財|新卒|中途|タレント|HR|リクルート|総務/;

// 対象ファイル（存在するものだけ処理）。パス, 名前列。
const TARGETS = [
  'data/leads-mochica-mynavi-named.csv',
  'data/leads-recruiter-acquired-1000.csv',
  'leads-mochica-named-consolidated.csv',
  'leads-mochica-named-consolidated-clean.csv',
];

// マイナビ中間ファイルから「話者注記」「HR裏付け無しの帰属」の (社名キー→名) 除外集合を作る。
// consolidated 等パターン列を持たないファイルの突合に使う。
function buildRejectSet() {
  const p = path.join(ROOT, 'data/leads-mochica-mynavi-named.csv');
  const set = new Set();
  if (!fs.existsSync(p)) return set;
  const { records } = readCsv(fs.readFileSync(p, 'utf8'));
  for (const r of records) {
    const name = (r['採用担当者名'] || '').trim();
    if (!name) continue;
    const pat = (r['抽出パターン'] || '').trim();
    const dept = (r['部署'] || '').trim();
    const bad = pat === 'インタビュー話者注記'
      || (pat === 'インタビュー帰属' && !HR_DEPT_RE.test(dept));
    if (bad) set.add(normCompanyName(r['企業名']) + '' + name.replace(/\s/g, ''));
  }
  return set;
}

// 1行が除去対象か判定し、理由を返す（対象でなければ null）。
// ※既存データにはローマ字表記の正当な氏名(Kozue Kuwaki 等)も多いので、
//   ブランケットな人名ゲートは使わず、報告された2クラス（助詞glue／話者注記）だけを外科的に除去する。
function removalReason(rec, rejectSet) {
  const name = (rec['採用担当者名'] || '').trim();
  if (!name) return null;
  // Rule1(B): 「姓＋助詞glue」（江藤+までお 等）だけを厳密に除去（ローマ字名・姓のみ名は温存）。
  const sp = splitName(name.replace(/\s/g, ''));
  if (sp && sp.mei && isParticleGlueMei(sp.mei)) return '助詞glue(江藤 までお型)';
  // Rule2a: 自ファイルにパターン列があれば直接判定
  const pat = (rec['抽出パターン'] || '').trim();
  const dept = (rec['部署'] || '').trim();
  if (pat === 'インタビュー話者注記') return '話者注記(被取材者/敬称の誤認)';
  if (pat === 'インタビュー帰属' && !HR_DEPT_RE.test(dept)) return '帰属(HR部署の裏付け無し)';
  // Rule2b: パターン列が無いファイルは中間ファイル由来の除外集合と突合
  const key = normCompanyName(rec['企業名']) + '' + name.replace(/\s/g, '');
  if (rejectSet.has(key)) return '話者注記/帰属(マイナビ中間と一致)';
  return null;
}

function main() {
  const rejectSet = buildRejectSet();
  const report = [];
  let filesChanged = 0;

  for (const rel of TARGETS) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) { console.log('skip (無し):', rel); continue; }
    const { headers, records } = readCsv(fs.readFileSync(p, 'utf8'));
    let removed = 0;
    for (const rec of records) {
      const reason = removalReason(rec, rejectSet);
      if (!reason) continue;
      report.push({ ファイル: rel, 企業名: rec['企業名'] || '', 除去した担当者名: rec['採用担当者名'] || '', 理由: reason });
      rec['採用担当者名'] = '';
      if ('氏名検証' in rec) rec['氏名検証'] = '';
      removed++;
    }
    if (removed && !DRY) fs.writeFileSync(p, toCsv(headers, records), 'utf8');
    if (removed) filesChanged++;
    console.log(`${DRY ? '[dry] ' : ''}${rel}: ${removed} 件除去 / 全${records.length}行`);
  }

  // レポート出力
  const repPath = path.join(ROOT, 'data', 'recruiter-name-fixes-report.csv');
  if (report.length && !DRY) {
    fs.writeFileSync(repPath, toCsv(['ファイル', '企業名', '除去した担当者名', '理由'], report), 'utf8');
  }
  console.log(`\n合計 ${report.length} 件の担当者名を除去（${filesChanged} ファイル）。`);
  if (!DRY && report.length) console.log('レポート:', path.relative(ROOT, repPath));
  // 理由別集計
  const byReason = {};
  for (const r of report) byReason[r.理由] = (byReason[r.理由] || 0) + 1;
  console.log('理由別:', JSON.stringify(byReason, null, 0));
}

main();
