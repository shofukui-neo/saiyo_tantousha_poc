'use strict';
/**
 * 納品リスト組み立て：ICP完全適合 × 年間新卒採用予定6名以上 × 重複なし 500件
 * ============================================================================
 * ユーザー要件（2026-08-17）:
 *   「ICP完全適合／採用人数は必ず6人以上／重複なしのリストを500件」
 *
 * ハード条件（1つでも欠けたら落とす。件数より“条件を満たしていること”を優先）:
 *   ① 完全新規   … 統合マスタ/BALES/MOCHICA顧客/SF全リード/NG企業のいずれにも社名が不在
 *   ② 新卒インテント … マイナビ新卒の掲載を実スクレイプで確認済（scoreMochica.flags.verifiedIntent）
 *   ③ 規模フィット … 会社概要ページの従業員数 100〜2000名
 *   ④ 非IT      … 会社概要の業種ラベルで IT/ソフトを絶対除外
 *   ⑤ 到達性    … 電話番号が日本の電話番号として妥当（架電できる）
 *   ⑥ 採用フロア … 年間新卒採用が **6名以上**（今回はハード条件。従来は軟らかい軸だった）
 *   ⑦ 重複なし   … 正規化社名(mkey)で1社1行。corpIDの重複も排除
 *
 * ⑥の一次情報（data/hire-count.json ＝ 採用人数台帳。大きい方を採り、どちらを採ったかを列に残す）:
 *   ・実績 … マイナビ会社概要の「過去3年間の新卒採用者数」等から **直近年の実際の採用者数**
 *            （enrich-hire-record.js）。1,090社中1,040社で判明した最も確かな一次情報。
 *   ・予定 … マイナビ採用データの募集コース別「募集人数 X～Y名」を合算した **下限和**
 *            （enrich-hire-crossyear.js）。例 8コース×「1～5名」= 23～55名 → 23名。
 *   実測: 募集人数が「1～5名」でも実績は年15～20名という社が普通にあるため、実績を優先的に採る。
 *
 * 使い方: `npm run icp:hire6`
 *   （先に `npm run icp:hire6:record`＝実績 と `npm run icp:hire6:enrich`＝予定 で台帳を作る）
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv } = require('./csv');
const { scoreMochica, parseEmployees } = require('./mochica-fit');
const { isExcludedIndustry } = require('./icp-rules');
const { normalizeJpPhone } = require('./phone');
const { buildExclusion, mkey, EMP_MIN: EMP_MIN_DEF, EMP_MAX: EMP_MAX_DEF } = require('./build-icp-fresh-1000');

const ROOT = path.resolve(__dirname, '..');
const getArg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const OUT = path.resolve(ROOT, getArg('out', 'data/leads-icp-hire6-500.csv'));
const REPORT = OUT.replace(/\.csv$/, '') + '-report.md';
const TARGET = parseInt(getArg('target', '500'), 10);
const HIRE_MIN = parseInt(getArg('min', '6'), 10);
const LEDGER = path.resolve(ROOT, getArg('ledger', 'data/hire-count.json'));
// 規模帯（既定はICPの100〜2000名。--emp-min/--emp-max で広げられる）
const EMP_MIN = parseInt(getArg('emp-min', String(EMP_MIN_DEF)), 10);
const EMP_MAX = parseInt(getArg('emp-max', String(EMP_MAX_DEF)), 10);
// 「過去に渡したリスト」と1社も被らせない（--exclude-past。ユーザー指定 2026-08-20: 対象はすべての納品物）
const EXCLUDE_PAST = process.argv.includes('--exclude-past');
const PAST_FILES = ['data/leads-icp-fresh-perfect-1000.csv', 'data/leads-icp-perfect-named-1000.csv',
  'data/leads-icp-fresh-10000.csv', 'data/leads-icp-fresh-named-1000.csv', 'data/leads-icp-hire6-500.csv'];
// 入力は「先に書いてあるものを優先」（納品済1000件は氏名エンリッチ済なので最優先）
const INPUTS = [
  ['data/leads-icp-fresh-perfect-1000.csv', '納品済1000(氏名エンリッチ済)'],
  ['data/icp-legacy-verified.csv', 'v1検証済プール'],
  ['data/icp-fresh-pool.csv', 'v2新規発掘プール'],
  ['data/icp-hire6-pool-27.csv', '27卒コーパス新規発掘(採用6名以上で発掘)'],
  ['data/icp-wide-pool.csv', '規模帯拡張の再探索(HTTP実取得)'],
  ['data/icp-gakujo-pool.csv', 'あさがくナビ新母集団'],
];

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const has = (v) => v && String(v).trim() && String(v).trim() !== '-';
const num = (v) => { const n = parseInt(String(v || '').replace(/[^0-9]/g, ''), 10); return Number.isFinite(n) ? n : 0; };

const COLS = ['No', '連絡先区分', '企業名', '架電宛名', '採用担当者名', '代表者名', '役職', '部署', '電話番号', 'メール',
  '業種', '従業員数', '本社', '上場', '新卒フラグ', '卒年',
  '年間新卒採用人数', '採用人数の種別', '採用人数レンジ', '採用実績(直近3年)', '採用フロア', '採用人数の根拠',
  '募集職種', '掲載媒体', '採用ページURL', 'アポ期待度', '優先度', '確信度', 'MOCHICA適合',
  'ICP判定', 'ICP根拠', '氏名の出所', '公式URL', '法人番号', 'corpID', '取得日'];

function run() {
  // ── 採用人数台帳 ────────────────────────────────────────────────
  let ledger = {};
  if (fs.existsSync(LEDGER)) { try { ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8')) || {}; } catch (_) {} }
  const ledgerGe = Object.values(ledger).filter((v) => num(v.人数) >= HIRE_MIN).length;
  log(`採用人数台帳: ${Object.keys(ledger).length}社（うち${HIRE_MIN}名以上 ${ledgerGe}社）← ${path.relative(ROOT, LEDGER)}`);

  // ── 入力プール（社名で先勝ち。先に読むファイルほど情報量が多い）──────────
  const rows = [];
  const seenName = new Set();
  for (const [rel, tag] of INPUTS) {
    const f = path.join(ROOT, rel);
    if (!fs.existsSync(f)) { log(`  (無し) ${rel}`); continue; }
    let recs = [];
    try { recs = readCsv(fs.readFileSync(f, 'utf8')).records; } catch (e) { log(`  読込失敗 ${rel}: ${String(e).slice(0, 60)}`); continue; }
    let add = 0;
    for (const r of recs) {
      const k = mkey(r['企業名']);
      if (!k || seenName.has(k)) continue;
      seenName.add(k);
      rows.push({ ...r, _src: tag });
      add++;
    }
    log(`  ${tag}: ${recs.length}行 → 新規に採用 ${add}社（累計 ${rows.length}）`);
  }
  if (!rows.length) { log('入力が空。先に icp:v2 / icp:verify を実行すること'); process.exitCode = 1; return; }

  log('除外索引（完全新規の再判定用）を構築中…');
  const excl = buildExclusion();
  const ng = new Set();
  const ngFile = path.join(ROOT, 'data', 'ng-companies.txt');
  if (fs.existsSync(ngFile)) {
    for (const l of fs.readFileSync(ngFile, 'utf8').split(/\r?\n/)) { const k = mkey(l); if (k) ng.add(k); }
    log(`  NG企業（アプローチ禁止）: ${ng.size}社`);
  }

  // 過去に渡したリスト（統合マスタに入っていない直近の納品物）
  const pastNames = new Set();
  if (EXCLUDE_PAST) {
    for (const rel of PAST_FILES) {
      const f = path.join(ROOT, rel);
      if (!fs.existsSync(f)) continue;
      try { for (const r of readCsv(fs.readFileSync(f, 'utf8')).records) { const k = mkey(r['企業名']); if (k) pastNames.add(k); } } catch (e) {}
    }
    log(`  過去に渡したリスト（除外対象）: ${pastNames.size}社`);
  }

  const kept = [];
  const why = {};
  const seenKey = new Set(), seenCorp = new Set();
  const drop = (reason) => { why[reason] = (why[reason] || 0) + 1; };

  for (const r of rows) {
    const name = String(r['企業名'] || '').trim();
    const k = mkey(name);
    if (!name || !k) { drop('社名なし'); continue; }
    // ⑦ 重複なし（社名・corpIDの両方で）
    if (seenKey.has(k)) { drop('重複(社名)'); continue; }
    const corp = String(r['corpID'] || '').trim();
    if (corp && seenCorp.has(corp)) { drop('重複(corpID)'); continue; }
    // ① 完全新規
    if (excl.names.has(k)) { drop('既存(マスタ/CRM)に存在'); continue; }
    if (ng.has(k)) { drop('アプローチ禁止企業'); continue; }
    if (pastNames.has(k)) { drop('過去に渡したリストに既出'); continue; }
    // ② 新卒インテント（マイナビ掲載を実取得している行だけ）
    const m0 = scoreMochica(r);
    if (!m0.flags.verifiedIntent) { drop('新卒インテント未確認'); continue; }
    // ③ 規模フィット
    const emp = parseEmployees(r['従業員数']);
    if (emp == null) { drop('従業員数不明'); continue; }
    if (emp < EMP_MIN || emp > EMP_MAX) { drop(`従業員${emp}名=規模帯外`); continue; }
    // ④ 非IT
    if (isExcludedIndustry(r['業種'] || r['募集職種'] || '')) { drop('IT/ソフト=絶対除外'); continue; }
    // ⑤ 到達性
    const phone = normalizeJpPhone(String(r['電話番号'] || ''));
    if (!phone) { drop('電話番号が無効=架電不可'); continue; }
    // ⑥ 採用フロア（今回のハード条件）: 「実績（直近年の新卒採用者数）」と「予定（募集人数コース合算の下限和）」の
    //    どちらか大きい方を年間新卒採用人数とする。実績＞予定のときは実績を一次情報として表示する。
    //    証拠の強さ順に採る（弱い出所が強い出所を上書きしないようにする）:
    //      1) 実績       … 会社概要「過去3年間の新卒採用者数」の直近年（構造化された表）
    //      2) 募集人数   … 採用データの募集コース別「募集人数」の合算下限（構造化された行）
    //      3) 自由文     … 掲載面の本文から拾った単発の「採用予定人数 N名」← 1)2)が有るときは使わない
    //    実測で 3) が 2) を上回って過大表示になる社があったため（Bフードサイエンス 自由文40名／実際は24～40名）、
    //    3) は 1)2) がどちらも無い社の参考値に降格し、判定には使わない。
    const led = (corp && ledger[corp]) || {};
    // ① 実績（直近年）。台帳に無くても、発掘層が構造化ブロックから書いた列があればそれを使う
    //    （あさがくナビ「採用予定人数／実績」など、媒体側の表から取った値。自由文ではない）。
    const rec = num(led.実績人数) || num(r['採用実績人数']);
    const plan = num(led.人数);         // ② 募集人数コース合算の下限和
    const loose = num(r['採用予定人数']); // ③ 自由文の単発読み（参考）
    if (!rec && !plan) { drop(loose ? '採用人数の裏取り無し(自由文のみ)' : '採用人数が不明(媒体に記載なし)'); continue; }
    const hire = Math.max(rec, plan);
    if (hire < HIRE_MIN) { drop(`採用${hire}名<${HIRE_MIN}名`); continue; }
    const useRec = rec >= plan;
    const hireKind = useRec ? `実績(${led.実績年 || ''}年)` : '募集予定';
    const hireSrc = useRec
      ? (led.実績根拠 || String(r['検証'] || '') || 'マイナビ会社概要 過去3年間の新卒採用者数')
      : (led.根拠 || String(r['検証'] || '') || 'マイナビ採用データ 募集人数コース合算');
    const hireRange = useRec ? `${rec}名` : (led.レンジ || `${hire}名`);

    seenKey.add(k); if (corp) seenCorp.add(corp);

    const tier = has(r['採用担当者名']) ? 1 : has(r['代表者名']) ? 2 : 3;
    const contact = tier === 1 ? r['採用担当者名'] : tier === 2 ? r['代表者名'] : '';
    const s = scoreMochica({ ...r, 電話番号: phone, 採用予定人数: String(hire) });
    const o = {};
    for (const c of COLS) o[c] = r[c] != null ? String(r[c]) : '';
    o['企業名'] = name;
    o['電話番号'] = phone;
    o['年間新卒採用人数'] = String(hire);
    o['採用人数の種別'] = hireKind;
    o['採用人数レンジ'] = hireRange;
    o['採用実績(直近3年)'] = led.実績3年 || '';
    o['採用フロア'] = `充足(${hire}名)`;
    o['採用人数の根拠'] = hireSrc;
    o['連絡先区分'] = tier === 1 ? '採用担当者名' : tier === 2 ? '代表者名' : '名前なし';
    o['架電宛名'] = contact ? ((has(r['部署']) ? r['部署'] + ' ' : '') + contact + ' 様') : (has(r['部署']) ? r['部署'] + ' ご採用ご担当者様' : 'ご採用ご担当者様');
    o['アポ期待度'] = String(s.total); o['優先度'] = s.priority; o['確信度'] = String(s.confidence);
    o['MOCHICA適合'] = s.total >= 80 ? '◎' : s.total >= 65 ? '○' : '△';
    const gy = (String(r['採用ページURL'] || '').match(/job\.mynavi\.jp\/(\d{2})\//) || [])[1];
    o['卒年'] = gy ? `${gy}卒(20${gy}年卒)` : (r['卒年'] ? String(r['卒年']) : '');
    if (!has(o['氏名の出所']) && tier <= 2) o['氏名の出所'] = tier === 1 ? `マイナビ(${r['パターン'] || '担当者面'})` : '代表者名';
    o['ICP判定'] = `ICP完全適合(6条件充足・採用${HIRE_MIN}名以上)`;
    o['ICP根拠'] = `完全新規｜マイナビ新卒掲載｜従業員${emp}名(${EMP_MIN}-${EMP_MAX})｜非IT(${r['業種'] || '業種未記載'})｜電話妥当｜年間新卒${hire}名以上`
      + (contact ? `｜${tier === 1 ? '採用担当者名' : '代表者名'}(${contact})` : '');
    o._tier = tier; o._hire = hire;
    kept.push(o);
  }

  // 並び: 連絡先ティア（担当者名→代表者名→名前なし）× アポ期待度降順 × 採用人数降順
  kept.sort((a, b) => (a._tier - b._tier)
    || ((parseInt(b['アポ期待度']) || 0) - (parseInt(a['アポ期待度']) || 0))
    || (b._hire - a._hire));
  const final = kept.slice(0, TARGET);
  final.forEach((r, i) => { r['No'] = String(i + 1); });

  // ── 出荷前の最終検証（納品ファイルそのものに対して）──────────────────
  const bad = [];
  const chk = new Set();
  for (const r of final) {
    const w = [];
    const k = mkey(r['企業名']);
    if (!k) w.push('社名なし');
    if (chk.has(k)) w.push('社名重複'); chk.add(k);
    const e = parseEmployees(r['従業員数']);
    if (e == null || e < EMP_MIN || e > EMP_MAX) w.push('規模帯外');
    if (isExcludedIndustry(r['業種'])) w.push('IT/ソフト');
    if (!has(r['業種'])) w.push('業種空欄');
    if (!normalizeJpPhone(String(r['電話番号'] || ''))) w.push('電話無効');
    if (!/マイナビ|あさがくナビ/.test(String(r['掲載媒体'] || ''))) w.push('新卒媒体掲載なし');
    if (num(r['年間新卒採用人数']) < HIRE_MIN) w.push(`採用${HIRE_MIN}名未満`);
    if (excl.names.has(k)) w.push('既存に存在');
    if (w.length) bad.push({ 企業名: r['企業名'], 理由: w.join('/') });
  }
  if (bad.length) { log(`❌ 検証NG ${bad.length}件: ${JSON.stringify(bad.slice(0, 5))}`); process.exitCode = 1; return; }

  final.forEach((r) => { delete r._tier; delete r._hire; });
  fs.writeFileSync(OUT, toCsv(COLS, final));

  // ── サマリ ────────────────────────────────────────────────────
  const t = (n) => final.filter((r) => r['連絡先区分'] === n).length;
  const hires = final.map((r) => num(r['年間新卒採用人数'])).sort((a, b) => a - b);
  const emps = final.map((r) => parseEmployees(r['従業員数'])).filter((x) => x != null).sort((a, b) => a - b);
  const band = { '6-9名': 0, '10-19名': 0, '20-49名': 0, '50名以上': 0 };
  for (const h of hires) band[h < 10 ? '6-9名' : h < 20 ? '10-19名' : h < 50 ? '20-49名' : '50名以上']++;
  const byInd = {}; for (const r of final) { const k = String(r['業種'] || '').split('/')[0] || '(未記載)'; byInd[k] = (byInd[k] || 0) + 1; }
  const kind = {}; for (const r of final) { const k = /実績/.test(r['採用人数の種別']) ? '実際の新卒採用者数（実績）' : '募集人数（予定・下限和）'; kind[k] = (kind[k] || 0) + 1; }
  const gyc = {}; for (const r of final) { const k = String(r['卒年'] || '(不明)'); gyc[k] = (gyc[k] || 0) + 1; }
  const n = final.length || 1;
  const pct = (v) => `${(v / n * 100).toFixed(1)}%`;

  const rep = [
    '# ICP完全適合 × 年間新卒採用6名以上 × 重複なし（納品サマリ）', '',
    `- 出力: \`${path.relative(ROOT, OUT)}\` … **${final.length}件**（目標 ${TARGET}件）`,
    `- 生成: ${new Date().toISOString()}`,
    `- 有資格プール: ${kept.length}社（うち上位${final.length}社を納品）`,
    '- 並び: 連絡先ティア（採用担当者名 → 代表者名 → 名前なし）× アポ期待度降順 × 採用人数降順', '',
    '## ハード条件（全件が充足・納品ファイルに対して再検証済）', '',
    '| 条件 | 判定に使った一次情報 | 充足 |', '|---|---|---:|',
    '| ① 完全新規 | 統合マスタ＋BALES＋MOCHICA顧客＋SF全リード＋NG企業に社名が不在 | 100% |',
    '| ② 新卒採用インテント | マイナビ新卒の掲載を実スクレイプで確認 | 100% |',
    `| ③ 規模フィット | 会社概要ページの従業員数が${EMP_MIN}〜${EMP_MAX}名（最小${emps[0]}／中央${emps[Math.floor(emps.length / 2)]}／最大${emps[emps.length - 1]}） | 100% |`,
    '| ④ 非IT | 会社概要ページの業種ラベルで IT/ソフトを絶対除外 | 100% |',
    '| ⑤ 到達性 | 電話番号が日本の電話番号として妥当 | 100% |',
    `| ⑥ 採用${HIRE_MIN}名以上 | マイナビの**実際の新卒採用者数（直近年）**を優先、無ければ募集人数コース合算の下限和（最小${hires[0]}／中央${hires[Math.floor(hires.length / 2)]}／最大${hires[hires.length - 1]}名） | 100% |`,
    '| ⑦ 重複なし | 正規化社名・corpID で1社1行 | 100% |', '',
    '## 年間新卒採用人数の分布', '', '| 帯 | 件数 | 割合 |', '|---|---:|---:|',
    ...Object.entries(band).map(([k, v]) => `| ${k} | ${v} | ${pct(v)} |`), '',
    '## 採用人数の根拠の内訳', '', '| 種別 | 件数 | 割合 |', '|---|---:|---:|',
    ...Object.entries(kind).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} | ${pct(v)} |`), '',
    '## 連絡先ティア', '', '| 区分 | 件数 | 割合 |', '|---|---:|---:|',
    `| ① 採用担当者名あり | ${t('採用担当者名')} | ${pct(t('採用担当者名'))} |`,
    `| ② 代表者名あり | ${t('代表者名')} | ${pct(t('代表者名'))} |`,
    `| ③ 名前なし（部署宛） | ${t('名前なし')} | ${pct(t('名前なし'))} |`, '',
    '## 掲載卒年', '', '| 卒年 | 件数 |', '|---|---:|',
    ...Object.entries(gyc).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`), '',
    '## 業種内訳（上位15）', '', '| 業種 | 件数 |', '|---|---:|',
    ...Object.entries(byInd).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `| ${k} | ${v} |`), '',
    '## 除外内訳（入力プール→納品で落とした理由）', '', '| 理由 | 件数 |', '|---|---:|',
    ...Object.entries(why).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`), '',
  ].join('\n');
  fs.writeFileSync(REPORT, rep);

  log(`✅ 検証OK（条件違反0・重複0）｜ ${final.length}件 = 担当者名${t('採用担当者名')} / 代表者名${t('代表者名')} / 名前なし${t('名前なし')}`);
  log(`有資格プール ${kept.length}社 ／ 除外 ${JSON.stringify(why)}`);
  log(`出力: ${OUT}`);
  log(`サマリ: ${REPORT}`);
}

if (require.main === module) run();
module.exports = { run };
