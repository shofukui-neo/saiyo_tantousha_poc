'use strict';
/**
 * build-sf-fresh-list — SF全リードから「BALES未登録 × 既存顧客でない × 生きているステージ」を抜く
 * =====================================================================
 * 母集団は Salesforce レポート『全てのリードSitoke突合用』(86,673行)。ここから
 *
 *   ① ステージ（列『リード 状況』）が **アーカイブ / コンバート 以外** の行だけ残す
 *      - 99：アーカイブ  … 追わないと決めた死んだリード
 *      - 05：コンバート  … 既に取引先/商談へ変換済み＝新規アプローチ先ではない
 *   ② **MOCHICA既存顧客**（法人名 / LINE登録名）に当たる企業を落とす
 *   ③ **BALESCLOUD既存CRM** に載っている企業を落とす（＝BALESに存在しない企業だけ残す）
 *   ④ SF内で同一企業が複数リードを持つ行を1社1行に名寄せ
 *
 * 突合は必ず company-match.js の規則（法人番号→社名→農協コア→表記ゆれ→長音ゆれ）で行う。
 * 生の社名一致だけだと表記ゆれで既存企業がすり抜けるため（docs/dedupe-architecture.md）。
 * 最下位tier（長音ゆれ）は別法人衝突の可能性があるので、落とした行は必ず除外明細CSVへ出す
 * （silent drop を作らない）。tierごと確認したい場合は --no-fuzzy で切れる。
 *
 * 使い方:
 *   node src/build-sf-fresh-list.js
 *   node src/build-sf-fresh-list.js --keep-dupes      # SF内名寄せをしない（リード単位で出す）
 *   node src/build-sf-fresh-list.js --no-fuzzy        # 長音ゆれtierを無効化（除外を厳しめに）
 *   node src/build-sf-fresh-list.js --out <csv> --excluded-out <csv>
 */
const fs = require('fs');
const path = require('path');
const { parseCsv, toCsv, normCompanyName } = require('./csv');
const { keysOf, hasKey } = require('./company-match');
const { buildExclusionIndex } = require('./exclusion-index');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const has = (k) => args.includes(k);

const SF = path.resolve(getArg('--sf', path.join(DATA, 'セールスフォースMOCHICA参照 - 全てのリードSitoke突合用.csv')));
// 除外索引の既定BALESパスは旧スナップショット。data/ にある最新の leadList を使う。
const BALES = path.resolve(getArg('--bales', latestBales()));
const CUSTOMERS = path.resolve(getArg('--customers', path.join(DATA, 'MOCHICAの既存顧客リスト - mochica-companies-list.csv')));
const OUT = path.resolve(getArg('--out', path.join(DATA, 'leads-sf-bales-new.csv')));
const EXCLUDED_OUT = path.resolve(getArg('--excluded-out', path.join(DATA, 'leads-sf-bales-new-excluded.csv')));
const KEEP_DUPES = has('--keep-dupes');
const FUZZY = !has('--no-fuzzy');

// data/ 内で最も新しい BALESCLOUD leadList を選ぶ（ファイル名の日時スタンプ順）
function latestBales() {
  const cands = fs.readdirSync(DATA)
    .filter((f) => /^BALESCLOUD.*leadList.*\.csv$/i.test(f))
    .sort();
  if (!cands.length) return path.join(DATA, 'BALESCLOUDの既存リスト - 202608071207_leadList_utf-8.csv');
  return path.join(DATA, cands[cands.length - 1]);
}

// SF内に残る動作確認用レコード。「テスト」を含むだけで落とすと 株式会社アドバンテスト /
// ベリサーブ沖縄テストセンター のような実在企業を巻き込むため、**社名全体が**テスト語の
// ものだけに限定する。落とした行は除外明細CSVに出す。
// ※「短い社名」を根拠にしてはいけない: 株式会社豊 / 株式会社匠 / 医療法人社団焔 のような
//   1文字社名は実在する（当初 normCompanyName(s).length<2 で34社を誤って落としていた）。
const JUNK_NAME_RE = /^(test|テスト|ﾃｽﾄ|てすと|dummy|ダミー|サンプル|sample|あ+)$/i;
function isJunkName(name) {
  const s = String(name || '').replace(/[\s　]/g, '');
  if (JUNK_NAME_RE.test(s)) return true;
  return !normCompanyName(s); // 正規化すると何も残らない（記号だけ等）
}

