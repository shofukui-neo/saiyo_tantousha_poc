'use strict';
/**
 * マイナビ担当者名つき → MOCHICAターゲット 最終アセンブラ
 * =====================================================================
 * build-mynavi-1000.js（3パターン抽出ハーベスタ）の出力を MOCHICA アポ期待値モデル(mochica-fit)で
 * 採点し、架電できる形（担当者名＋電話＋規模フィット）に整えて出力する。
 *
 *   入力 : data/recruiter-mynavi-1000.csv（採用担当者名／電話／従業員数／卒年／パターン…）
 *   属性合流: leads-mochica-target.csv（正リスト・電話や新卒フラグを社名一致で借りる）
 *   採点 : scoreMochica（INT=マイナビ実取得95 / SIZE=50-150スイート / REACH=電話+担当者名 …）
 *   出力 : leads-mochica-mynavi-named.csv        担当者名つき全件（スコア降順）
 *          leads-mochica-mynavi-callable.csv     最高確度（電話妥当×担当者名×氏名検証OK×スコア>=min）
 *
 *   node src/build-mochica-mynavi.js [--in data/recruiter-mynavi-1000.csv] [--min 70]
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, normCompanyName } = require('./csv');
const { scoreMochica } = require('./mochica-fit');
const { isFullName, isKnownSurname, isPlausiblePersonName } = require('./jp-names');
const { normalizeJpPhone } = require('./phone');

const getArg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const ROOT = path.resolve(__dirname, '..');
const IN = path.resolve(getArg('in', path.join('data', 'recruiter-mynavi-1000.csv')));
const MIN = parseFloat(getArg('min', '70'));
const TARGET_CSV = path.join(ROOT, 'leads-mochica-target.csv');

// 氏名の妥当性ゲート（辞書フルネーム/既知姓/構造アンカーで通った2-4字漢字）。地名/イニシャルを弾く。
function validName(n) {
  const s = String(n || '').trim();
  if (!s) return false;
  return isFullName(s) || isKnownSurname(s) || isPlausiblePersonName(s.replace(/\s/g, ''));
}
const loadCsv = (p) => (fs.existsSync(p) ? readCsv(fs.readFileSync(p, 'utf8')).records : []);

// 正リストから社名一致で借りる属性（電話/規模/設立年/業種/新卒フラグ等）。
const BORROW = ['電話番号', '従業員数', '設立年', '業種', '都道府県', '代表者名', '法人番号', '公式URL', '新卒フラグ'];
function buildAttrIndex() {
  const idx = new Map();
  for (const r of loadCsv(TARGET_CSV)) {
    const nm = normCompanyName(r['企業名'] || '');
    if (!nm) continue;
    const cur = idx.get(nm) || {};
    for (const col of BORROW) if ((cur[col] == null || cur[col] === '') && r[col]) cur[col] = r[col];
    idx.set(nm, cur);
  }
  return idx;
}

function main() {
  if (!fs.existsSync(IN)) { console.error('入力が見つかりません:', IN); process.exit(1); }
  const now = new Date();
  const rows = loadCsv(IN).filter((r) => String(r['採用担当者名'] || '').trim());
  const attr = buildAttrIndex();

  let enriched = 0;
  const records = rows.map((r) => {
    const rec = {
      企業名: r['企業名'], corpID: r['corpID'] || '', 採用担当者名: r['採用担当者名'], 役職: r['役職'] || '', 部署: r['部署'] || '',
      採用担当者名取得元: 'マイナビ', 抽出パターン: r['パターン'] || '', 担当者確度: r['担当者確度'] || '',
      根拠URL: r['採用ページURL'] || '', 担当者根拠: r['担当者根拠'] || '',
      マイナビ掲載: r['マイナビ掲載'] || '○', 電話番号: r['電話番号'] || '', メール: r['メール'] || '',
      従業員数: r['従業員数'] || '', 採用予定人数: r['採用予定人数'] || '', 募集職種: r['募集職種'] || '', 卒年: r['卒年'] || '',
    };
    const a = attr.get(normCompanyName(rec['企業名'] || ''));
    if (a) { let t = false; for (const col of BORROW) if (a[col] && !String(rec[col] || '').trim()) { rec[col] = a[col]; t = true; } if (t) enriched++; }
    return rec;
  });

  const scored = records.map((rec) => ({ rec, s: scoreMochica(rec, { now }) }));
  scored.sort((a, b) => b.s.total - a.s.total);

  const SCORE_COLS = ['アポ期待度', '優先度', '確信度', 'なぜ今なぜこの企業', 'INT', 'SIZE', 'REACH', 'TIM', 'TRUST'];
  const META = ['企業名', '採用担当者名', '氏名検証', '抽出パターン', '役職', '部署', '担当者確度', '電話番号', 'メール',
    '従業員数', '採用予定人数', '卒年', '業種', '都道府県', '設立年', '法人番号', 'マイナビ掲載', '根拠URL', '採点根拠'];
  const headers = [...SCORE_COLS, ...META];
  const toRow = ({ rec, s }) => Object.assign({}, rec, {
    アポ期待度: s.total, 優先度: s.priority, 確信度: s.confidence, なぜ今なぜこの企業: s.why,
    INT: s.dims.intent, SIZE: s.dims.size, REACH: s.dims.reach, TIM: s.dims.timing, TRUST: s.dims.trust,
    氏名検証: validName(rec['採用担当者名']) ? 'OK' : '要確認', 採点根拠: s.reasons.join(' / '),
  });

  const allRows = scored.map(toRow);
  const callable = scored.filter((x) => x.s.total >= MIN
    && String(x.rec['電話番号'] || '').trim() && normalizeJpPhone(x.rec['電話番号'])
    && validName(x.rec['採用担当者名']));

  fs.writeFileSync(path.join(ROOT, 'leads-mochica-mynavi-named.csv'), toCsv(headers, allRows), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'leads-mochica-mynavi-callable.csv'), toCsv(headers, callable.map(toRow)), 'utf8');

  const L = '──────────────────────────────────────────────';
  const byPat = {};
  for (const r of records) { const p = r['抽出パターン'] || 'その他'; byPat[p] = (byPat[p] || 0) + 1; }
  const band = (n) => scored.filter((x) => x.s.priority === n).length;
  console.log('\n' + L);
  console.log('  マイナビ担当者名つき × MOCHICA 採点');
  console.log(L);
  console.log(`  担当者名あり総数     : ${records.length}社`);
  console.log(`  氏名検証OK           : ${records.filter((r) => validName(r['採用担当者名'])).length}社`);
  console.log(`  属性合流(正リスト)   : ${enriched}社`);
  console.log(`  電話あり             : ${records.filter((r) => String(r['電話番号'] || '').trim()).length}社`);
  console.log(`  従業員数判明         : ${records.filter((r) => String(r['従業員数'] || '').trim()).length}社`);
  console.log(L);
  console.log('  ◆ 抽出パターン内訳: ' + JSON.stringify(byPat));
  console.log(L);
  console.log(`  ◆ 採点バンド  今週架電(70+): ${band('今週架電')} ／ ナーチャリング: ${band('ナーチャリング')} ／ 後回し: ${band('後回し')}`);
  console.log(`  ◆ 名指し架電可能（最高確度）: ${callable.length}社 → leads-mochica-mynavi-callable.csv`);
  console.log(L);
  console.log(`  ◆ 上位${Math.min(20, scored.length)}社`);
  scored.slice(0, 20).forEach((x, i) => {
    const d = x.s.dims; const ph = String(x.rec['電話番号'] || '').trim();
    console.log(`   ${String(i + 1).padStart(2)}. ${String(x.s.total).padStart(3)}｜INT${String(d.intent).padStart(3)}/SIZE${String(d.size).padStart(3)}/REACH${String(d.reach).padStart(3)}  ${x.rec['企業名']}（${x.rec['採用担当者名']}）[${x.rec['抽出パターン']}]${ph ? '☎' + ph : ''}`);
  });
  console.log(L);
  console.log(`  出力: leads-mochica-mynavi-named.csv（全 ${allRows.length}社・スコア降順）`);
  console.log(`        leads-mochica-mynavi-callable.csv（最高確度 ${callable.length}社）\n`);
}

main();
