'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { SIGNAL_LIST, detectAll, detectHrMidCareerJob, detectHirePlanIncrease } = require('../src/intent/signals');
const { detectOpportunitySignals, OPPORTUNITY_SIGNALS } = require('../src/intent/opportunity-signals');
const { scoreIntent, talkGuide } = require('../src/intent/score');
const { fromRow, addDocument, evidenceText } = require('../src/intent/collect');
const { mergeSignals, signalsToHits } = require('../src/intent/store');
const { targetFit, exactCount } = require('../src/intent/target-fit');
const { buildRow, COLS } = require('../src/intent-analyze');
const { readCsv, toCsv } = require('../src/csv');
const NOW = new Date('2026-09-09T00:00:00Z');
const TODAY = '2026-09-09';
let pass = 0;
function t(label, fn) { fn(); pass++; console.log('  ✔', label); }
const examples = [
  '新卒の応募者情報をExcelで管理しています',
  '新卒採用の面接日程調整に工数がかかっています',
  '新卒採用の選考辞退が増加して課題になっています',
  '新卒採用の内定者フォローを強化しています',
  '新卒採用では複数媒体の応募者を一元管理したい',
  '新卒採用で各拠点の選考状況を共有しています',
  '新卒採用の採用管理システムを比較検討しています',
  '新卒採用DXのプロジェクトを開始します',
];
const doc = (text, date = TODAY, url = 'https://example.test/recruit') => ({ text, date, url });
const detect = docs => detectOpportunitySignals({ インテント資料: docs }, { now: NOW, 検知日: TODAY });
const good = { 企業名: '株式会社検証サンプル', 業種: '製造業', 従業員数: '300', 年間新卒採用人数: '21', アポ期待度: '80', 電話番号: '03-0000-0000', ATS判定: '未導入' };

