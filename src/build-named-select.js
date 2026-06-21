'use strict';
/**
 * 採用担当者名つき × MOCHICAターゲット × 高スコア 厳選ビルダー
 * =====================================================================
 * 「採用担当者名が判明している」名簿（recruiter-*.csv 各系統）を1本に束ね、
 * 手持ちの属性ソース（leads-mochica-target.csv ＋ records JSON群）から
 * 従業員数/電話/設立年/業種…を名寄せ合流して“採点可能”な状態にし、
 * mochica-fit でアポ取得期待値を採点 → 高スコアのみを厳選する。
 *
 *   入力（名前あり）: data/recruiter-fresh / -gemini / -recruitpage-full / -wantedly
 *                    ＋ leads-mochica-target.csv の採用担当者名あり行
 *   属性合流ソース  : leads-mochica-target.csv（電話・規模・業種を持つ）
 *                    ＋ data/{merged,fresh,records-1000,gbiz}-records.json（規模/設立年/業種）
 *
 *   node src/build-named-select.js [--min 70]
 *     --min   厳選しきい値（アポ期待度）。既定70＝「今週架電」バンド
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, mergeKey, truthy } = require('./csv');
const { scoreMochica } = require('./mochica-fit');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const getArg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };

// 採用担当者名を持つ名簿（各系統）。確度・取得元・根拠も保持。
const NAME_SOURCES = [
  { p: path.join(DATA, 'recruiter-fresh.csv'), tag: '自社採用ページ(fresh)' },
  { p: path.join(DATA, 'recruiter-gemini.csv'), tag: '自社採用ページ(gemini)' },
  { p: path.join(DATA, 'recruiter-recruitpage-full.csv'), tag: '自社採用ページ' },
  { p: path.join(DATA, 'recruiter-wantedly.csv'), tag: 'Wantedly募集' },
];
// 属性（電話/規模/設立年/業種…）を借りてくるソース。先に来たものを優先。
const ATTR_CSV = [path.join(ROOT, 'leads-mochica-target.csv')];
const ATTR_JSON = ['merged-records.json', 'fresh-records.json', 'records-1000.json', 'gbiz-records.json']
  .map((f) => path.join(DATA, f));

// 借用する属性列（mochica-fit が読む列を網羅）
const BORROW = ['電話番号', '従業員数', '設立年', '業種', '都道府県', '代表者名', '法人番号', '公式URL',
  'メール', 'メール確度', '担当者確度', '補助金',
  '新卒フラグ', '新卒出稿', '現在求人掲載中', '掲載媒体', '掲載媒体数', '出稿媒体数', '採用中',
  '求人件数', '採用予定人数', '募集職種数', '採用職種', '職種', '採用ページ有無', '採用ページURL',
  '新卒言及', '発見媒体', '辞退シグナル', '採用ページ更新', '出稿増', '来期検討', 'プレスリリース', '競合ATS導入'];

function loadCsv(p) {
  if (!fs.existsSync(p)) return [];
  return readCsv(fs.readFileSync(p, 'utf8')).records;
}
function loadJson(p) {
  if (!fs.existsSync(p)) return [];
  try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return Array.isArray(j) ? j : (j.records || []); }
  catch { return []; }
}

// 属性インデックス（mergeKey → 属性レコード、最初の非空が勝つ）
function buildAttrIndex() {
  const idx = new Map();
  const absorb = (recs) => {
    for (const r of recs) {
      const k = mergeKey(r); if (!k) continue;
      const cur = idx.get(k) || {};
      for (const col of BORROW) {
        if ((cur[col] == null || cur[col] === '') && r[col] != null && String(r[col]).trim() !== '') cur[col] = r[col];
      }
      idx.set(k, cur);
    }
  };
  for (const p of ATTR_CSV) absorb(loadCsv(p));
  for (const p of ATTR_JSON) absorb(loadJson(p));
  return idx;
}

function main() {
  const min = parseFloat(getArg('min', '70'));
  const now = new Date();

  // ── 1) 名前ありレコードを束ねて社名で重複排除（確度の高い方を残す）──
  const byKey = new Map();
  const srcStats = [];
  for (const { p, tag } of NAME_SOURCES) {
    const recs = loadCsv(p).filter((r) => String(r['採用担当者名'] || '').trim());
    srcStats.push(`${path.basename(p)}:${recs.length}`);
    for (const r of recs) {
      const k = mergeKey(r); if (!k) continue;
      const conf = parseFloat(r['確度'] || '0') || 0;
      const cand = {
        '企業名': r['企業名'], '採用担当者名': r['採用担当者名'], '役職': r['役職'] || '', '部署': r['部署'] || '',
        '採用担当者名取得元': r['取得元'] || tag, '担当者確度': r['確度'] || '', '根拠URL': r['根拠URL'] || '',
        '根拠': r['根拠'] || '', '公式URL': r['公式URL'] || '', '_conf': conf,
      };
      const prev = byKey.get(k);
      if (!prev || conf > prev._conf) byKey.set(k, cand);
    }
  }
  // leads-mochica-target.csv 内の採用担当者名あり行（既に属性フル）も合流
  for (const r of loadCsv(ATTR_CSV[0]).filter((x) => String(x['採用担当者名'] || '').trim())) {
    const k = mergeKey(r); if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, {
      '企業名': r['企業名'], '採用担当者名': r['採用担当者名'], '役職': r['役職'] || '', '部署': r['部署'] || '',
      '採用担当者名取得元': r['採用担当者名取得元'] || r['取得元媒体'] || '', '担当者確度': r['担当者確度'] || '',
      '根拠URL': r['根拠URL'] || '', '根拠': '', '公式URL': r['公式URL'] || '', '_conf': 0.9,
    });
  }

  // ── 2) 属性合流 ──
  const attr = buildAttrIndex();
  let enriched = 0, hasPhone = 0;
  const records = [];
  for (const [k, rec] of byKey) {
    const a = attr.get(k);
    if (a) { for (const col of BORROW) if (a[col] != null && a[col] !== '' && !String(rec[col] || '').trim()) rec[col] = a[col]; enriched++; }
    if (String(rec['電話番号'] || '').trim()) hasPhone++;
    records.push(rec);
  }

  // ── 3) 採点 ──
  const scored = records.map((rec) => ({ rec, s: scoreMochica(rec, { now }) }));
  scored.sort((a, b) => b.s.total - a.s.total);

  // ── 4) 出力列 ──
  const SCORE_COLS = ['アポ期待度', '優先度', '確信度', 'なぜ今なぜこの企業', 'INT', 'SIZE', 'REACH', 'TIM', 'TRUST'];
  const META_COLS = ['企業名', '採用担当者名', '役職', '部署', '採用担当者名取得元', '担当者確度',
    '電話番号', '従業員数', '業種', '都道府県', '設立年', '代表者名', '法人番号', '公式URL', '根拠URL', '採点根拠'];
  const headers = [...SCORE_COLS, ...META_COLS];
  const toRow = ({ rec, s }) => Object.assign({}, rec, {
    'アポ期待度': s.total, '優先度': s.priority, '確信度': s.confidence, 'なぜ今なぜこの企業': s.why,
    'INT': s.dims.intent, 'SIZE': s.dims.size, 'REACH': s.dims.reach, 'TIM': s.dims.timing, 'TRUST': s.dims.trust,
    '採点根拠': s.reasons.join(' / '),
  });

  const allRows = scored.map(toRow);
  const select = scored.filter((x) => x.s.total >= min);
  const selRows = select.map(toRow);

  const outAll = path.join(DATA, 'recruiter-scored-all.csv');
  const outSel = path.join(ROOT, 'leads-mochica-named-select.csv');
  fs.writeFileSync(outAll, toCsv(headers, allRows), 'utf8');
  fs.writeFileSync(outSel, toCsv(headers, selRows), 'utf8');

  // ── 5) ファネル・レポート ──
  const L = '──────────────────────────────────────────────';
  const band = (n) => scored.filter((x) => x.s.priority === n).length;
  const callable = (arr) => arr.filter((x) => /電話妥当/.test(x.s.reasons.join(''))).length;
  const sizeFit = (arr) => arr.filter((x) => x.s.dims.size >= 90).length;
  console.log('\n' + L);
  console.log('  採用担当者名つき × MOCHICAターゲット × 高スコア 厳選');
  console.log(L);
  console.log(`  名簿ソース(名前あり): ${srcStats.join(' / ')}`);
  console.log(`  重複排除後の母数     : ${records.length}社（採用担当者名あり）`);
  console.log(`  属性合流できた       : ${enriched}/${records.length}社（電話判明 ${hasPhone}社）`);
  console.log(L);
  console.log('  ◆ 採点バンド（全 ' + records.length + '社）');
  console.log(`    今週架電(70+)        : ${band('今週架電')}`);
  console.log(`    ナーチャリング(50-69) : ${band('ナーチャリング')}`);
  console.log(`    後回し(<50)          : ${band('後回し')}`);
  console.log(L);
  console.log(`  ◆ 厳選（アポ期待度 ${min}+）: ${select.length}社`);
  console.log(`    うち 電話で架電可能   : ${callable(select)}社`);
  console.log(`    うち 規模スイート(50-150): ${sizeFit(select)}社`);
  console.log(L);
  console.log(`  ◆ 厳選 上位${Math.min(25, select.length)}社（期待度｜INT/SIZE/REACH/TIM｜担当者）`);
  select.slice(0, 25).forEach((x, i) => {
    const d = x.s.dims;
    console.log(`   ${String(i + 1).padStart(2)}. ${String(x.s.total).padStart(3)}｜${String(d.intent).padStart(3)}/${String(d.size).padStart(3)}/${String(d.reach).padStart(3)}/${String(d.timing).padStart(3)}  ${x.rec['企業名']}（${x.rec['採用担当者名']}）${String(x.rec['電話番号'] || '').trim() ? '☎' + x.rec['電話番号'] : '電話なし'}`);
  });
  console.log(L);
  console.log(`  出力: ${outSel}（厳選 ${select.length}社）`);
  console.log(`        ${outAll}（採点全 ${allRows.length}社）\n`);
}

main();
