'use strict';
// 架電禁止ガードの純ロジックテスト（ネット不要・本番の禁止リストに依存しない）。
//   node test/ng-guard.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 本番の data/ng-companies.txt ではなくテスト用リストを見せる（環境で結果が揺れないように）。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ngguard-'));
const NG_FILE = path.join(TMP, 'ng.txt');
fs.writeFileSync(NG_FILE, [
  '株式会社ビックカメラ',
  'SOMPOケア株式会社',
  '株式会社テスコ',
  '有限会社仁',
  '株式会社サンプル（旧：株式会社オールドネーム）',
].join('\n'), 'utf8');
process.env.NG_LIST_FILE = NG_FILE;

const guard = require('../src/ng-guard');
const { toCsv } = require('../src/csv');

let pass = 0;
function t(msg, fn) { try { fn(); pass++; console.log('  ✓', msg); } catch (e) { console.error('  ✗', msg, '\n    ', e.message); process.exitCode = 1; } }

console.log('ng-guard（架電禁止の無条件削除）:');

// ---- 社名の突合 ----
t('リストと同じ表記は落ちる', () => {
  assert.ok(guard.isNg('株式会社ビックカメラ'));
  assert.ok(guard.isNg('SOMPOケア株式会社'));
});

t('法人格の表記ゆれ（(株)/㈱/全角）を吸収する', () => {
  for (const n of ['(株)ビックカメラ', '（株）ビックカメラ', '㈱ビックカメラ', 'ビックカメラ (株)']) {
    assert.ok(guard.isNg(n), n);
  }
});

t('半角カナ表記も落ちる（normCompanyName だけでは取りこぼす経路）', () => {
  assert.ok(guard.isNg('ﾋﾞｯｸｶﾒﾗ株式会社'));
  assert.ok(guard.isNg('ﾋﾞｯｸｶﾒﾗ (株)'));
});

t('前株/後株が逆でも落とす（既定は安全側＝位置を見ない）', () => {
  assert.ok(guard.isNg('テスコ株式会社'));      // リスト側は「株式会社テスコ」
});

t('NG_STRICT_CORP_POS=1 なら前後逆は別法人として残す', () => {
  process.env.NG_STRICT_CORP_POS = '1';
  try { assert.ok(!guard.isNg('テスコ株式会社')); }
  finally { delete process.env.NG_STRICT_CORP_POS; }
  assert.ok(guard.isNg('テスコ株式会社'));      // 既定に戻ること
});

t('旧社名表記もキー化される', () => {
  assert.ok(guard.isNg('株式会社オールドネーム'));
  assert.ok(guard.isNg('株式会社サンプル'));
});

t('部分一致では落ちない（別法人を巻き込まない）', () => {
  assert.ok(!guard.isNg('株式会社ビックカメラ商事'));
  assert.ok(!guard.isNg('ビックカメラ販売株式会社'));
  assert.ok(!guard.isNg('架空テスト工業株式会社'));
});

t('正規化1文字の社名（有限会社仁）は完全一致だけに当たる', () => {
  assert.ok(guard.isNg('有限会社仁'));
  assert.ok(!guard.isNg('有限会社仁川運輸'));
});

t('空・null は落とさない', () => {
  assert.ok(!guard.isNg(''));
  assert.ok(!guard.isNg(null));
  assert.ok(!guard.isNg(undefined));
});

// ---- 社名列の自動判定 ----
t('社名列を自動判定する（BALES の「会社情報：会社名」等の接尾も拾う）', () => {
  assert.deepStrictEqual(guard.nameColumnsOf(['企業名', '電話']), ['企業名']);
  assert.deepStrictEqual(guard.nameColumnsOf(['会社情報：会社名', '会社情報：電話']), ['会社情報：会社名']);
  assert.deepStrictEqual(guard.nameColumnsOf(['法人名']), ['法人名']);
  assert.deepStrictEqual(guard.nameColumnsOf(['company_name']), ['company_name']);
  assert.deepStrictEqual(guard.nameColumnsOf(['媒体', 'yield']), []);   // 分析レポートは対象外
});

// ---- 出力フック（ここが「無条件削除」の本体）----
t('toCsv が禁止企業の行を落とす', () => {
  const csv = toCsv(['企業名', '電話'], [
    { 企業名: '株式会社ビックカメラ', 電話: '03' },
    { 企業名: '架空テスト工業株式会社', 電話: '06' },
  ]);
  assert.ok(!/ビックカメラ/.test(csv), csv);
  assert.ok(/架空テスト工業/.test(csv), csv);
  assert.strictEqual(csv.split('\n').length, 2);   // ヘッダ＋1行
});

t('toCsv は社名列が無いCSV（分析レポート）には触らない', () => {
  const csv = toCsv(['媒体', 'yield'], [{ 媒体: 'マイナビ', yield: '0.5' }]);
  assert.strictEqual(csv.split('\n').length, 2);
});

t('ngGuard:false で除外明細そのものは書き出せる', () => {
  const csv = toCsv(['企業名', 'NG一致名'],
    [{ 企業名: '株式会社ビックカメラ', NG一致名: '株式会社ビックカメラ' }], { ngGuard: false });
  assert.ok(/ビックカメラ/.test(csv));
});

t('filterRecords は残った行と落とした明細の両方を返す', () => {
  const r = guard.filterRecords(['企業名'], [
    { 企業名: 'SOMPOケア株式会社' }, { 企業名: '架空テスト工業株式会社' },
  ]);
  assert.strictEqual(r.kept.length, 1);
  assert.strictEqual(r.removed.length, 1);
  assert.strictEqual(r.removed[0].ng, 'SOMPOケア株式会社');
});

t('filterRows（行配列版）もヘッダを残して落とす', () => {
  const rows = [['企業名', '電話'], ['㈱ビックカメラ', '03'], ['架空テスト工業株式会社', '06']];
  const r = guard.filterRows(rows);
  assert.strictEqual(r.kept.length, 2);        // ヘッダ＋1行
  assert.strictEqual(r.removed.length, 1);
});

t('NG_GUARD=off で緊急停止できる', () => {
  process.env.NG_GUARD = 'off';
  try {
    assert.ok(!guard.isNg('株式会社ビックカメラ'));
    assert.ok(/ビックカメラ/.test(toCsv(['企業名'], [{ 企業名: '株式会社ビックカメラ' }])));
  } finally { delete process.env.NG_GUARD; }
  assert.ok(guard.isNg('株式会社ビックカメラ'));
});

// ---- 後始末 ----
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

console.log(`  → ${pass} 件成功`);