// ── 除外するステージ ────────────────────────────────────────────
// SFのピックリストは「05：コンバート」「99：アーカイブ」の他に採番なしの表記ゆれ
// （'リサイクル' が 89付き/なしの両方で存在）があるため、番号ではなく語で判定する。
const DROP_STAGE_RE = /(アーカイブ|コンバート)/;

// ── SFレポート（先頭に説明行がある形式）を読む ──────────────────
function readSfReport(file) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  let hi = -1;
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    if (rows[i] && rows[i].some((c) => /会社名\s*\/\s*取引先/.test(String(c)))) { hi = i; break; }
  }
  if (hi < 0) throw new Error(`SFレポートのヘッダ行（会社名 / 取引先）が見つかりません: ${file}`);
  const header = rows[hi].map((c) => String(c).trim());
  const col = (name) => header.indexOf(name);
  const IDX = {
    id: col('リードID18'), name: col('会社名 / 取引先'), phone: col('電話'), sei: col('姓'),
    hire: col('採用人数(選択リスト)'), stage: col('リード 状況'), emp: col('従業員数レンジ(ランスケ）'),
    mail: col('メール'), industry: col('業種'),
    survey10: col('セミナーアンケート項目10'), survey7: col('セミナーアンケート項目7'),
  };
  const g = (r, i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');
  const records = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every((c) => !String(c || '').trim())) continue;
    if (g(r, IDX.id) === '合計' || g(r, 1) === '合計') continue; // レポート末尾の集計行
    records.push({
      リードID18: g(r, IDX.id), 企業名: g(r, IDX.name), 電話: g(r, IDX.phone), 姓: g(r, IDX.sei),
      '採用人数(選択リスト)': g(r, IDX.hire), ステージ: g(r, IDX.stage), 従業員数レンジ: g(r, IDX.emp),
      メール: g(r, IDX.mail), 業種: g(r, IDX.industry),
      アンケート10: g(r, IDX.survey10), アンケート7: g(r, IDX.survey7),
    });
  }
  return records;
}

// ── SF内名寄せ：同一企業の複数リードから代表1件を選ぶ ─────────────
// 「連絡先が埋まっている行」＞「ステージが進んでいる行」の順で優先する。
const STAGE_RANK = {
  '04：ジャッジ': 6, '03：コネクト情報獲得': 5, '02：担当者未接触': 4,
  '01：新規': 3, 'New': 3, '89：リサイクル': 2, 'リサイクル': 2, '潜在顧客': 1,
};
function score(r) {
  return (r.電話 ? 8 : 0) + (r.メール ? 4 : 0) + (r.姓 ? 2 : 0)
    + (r['採用人数(選択リスト)'] ? 1 : 0) + (r.従業員数レンジ ? 1 : 0)
    + (STAGE_RANK[r.ステージ] || 0) * 0.1;
}

