'use strict';
/**
 * 全成果物リスト 統合コンソリデーター（バックアップ兼クリーンリスト生成）
 * =====================================================================
 * 直下/ data/ / sources/ / archive/ に乱立していた「リスト作成の結果物」CSVを
 * 1本のバックアップCSVに統合する。統合と同時に:
 *   - 正規化：法人番号13桁化・社名正規化（法人格/記号/空白除去）・列名エイリアス吸収
 *   - 重複排除：法人番号→正規化社名 で名寄せし、複数ソースの項目を補完マージ
 *   - スコアリング：MOCHICAアポ取得期待値で全件再採点（アポ期待度/優先度/確信度）
 *   - 既存被り判定：MOCHICA既存顧客 / BALES既存CRM / SF全リード と突合しフラグ付与（除外はしない=バックアップ）
 *
 * 参照元（重複排除・既存被り判定のマスタ）は data/ にそのまま残し、削除しない。
 * 使い方: node src/consolidate-all.js --dir <成果物CSVを集めたディレクトリ> [--out data/leads-consolidated-all.csv]
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, normCompanyName, normCorpNumber, mergeKey } = require('./csv');
const { scoreMochica, parseEmployees } = require('./mochica-fit');
const { qualifiesForList, proposalTier } = require('./icp-rules');
const { buildBalesIndex, suppress } = require('./suppression');
const { createMatchIndex } = require('./company-match');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const STAGE = getArg('--dir', path.join(ROOT, 'data', '_stage-results'));
const OUT = path.resolve(getArg('--out', path.join(ROOT, 'data', 'leads-consolidated-all.csv')));

// ── 正規化：列名エイリアス → 正準スキーマ ─────────────────────────────
const ALIASES = {
  '企業名': ['企業名', 'company_name', '会社名', '法人名'],
  '法人番号': ['法人番号'],
  '採用担当者名': ['採用担当者名'],
  '氏名検証': ['氏名検証'],
  '担当者確度': ['担当者確度', '融合確度', '確度'],
  '役職': ['役職'],
  '部署': ['部署'],
  '代表者名': ['代表者名'],
  '架電宛名': ['架電宛名', '架電呼称'],
  '電話番号': ['電話番号', '電話'],
  'メール': ['メール'],
  'メール確度': ['メール確度'],
  '公式URL': ['公式URL', 'homepage_url', 'Webサイト', 'ホームページ'],
  '業種': ['業種'],
  '都道府県': ['都道府県'],
  '従業員数': ['従業員数', '従業員規模', '従業員数レンジ'],
  '設立年': ['設立年', '設立'],
  '補助金': ['補助金'],
  '上場': ['上場'],
  '新卒フラグ': ['新卒フラグ', 'マイナビ掲載'],
  '採用予定人数': ['採用予定人数', '採用人数', '採用数'],
  '採用職種': ['採用職種', '職種', '募集職種'],
  '掲載媒体': ['掲載媒体', '取得元媒体', '発見媒体'],
  '求人件数': ['求人件数'],
  '採用ページURL': ['採用ページURL'],
  '提案プラン': ['提案プラン'],
  'セグメント区分': ['セグメント区分', 'セグメント'],
  'ICPランク': ['ICPランク'],
  '根拠URL': ['根拠URL'],
  '取得日': ['取得日'],
};
const CANON = Object.keys(ALIASES);

// 出力スキーマ：正準フィールド + 再採点/統合メタ
const OUT_HEADERS = [
  '企業名', '法人番号', '採用担当者名', '氏名検証', '担当者確度', '役職', '部署', '代表者名', '架電宛名',
  '電話番号', 'メール', 'メール確度', '公式URL', '業種', '都道府県', '従業員数', '設立年', '補助金', '上場',
  '新卒フラグ', '採用予定人数', '採用職種', '掲載媒体', '求人件数', '採用ページURL',
  'アポ期待度', '優先度', 'MOCHICA適合', '確信度', '提案プラン', 'セグメント区分', 'ICPランク',
  '既存被り', '呼べる条件', '根拠URL', '取得日', '統合ソース数', '統合元ファイル',
];

// ソース優先度（上ほど値の衝突時に採用＝最も裏取り/検証済みのソースを上位に）
const PRIORITY = [
  'consolidated-clean', 'named-consolidated', 'consolidated',
  'target-enriched', 'target-namedonly', 'target-repfilled', 'leads-mochica-target.csv', 'target.bak',
  'ng-filtered', 'ng-excluded',
  'named-callable', 'mynavi-callable', 'named-select', 'mynavi-named', 'named-mochica-max', 'recruiter-acquired',
  'recruiter-scored-all', 'recruiter-fused', 'rep-full', 'rep-filled', 'rep-recover',
  'recruiter-mynavi-1000', 'recruiter-mynavi', 'nonwantedly', 'prtimes-enriched', 'leads-prtimes',
  'saiyo-tantou', 'recruitpage', 'deep-harvest', 'probe-harvest', 'adaptive', 'gemini', 'fresh', 'active', 'wantedly',
  'hire-enriched', 'mochica-lookalike',
  'A-mynavi-names', 'A-mynavi-public', 'A-names', 'A-media', 'A-mynavi',
  'B-gbiz', 'C-prtimes', 'D-shitchu', 'E-hiring', 'T-tech', 'mynavi-enum', 'prtimes-companies', 'active-recruiters',
  'media-company-pool', 'all-companies-universe', 'outcomes', 'research-worksheet',
  'leads.master', 'leads-mochica.scored', 'scored', 'archive',
];
function priorityOf(name) {
  for (let i = 0; i < PRIORITY.length; i++) if (name.includes(PRIORITY[i])) return i;
  return PRIORITY.length; // 未知は最後
}

// レコード → 正準レコード（エイリアス解決 + 法人番号13桁化）
function canonicalize(raw) {
  const out = {};
  for (const field of CANON) {
    let v = '';
    for (const col of ALIASES[field]) { if (raw[col] != null && String(raw[col]).trim() !== '') { v = String(raw[col]).trim(); break; } }
    out[field] = v;
  }
  out['法人番号'] = normCorpNumber(out['法人番号']);
  return out;
}

const firstNonEmpty = (a, b) => (String(a || '').trim() ? a : b);

// ── 既存被りマスタ索引の構築（除外はしない＝フラグのみ） ──────────────
// company-match の MatchIndex を使用（法人番号/正規化社名/農協コアの3系統で突合）。
function buildExclusionIndex() {
  const idx = createMatchIndex();
  // MOCHICA既存顧客：法人名 と LINE登録名 の“両方”を索引（別称登録の取りこぼしを防ぐ）
  const mc = path.join(ROOT, 'data', 'MOCHICAの既存顧客リスト - mochica-companies-list.csv');
  if (fs.existsSync(mc)) {
    const { records } = readCsv(fs.readFileSync(mc, 'utf8'));
    for (const r of records) { idx.addName(r['法人名'], 'MOCHICA顧客'); idx.addName(r['LINEアカウント登録企業名'], 'MOCHICA顧客'); }
    console.log(`  既存索引 MOCHICA顧客: ${records.length}`);
  }
  // BALES既存CRM（会社情報：会社名）
  const bl = path.join(ROOT, 'data', 'BALESCLOUDの既存リスト - 202607062007_leadList_utf-8.csv');
  if (fs.existsSync(bl)) { const { records } = readCsv(fs.readFileSync(bl, 'utf8')); for (const r of records) idx.addName(r['会社情報：会社名'], 'BALES'); console.log(`  既存索引 BALES: ${records.length}`); }
  // SF全リード（Salesforceレポート：プリアンブル後の「会社名 / 取引先」列）
  const sf = path.join(ROOT, 'data', 'セールスフォースMOCHICA参照 - 全てのリードSitoke突合用.csv');
  if (fs.existsSync(sf)) {
    const { records, n } = parseSfReport(fs.readFileSync(sf, 'utf8'));
    for (const r of records) idx.addName(r.company, 'SF');
    console.log(`  既存索引 SF全リード: ${n}`);
  }
  return idx;
}
// Salesforceレポート形式（先頭に説明行、ヘッダ行に「会社名 / 取引先」）から会社名を抽出
function parseSfReport(text) {
  const { parseCsv } = require('./csv');
  const rows = parseCsv(text);
  let hi = -1, ci = -1;
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const j = rows[i].findIndex((c) => /会社名\s*\/\s*取引先/.test(String(c)));
    if (j >= 0) { hi = i; ci = j; break; }
  }
  if (hi < 0) return { records: [], n: 0 };
  const out = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const c = String(rows[i][ci] || '').trim();
    if (c) out.push({ company: c });
  }
  return { records: out, n: out.length };
}

function main() {
  if (!fs.existsSync(STAGE)) { console.error(`成果物ディレクトリが無い: ${STAGE}`); process.exit(1); }
  // マニフェスト（フラット名 → 元パス）。無ければファイル名をそのまま元パス扱い。
  const origOf = new Map();
  const manP = path.join(STAGE, '_manifest.tsv');
  if (fs.existsSync(manP)) for (const line of fs.readFileSync(manP, 'utf8').split(/\r?\n/)) { const [flat, orig] = line.split('\t'); if (flat) origOf.set(flat, orig); }

  const files = fs.readdirSync(STAGE).filter((f) => /\.csv$/i.test(f));
  // 優先度で並べ替え（元パス基準）
  files.sort((a, b) => priorityOf(origOf.get(a) || a) - priorityOf(origOf.get(b) || b));

  const groups = new Map(); // key -> { rec, files:Set, n }
  const srcStats = [];
  let totalIn = 0;
  for (const f of files) {
    const orig = origOf.get(f) || f;
    const { records } = readCsv(fs.readFileSync(path.join(STAGE, f), 'utf8'));
    let used = 0;
    for (const raw of records) {
      const rec = canonicalize(raw);
      if (!rec['企業名']) continue;
      const key = mergeKey(rec);
      if (!key) continue;
      totalIn++; used++;
      const cur = groups.get(key);
      if (!cur) { groups.set(key, { rec, files: new Set([orig]) }); }
      else { for (const k of CANON) cur.rec[k] = firstNonEmpty(cur.rec[k], rec[k]); cur.files.add(orig); }
    }
    srcStats.push({ file: orig, n: used });
  }

  // 既存被りマスタ
  console.log('既存被りマスタ索引を構築中…');
  const excl = buildExclusionIndex();
  let balesIdx = new Map();
  const balesP = path.join(ROOT, 'data', 'BALESCLOUDの既存リスト - 202607062007_leadList_utf-8.csv');
  if (fs.existsSync(balesP)) balesIdx = buildBalesIndex(fs.readFileSync(balesP, 'utf8'));
  const now = new Date();
  const nowYm = { y: now.getFullYear(), mo: now.getMonth() + 1 };

  const rows = [];
  for (const { rec, files } of groups.values()) {
    const emp = parseEmployees(rec['従業員数']);
    const hireM = String(rec['採用予定人数'] || '').match(/\d+/);
    const hire = hireM ? parseInt(hireM[0], 10) : null;
    const sc = scoreMochica(rec, { now });
    const tier = proposalTier(emp);
    const entryM = String(rec['エントリー数'] || rec['エントリー人数'] || '').match(/\d+/);
    const q = qualifiesForList({ company: rec['企業名'], contactName: rec['採用担当者名'], phone: rec['電話番号'], hire, emp, entry: entryM ? parseInt(entryM[0], 10) : null, industry: rec['業種'] });
    // 既存被り（法人番号→正規化社名→農協コアの順で判定。company-match に集約）
    const overlap = excl.matchLabel(rec);
    // BALESサプレッション（負シグナル）
    const sup = suppress({ '企業名': rec['企業名'], '業種': rec['業種'], '採用予定人数': rec['採用予定人数'] }, balesIdx, { now: nowYm });
    rows.push({
      ...rec,
      '氏名検証': rec['氏名検証'] || (rec['採用担当者名'] ? '' : ''),
      'アポ期待度': sc.total,
      '優先度': sc.priority,
      'MOCHICA適合': sc.total >= 70 ? '◎' : sc.total >= 50 ? '○' : '△',
      '確信度': sc.confidence,
      '提案プラン': rec['提案プラン'] || tier.plan,
      '既存被り': overlap || (sup.action === 'remove' ? 'BALES(負)' : ''),
      '呼べる条件': q.pass ? 'OK' : (q.reasons || []).join('｜'),
      '統合ソース数': files.size,
      '統合元ファイル': [...files].join(' / '),
    });
  }

  // 並べ替え：既存被りなし優先 → アポ期待度降順 → 企業名
  rows.sort((a, b) => {
    const oa = a['既存被り'] ? 1 : 0, ob = b['既存被り'] ? 1 : 0;
    return (oa - ob) || (b['アポ期待度'] - a['アポ期待度']) || String(a['企業名']).localeCompare(String(b['企業名']), 'ja');
  });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, '﻿' + toCsv(OUT_HEADERS, rows), 'utf8');

  // レポート
  const L = '──────────────────────────────────────────────';
  const overlapN = rows.filter((r) => r['既存被り']).length;
  const named = rows.filter((r) => r['採用担当者名']).length;
  const phone = rows.filter((r) => r['電話番号']).length;
  const band = (lo, hi) => rows.filter((r) => r['アポ期待度'] >= lo && (hi == null || r['アポ期待度'] < hi)).length;
  const fresh = rows.filter((r) => !r['既存被り']);
  console.log('\n' + L);
  console.log('  全成果物 統合バックアップ（正規化 + 重複排除 + 再採点 + 既存被り判定）');
  console.log(L);
  console.log('  取得元ファイル別 投入行数（正規化後・企業名あり）:');
  for (const s of srcStats.sort((a, b) => b.n - a.n)) console.log(`    ${String(s.n).padStart(6)}  ${s.file}`);
  console.log(L);
  console.log(`  投入行 合計            : ${totalIn}`);
  console.log(`  ユニーク企業（名寄せ後） : ${rows.length}`);
  console.log(`  ├ 採用担当者名あり      : ${named}`);
  console.log(`  ├ 電話番号あり          : ${phone}`);
  console.log(`  └ 既存被り（除外候補）   : ${overlapN}  → 既存被りなし ${rows.length - overlapN}`);
  console.log(L);
  console.log(`  MOCHICA適合（既存被りなし ${fresh.length}社中）:`);
  console.log(`    ◎ 70+   : ${fresh.filter((r) => r['アポ期待度'] >= 70).length}`);
  console.log(`    ○ 50-69 : ${fresh.filter((r) => r['アポ期待度'] >= 50 && r['アポ期待度'] < 70).length}`);
  console.log(`    △ -49   : ${fresh.filter((r) => r['アポ期待度'] < 50).length}`);
  console.log(L);
  console.log(`  出力（バックアップ兼クリーンリスト）: ${path.relative(ROOT, OUT)}`);
  console.log('');
}

main();
