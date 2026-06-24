'use strict';
/**
 * 最終アセンブラ：採用担当者名つき × MOCHICAターゲット × 高スコア 厳選リスト
 * =====================================================================
 * 全ての「採用担当者名つき」名簿を1本に束ね、媒体プロヴェナンス（どの媒体由来か）を
 * インテント信号へ変換し、手持ち属性（電話・規模・新卒フラグ）を名寄せ合流して
 * mochica-fit で採点 → 高確度・高スコアのみを厳選する。build-named-select の上位版。
 *
 *   名前ソース（採用担当者名あり）:
 *     - data/recruiter-probe-harvest.csv  自社採用ページ実取得（harvest-catalog --recruit-pages）★最重要
 *     - data/recruiter-fresh / -gemini / -recruitpage-full.csv  自社採用ページ
 *     - data/recruiter-wantedly.csv       Wantedly募集（投稿者名・中途寄り）
 *     - leads-mochica-target.csv          既に担当者名が入っている行
 *   属性合流（電話/規模/設立年/業種/新卒フラグ…）:
 *     - leads-mochica-target.csv（713社・電話と新卒フラグ保持）＋ data/*-records.json
 *
 *   node src/build-named-mochica.js [--min 70]
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, mergeKey, normCompanyName, normCorpNumber, truthy } = require('./csv');
const { scoreMochica } = require('./mochica-fit');
const { isFullName, isKnownSurname } = require('./jp-names');

// 氏名の妥当性（最高確度リストの品質ゲート）。姓辞書フルネーム/既知姓/ローマ字フルネームのみOK。
// "M.A"(イニシャル)・"胡麻"(一般語)・"宮城県"(住所由来の地名)等の誤抽出を弾く。
// 確度値はパターン強度であり氏名妥当性ではないため別途検証する。
const GEO_TAIL_RE = /[都道府県市区町村郡]$/;                 // 「宮城県」「青葉区」等の地名語尾
const PREF_RE = /^(北海道|青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|東京|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|京都|大阪|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄)/;
function validName(n) {
  const s = String(n || '').trim();
  if (!s) return false;
  const joined = s.replace(/[ 　]/g, '');
  if (GEO_TAIL_RE.test(joined)) return false;                // 県/市/区/町… で終わる＝住所片
  if (PREF_RE.test(joined) && joined.length <= 4) return false; // 「宮城県」「東京都」等の都道府県名
  if (isFullName(s) || isKnownSurname(s)) return true;
  return /^[A-Z][a-z]+\s+[A-Z][a-z]+$/.test(s); // ローマ字フルネーム
}

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const getArg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };

// 名前ソース。kind: 'recruit-page'＝自社採用ページ由来（採用ページ有無シグナル）、'wantedly'＝中途寄り。
const NAME_SOURCES = [
  { p: path.join(DATA, 'recruiter-adaptive.csv'), tag: '企業サイト探索(適応)', kind: 'recruit-page', conf: 0.82 },
  { p: path.join(DATA, 'recruiter-deep-harvest.csv'), tag: '自社採用ページ(深掘り)', kind: 'recruit-page', conf: 0.82 },
  { p: path.join(DATA, 'recruiter-probe-harvest.csv'), tag: '自社採用ページ(実取得)', kind: 'recruit-page', conf: 0.8 },
  { p: path.join(DATA, 'recruiter-fresh.csv'), tag: '自社採用ページ', kind: 'recruit-page' },
  { p: path.join(DATA, 'recruiter-gemini.csv'), tag: '自社採用ページ', kind: 'recruit-page' },
  { p: path.join(DATA, 'recruiter-recruitpage-full.csv'), tag: '自社採用ページ', kind: 'recruit-page' },
  { p: path.join(DATA, 'recruiter-mynavi.csv'), tag: 'マイナビ', kind: 'mynavi', conf: 0.7 },
  { p: path.join(DATA, 'recruiter-wantedly.csv'), tag: 'Wantedly募集', kind: 'wantedly' },
];
const TARGET_CSV = path.join(ROOT, 'leads-mochica-target.csv');
const ATTR_JSON = ['merged-records.json', 'fresh-records.json', 'records-1000.json', 'gbiz-records.json'].map((f) => path.join(DATA, f));

const BORROW = ['電話番号', '従業員数', '設立年', '業種', '都道府県', '代表者名', '法人番号', '公式URL',
  'メール', 'メール確度', '担当者確度', '補助金', 'マイナビ掲載', '新卒掲載確認',
  '新卒フラグ', '新卒出稿', '現在求人掲載中', '掲載媒体', '掲載媒体数', '出稿媒体数', '採用中',
  '求人件数', '採用予定人数', '募集職種数', '採用職種', '職種', '採用ページ有無', '採用ページURL',
  '新卒言及', '発見媒体', '辞退シグナル', '採用ページ更新', '出稿増', '来期検討', 'プレスリリース', '競合ATS導入'];

const loadCsv = (p) => fs.existsSync(p) ? readCsv(fs.readFileSync(p, 'utf8')).records : [];
const loadJson = (p) => { if (!fs.existsSync(p)) return []; try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return Array.isArray(j) ? j : (j.records || []); } catch { return []; } };

// 属性は法人番号キーと正規化社名キーの両方で引けるようにする（収穫CSVは法人番号を持たず社名キーのため）。
function buildAttrIndex() {
  const idx = new Map();
  const absorb = (recs) => {
    for (const r of recs) {
      const num = normCorpNumber(r['法人番号']);
      const nm = normCompanyName(r['企業名'] || r['company_name'] || '');
      const keys = [];
      if (num) keys.push('C:' + num);
      if (nm) keys.push('N:' + nm);          // 法人番号で引けない収穫行のフォールバック
      if (!keys.length) continue;
      let cur = null;
      for (const k of keys) if (idx.has(k)) { cur = idx.get(k); break; }
      if (!cur) cur = {};
      for (const col of BORROW) if ((cur[col] == null || cur[col] === '') && r[col] != null && String(r[col]).trim() !== '') cur[col] = r[col];
      for (const k of keys) idx.set(k, cur);  // 同一企業を両キーで同じ属性オブジェクトに束ねる
    }
  };
  absorb(loadCsv(TARGET_CSV));      // 電話・新卒フラグを持つ手持ち713社を最優先
  absorb(loadCsv(path.join(DATA, 'recruiter-mynavi.csv'))); // マイナビ掲載○/電話/卒年で intent・到達性を底上げ
  for (const p of ATTR_JSON) absorb(loadJson(p));
  return idx;
}
// レコードを法人番号→社名の順で属性引き
function attrLookup(idx, rec) {
  const num = normCorpNumber(rec['法人番号']);
  if (num && idx.has('C:' + num)) return idx.get('C:' + num);
  const nm = normCompanyName(rec['企業名'] || '');
  return nm ? idx.get('N:' + nm) : null;
}

function main() {
  const min = parseFloat(getArg('min', '70'));
  const now = new Date();

  // 1) 名前ありを束ねて社名で重複排除（確度の高い方を残す）。媒体プロヴェナンスを保持。
  const byKey = new Map();
  const srcStats = [];
  for (const { p, tag, kind, conf: baseConf } of NAME_SOURCES) {
    const recs = loadCsv(p).filter((r) => String(r['採用担当者名'] || '').trim());
    srcStats.push({ src: path.basename(p), n: recs.length });
    for (const r of recs) {
      const k = mergeKey(r); if (!k) continue;
      const conf = parseFloat(r['確度'] || '') || baseConf || 0;
      const evid = r['根拠URL'] || '';
      const cand = {
        '企業名': r['企業名'], '採用担当者名': r['採用担当者名'], '役職': r['役職'] || '', '部署': r['部署'] || '',
        '採用担当者名取得元': r['取得元'] || tag, '担当者確度': r['確度'] || (baseConf || ''),
        '根拠URL': evid, '公式URL': r['公式URL'] || '', '_conf': conf, '_kind': kind,
      };
      // 自社採用ページ由来＝採用ページ有無シグナルを立てる（INTのrecruitPage判定に効く。捏造でなく取得元の事実）
      if (kind === 'recruit-page') { cand['採用ページ有無'] = '○'; if (evid) cand['採用ページURL'] = evid; }
      // マイナビ由来＝新卒掲載の実取得（mynaviHit→INT最強ティア）。電話も持ち帰る。
      if (kind === 'mynavi') { cand['マイナビ掲載'] = r['マイナビ掲載'] || '○'; if (r['電話番号']) cand['電話番号'] = r['電話番号']; if (r['募集職種数']) cand['募集職種数'] = r['募集職種数']; }
      const prev = byKey.get(k);
      if (!prev || conf > prev._conf) byKey.set(k, cand);
    }
  }
  // leads-mochica-target.csv 内の担当者名あり行（属性フル）
  let targetNamed = 0;
  for (const r of loadCsv(TARGET_CSV).filter((x) => String(x['採用担当者名'] || '').trim())) {
    const k = mergeKey(r); if (!k) continue; targetNamed++;
    if (!byKey.has(k)) byKey.set(k, { '企業名': r['企業名'], '採用担当者名': r['採用担当者名'], '役職': r['役職'] || '', '部署': r['部署'] || '', '採用担当者名取得元': r['採用担当者名取得元'] || r['取得元媒体'] || '', '担当者確度': r['担当者確度'] || '', '根拠URL': r['根拠URL'] || '', '公式URL': r['公式URL'] || '', '_conf': 0.9, '_kind': 'target' });
  }

  // 2) 属性合流
  const attr = buildAttrIndex();
  let enriched = 0, hasPhone = 0;
  const records = [];
  for (const [k, rec] of byKey) {
    const a = attrLookup(attr, rec);
    if (a) { let t = false; for (const col of BORROW) if (a[col] != null && a[col] !== '' && !String(rec[col] || '').trim()) { rec[col] = a[col]; t = true; } if (t) enriched++; }
    if (String(rec['電話番号'] || '').trim()) hasPhone++;
    records.push(rec);
  }

  // 3) 採点
  const scored = records.map((rec) => ({ rec, s: scoreMochica(rec, { now }) }));
  scored.sort((a, b) => b.s.total - a.s.total);

  // 4) 出力
  const SCORE_COLS = ['アポ期待度', '優先度', '確信度', 'なぜ今なぜこの企業', 'INT', 'SIZE', 'REACH', 'TIM', 'TRUST'];
  const META = ['企業名', '採用担当者名', '氏名検証', '役職', '部署', '採用担当者名取得元', '担当者確度', '電話番号', '従業員数', '業種', '都道府県', '設立年', '代表者名', '法人番号', '新卒フラグ', '公式URL', '根拠URL', '採点根拠'];
  const headers = [...SCORE_COLS, ...META];
  const toRow = ({ rec, s }) => Object.assign({}, rec, { 'アポ期待度': s.total, '優先度': s.priority, '確信度': s.confidence, 'なぜ今なぜこの企業': s.why, 'INT': s.dims.intent, 'SIZE': s.dims.size, 'REACH': s.dims.reach, 'TIM': s.dims.timing, 'TRUST': s.dims.trust, '氏名検証': validName(rec['採用担当者名']) ? 'OK' : '要確認', '採点根拠': s.reasons.join(' / ') });
  const allRows = scored.map(toRow);
  const select = scored.filter((x) => x.s.total >= min);
  // 最高確度＝70+ × 電話妥当 × 担当者名あり × 氏名検証OK
  const callableNamed = scored.filter((x) => x.s.total >= min && /電話妥当/.test(x.s.reasons.join('')) && /担当者名あり/.test(x.s.reasons.join('')) && validName(x.rec['採用担当者名']));

  fs.writeFileSync(path.join(DATA, 'recruiter-scored-all.csv'), toCsv(headers, allRows), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'leads-mochica-named-select.csv'), toCsv(headers, select.map(toRow)), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'leads-mochica-named-callable.csv'), toCsv(headers, callableNamed.map(toRow)), 'utf8');

  // 5) レポート
  const L = '──────────────────────────────────────────────';
  const band = (n) => scored.filter((x) => x.s.priority === n).length;
  const cnt = (arr, pred) => arr.filter(pred).length;
  console.log('\n' + L);
  console.log('  最終厳選：採用担当者名 × MOCHICAターゲット × 高スコア');
  console.log(L);
  console.log('  名前ソース（採用担当者名あり・重複排除前）:');
  for (const s of srcStats) console.log(`    ${s.src.padEnd(34)} : ${s.n}`);
  console.log(`    leads-mochica-target.csv(担当者名あり)   : ${targetNamed}`);
  console.log(L);
  console.log(`  重複排除後の母数        : ${records.length}社`);
  console.log(`  属性合流できた          : ${enriched}社（電話判明 ${hasPhone}社）`);
  console.log(L);
  console.log('  ◆ 採点バンド');
  console.log(`    今週架電(70+)         : ${band('今週架電')}`);
  console.log(`    ナーチャリング(50-69)  : ${band('ナーチャリング')}`);
  console.log(`    後回し(<50)           : ${band('後回し')}`);
  console.log(L);
  console.log(`  ◆ 厳選（アポ期待度 ${min}+）: ${select.length}社`);
  console.log(`     ├ 電話で名指し架電可能（最高確度） : ${callableNamed.length}社 → leads-mochica-named-callable.csv`);
  console.log(`     └ 規模スイート(50-150)            : ${cnt(select, (x) => x.s.dims.size >= 90)}社`);
  console.log(L);
  console.log(`  ◆ 厳選 上位${Math.min(25, select.length)}社（期待度｜INT/SIZE/REACH/TIM｜担当者｜電話）`);
  select.slice(0, 25).forEach((x, i) => {
    const d = x.s.dims; const ph = String(x.rec['電話番号'] || '').trim();
    console.log(`   ${String(i + 1).padStart(2)}. ${String(x.s.total).padStart(3)}｜${String(d.intent).padStart(3)}/${String(d.size).padStart(3)}/${String(d.reach).padStart(3)}/${String(d.timing).padStart(3)}  ${x.rec['企業名']}（${x.rec['採用担当者名']}）${ph ? '☎' + ph : '電話なし'}`);
  });
  console.log(L);
  console.log(`  出力: leads-mochica-named-callable.csv（最高確度 ${callableNamed.length}社）`);
  console.log(`        leads-mochica-named-select.csv  （厳選 ${select.length}社）`);
  console.log(`        data/recruiter-scored-all.csv    （採点全 ${allRows.length}社）\n`);
}

main();
