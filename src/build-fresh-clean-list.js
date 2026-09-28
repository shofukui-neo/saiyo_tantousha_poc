'use strict';
/**
 * BALES／アーカイブ／既存顧客 のどれにも無い 完全新規リスト ビルダー（2026-09-28）
 * ============================================================================
 * 条件（2026-09-28 ユーザー指定）: 「BALESにない・アーカイブでもない・既存顧客でもない」リストを N件。
 *
 * 除外（1社でも当たれば落とす）:
 *   ① BALES既存CRM（全ステージ＝「99：アーカイブ」「アーカイブ」ステージも含む）
 *   ② MOCHICA既存顧客
 *   ③ SF全リード（「99：アーカイブ」「05：コンバート」も含む全件）
 *   ④ アーカイブ＝過去に作成・納品したリスト
 *        - 納品台帳 data/_delivered-ledger.csv
 *        - 過去納品CSV（verify-fresh-hire.js の PAST のうち現存するもの。整形ダンプ leads-bales-format は除く）
 *        - --archive-dir（既定: ダウンロードフォルダ）直下のCSV全部。社名列（企業名/会社名/…）を持つものは
 *          すべて「一度はどこかに出した社」とみなす。台帳に記録し忘れた 9/1 完全新規2000件・9/18 A-B階層
 *          架電リスト・8/10 SF/BALES未登録リスト等がここで効く（台帳は 7/29 で更新が止まっていた）
 *   ⑤ 架電禁止リスト data/ng-companies.txt（toCsv のガードでも落ちるが、件数を数えるため先に落とす）
 *   ⑥ ICPの絶対除外（IT・ソフトウェア／官公庁）
 *   ⑦ 電話番号が日本の番号として不正・欠落
 *   ⑧ 自己重複（company-match の表記ゆれ・拠点名寄せ込み＋同一電話番号）
 *
 * 規模フロア（従業員100名・新卒6名）は **かけない**。ICP適合は列に出し、並び順で上に寄せる。
 *   ※ ICP適合×完全新規は 9/1（2000件）・9/14 に出し切っており、現母集団には約50社しか残っていない。
 *
 * 母集団: data/leads-intent-wide.csv（インテント採点済み）＋ data/leads-consolidated-all.csv（統合マスタ）
 * 並び: ICP適合 → 要確認 → 規模未満（各内で インテント階層 A>B>C>D → 総合優先度 → インテントスコア → 従業員数）
 *
 * 使い方:
 *   node src/build-fresh-clean-list.js [--target 2000] [--out data/leads-fresh-clean-2000.csv]
 *        [--archive-dir <dir>] [--record]   # --record で納品台帳へ追記
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readCsv, toCsv } = require('./csv');
const { createMatchIndex } = require('./company-match');
const { buildExclusionIndex } = require('./exclusion-index');
const { appendRecords } = require('./delivered-ledger');
const { isExcludedIndustry, isGovernmentOrg, classifyOrgType } = require('./icp-rules');
const { normalizeJpPhone } = require('./phone');
const { prefectureForNumber } = require('./areacode');
const { PAST } = require('./verify-fresh-hire');
const ng = require('./ng-guard');

const ROOT = path.resolve(__dirname, '..');
const getArg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const hasFlag = (n) => process.argv.includes('--' + n);
const TARGET = parseInt(getArg('target', '2000'), 10);
const OUT = path.resolve(ROOT, getArg('out', 'data/leads-fresh-clean-' + TARGET + '.csv'));
const REPORT = OUT.replace(/\.csv$/, '-report.md');
const ARCHIVE_DIR = path.resolve(getArg('archive-dir', path.join(os.homedir(), 'Downloads')));
const WIDE = path.join(ROOT, 'data/leads-intent-wide.csv');
const CONS = path.join(ROOT, 'data/leads-consolidated-all.csv');

const g = (r, k) => String(r && r[k] != null ? r[k] : '').trim();
const log = (m) => console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const NAME_COL = (h) => h.find((c) => /^(企業名|会社名|法人名|社名|company_name)$/.test(c) || /：会社名$/.test(c));
// 業種ラベルが空の社が多いので、社名の明白なITシグナルでも落とす（build-new-icp-list.js と同じ語彙）
const NAME_IT_RE = /ソフトウ|ソフト技研|システム開発|システムズ|システム・|ＳＩ|SIer|SES|情報処理|情報システム|ソリューションズ|テクノロジーズ|デジタル|ネットワーク|ウェブ|ソフトウェア/;
const PREFS = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'];
// テスト用フィクスチャ（sources/outcomes.csv・D-shitchu.csv のギリシャ文字社名）が統合マスタに混入している
const FIXTURE_SRC_RE = /D-shitchu|outcomes\.csv/;
// 06-1234-5678 / 03-2222-3333 / 045-987-6543 のような架空番号
const DUMMY_PHONE_RE = /(12345678|23456789|98765432|87654321|9876543)$|(\d)\1{3}(\d)\2{3}$/;
const prefOf = (s) => { for (const p of PREFS) if (String(s || '').includes(p)) return p; return ''; };

const COLS = ['No', 'ICP区分', '企業名', '架電宛名', '採用担当者名', '役職', '部署', '電話番号', 'メール',
  '業種', '従業員数', '都道府県', '本社', '組織型', '募集人数(最新卒年)', '昨年度入社数', '採用実績(直近3年)',
  'インテント階層', 'インテントスコア', '総合優先度', '最有力シグナル', 'なぜ今', '推奨トーク', '予算状態',
  'ICP判定根拠', '採用ページURL', '公式URL', '法人番号', 'corpID', '完全新規根拠', '取得日'];

// 過去に出したリスト（アーカイブ）の索引。どのファイルで当たったかを明細に出すため label にファイル名を持つ。
function buildArchiveIndex() {
  const idx = createMatchIndex();
  const files = [];
  for (const rel of PAST) {
    // leads-bales-format.csv は統合マスタの整形ダンプ（営業へ渡していない）。入れると母集団がほぼ全滅する
    if (/leads-bales-format\.csv$/.test(rel)) continue;
    const f = path.join(ROOT, rel);
    if (fs.existsSync(f)) files.push(f);
  }
  if (fs.existsSync(ARCHIVE_DIR)) {
    for (const f of fs.readdirSync(ARCHIVE_DIR)) if (/\.csv$/i.test(f)) files.push(path.join(ARCHIVE_DIR, f));
  }
  let used = 0;
  for (const f of files) {
    let o;
    try { o = readCsv(fs.readFileSync(f, 'utf8')); } catch (e) { continue; }
    const col = NAME_COL(o.headers);
    if (!col) continue;
    used++;
    for (const r of o.records) { const v = g(r, col); if (v) idx.addName(v, path.basename(f)); }
  }
  return { idx, files: used };
}

function icpClass(w, c) {
  const j = g(w, 'MOCHCA適合判定');
  if (j === '対象外') return '規模未満';
  if (j) return j === '要確認' ? '要確認' : 'ICP適合';
  // 統合マスタの MOCHICA適合（◎○△）は一次情報（従業員数・新卒数）の裏付けが無いので採らない
  return '情報不足';
}
const CLASS_RANK = { ICP適合: 0, 要確認: 1, 情報不足: 2, 規模未満: 3 };
const TIER_RANK = { A: 0, B: 1, C: 2, D: 3 };

function main() {
  const ex = buildExclusionIndex({ masters: true, ledger: true });
  if (ex.missing.length) { console.error('除外マスタが欠けています。中止します: ' + ex.missing.join(' / ')); process.exit(1); }
  const arch = buildArchiveIndex();
  log('アーカイブ索引: ' + arch.files + 'ファイル／' + arch.idx.size + '社（' + path.relative(ROOT, ARCHIVE_DIR) + ' ほか）');
  if (!ng.size()) { console.error('架電禁止リスト data/ng-companies.txt が空です。npm run ng:sync を先に。'); process.exit(1); }
  log('架電禁止リスト: ' + ng.size() + '社');

  const wide = readCsv(fs.readFileSync(WIDE, 'utf8')).records;
  const cons = readCsv(fs.readFileSync(CONS, 'utf8')).records;
  const wideBy = new Map(); for (const r of wide) { const n = g(r, '企業名'); if (n && !wideBy.has(n)) wideBy.set(n, r); }
  const consBy = new Map(); for (const r of cons) { const n = g(r, '企業名'); if (n && !consBy.has(n)) consBy.set(n, r); }
  const names = [...new Set([...wideBy.keys(), ...consBy.keys()])];
  log('母集団: ' + names.length + '社（インテント採点 ' + wideBy.size + '／統合マスタ ' + consBy.size + '）');

  const st = { 母集団: names.length, BALES: 0, 既存顧客: 0, SF: 0, 納品台帳: 0, アーカイブ: 0, 架電禁止: 0,
    IT: 0, 官公庁: 0, テストデータ: 0, 電話なし: 0, 自己重複: 0, 候補: 0 };
  const cands = [];
  for (const n of names) {
    const w = wideBy.get(n); const c = consBy.get(n);
    const rec = { 企業名: n, 法人番号: g(w, '法人番号') || g(c, '法人番号') };
    const d = ex.idx.matchDetail(rec);
    if (d && d.matched) {
      const lb = String(d.label || '');
      if (/BALES/.test(lb)) st.BALES++; else if (/MOCHICA/.test(lb)) st.既存顧客++; else if (/SF/.test(lb)) st.SF++; else st.納品台帳++;
      continue;
    }
    if (arch.idx.has(rec)) { st.アーカイブ++; continue; }
    if (ng.isNg(n)) { st.架電禁止++; continue; }
    const industry = g(w, '業種') || g(c, '業種');
    const reason = g(w, 'MOCHCA適合根拠');
    if (isExcludedIndustry(industry) || NAME_IT_RE.test(n) || /IT・ソフトウェア/.test(reason)) { st.IT++; continue; }
    if (isGovernmentOrg(n, industry) || /官公庁|自治体ドメイン/.test(reason)) { st.官公庁++; continue; }
    if (FIXTURE_SRC_RE.test(g(c, '統合元ファイル')) && !w) { st.テストデータ++; continue; }
    const phone = normalizeJpPhone(g(w, '電話番号')) || normalizeJpPhone(g(c, '電話番号'));
    if (!phone || DUMMY_PHONE_RE.test(phone.replace(/\D/g, ''))) { st.電話なし++; continue; }
    cands.push({ n, w, c, phone, industry, cls: icpClass(w, c) });
  }

  cands.sort((a, b) => (CLASS_RANK[a.cls] - CLASS_RANK[b.cls])
    || ((TIER_RANK[g(a.w, 'インテント階層')] ?? 9) - (TIER_RANK[g(b.w, 'インテント階層')] ?? 9))
    || ((parseFloat(g(b.w, '総合優先度')) || 0) - (parseFloat(g(a.w, '総合優先度')) || 0))
    || ((parseFloat(g(b.w, 'インテントスコア')) || 0) - (parseFloat(g(a.w, 'インテントスコア')) || 0))
    || ((parseInt(g(b.w, '従業員数') || g(b.c, '従業員数'), 10) || 0) - (parseInt(g(a.w, '従業員数') || g(a.c, '従業員数'), 10) || 0)));

  // 自己重複: 同一法人の表記ゆれ・拠点違い（company-match）と同一電話番号。並べ替え後なので上位側が残る。
  const self = createMatchIndex();
  const phones = new Set();
  const today = new Date().toISOString().slice(0, 10);
  const rows = [];
  for (const x of cands) {
    const rec = { 企業名: x.n, 法人番号: g(x.w, '法人番号') || g(x.c, '法人番号') };
    const pk = x.phone.replace(/\D/g, '');
    if (self.has(rec) || phones.has(pk)) { st.自己重複++; continue; }
    self.addRecord(rec, 'self'); phones.add(pk);
    st.候補++;
    if (rows.length >= TARGET) continue;
    const w = x.w || {}; const c = x.c || {};
    const honsha = g(w, '本社') || g(c, '都道府県');
    rows.push({
      ICP区分: x.cls, 企業名: x.n,
      架電宛名: g(w, '架電宛名') || g(c, '架電宛名') || '採用ご担当者様',
      採用担当者名: g(w, '採用担当者名') || g(c, '採用担当者名'),
      役職: g(w, '役職') || g(c, '役職'), 部署: g(w, '部署') || g(c, '部署'),
      電話番号: x.phone, メール: g(w, 'メール') || g(c, 'メール'),
      業種: x.industry, 従業員数: g(w, '従業員数') || g(c, '従業員数'),
      都道府県: prefOf(honsha) || prefOf(g(c, '都道府県')) || prefectureForNumber(x.phone), 本社: honsha,
      組織型: classifyOrgType(x.n).label,
      '募集人数(最新卒年)': g(w, '募集人数(最新卒年)') || g(c, '採用予定人数'),
      昨年度入社数: g(w, '昨年度入社数'), '採用実績(直近3年)': g(w, '採用実績(直近3年)'),
      インテント階層: g(w, 'インテント階層'), インテントスコア: g(w, 'インテントスコア'), 総合優先度: g(w, '総合優先度'),
      最有力シグナル: g(w, '最有力シグナル'), なぜ今: g(w, 'なぜ今'), 推奨トーク: g(w, '推奨トーク'), 予算状態: g(w, '予算状態'),
      ICP判定根拠: g(w, 'MOCHCA適合根拠') || g(c, 'MOCHICA適合'),
      採用ページURL: g(w, '採用ページURL') || g(c, '採用ページURL'), 公式URL: g(w, '公式URL') || g(c, '公式URL'),
      法人番号: g(w, '法人番号') || g(c, '法人番号'), corpID: g(w, 'corpID'),
      完全新規根拠: 'BALES(全ステージ)／MOCHICA顧客／SF全リード／納品台帳／過去納品リスト／架電禁止 のいずれにも不在',
      取得日: today,
    });
  }
  rows.forEach((r, i) => { r.No = String(i + 1); });

  fs.writeFileSync(OUT, toCsv(COLS, rows), 'utf8');
  log('出力: ' + rows.length + '社 → ' + path.relative(ROOT, OUT) + '（候補 ' + st.候補 + '社）');
  if (rows.length < TARGET) console.warn('⚠ 目標 ' + TARGET + '件に対し ' + rows.length + '件しか残りませんでした');

  const count = (k) => { const m = {}; for (const r of rows) { const v = r[k] || '(空)'; m[v] = (m[v] || 0) + 1; } return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  const L = ['# 完全新規リスト（BALES／アーカイブ／既存顧客 かぶりなし） ' + rows.length + '件', '',
    '生成: ' + today + '／母集団 ' + st.母集団 + '社 → 候補 ' + st.候補 + '社 → 出力 ' + rows.length + '社', '',
    '## 落とした内訳（上から順に判定）', '', '| 理由 | 社数 |', '|---|---|'];
  for (const k of ['BALES', '既存顧客', 'SF', '納品台帳', 'アーカイブ', '架電禁止', 'IT', '官公庁', 'テストデータ', '電話なし', '自己重複']) {
    L.push('| ' + k + ' | ' + st[k] + ' |');
  }
  L.push('', 'アーカイブ = 納品台帳に加え、過去納品CSVとダウンロードフォルダのCSV ' + arch.files + '本（社名列を持つもの全部）。', '');
  L.push('## ICP区分', '', '| 区分 | 社数 |', '|---|---|');
  for (const kv of count('ICP区分')) L.push('| ' + kv[0] + ' | ' + kv[1] + ' |');
  L.push('', '## インテント階層', '', '| 階層 | 社数 |', '|---|---|');
  for (const kv of count('インテント階層')) L.push('| ' + kv[0] + ' | ' + kv[1] + ' |');
  L.push('', '## 組織型', '', '| 組織型 | 社数 |', '|---|---|');
  for (const kv of count('組織型')) L.push('| ' + kv[0] + ' | ' + kv[1] + ' |');
  L.push('', '## 都道府県（上位15）', '', '| 都道府県 | 社数 |', '|---|---|');
  for (const kv of count('都道府県').slice(0, 15)) L.push('| ' + kv[0] + ' | ' + kv[1] + ' |');
  L.push('', '採用担当者名あり: ' + rows.filter((r) => r.採用担当者名).length + '社／メールあり: ' + rows.filter((r) => r.メール).length + '社');
  fs.writeFileSync(REPORT, L.join('\n'), 'utf8');
  log('レポート: ' + path.relative(ROOT, REPORT));
  console.log(JSON.stringify(st));

  if (hasFlag('record')) {
    const r = appendRecords(path.join(ROOT, 'data/_delivered-ledger.csv'), rows, { batch: path.basename(OUT, '.csv'), source: path.basename(OUT) });
    log('納品台帳へ追記: ' + r.added + '社（既出 ' + r.skipped + '）／台帳計 ' + r.total);
  }
}
main();