function main() {
  console.log(`[SF] ${path.relative(ROOT, SF)}`);
  const all = readSfReport(SF);
  console.log(`[SF] 全リード ${all.length}行`);

  // ① ステージで絞る
  const byStage = new Map();
  const alive = [];
  const droppedStage = [];
  for (const r of all) {
    byStage.set(r.ステージ, (byStage.get(r.ステージ) || 0) + 1);
    if (DROP_STAGE_RE.test(r.ステージ)) droppedStage.push(r); else alive.push(r);
  }
  console.log('[ステージ内訳] ' + [...byStage.entries()].sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k || '(空)'} ${v}`).join(' / '));
  console.log(`[①ステージ] アーカイブ/コンバートを除外 → ${alive.length}行 残（除外 ${droppedStage.length}行）`);

  // ②③ 既存顧客 + BALES 既存CRM を除外索引に積む
  const ex = buildExclusionIndex({
    layers: ['customers', 'bales'], fuzzy: FUZZY,
    files: { customers: CUSTOMERS, bales: BALES },
  });
  if (ex.missing.length) {
    for (const m of ex.missing) console.error(`[中断] 除外マスタ未配置: ${m}`);
    process.exit(1); // 未突合のまま「新規」と称するリストは出さない
  }
  console.log(`[BALES] ${path.relative(ROOT, BALES)}`);

  const kept = [];
  const excluded = [];
  const noKey = [];
  let junk = 0;
  for (const r of alive) {
    if (!hasKey({ 企業名: r.企業名 })) { noKey.push(r); continue; } // 社名なし＝新規判定不能
    if (isJunkName(r.企業名)) {
      junk++;
      excluded.push(Object.assign({}, r, { 除外理由: 'テスト行', 突合tier: '社名', 突合先: '' }));
      continue;
    }
    const d = ex.idx.matchDetail({ 企業名: r.企業名 });
    if (d.matched) excluded.push(Object.assign({}, r, { 除外理由: d.label, 突合tier: d.tier, 突合先: d.master }));
    else kept.push(r);
  }
  const byLabel = new Map();
  for (const e of excluded) byLabel.set(e.除外理由, (byLabel.get(e.除外理由) || 0) + 1);
  console.log(`[②③既存除外] ${excluded.length}行 除外（${[...byLabel.entries()].map(([k, v]) => `${k} ${v}`).join(' / ')}）`
    + `${noKey.length ? ` ／ 社名空で判定不能 ${noKey.length}行も除外` : ''}`);

  // ④ SF内で1社1行に名寄せ
  let out = kept;
  let selfDup = 0;
  if (!KEEP_DUPES) {
    const best = new Map(); // 代表キー -> record
    const alias = new Map(); // 各tierのキー -> 代表キー
    for (const r of kept) {
      const k = keysOf({ 企業名: r.企業名 });
      const cands = [k.bango, k.name, k.core, k.loose, FUZZY ? k.fuzzy : ''].filter(Boolean);
      let owner = '';
      for (const c of cands) if (alias.has(c)) { owner = alias.get(c); break; }
      if (!owner) owner = k.name || k.bango || cands[0];
      for (const c of cands) if (!alias.has(c)) alias.set(c, owner);
      const cur = best.get(owner);
      if (!cur) { best.set(owner, Object.assign({ SF重複リード数: 1 }, r)); continue; }
      selfDup++;
      cur.SF重複リード数++;
      if (score(r) > score(cur)) {
        const n = cur.SF重複リード数;
        best.set(owner, Object.assign({ SF重複リード数: n }, r));
      }
    }
    out = [...best.values()];
    console.log(`[④名寄せ] SF内重複 ${selfDup}行を統合 → ${out.length}社`);
  }

  out.sort((a, b) => (STAGE_RANK[b.ステージ] || 0) - (STAGE_RANK[a.ステージ] || 0)
    || (b.電話 ? 1 : 0) - (a.電話 ? 1 : 0) || String(a.企業名).localeCompare(String(b.企業名), 'ja'));

  const HEADERS = ['企業名', '電話', '姓', 'メール', 'ステージ', '採用人数(選択リスト)', '従業員数レンジ',
    '業種', 'アンケート10', 'アンケート7', 'リードID18'].concat(KEEP_DUPES ? [] : ['SF重複リード数']);
  fs.writeFileSync(OUT, toCsv(HEADERS, out), 'utf8');
  fs.writeFileSync(EXCLUDED_OUT, toCsv(['企業名', 'ステージ', '除外理由', '突合tier', '突合先', '電話', 'リードID18'],
    excluded.sort((a, b) => String(a.突合tier).localeCompare(String(b.突合tier)))), 'utf8');

  const withPhone = out.filter((r) => r.電話).length;
  const withMail = out.filter((r) => r.メール).length;
  console.log('\n── 結果 ──────────────────────────────');
  console.log(`SF全リード              ${all.length}`);
  console.log(`  −アーカイブ/コンバート ${droppedStage.length}`);
  console.log(`  −既存顧客/BALES既存    ${excluded.length - junk}${noKey.length ? ` (＋社名空 ${noKey.length})` : ''}`);
  console.log(`  −テスト行              ${junk}`);
  console.log(`  −SF内重複              ${selfDup}`);
  console.log(`= 出力                  ${out.length}${KEEP_DUPES ? '行' : '社'}`
    + `（電話あり ${withPhone} / メールあり ${withMail}）`);
  console.log(`\n  ${path.relative(ROOT, OUT)}`);
  console.log(`  ${path.relative(ROOT, EXCLUDED_OUT)}  （除外の内訳・tier確認用）`);
}

main();