t('定義は8→30種類、ID・CSV列は一意', () => {
  // 8（基礎）＋8（課題）＋5（卒年面）＋4（昨年度の失敗）＋4（資金）＋1（採用構成）＝30
  assert.strictEqual(SIGNAL_LIST.length, 30);
  assert.strictEqual(new Set(SIGNAL_LIST.map(s => s.id)).size, 30);
  assert.strictEqual(new Set(COLS).size, COLS.length);
});
Object.keys(OPPORTUNITY_SIGNALS).forEach((id, i) => t(`${id}: 根拠付き検知・トーク・CSVまで接続`, () => {
  const ev = fromRow({ ...good, インテント本文: examples[i], インテント根拠URL: doc('').url, インテント発生日: TODAY });
  const hits = detectAll(ev, null, { now: NOW, 検知日: TODAY });
  assert.ok(hits.some(h => h.signal === id));
  const res = scoreIntent(hits, { now: NOW });
  assert.ok(talkGuide(res).length > 10);
  const row = buildRow(good, ev, res, 1);
  assert.ok(row[OPPORTUNITY_SIGNALS[id].列]);
  assert.ok(row.根拠URL一覧.includes(doc('').url));
  assert.strictEqual(row.ATS判定, '未導入');
}));
t('根拠URL欠損・不正プロトコルは検知しない', () => {
  for (const url of ['', 'javascript:alert(1)', 'not-url']) assert.strictEqual(detect([doc(examples[0], TODAY, url)]).length, 0);
});
t('一般記事・他社事例・解決済み・否定・新卒文脈なしを除く', () => {
  for (const text of [
    `導入事例: ${examples[0]}`, `他社では${examples[1]}`, `${examples[1]}が解消済みです`,
    '新卒の採用管理システムの導入を検討していません', '新卒採用DXのプロジェクトは中止しました',
    '中途採用の面接日程調整に工数がかかっています',
    '新卒採用を実施しています。経理ではExcelで応募者を管理しています',
  ]) assert.strictEqual(detect([doc(text)]).length, 0, text);
});
t('未来・不正日付・4半減期超は検知しない', () => {
  for (const date of ['2026-10-01', '2026-02-30', 'invalid', '2024-01-01']) assert.strictEqual(detect([doc(examples[0], date)]).length, 0, date);
});
t('発生日不明は弱い、検知日で古い事実を新しくしない', () => {
  const unknown = detect([doc(examples[0], '')])[0];
  assert.strictEqual(unknown.strength, 0.4);
  const fresh = scoreIntent(detect([doc(examples[0])]), { now: NOW });
  const old = scoreIntent(detect([doc(examples[0], '2026-07-11')]), { now: NOW });
  assert.ok(Math.abs(old.スコア - fresh.スコア / 2) < 0.2);
});
t('同一資料や同じシグナルを重複加点しない', () => {
  const hits = detect([doc(examples[0]), doc(examples[0]), doc(examples[0], TODAY, 'https://example.test/other')]);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(scoreIntent([...hits, ...hits], { now: NOW }).スコア, scoreIntent(hits, { now: NOW }).スコア);
});
t('同じ課題群に属するシグナルは上限で抑える', () => {
  const r = scoreIntent(detect([doc(examples.slice(0, 2).join('。'))]), { now: NOW });
  assert.strictEqual(r.スコア, 32);
  assert.ok(r.内訳.some(d => d.調整前点数 > d.点数));
});
t('日付不明の同一根拠は再取得しても鮮度を更新しない', () => {
  const h = detect([doc(examples[0], '')])[0];
  const initial = mergeSignals({}, [h], { now: NOW });
  const later = new Date('2026-11-08');
  const merged = mergeSignals(initial, [{ ...h, 検知日: '2026-11-08' }], { now: later });
  const r = scoreIntent(signalsToHits(merged), { now: later });
  assert.ok(Math.abs(r.スコア - h.weight * h.strength / 2) < 0.2);
});
t('求人は正規化後の社名完全一致のみ', () => {
  assert.strictEqual(detectHrMidCareerJob([{ 企業名: '株式会社検証サンプル子会社', 職種: '採用担当', 本文: '新卒採用管理と日程調整' }], { companyName: good.企業名 }), null);
});
t('CSVの採用人数の範囲を連結しない、ゼロは既知の値', () => {
  assert.strictEqual(exactCount('10～20名'), null);
  assert.strictEqual(exactCount('1,200人'), 1200);
  assert.strictEqual(exactCount('０名'), 0);
  assert.strictEqual(fromRow({ 採用予定人数: '10～20名' }).採用予定人数, '10～20名');
  assert.strictEqual(detectHirePlanIncrease({ plan: '10～20名', prevPlan: '5名' }), null);
});
t('HTMLの強調タグは文脈を維持、段落・ナビは混ぜない', () => {
  const text = evidenceText('<nav>新卒採用の選考辞退が増加して課題</nav><p>新卒の応募者情報を<strong>Excel</strong>で管理しています</p><p>中途の内定辞退が増加して課題です</p>');
  const hits = detect([doc(text)]);
  assert.deepStrictEqual(hits.map(h => h.signal), ['MANUAL_APPLICANT']);
});
t('適合しない企業はインテント満点でも順位0・架電不可', () => {
  for (const changes of [{ 業種: 'ソフトウェア' }, { 従業員数: '99' }, { 年間新卒採用人数: '0' },
    { エントリー人数: '49' }, { DNC: '1' }, { DNC: '○' }, { 架電拒否: '✓' }, { 既存顧客: 'true' }, { 公式URL: 'https://www.city.example.jp' }]) {
    const f = targetFit({ ...good, ...changes }, {}, { スコア: 100 });
    assert.strictEqual(f.status, '対象外', JSON.stringify(changes));
    assert.strictEqual(f.priority, 0);
    assert.ok(f.action.includes('架電しない'));
  }
});
t('未知の条件は要確認、スコア不明を低適合と断定しない', () => {
  const f = targetFit({ 企業名: '未確認サンプル' }, {}, { スコア: 100 });
  assert.strictEqual(f.status, '要確認');
  assert.strictEqual(f.priority, 49);
  assert.ok(f.missing.includes('新卒採用人数'));
  assert.strictEqual(targetFit({ ...good, アポ期待度: '' }, {}, { スコア: 40 }).priority, 43.5);
});
t('既存ATS導入は一律除外せず、確認ルートを出す', () => {
  const f = targetFit({ ...good, ATS判定: '導入済' }, {}, { スコア: 60 });
  assert.strictEqual(f.status, '適合');
  assert.ok(f.route.includes('切替'));
});
t('根拠資料JSONの再入力と欠損・破損に対応する', () => {
  const ev = fromRow({ インテント資料JSON: JSON.stringify([doc(examples[0])]) });
  addDocument(ev, doc(examples[0]));
  assert.strictEqual(ev.インテント資料.length, 1);
  assert.strictEqual(detectAll(ev, null, { now: NOW }).length, 1);
  assert.ok(fromRow({ インテント資料JSON: 'broken' }).エラー.length);
  assert.strictEqual(fromRow({}).インテント資料.length, 0);
});
t('CLIをオフラインで実行し、30軸・適合限定・JSON・レポートを確認', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-opportunity-'));
  const input = path.join(dir, 'input.csv');
  const out = path.join(dir, 'out.csv');
  const report = path.join(dir, 'report.md');
  const rows = [good, { ...good, 企業名: '小規模検証サンプル', 従業員数: '10' }].map(r => ({ ...r,
    インテント本文: examples.join('。'), インテント根拠URL: doc('').url, インテント発生日: new Date().toISOString().slice(0, 10) }));
  try {
    fs.writeFileSync(input, toCsv(Object.keys(rows[0]), rows));
    execFileSync(process.execPath, [path.resolve(__dirname, '../src/intent-analyze.js'), '--in', input,
      '--out', out, '--report', report, '--offline', '--no-store', '--qualified-only'], { stdio: 'pipe' });
    const parsed = readCsv(fs.readFileSync(out, 'utf8'));
    assert.strictEqual(parsed.records.length, 1);
    assert.strictEqual(parsed.headers.filter(c => /^S\d+_/.test(c)).length, 30);
    assert.strictEqual(parsed.records[0].MOCHCA適合判定, '適合');
    assert.strictEqual(JSON.parse(parsed.records[0].シグナル内訳JSON).length, 8);
    assert.ok(fs.readFileSync(report, 'utf8').includes('受注確率ではありません'));
  } finally {
    // 作成した既知の一時ファイルだけを削除する。
    // CLIは作業ファイル（<out>.work.csv）と根拠JSONLも同じ場所に出しうるので一緒に畳む。
    const side = [out.replace(/\.csv$/i, '') + '.work.csv', out.replace(/\.csv$/i, '') + '.evidence.jsonl'];
    for (const f of [input, out, report, ...side]) if (fs.existsSync(f)) fs.unlinkSync(f);
    fs.rmdirSync(dir);
  }
});
console.log(`インテント追加分析: ${pass} pass`);
