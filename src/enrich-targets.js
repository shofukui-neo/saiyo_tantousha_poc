'use strict';
// 営業ターゲットリストに、Wantedly実取得の採用担当者名を突き合わせて付与する（オフライン・ネット不要）。
// ------------------------------------------------------------------
// 背景: 18-19巡の検証で「個人名が取れるのは採用広報が活発なSME(Wantedly掲載)」と確定。
//   ターゲット(中堅大手)とは母集団がほぼ別だが、重なる数社には実名を付けられる。
//   names:from-cache が作る sources/A-names-from-cache.csv（企業×担当者）を、
//   手持ちのリスト群と正規化社名で突合し、一致分だけ法人番号付きで出力する＝マージ可能な担当者名差分。
//
// 使い方:
//   node src/enrich-targets.js                       # 既定リスト群を突合
//   node src/enrich-targets.js --lists a.csv,b.csv   # 突合対象を指定
//   npm run names:enrich
const fs = require('fs');
const path = require('path');
const { readCsv, normCompanyName, toCsv } = require('./csv');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
const NAMES_CSV = getArg('names', 'sources/A-names-from-cache.csv');
const MYNAVI_CSV = getArg('mynavi', 'sources/A-mynavi-names.csv'); // マイナビ実取得(担当者名＋到達性, 法人番号付き)
const OUT = getArg('out', 'sources/A-names-enrichment.csv');
const LISTS = String(getArg('lists',
  'leads-daihyou-1000.csv,leads-fresh-1000.csv,leads-telapo-1000.csv,leads.master.csv,leads-mochica.scored.csv'))
  .split(',').map((s) => s.trim()).filter(Boolean);

function abs(p) { return path.resolve(__dirname, '..', p); }

function run() {
  // Wantedly: 正規化社名 -> 担当者名レコード（SME中心。社名で突合）
  const wIdx = new Map();
  if (fs.existsSync(abs(NAMES_CSV))) {
    for (const r of readCsv(fs.readFileSync(abs(NAMES_CSV), 'utf8')).records) {
      const k = normCompanyName(r['企業名'] || '');
      if (k && !wIdx.has(k)) wIdx.set(k, r);
    }
  }
  // マイナビ: 法人番号 -> レコード（中堅大手。担当者名は主にメール推定＋到達性。法人番号で突合）
  const mIdx = new Map();
  if (fs.existsSync(abs(MYNAVI_CSV))) {
    for (const r of readCsv(fs.readFileSync(abs(MYNAVI_CSV), 'utf8')).records) {
      const c = String(r['法人番号'] || '').trim();
      if (c && !mIdx.has(c)) mIdx.set(c, r);
    }
  }
  console.log(`担当者名ソース: Wantedly ${wIdx.size}社 / マイナビ ${mIdx.size}社`);

  const seen = new Set();
  const out = [];
  for (const f of LISTS) {
    if (!fs.existsSync(abs(f))) continue;
    let matched = 0;
    for (const r of readCsv(fs.readFileSync(abs(f), 'utf8')).records) {
      const name = r['企業名'] || r['company_name'] || '';
      const corp = String(r['法人番号'] || '').trim();
      const k = normCompanyName(name);
      const w = k && wIdx.get(k);
      const m = corp && mIdx.get(corp);
      // 担当者名はWantedly(実名・確度0.5)優先→マイナビ(メール推定等)。到達性はマイナビから補完。
      const recruiterName = (w && w['採用担当者名']) || (m && m['採用担当者名']) || '';
      const hasReach = m && (m['電話番号'] || m['メール'] || m['部署']);
      if (!recruiterName && !hasReach) continue;
      const dedup = (corp || k) + '|' + recruiterName;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      matched++;
      out.push({
        企業名: name, 法人番号: corp,
        採用担当者名: recruiterName,
        担当者根拠: (w && recruiterName === w['採用担当者名']) ? 'Wantedly投稿者' : (m ? (m['担当者根拠'] || '') : ''),
        部署: (m && m['部署']) || '', メール: (m && m['メール']) || '', 電話番号: (m && m['電話番号']) || '',
        採用予定人数: (m && m['採用予定人数']) || '', マイナビ掲載: (m && m['マイナビ掲載']) || '',
        取得元媒体: [w && 'Wantedly', m && 'マイナビ'].filter(Boolean).join('+'),
        根拠URL: (w && w['根拠URL']) || (m && m['採用ページURL']) || '',
      });
    }
    console.log(`  ${f}: enrich ${matched}社`);
  }
  const HEAD = ['企業名', '法人番号', '採用担当者名', '担当者根拠', '部署', 'メール', '電話番号', '採用予定人数', 'マイナビ掲載', '取得元媒体', '根拠URL'];
  fs.writeFileSync(abs(OUT), toCsv(HEAD, out));
  const withName = out.filter((r) => r['採用担当者名']).length;
  console.log(`\n出力: ${OUT}（ユニーク ${out.length}社 / うち担当者名あり ${withName}）`);
  console.log('※ 担当者名は母集団の壁で少数。到達性(部署/電話/メール/予定人数)はマイナビ実取得分を付与＝架電リストの底上げ。');
}

run();
