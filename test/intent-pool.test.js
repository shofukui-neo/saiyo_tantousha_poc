'use strict';
/**
 * 母集団づくり（build-intent-pool.js）と採点し直し（rescore-intent.js）の検証。
 * どちらも納品物を直接作る／書き換えるので、壊れると成果物が壊れる。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { readCsv, toCsv } = require('../src/csv');
const { fetchableSources, poolPriority } = require('../src/build-intent-pool');
const { hitsFromRow } = require('../src/rescore-intent');

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ✔ ' + name); } catch (e) { console.error('  ✘ ' + name); throw e; } };
const SRC = path.resolve(__dirname, '..', 'src');

// ---- 取得系統の判定 ----------------------------------------------------
t('マイナビURLから corpID を復元し、卒年面系統が立つ', () => {
  const r = fetchableSources({ 企業名: 'A社', 採用ページURL: 'https://job.mynavi.jp/27/pc/search/corp58978/outline.html' });
  assert.strictEqual(r.corpID, '58978');
  assert.ok(r.sources.includes('mynavi') && r.sources.includes('faces'));
  // /pc/corpNNN/ 形式（search なし）も拾う
  assert.strictEqual(fetchableSources({ 企業名: 'A社', 採用ページURL: 'https://job.mynavi.jp/28/pc/corp123/sem.html' }).corpID, '123');
});

t('公式URL列に媒体URLが入っている行を自社サイト扱いしない', () => {
  // 実測: 統合マスタの公式URL列に job.mynavi.jp が2,234件入っている
  for (const u of ['https://job.mynavi.jp/27/pc/search/corp1/', 'https://job.rikunabi.com/2027/company/1/']) {
    assert.ok(!fetchableSources({ 企業名: 'A社', 公式URL: u }).sources.includes('site'), u);
  }
  assert.ok(fetchableSources({ 企業名: 'A社', 公式URL: 'https://example.co.jp/' }).sources.includes('site'));
});

t('取得系統が何も無い行は csv と jobs だけ（社名しか無いため）', () => {
  const r = fetchableSources({ 企業名: 'A社' });
  assert.deepStrictEqual(r.sources, ['csv', 'jobs']);
  assert.strictEqual(r.corpID, '');
  // 社名すら無ければ jobs も立たない
  assert.deepStrictEqual(fetchableSources({}).sources, ['csv']);
});

t('採点優先度は「取りに行ける一次情報が多い社」を上に置く', () => {
  const 厚い = poolPriority({ 電話番号: '03-0000-0000', 採用担当者名: '山田', 従業員数: '500' }, ['csv', 'mynavi', 'faces', 'site']);
  const 薄い = poolPriority({}, ['csv', 'jobs']);
  assert.ok(厚い > 薄い, `${厚い} > ${薄い}`);
  // 架電できない社（電話なし）は同条件でも下がる
  assert.ok(poolPriority({ 電話番号: '03-0000-0000' }, ['csv', 'mynavi']) > poolPriority({}, ['csv', 'mynavi']));
});

// ---- CLI: 母集団づくり -------------------------------------------------
t('CLI: 架電禁止・名寄せ重複・取得系統なしを落とし、階層で絞れる', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-pool-'));
  const input = path.join(dir, 'in.csv');
  const out = path.join(dir, 'out.csv');
  const ng = fs.readFileSync(path.resolve(__dirname, '..', 'data', 'ng-companies.txt'), 'utf8')
    .split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const 禁止社 = ng[0];
  const rows = [
    { 企業名: '取得可A', 採用ページURL: 'https://job.mynavi.jp/27/pc/search/corp111/outline.html', 法人番号: '1000000000001', インテント階層: 'A', 電話番号: '03-1' },
    { 企業名: '取得可B', 採用ページURL: 'https://job.mynavi.jp/27/pc/search/corp222/outline.html', 法人番号: '1000000000002', インテント階層: 'B', 電話番号: '03-2' },
    { 企業名: '取得可A・別表記', 採用ページURL: 'https://job.mynavi.jp/27/pc/search/corp111/outline.html', 法人番号: '1000000000001', インテント階層: 'A', 電話番号: '03-1' },
    { 企業名: '取得不可', 法人番号: '1000000000003', インテント階層: 'A', 電話番号: '03-3' },
    { 企業名: 禁止社, 採用ページURL: 'https://job.mynavi.jp/27/pc/search/corp333/outline.html', 法人番号: '1000000000004', インテント階層: 'A' },
  ];
  try {
    fs.writeFileSync(input, toCsv(Object.keys(rows[0]), rows, { ngGuard: false }));
    execFileSync(process.execPath, [path.join(SRC, 'build-intent-pool.js'),
      '--in', input, '--out', out, '--fetchable-only'], { stdio: 'pipe' });
    const names = readCsv(fs.readFileSync(out, 'utf8')).records.map((r) => r['企業名']);
    assert.deepStrictEqual(names.sort(), ['取得可A', '取得可B'], '禁止・重複・取得不可が落ちる');

    // --tier で階層を絞る
    const outA = path.join(dir, 'outA.csv');
    execFileSync(process.execPath, [path.join(SRC, 'build-intent-pool.js'),
      '--in', input, '--out', outA, '--fetchable-only', '--tier', 'A'], { stdio: 'pipe' });
    assert.deepStrictEqual(readCsv(fs.readFileSync(outA, 'utf8')).records.map((r) => r['企業名']), ['取得可A']);

    // --exclude-scored で既に採点した社を外す
    const done = path.join(dir, 'done.csv');
    fs.writeFileSync(done, toCsv(['企業名', '法人番号'], [{ 企業名: '取得可A', 法人番号: '1000000000001' }], { ngGuard: false }));
    const outD = path.join(dir, 'outD.csv');
    execFileSync(process.execPath, [path.join(SRC, 'build-intent-pool.js'),
      '--in', input, '--out', outD, '--fetchable-only', '--exclude-scored', done], { stdio: 'pipe' });
    assert.deepStrictEqual(readCsv(fs.readFileSync(outD, 'utf8')).records.map((r) => r['企業名']), ['取得可B']);
  } finally {
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
    fs.rmdirSync(dir);
  }
});

// ---- 採点し直し --------------------------------------------------------
t('内訳JSONから hit を復元する（壊れたJSONは黙って捨てない）', () => {
  const 内訳 = [{ signal: 'SECONDARY_RECRUIT', 名称: 'x', 列: 'S2_二次募集', weight: 28,
    level: '確定(二次・追加募集)', strength: 1, 根拠: 'r', 詳細: {}, 検知日: '2026-09-14', 点数: 28, 調整前点数: 28 }];
  const h = hitsFromRow({ シグナル内訳JSON: JSON.stringify(内訳) });
  assert.strictEqual(h.length, 1);
  assert.strictEqual(h[0].半減期日, 30, '半減期は定義から引き直す（内訳に入っていない）');
  assert.strictEqual(hitsFromRow({ シグナル内訳JSON: '{壊れ' }), null);
  assert.deepStrictEqual(hitsFromRow({ シグナル内訳JSON: '[]' }), []);
});

t('CLI: 採点し直しで階層とレポートが揃って更新される', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-rescore-'));
  const csv = path.join(dir, 'scored.csv');
  const md = path.join(dir, 'scored.md');
  // face群だけを積み上げた行。群上限(26)が効けば合計は26で頭打ちになる。
  const face = (signal, 列, weight) => ({ signal, 名称: signal, 列, weight, level: '確定(x)',
    strength: 1, 根拠: 'r', 詳細: {}, 検知日: new Date().toISOString().slice(0, 10), 点数: weight, 調整前点数: weight });
  const 内訳 = [face('MANUAL_ENTRY', 'S17_手作業応募', 26), face('NEXT_FACE_LIVE', 'S18_次年度面始動', 24),
    face('SELECTION_LOAD', 'S19_多段選考', 18)];
  const row = { No: '1', 企業名: '検証社', インテントスコア: '68', インテント階層: 'A', 総合優先度: '50',
    検知シグナル: 'x', 最有力シグナル: 'x', シグナル強度: '', なぜ今: '', 根拠: '', 推奨トーク: '', 推奨アクション: '',
    従業員数: '500', 業種: '製造', 年間新卒採用人数: '10', シグナル内訳JSON: JSON.stringify(内訳),
    S17_手作業応募: '', S18_次年度面始動: '', S19_多段選考: '' };
  try {
    fs.writeFileSync(csv, toCsv(Object.keys(row), [row], { ngGuard: false }));
    fs.writeFileSync(md, '# 古いレポート\n');
    execFileSync(process.execPath, [path.join(SRC, 'rescore-intent.js'), '--in', csv, '--report', md], { stdio: 'pipe' });
    const rec = readCsv(fs.readFileSync(csv, 'utf8')).records[0];
    // 68点(=26+24+18) が face群上限26で頭打ちになる
    assert.strictEqual(parseFloat(rec['インテントスコア']), 26, '群上限が効く');
    assert.strictEqual(rec['インテント階層'], 'B', 'A閾値48.4に届かない');
    const report = fs.readFileSync(md, 'utf8');
    assert.ok(!report.includes('古いレポート'), 'レポートが作り直される');
    assert.ok(report.includes('階層の閾値'), 'レポートに閾値が書かれる');
  } finally {
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
    fs.rmdirSync(dir);
  }
});

// ---- 最終書き出し（行を開かずに並べ替える） ----------------------------
t('finalize: 引用符内の改行で行を切らず、並べ替えと採番が正しい', () => {
  const { finalizeFromWork } = require('../src/intent/finalize');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-finalize-'));
  const work = path.join(dir, 'w.csv');
  const out = path.join(dir, 'o.csv');
  const cols = ['No', '企業名', '総合優先度', 'インテントスコア', '根拠'];
  // 引用符・改行・カンマを全部含む値。行スキャナが引用符内の改行で行を切ると壊れる。
  const 改行入り = '改行を含む\n根拠, カンマも含む';
  const rows = [
    { No: '', 企業名: '低い社', 総合優先度: '10', インテントスコア: '5', 根拠: 'ふつうの根拠' },
    { No: '', 企業名: '高い社', 総合優先度: '90', インテントスコア: '50', 根拠: 改行入り },
    { No: '', 企業名: '同点社', 総合優先度: '90', インテントスコア: '80', 根拠: '"引用符"つき' },
  ];
  fs.writeFileSync(work, toCsv(cols, rows, { ngGuard: false }) + '\n');
  return finalizeFromWork(work, out).then((r) => {
    assert.strictEqual(r.行数, 3);
    const got = readCsv(fs.readFileSync(out, 'utf8')).records;
    assert.deepStrictEqual(got.map((x) => x['企業名']), ['同点社', '高い社', '低い社'],
      '総合優先度→インテントスコアの降順（同点はスコアで割る）');
    assert.deepStrictEqual(got.map((x) => x.No), ['1', '2', '3'], '並べ替えた後に採番する');
    assert.strictEqual(got[1]['根拠'], 改行入り);
    assert.strictEqual(got[0]['根拠'], '"引用符"つき');
  });
});

t('finalize: 架電禁止企業は最終書き出しでも落ちる（関所を減らさない）', () => {
  const { finalizeFromWork } = require('../src/intent/finalize');
  const ng = fs.readFileSync(path.resolve(__dirname, '..', 'data', 'ng-companies.txt'), 'utf8')
    .split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-finalize-ng-'));
  const work = path.join(dir, 'w.csv');
  const out = path.join(dir, 'o.csv');
  const cols = ['No', '企業名', '総合優先度', 'インテントスコア'];
  fs.writeFileSync(work, toCsv(cols, [
    { No: '', 企業名: ng, 総合優先度: '99', インテントスコア: '99' },
    { No: '', 企業名: '通常社', 総合優先度: '10', インテントスコア: '10' },
  ], { ngGuard: false }) + '\n');
  return finalizeFromWork(work, out).then((r) => {
    assert.strictEqual(r.除外, 1, '禁止企業は最上位でも落ちる');
    assert.deepStrictEqual(readCsv(fs.readFileSync(out, 'utf8')).records.map((x) => x['企業名']), ['通常社']);
  });
});

console.log('母集団・採点し直し: ' + pass + ' pass');
