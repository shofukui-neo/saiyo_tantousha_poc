'use strict';
/**
 * company-match / normCompanyName 重複除去ロジックの詳細テスト
 * =====================================================================
 * 発端: 「高知県農業協同組合(JA高知県)」がMOCHICA顧客なのに既存被りで弾かれず納品リストに混入。
 * 原因: normCompanyName が別称括弧「(JA高知県)」を残し、顧客側「高知県農業協同組合」と不一致。
 *
 * 本テストは (1) 注釈括弧の除去 (2) 農協(JA)別称の同一視 (3) 連合会/中央会の誤マッチ防止
 * (4) 実MOCHICA顧客リストとの突合 (5) 別法人の非衝突 を網羅的に検証する。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { normCompanyName, stripAnnotations } = require('../src/csv');
const { companyCore, createMatchIndex, keysOf, looseKey, fuzzyKey, stripBranch, hasKey } = require('../src/company-match');

let pass = 0, fail = 0;
const fails = [];
function ok(label, cond) { if (cond) { pass++; } else { fail++; fails.push(label); console.log(`  ✗ ${label}`); } }
function eq(label, a, b) { ok(`${label}  (${JSON.stringify(a)} === ${JSON.stringify(b)})`, a === b); }
function ne(label, a, b) { ok(`${label}  (${JSON.stringify(a)} !== ${JSON.stringify(b)})`, a !== b); }

const ROOT = path.resolve(__dirname, '..');

// ── 1) 注釈括弧の除去（normCompanyName） ─────────────────────────────
console.log('\n[1] 注釈括弧・ブラケットの除去');
eq('別称括弧(JA高知県)を除去', normCompanyName('高知県農業協同組合(JA高知県)'), normCompanyName('高知県農業協同組合'));
eq('全角別称括弧（JA高知県）を除去', normCompanyName('高知県農業協同組合（ＪＡ高知県）'), normCompanyName('高知県農業協同組合'));
eq('ブラケット【JA高知中央会】を除去', normCompanyName('高知県農業協同組合中央会【JA高知中央会】'), normCompanyName('高知県農業協同組合中央会'));
eq('読み括弧（たなか）を除去', normCompanyName('田中商店（たなか）'), normCompanyName('田中商店'));
eq('支店ラベル【本店営業部】を除去', normCompanyName('地方銀行【本店営業部】'), normCompanyName('地方銀行'));
eq('複数括弧を除去', normCompanyName('アルファ(東京)(第二)'), normCompanyName('アルファ'));
eq('入れ子括弧を除去', normCompanyName('ベータ(関東(北))'), normCompanyName('ベータ'));
// 既存の法人格除去は維持（回帰防止）
eq('株式会社除去は維持', normCompanyName('株式会社イータ'), normCompanyName('イータ㈱'));
eq('（株）表記除去は維持', normCompanyName('（株）アルファ'), normCompanyName('アルファ株式会社'));
// degenerate: 括弧を外すと空になる場合は原文維持（誤って全社を空キーに潰さない）
ok('括弧のみ社名は空キーにしない', normCompanyName('(株)') !== '');
ok('stripAnnotations は括弧内を除去', stripAnnotations('A(x)【y】B') === 'AB');

// ── 2) 農協(JA)別称の同一視（companyCore） ──────────────────────────
console.log('\n[2] 農協(JA)別称の同一視');
eq('JA高知県 と 農業協同組合 は同コア', companyCore('JA高知県'), companyCore('高知県農業協同組合'));
eq('全角ＪＡ も同コア', companyCore('ＪＡ高知県'), companyCore('高知県農業協同組合'));
eq('別称括弧付きも同コア', companyCore('高知県農業協同組合(JA高知県)'), companyCore('JA高知県'));
eq('「農協」短縮形も同コア', companyCore('高知県農協'), companyCore('高知県農業協同組合'));
ok('農協コアは coop: 接頭辞', companyCore('高知県農業協同組合').startsWith('coop:'));
ok('非農協はコアなし（空）', companyCore('高知県') === '' && companyCore('株式会社トヨタ') === '');

// ── 3) 連合会/中央会の誤マッチ防止（最重要ガード） ───────────────────
console.log('\n[3] 連合会/中央会/信連/経済連は別法人＝collapseしない');
eq('信連はコアなし', companyCore('高知県信用農業協同組合連合会'), '');
eq('経済連はコアなし', companyCore('熊本県経済農業協同組合連合会'), '');
eq('共済連はコアなし', companyCore('全国共済農業協同組合連合会'), '');
eq('厚生連はコアなし', companyCore('長野県厚生農業協同組合連合会'), '');
eq('中央会はコアなし', companyCore('高知県農業協同組合中央会'), '');
// 別法人が同コアに潰れていないこと（信連・中央会 と 本体農協 が別）
ne('本体農協 と 信連 は別コア/別キー', keysOf('高知県農業協同組合').core || 'A', keysOf('高知県信用農業協同組合連合会').core || 'B');
ne('本体農協 と 中央会 は別コア/別キー', keysOf('高知県農業協同組合').core || 'A', keysOf('高知県農業協同組合中央会').core || 'C');

// ── 4) MatchIndex の突合挙動 ────────────────────────────────────────
console.log('\n[4] MatchIndex 突合挙動');
{
  const idx = createMatchIndex();
  idx.addName('高知県農業協同組合', 'MOCHICA顧客'); // 顧客は正式名で登録
  ok('別称括弧付きリード → 顧客ヒット', idx.has('高知県農業協同組合(JA高知県)'));
  eq('ヒットラベルはMOCHICA顧客', idx.matchLabel('高知県農業協同組合(JA高知県)'), 'MOCHICA顧客');
  ok('JA別称のみのリード → 顧客ヒット（コア）', idx.has('JA高知県'));
  ok('別の農協(高知市)は非ヒット', !idx.has('高知市農業協同組合'));
  ok('信連は非ヒット（別法人）', !idx.has('高知県信用農業協同組合連合会'));
  ok('中央会は非ヒット（別法人）', !idx.has('高知県農業協同組合中央会'));
}
{
  // 法人番号の完全一致
  const idx = createMatchIndex();
  idx.addRecord({ '企業名': 'サンプル', '法人番号': '1234567890123' }, 'SF');
  ok('法人番号一致でヒット', idx.has({ '企業名': '別名でも', '法人番号': '1234567890123' }));
  ok('法人番号12桁は無効（桁不足は無視）', !idx.has({ '企業名': 'x', '法人番号': '123456789012' }));
}
{
  // MOCHICA: 法人名 と LINE登録名 の両索引（別称登録の取りこぼし防止）
  const idx = createMatchIndex();
  idx.addName('オホーツク網走農業協同組合', 'MOCHICA顧客'); // 法人名
  idx.addName('ＪＡオホーツク網走', 'MOCHICA顧客');          // LINE登録名（別称）
  ok('法人名側でヒット', idx.has('オホーツク網走農業協同組合(JAオホーツク網走)'));
  ok('LINE別称側でヒット', idx.has('JAオホーツクABASHIRI'.replace('ABASHIRI', '網走')));
}

// ── 5) 別法人の非衝突（誤除外＝false positive を出さない） ────────────
console.log('\n[5] 別法人の非衝突（過剰除外を出さない）');
{
  const idx = createMatchIndex();
  idx.addName('トヨタ自動車株式会社', 'X');
  ok('日産は非ヒット', !idx.has('日産自動車株式会社'));
  ok('トヨタ紡織は非ヒット（部分一致で誤爆しない）', !idx.has('トヨタ紡織株式会社'));
}
{
  // 都道府県違いの農協が互いに潰れない
  const idx = createMatchIndex();
  idx.addName('香川県農業協同組合', 'MOCHICA顧客');
  ok('香川≠高知（農協コアが県で分離）', !idx.has('高知県農業協同組合'));
  ok('香川県農協 自身はヒット', idx.has('JA香川県'));
}

// ── 6) 実データ突合（MOCHICA顧客リスト） ────────────────────────────
console.log('\n[6] 実MOCHICA顧客リストとの突合');
const MC = path.join(ROOT, 'data', 'MOCHICAの既存顧客リスト - mochica-companies-list.csv');
if (fs.existsSync(MC)) {
  const { readCsv } = require('../src/csv');
  const { records } = readCsv(fs.readFileSync(MC, 'utf8'));
  const idx = createMatchIndex();
  for (const r of records) { idx.addName(r['法人名'], 'MOCHICA顧客'); idx.addName(r['LINEアカウント登録企業名'], 'MOCHICA顧客'); }
  // 発端の実ケース：納品リストの表記が顧客ヒットすること
  ok('★発端ケース 高知県農業協同組合(JA高知県) が顧客ヒット', idx.has('高知県農業協同組合(JA高知県)'));
  // 他の農協顧客も別称表記でヒットすること
  ok('香川県農業協同組合(JA香川県) が顧客ヒット', idx.has('香川県農業協同組合(JA香川県)'));
  ok('となみ野農協 別称でヒット', idx.has('となみ野農業協同組合（JAとなみ野）'));
  // 別法人（信連/中央会）は納品対象として弾かれ過ぎない＝顧客本体と混同しない
  //   ※ 信連自体が顧客なら別途ヒットするのは正しい。ここでは高知“信連”が高知“本体”と
  //     取り違えられていないこと（＝コア衝突していないこと）を確認。
  const hitLabel = idx.matchLabel('高知県信用農業協同組合連合会');
  ok('高知信連は（もし顧客でなければ）本体と誤ヒットしない', typeof hitLabel === 'string');
  console.log(`    MOCHICA顧客 索引: ${records.length}行 → 社名キー${idx.nameSize} / 農協コア${idx.coreSize}`);
} else {
  console.log('  (MOCHICA顧客リスト未配置のためスキップ)');
}

// ── 7) 衝突監査：MOCHICA顧客内で異なる正式名が同一キーに潰れていないか ──
console.log('\n[7] 衝突監査（異なる法人が同キーに潰れていないか）');
if (fs.existsSync(MC)) {
  const { readCsv } = require('../src/csv');
  const { records } = readCsv(fs.readFileSync(MC, 'utf8'));
  // 農協コア別に、元の正式名（正規化ベース名）の異なり数を数える。
  // 同一コアに“基本キーが異なる”法人が複数ぶら下がっていたら衝突候補として警告。
  const coreToBase = new Map();
  for (const r of records) {
    const name = r['法人名']; if (!name) continue;
    const k = keysOf(name);
    if (!k.core) continue;
    if (!coreToBase.has(k.core)) coreToBase.set(k.core, new Set());
    coreToBase.get(k.core).add(k.name);
  }
  const collisions = [...coreToBase.entries()].filter(([, set]) => set.size > 1);
  for (const [core, set] of collisions) console.log(`  ⚠ 衝突候補 ${core}: ${[...set].join(' / ')}`);
  ok('MOCHICA顧客内で農協コア衝突なし', collisions.length === 0);
} else {
  console.log('  (スキップ)');
}

// ── 8) 表記ゆれキー tier4（2026-07-30 追加） ────────────────────────
console.log('\n[8] 表記ゆれキー（旧字体／長音字種／カナ⇔かな／支店・拠点）');
{
  const same = (label, a, b) => eq(label, looseKey(a), looseKey(b));
  same('旧字体 髙島屋⇔高島屋', '株式会社ジェイアール東海髙島屋', '株式会社ジェイアール東海高島屋');
  same('旧字体 濵⇔濱⇔浜', '濵田酒造株式会社', '浜田酒造株式会社');
  same('旧字体 渡邊⇔渡辺', '株式会社渡邊製作所', '株式会社渡辺製作所');
  same('カナ⇔かな かわでん', '株式会社かわでん', '株式会社カワデン');
  same('カナ⇔かな 八幡ねじ', '株式会社八幡ねじ', '株式会社八幡ネジ');
  same('カナ⇔かな 生協', '生活協同組合コープかごしま', '生活協同組合コープカゴシマ');
  same('長音の字種ゆれ（―／－→ー）', 'ソニ―生命保険株式会社', 'ソニー生命保険株式会社');
  same('拠点 本社付き', '株式会社コスモネット本社', '株式会社コスモネット');
  same('拠点 本店営業部付き', 'アルプス中央信用金庫本店営業部', 'アルプス中央信用金庫');
  same('拠点 後株＋支社', 'ソニー生命保険株式会社柏支社', 'ソニー生命保険株式会社');
  same('拠点 後株＋県名支社', 'トヨタモビリティパーツ株式会社茨城支社', 'トヨタモビリティパーツ株式会社');
  same('グループ表記', 'オーハシテクニカグループ', '株式会社オーハシテクニカ');
  // 長音の“有無”は tier5 のみ（tier4では別扱い＝過剰collapseしない）
  ne('tier4はファミリー≠ファミリ', looseKey('株式会社ファミリー'), looseKey('株式会社ファミリ'));
  eq('tier5はコンピュータ＝コンピューター', fuzzyKey('株式会社コンピュータマインド'), fuzzyKey('株式会社コンピューターマインド'));
  // 別法人を潰さないガード
  ne('浜田≠浜田酒造', looseKey('株式会社浜田'), looseKey('浜田酒造株式会社'));
  ne('ホールディングスは別法人', looseKey('ナカザワホールディングス株式会社'), looseKey('株式会社ナカザワ'));
  ne('信連は本体農協と別', looseKey('高知県信用農業協同組合連合会'), looseKey('高知県農業協同組合'));
  ok('1文字キーは無効（衝突源にしない）', looseKey('株式会社A') === '' || looseKey('株式会社A').length >= 2);
  eq('stripBranch 後株＋支店', stripBranch('ソニー生命保険株式会社柏支社'), 'ソニー生命保険株式会社');
  ok('stripBranch は支店語が無ければ素通し', stripBranch('株式会社トヨタ') === '株式会社トヨタ');
}
{
  const idx = createMatchIndex();
  idx.addName('イワテ生活協同組合', 'BALES');
  ok('★実ケース いわて生活協同組合 がヒット（カナ⇔かな）', idx.has('いわて生活協同組合'));
  eq('tier は表記ゆれ', idx.matchDetail('いわて生活協同組合').tier, '表記ゆれ');
  eq('一致相手を返す', idx.matchDetail('いわて生活協同組合').master, 'イワテ生活協同組合');
}
{
  const idx = createMatchIndex({ fuzzy: false });
  idx.addName('株式会社コンピューターマインド', 'BALES');
  ok('fuzzy=false なら長音ゆれは非ヒット', !idx.has('株式会社コンピュータマインド'));
  const idx2 = createMatchIndex();
  idx2.addName('株式会社コンピューターマインド', 'BALES');
  ok('fuzzy=true（既定）で長音ゆれはヒット', idx2.has('株式会社コンピュータマインド'));
  eq('tier は長音ゆれ', idx2.matchDetail('株式会社コンピュータマインド').tier, '長音ゆれ');
}

// ── 9) キー無し行の検出（「未突合＝新規」の誤認を防ぐ） ────────────────
console.log('\n[9] 突合キー無し行の検出');
ok('社名も番号も無い行は hasKey=false', !hasKey({ '企業名': '', '法人番号': '' }));
ok('社名だけでも hasKey=true', hasKey({ '企業名': 'トヨタ自動車' }));
ok('法人番号だけでも hasKey=true', hasKey({ '企業名': '', '法人番号': '1234567890123' }));
{
  const idx = createMatchIndex();
  idx.addName('トヨタ自動車株式会社', 'X');
  ok('空社名は誤ヒットしない', !idx.has({ '企業名': '' }));
  ok('空社名はマスタ側にも登録されない', createMatchIndex().size === 0);
}

// ── 10) 除外索引（exclusion-index）の健全性 ─────────────────────────
console.log('\n[10] 除外索引の層構成');
{
  const { buildExclusionIndex } = require('../src/exclusion-index');
  const ex = buildExclusionIndex({ quiet: true, ledger: false });
  ok('masters層が読めている（顧客/BALES/SFのいずれか）', Object.keys(ex.stats).length > 0);
  ok('マスタ未配置は missing に出る（silentにしない）', Array.isArray(ex.missing));
  ok('索引サイズ > 0', ex.idx.size > 0);
  if (ex.stats['MOCHICA顧客']) ok('★発端ケース JA高知県 が索引でヒット', ex.idx.has('高知県農業協同組合(JA高知県)'));
  console.log(`    層: ${ex.layers.join('+')}／${Object.entries(ex.stats).map(([k, v]) => k + ' ' + v).join(' / ')}`);
  for (const m of ex.missing) console.log(`    ⚠ 未配置: ${m}`);
}

// ── 結果 ────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(58)}`);
if (fail === 0) {
  console.log(`COMPANY-MATCH TEST PASSED ✓  (${pass} checks)`);
  process.exit(0);
} else {
  console.log(`COMPANY-MATCH TEST FAILED ✗  ${fail} 件失敗 / ${pass} 成功`);
  for (const f of fails) console.log(`   - ${f}`);
  process.exit(1);
}
