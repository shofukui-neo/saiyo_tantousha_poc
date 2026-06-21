'use strict';
/**
 * MOCHICA営業リスト・ビルダー（採点＋根拠＋確信度レポート）
 * =====================================================================
 * 「このリストは“今のリスト”よりアポが取れる」と言い切るための一気通貫CLI。
 *   1. ベースCSV（電話・規模・業種・代表者名を持つ手持ちリスト）を読む
 *   2. インテントCSV（新卒フラグ/掲載媒体数/採用中…）を法人番号/社名で名寄せ合流
 *   3. （任意）--enrich でマイナビをPlaywright実スクレイピングし採用担当者名＋掲載確認を補完
 *   4. mochica-fit でアポ取得期待値を採点 → 降順ソート
 *   5. 「なぜ今・なぜこの企業」付きCSVを出力し、上位の“裏取り率”を確信度レポートで提示
 *
 * 使い方:
 *   node src/build-mochica-list.js                          # 既定で採点まで
 *   node src/build-mochica-list.js --in leads-daihyou-1000.csv --intent leads.master.csv
 *   node src/build-mochica-list.js --enrich 30              # 上位30社の担当者名をマイナビ実取得
 *   node src/build-mochica-list.js --enrich 50 --enrich-empty-only --top 40
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, mergeKey, truthy } = require('./csv');
const { scoreMochica } = require('./mochica-fit');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}

// 合流ソースから借りてくる列（ベースが空のとき、最初に見つかった非空値を採用）
// ① 連絡先（テレアポ成立条件。電話を持つ別リストや代表者名リストから補完）
const CONTACT_BORROW = ['電話番号', 'メール', 'メール確度', '担当者確度', '代表者名',
  '採用担当者名', '役職', '部署', '公式URL', '従業員数', '業種', '都道府県', '設立年', '補助金', '法人番号'];
// ② 新卒インテント（master 等の出稿/フラグから補完）
const INTENT_BORROW = ['新卒フラグ', '新卒出稿', '現在求人掲載中', '掲載媒体', '掲載媒体数', '出稿媒体数',
  '採用中', '求人件数', '採用予定人数', '募集職種数', '採用職種', '職種', '採用ページ有無', '採用ページURL',
  '新卒言及', '発見媒体', '辞退シグナル', '採用ページ更新', '出稿増', '来期検討', 'プレスリリース', '競合ATS導入'];
const BORROW_COLS = [...new Set([...CONTACT_BORROW, ...INTENT_BORROW])];

function loadCsv(p) {
  if (!p || !fs.existsSync(p)) return { headers: [], records: [] };
  return readCsv(fs.readFileSync(p, 'utf8'));
}

// インテントCSVを名寄せキーで引けるMapに
function indexByKey(records) {
  const map = new Map();
  for (const r of records) { const k = mergeKey(r); if (k && !map.has(k)) map.set(k, r); }
  return map;
}

const bar = (n, w = 18) => '█'.repeat(Math.round((n / 100) * w)) + '░'.repeat(w - Math.round((n / 100) * w));
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

async function maybeEnrich(records, scoredSorted) {
  const enrichN = parseInt(getArg('enrich', '0'), 10) || 0;
  if (!enrichN) return { enriched: 0 };
  const emptyOnly = !!getArg('enrich-empty-only', false);
  // 上位から、担当者名が空（or 全件）の社を対象に
  let targets = scoredSorted.map((x) => x.rec);
  if (emptyOnly) targets = targets.filter((r) => !String(r['採用担当者名'] || '').trim());
  targets = targets.slice(0, enrichN);
  if (!targets.length) return { enriched: 0 };

  console.log(`\n  ▶ マイナビ実スクレイピングで採用担当者名を補完（対象 ${targets.length}社, Playwright起動）…`);
  const { MynaviScraper } = require('./scrape-mynavi');
  const sc = new MynaviScraper();
  await sc.launch();
  let got = 0;
  try {
    for (let i = 0; i < targets.length; i++) {
      const rec = targets[i];
      process.stdout.write(`    [${i + 1}/${targets.length}] ${rec['企業名']} … `);
      const r = await sc.scrapeCompany(rec['企業名']).catch((e) => ({ 根拠: 'error:' + e.message }));
      if (r.マイナビ掲載) { rec['マイナビ掲載'] = r.マイナビ掲載; rec['新卒掲載確認'] = '○'; }
      if (r.採用担当者名) { rec['採用担当者名'] = r.採用担当者名; got++; }
      if (r.部署 && !rec['部署']) rec['部署'] = r.部署;
      if (r.役職 && !rec['役職']) rec['役職'] = r.役職;
      if (r.採用ページURL && !rec['採用ページURL']) rec['採用ページURL'] = r.採用ページURL;
      if (r.募集職種 && !rec['採用職種']) rec['採用職種'] = r.募集職種;
      if (r.募集職種数 && !rec['募集職種数']) rec['募集職種数'] = r.募集職種数;
      if (r.採用予定人数 && !rec['採用予定人数']) rec['採用予定人数'] = r.採用予定人数;
      console.log(`${r.マイナビ掲載 ? '掲載○' : '掲載×'} ${r.採用担当者名 || '担当者—'}`);
    }
  } finally { await sc.close(); }
  console.log(`  ▶ 補完完了：担当者名 ${got}/${targets.length}社 取得\n`);
  return { enriched: got };
}

async function main() {
  // ベースは“架電できる”telapoリスト（電話番号を全件保持）。--merge で連絡先/インテントを合流。
  const inPath = getArg('in', 'leads-telapo-1000.csv');
  // 既定の合流ソース: daihyou(代表者名) + master(新卒インテント) + A-pages(媒体横断 掲載媒体数/従業員数/採用人数)
  const mergeArg = getArg('merge', getArg('intent', 'leads-daihyou-1000.csv,leads.master.csv,sources/A-pages.csv'));
  const mergePaths = String(mergeArg).split(',').map((s) => s.trim()).filter(Boolean);
  const outPath = getArg('out', 'leads-mochica.scored.csv');
  const top = parseInt(getArg('top', '20'), 10) || 20;
  const min = getArg('min', null) != null ? parseFloat(getArg('min')) : null;
  const reportN = parseInt(getArg('report', '100'), 10) || 100;

  if (!fs.existsSync(inPath)) {
    console.error(`ベースCSVが見つかりません: ${path.resolve(inPath)}`); process.exit(1);
  }
  const base = loadCsv(inPath);
  if (!base.records.length) { console.error('ベースCSVが空です'); process.exit(1); }
  // 借用列がベースヘッダに無ければ追加（合流値の置き場所を確保）
  for (const col of BORROW_COLS) if (!base.headers.includes(col)) base.headers.push(col);

  // ── 連絡先＋インテントを複数ソースから合流（法人番号→社名キー, 最初の非空値を採用）──
  const mergeStats = [];
  for (const mp of mergePaths) {
    const src = loadCsv(mp);
    if (!src.records.length) { mergeStats.push(`${path.basename(mp)}:なし`); continue; }
    const idx = indexByKey(src.records);
    let touched = 0;
    for (const rec of base.records) {
      const k = mergeKey(rec);
      const s = k ? idx.get(k) : null;
      if (!s) continue;
      let t = false;
      for (const col of BORROW_COLS) {
        if (s[col] != null && String(s[col]).trim() !== '' && !String(rec[col] || '').trim()) { rec[col] = s[col]; t = true; }
      }
      if (t) touched++;
    }
    mergeStats.push(`${path.basename(mp)}:${touched}社`);
  }
  const merged = mergeStats.join(' / ');

  const now = new Date();
  // 初回採点（enrich対象を上位から選ぶため一度ソート）
  let scored = base.records.map((rec) => ({ rec, s: scoreMochica(rec, { now }) }));
  scored.sort((a, b) => b.s.total - a.s.total);

  // ── 任意：マイナビ実取得で担当者名・掲載確認を補完 → 再採点 ──
  const enr = await maybeEnrich(base.records, scored);
  if (enr.enriched) {
    scored = base.records.map((rec) => ({ rec, s: scoreMochica(rec, { now }) }));
    scored.sort((a, b) => b.s.total - a.s.total);
  }

  // ── 出力CSV（営業がそのまま使う列を前に） ──
  const SCORE_COLS = ['アポ期待度', '優先度', '確信度', 'なぜ今なぜこの企業',
    'INT', 'SIZE', 'REACH', 'TIM', 'TRUST', '採点根拠'];
  const outHeaders = SCORE_COLS.concat(base.headers.filter((h) => !SCORE_COLS.includes(h)));
  const outRecords = [];
  for (const { rec, s } of scored) {
    if (min != null && s.total < min) continue;
    outRecords.push(Object.assign({}, rec, {
      'アポ期待度': s.total, '優先度': s.priority, '確信度': s.confidence, 'なぜ今なぜこの企業': s.why,
      'INT': s.dims.intent, 'SIZE': s.dims.size, 'REACH': s.dims.reach, 'TIM': s.dims.timing, 'TRUST': s.dims.trust,
      '採点根拠': s.reasons.join(' / '),
    }));
  }
  fs.writeFileSync(outPath, toCsv(outHeaders, outRecords), 'utf8');

  // ── 確信度レポート（“言い切る”ための裏取り集計） ──
  const L = '──────────────────────────────────────────────';
  const total = scored.length;
  const band = (name) => scored.filter((x) => x.s.priority === name);
  const callThisWeek = band('今週架電');
  const headN = scored.slice(0, Math.min(reportN, total));
  const agg = (arr, pred) => pct(arr.filter(pred).length, arr.length);
  const avg = (arr, key) => Math.round(arr.reduce((a, x) => a + (key === 'total' ? x.s.total : key === 'conf' ? x.s.confidence : x.s.dims[key]), 0) / (arr.length || 1));

  console.log('\n' + L);
  console.log('  MOCHICA営業リスト — アポ取得期待値モデル v1');
  console.log(L);
  console.log(`  入力(架電ベース): ${path.resolve(inPath)}（${base.records.length}社）`);
  console.log(`  連絡先/インテント合流: ${merged}`);
  console.log(`  ターゲット: 新卒を増やしたい中小(50-150名) × 28卒の媒体選定・採用設計期`);
  console.log(L);
  console.log('  ◆ 平均スコア（全体）');
  console.log(`    アポ期待度    : ${avg(scored, 'total')}  ${bar(avg(scored, 'total'))}`);
  console.log(`    ① 新卒インテント: ${avg(scored, 'intent')}  ${bar(avg(scored, 'intent'))}`);
  console.log(`    ② 規模フィット : ${avg(scored, 'size')}  ${bar(avg(scored, 'size'))}`);
  console.log(`    ③ 到達性      : ${avg(scored, 'reach')}  ${bar(avg(scored, 'reach'))}`);
  console.log(`    ④ タイミング   : ${avg(scored, 'timing')}  ${bar(avg(scored, 'timing'))}`);
  console.log(L);
  console.log('  ◆ 架電優先度');
  console.log(`    今週架電(70+)       : ${callThisWeek.length}`);
  console.log(`    ナーチャリング(50-69): ${band('ナーチャリング').length}`);
  console.log(`    後回し(<50)         : ${band('後回し').length}`);
  console.log(L);
  console.log(`  ◆ 確信度レポート — 上位${headN.length}社は“最適な相手”か（裏取り率）`);
  console.log(`    新卒採用を実データで確認 : ${agg(headN, x => x.s.flags.verifiedIntent)}%   ← 「本当に新卒採用している」`);
  console.log(`    規模スイート(50-150名)   : ${agg(headN, x => x.s.flags.sizeFit)}%   ← 「MOCHICAが刺さる規模」`);
  console.log(`    電話で架電可能            : ${agg(headN, x => x.s.flags.callable)}%   ← 「今日電話できる」`);
  console.log(`    採用担当者を名指し可能    : ${agg(headN, x => x.s.flags.named)}%   ← 「担当者に繋がる」`);
  console.log(`    平均確信度               : ${avg(headN, 'conf')}/100`);
  console.log(L);
  console.log(`  ◆ 今週架電すべき上位${Math.min(top, scored.length)}社（期待度｜INT/SIZE/REACH/TIM｜確信度）`);
  scored.slice(0, top).forEach((x, i) => {
    const d = x.s.dims;
    console.log(`   ${String(i + 1).padStart(2)}. ${String(x.s.total).padStart(3)}｜${String(d.intent).padStart(3)}/${String(d.size).padStart(3)}/${String(d.reach).padStart(3)}/${String(d.timing).padStart(3)}｜確信${String(x.s.confidence).padStart(3)}  ${x.rec['企業名'] || ''}`);
    console.log(`       └ ${x.s.why}`);
  });
  console.log(L);
  console.log(`\n  出力: ${path.resolve(outPath)}（${outRecords.length}社${min != null ? `, アポ期待度${min}+のみ` : ''}）`);
  // “言い切る”ための一行サマリ
  const verifiedTop = agg(callThisWeek.length ? callThisWeek : headN, x => x.s.flags.verifiedIntent);
  const callableTop = agg(callThisWeek.length ? callThisWeek : headN, x => x.s.flags.callable);
  console.log(`\n  ✅ 言い切れること: 今週架電リストの ${verifiedTop}% は新卒採用を実データで確認済み、`);
  console.log(`     ${callableTop}% は今日そのまま架電できる。汎用属性ではなく“新卒インテント×規模×到達性×28卒設計期”で選定。\n`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
