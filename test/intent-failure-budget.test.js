'use strict';
/**
 * 昨年度の採用失敗シグナル（S22〜S25）と資金シグナル／資金リスク（S26〜S29）の検証。
 * 実ページ（job.mynavi.jp/27/pc/search/corp83346・86770 ほか 2026-09 実測）の並びを
 * 縮めたテキストで、パーサと判定を固定する。
 *
 * ここで固定したい事故:
 *   - 男女別の採用者数テーブル（年＋名×3）を定着率テーブルと取り違える
 *   - 「非上場のため開示していません。※◯◯グループの売上は3.11兆円」からグループの売上を拾う
 *   - 「過去10年赤字決算なし」を赤字リスクとして拾う
 *   - 資金リスクが加点になり、「お金が無い会社ほど点が高い」状態になる
 */
const assert = require('assert');
const mf = require('../src/intent/mynavi-face');
const { detectFailureSignals, hireActuals, FAILURE_SIGNALS } = require('../src/intent/failure-signals');
const { detectBudgetSignals, assessFunding, extractTiming, BUDGET_SIGNALS } = require('../src/intent/budget-signals');
const { scoreIntent } = require('../src/intent/score');
const { SIGNAL_LIST } = require('../src/intent/signals');

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ✔ ' + name); } catch (e) { console.error('  ✘ ' + name); throw e; } };
const NOW = new Date('2026-09-18T00:00:00Z');
const D = '2026-09-18';

// 実ページ（corp83346 の会社概要）の並びを縮めたもの
const OUTLINE = [
  '最終更新日：2026/9/16',
  '資本金', '4億円', '売上高', '210億4,830万円（2025年11月現在）', '従業員', '407名（2025年4月1日現在）',
  '募集人数', '11～15名',
  '事業所',
  '【福岡県】', '・本社', '・福岡支社', '・西福岡営業所', '・大牟田支社', '・小倉支社', '・久留米支社',
  '【佐賀県】', '・佐賀支社', '【長崎県】', '・長崎支社', '・佐世保支社', '【熊本県】', '・熊本支社',
  '【大分県】', '・東九州支社', '【宮崎県】', '・都城出張所', '【鹿児島県】', '・南九州支社', '【山口県】', '・山口営業所',
  '主な取引先', '病院、クリニック等',
  '過去3年間の新卒採用者数（男女別）',
  '2025年', '6名', '2名', '8名',
  '2024年', '7名', '3名', '10名',
  '2023年', '5名', '3名', '8名',
  '過去3年間の新卒採用者数・', '離職者数・定着率', '採用者', '離職者', '定着率',
  '2025年', '8名', '0名', '100%',
  '2024年', '10名', '3名', '70.0%',
  '2023年', '8名', '0名', '100%',
  '(株)サンプルと特徴・特色が同じ企業を探す。',
  '過去10年赤字決算なしなど安定した業績',
  '3年連続売上高前年比が130％以上と急成長中',
  '年間休日120日以上',
  'よろしいですか？',
].join('\n');

// ---- パーサ ------------------------------------------------------------
t('定着率テーブルを読む（直前の男女別テーブルと取り違えない）', () => {
  const r = mf.parseRetention(OUTLINE);
  assert.deepStrictEqual(r.系列.map((x) => [x.年, x.採用者, x.離職者, x.定着率]),
    [[2025, 8, 0, 100], [2024, 10, 3, 70], [2023, 8, 0, 100]]);
  // 男女別の「2025年 6名 2名 8名」を拾っていたら採用者が6名になる
  assert.strictEqual(r.最新.採用者, 8);
});

t('会社データは桁を足し合わせる（210億4,830万円を210億で止めない）', () => {
  const d = mf.parseCompanyData(OUTLINE);
  assert.strictEqual(d.売上高, 21048300000);
  assert.strictEqual(d.資本金, 400000000);
  assert.strictEqual(d.従業員数, 407);
  assert.strictEqual(mf.parseMoneyJP('3.11兆円'), 3110000000000);
  assert.strictEqual(mf.parseMoneyJP('3,300万円'), 33000000);
});

t('「開示していません」の欄からグループの売上を拾わない', () => {
  const text = ['資本金', '36億8,560万円',
    '売上高（国内単独）', '※2024年度より非上場会社となったため開示していません。',
    '※マザーサングループの売上は、3.11兆円（2025年3月期）です。',
    '従業員', '1,200名'].join('\n');
  const d = mf.parseCompanyData(text);
  assert.strictEqual(d.売上高, null);
  assert.strictEqual(d.非開示, true);
  assert.strictEqual(d.資本金, 3685600000);
});

t('事業所は列挙型でも数える（都道府県は重複なく数える）', () => {
  const o = mf.parseOffices(OUTLINE);
  assert.strictEqual(o.都道府県数, 8);   // 福岡・佐賀・長崎・熊本・大分・宮崎・鹿児島・山口
  assert.ok(o.拠点規模 >= 12, '拠点規模=' + o.拠点規模);
});

t('特徴・特色タグを統制語彙として取り出す', () => {
  const tags = mf.parseFeatureTags(OUTLINE);
  assert.ok(tags.includes('過去10年赤字決算なしなど安定した業績'));
  assert.ok(tags.some((x) => x.includes('急成長中')));
});

// ---- S22 昨年度の採用計画が未充足 --------------------------------------
t('前年の募集人数が台帳にあれば、充足率で「確定」になる', () => {
  const ev = { 定着: mf.parseRetention(OUTLINE) };            // 2025年入社8名
  const prev = { 卒年面: { 25: { 募集人数: { 下限: 20, 上限: 20, 表記: '20名' } } } };
  const [h] = detectFailureSignals(ev, { now: NOW, 検知日: D, prev }).filter((x) => x.signal === 'LAST_YEAR_SHORTFALL');
  assert.ok(/^確定/.test(h.level), h.level);
  assert.strictEqual(h.詳細.充足率, 40);
  assert.ok(h.根拠.includes('募集人数20名'), h.根拠);
});

t('台帳が無い1周目は、今年度の募集人数との差から弱く採るだけ（確定にしない）', () => {
  const ev = { 定着: mf.parseRetention(OUTLINE), 卒年面: { 27: { 募集人数: { 下限: 20, 上限: 25, 表記: '20～25名' } } } };
  const [h] = detectFailureSignals(ev, { now: NOW, 検知日: D, prev: null }).filter((x) => x.signal === 'LAST_YEAR_SHORTFALL');
  assert.ok(/^中/.test(h.level), h.level);
  assert.strictEqual(h.詳細.前年計画不明, true);
  assert.ok(h.根拠.includes('架電で確認'), h.根拠);
});

t('今年度の募集人数が昨年度実績を下回る社ではS22を立てない', () => {
  const ev = { 定着: mf.parseRetention(OUTLINE), 卒年面: { 27: { 募集人数: { 下限: 5, 上限: 5, 表記: '5名' } } } };
  assert.strictEqual(detectFailureSignals(ev, { now: NOW, 検知日: D }).filter((x) => x.signal === 'LAST_YEAR_SHORTFALL').length, 0);
});

// ---- S23 早期離職 -------------------------------------------------------
t('直近入社の定着率が下がっていれば早期離職が立つ', () => {
  const ev = { 定着: { 系列: [{ 年: 2025, 採用者: 8, 離職者: 3, 定着率: 62.5 }], 最新: { 年: 2025 }, 開示年: 2025 } };
  const [h] = detectFailureSignals(ev, { now: NOW, 検知日: D }).filter((x) => x.signal === 'EARLY_TURNOVER');
  assert.ok(/^確定/.test(h.level), h.level);
  assert.strictEqual(h.strength, 1);
});

t('直近が定着率100%なら立たない（3年平均が低い時だけ弱く採る）', () => {
  const 良い = { 定着: mf.parseRetention(OUTLINE) };           // 100 / 70 / 100 → 平均90
  assert.strictEqual(detectFailureSignals(良い, { now: NOW, 検知日: D }).filter((x) => x.signal === 'EARLY_TURNOVER').length, 0);
  const 悪い = { 定着: { 系列: [{ 年: 2025, 採用者: 8, 離職者: 0, 定着率: 100 }, { 年: 2024, 採用者: 8, 離職者: 5, 定着率: 60 }, { 年: 2023, 採用者: 8, 離職者: 5, 定着率: 60 }] } };
  const [h] = detectFailureSignals(悪い, { now: NOW, 検知日: D }).filter((x) => x.signal === 'EARLY_TURNOVER');
  assert.ok(/^弱/.test(h.level), h.level);
});

t('定着率96.5%（57名中2名離職）は失敗として扱わない', () => {
  const ev = { 定着: { 系列: [{ 年: 2025, 採用者: 57, 離職者: 2, 定着率: 96.5 }] } };
  assert.strictEqual(detectFailureSignals(ev, { now: NOW, 検知日: D }).filter((x) => x.signal === 'EARLY_TURNOVER').length, 0);
});

t('入社数の微減（16→15名）はシグナルにしない', () => {
  const ev = { 採用実績系列: '2026年15名/2025年16名' };
  assert.strictEqual(detectFailureSignals(ev, { now: NOW, 検知日: D }).filter((x) => x.signal === 'HIRE_DOWNTREND').length, 0);
});

t('売上30億円台は原資シグナルにしない（ICPではほぼ全社が該当するため）', () => {
  assert.strictEqual(detectBudgetSignals({ 会社データ: { 売上高: 3.5e9, 従業員数: 400 } }, { now: NOW, 検知日: D }).length, 0);
  assert.strictEqual(detectBudgetSignals({ 会社データ: { 売上高: 1.2e10, 従業員数: 400 } }, { now: NOW, 検知日: D })[0].signal, 'FUND_CAPACITY');
});

t('開示が古い年の定着率は強度を割り引く', () => {
  const 古い = { 定着: { 系列: [{ 年: 2022, 採用者: 8, 離職者: 4, 定着率: 50 }] } };
  const [h] = detectFailureSignals(古い, { now: NOW, 検知日: D }).filter((x) => x.signal === 'EARLY_TURNOVER');
  assert.ok(h.strength < 1, h.strength);
  assert.ok(h.level.includes('年前の開示'), h.level);
});

// ---- S24 採用難の記載 ---------------------------------------------------
t('自社で「計画に届かなかった」と書いている社を拾い、否定文は拾わない', () => {
  const 言及 = { 掲載本文: '昨年度は新卒の採用計画に届かず、母集団形成に苦戦しました。' };
  const [h] = detectFailureSignals(言及, { now: NOW, 検知日: D }).filter((x) => x.signal === 'SHORTFALL_VOICE');
  assert.ok(/^確定/.test(h.level), h.level);
  const 否定 = { 掲載本文: '新卒採用で母集団形成に苦戦したことはありません。' };
  assert.strictEqual(detectFailureSignals(否定, { now: NOW, 検知日: D }).filter((x) => x.signal === 'SHORTFALL_VOICE').length, 0);
});

// ---- S25 入社数の減少 ---------------------------------------------------
t('入社数の減少は「絞ったのか採れなかったのか」を根拠文で保留する', () => {
  const ev = { 採用実績系列: '2026年4名/2025年12名/2024年10名' };
  assert.strictEqual(hireActuals(ev).出所, '採用実績');
  const [h] = detectFailureSignals(ev, { now: NOW, 検知日: D }).filter((x) => x.signal === 'HIRE_DOWNTREND');
  assert.ok(/^強/.test(h.level), h.level);
  assert.ok(h.根拠.includes('架電で確認'), h.根拠);
});

// ---- S26〜S29 資金シグナル（加点）---------------------------------------
t('特徴タグから業績伸長、事業所から多拠点、業種から人が資本を採る', () => {
  const ev = {
    特徴: mf.parseFeatureTags(OUTLINE), 拠点: mf.parseOffices(OUTLINE),
    会社データ: mf.parseCompanyData(OUTLINE), 業種: 'ガス・エネルギー',
  };
  const ids = detectBudgetSignals(ev, { now: NOW, 検知日: D }).map((h) => h.signal).sort();
  assert.deepStrictEqual(ids, ['EXPANSION_SITES', 'FUND_CAPACITY', 'GROWTH_TREND', 'PEOPLE_BUSINESS']);
});

t('人材派遣は最上位の「人が資本」区分になる', () => {
  const [h] = detectBudgetSignals({ 業種: '人材派遣・人材紹介' }, { now: NOW, 検知日: D });
  assert.strictEqual(h.signal, 'PEOPLE_BUSINESS');
  assert.strictEqual(h.strength, 1);
});

// ---- 資金リスク（減点。点にしない）---------------------------------------
t('赤字・採用縮小・予算確定を区別し、いちばん厳しい係数に合わせる', () => {
  const 赤字 = assessFunding({ 掲載本文: '今期は営業損失を計上しました。' }, []);
  assert.strictEqual(赤字.状態, '逼迫');
  const 縮小 = assessFunding({ 掲載本文: '2027年卒の新卒採用は見送りとさせていただきます。' }, []);
  assert.strictEqual(縮小.リスク[0].種別, '採用縮小');
  const 予算 = assessFunding({ 掲載本文: '今期の予算は確定しており、導入は来期の予算で検討します。' }, []);
  assert.strictEqual(予算.状態, '予算確定');
  assert.strictEqual(予算.検討時期, '来期');
  assert.strictEqual(予算.ナーチャリング, true);
  const 両方 = assessFunding({ 掲載本文: '来期の予算で検討します。なお今期は営業損失を計上しました。' }, []);
  assert.strictEqual(両方.係数, 0.70, '甘い方へ丸めてはいけない');
});

t('「過去10年赤字決算なし」を赤字リスクにしない', () => {
  const r = assessFunding({ 掲載本文: '当社は過去10年赤字決算なしの安定経営です。' }, []);
  assert.deepStrictEqual(r.リスク, []);
});

t('募集人数が前卒年から減っていれば、文面が無くても採用縮小として拾う', () => {
  const ev = { 卒年面: { 27: { 募集人数: { 下限: 20, 表記: '20名' } }, 28: { 募集人数: { 下限: 5, 表記: '5名' } } } };
  const r = assessFunding(ev, []);
  assert.strictEqual(r.状態, '逼迫');
  assert.ok(r.根拠.includes('募集人数'), r.根拠);
});

t('資金リスクは加点されない（点は変わらず、行動と係数だけが変わる）', () => {
  const hits = [{ signal: 'SECONDARY_RECRUIT', 名称: 'x', 列: 'S2_二次募集', weight: 28, 半減期日: 30,
    level: '確定(二次・追加募集)', strength: 1, 根拠: 'x', 詳細: {}, 検知日: D }];
  const 素 = scoreIntent(hits, { now: NOW });
  const 資金付き = scoreIntent(hits, { now: NOW, 資金: assessFunding({ 掲載本文: '今期の予算は確定しています。' }, hits) });
  assert.strictEqual(素.スコア, 資金付き.スコア);
  assert.strictEqual(資金付き.予算係数, 0.85);
  assert.ok(資金付き.行動.startsWith('ナーチャリング'), 資金付き.行動);
});

t('昨年度の未充足が「確定」なら、合計点に関わらずA階層に上げる', () => {
  const hits = [{ signal: 'LAST_YEAR_SHORTFALL', 名称: 'x', 列: 'S22_昨年度未充足', weight: 36, 半減期日: 210,
    level: '確定(昨年度の採用計画が未充足)', strength: 0.8, 根拠: 'x', 詳細: {}, 検知日: D }];
  const res = scoreIntent(hits, { now: NOW });
  assert.ok(res.スコア < 45.4, '合計点では届かない前提: ' + res.スコア);
  assert.strictEqual(res.階層, 'A');
  // 同じ軸でも「中」止まりなら上げない
  const 弱 = scoreIntent([{ ...hits[0], level: '中(今年度の募集人数が昨年度実績を大きく上回る)' }], { now: NOW });
  assert.notStrictEqual(弱.階層, 'A');
});

t('追加8軸は列・順位が一意で、既存21軸と衝突しない', () => {
  assert.strictEqual(Object.keys(FAILURE_SIGNALS).length, 4);
  assert.strictEqual(Object.keys(BUDGET_SIGNALS).length, 4);
  assert.strictEqual(SIGNAL_LIST.length, 30);   // ＋S30 採用構成
  assert.strictEqual(new Set(SIGNAL_LIST.map((s) => s.列)).size, 30);
  assert.strictEqual(new Set(SIGNAL_LIST.map((s) => s.順位)).size, 30);
});

t('検討時期は検討の文脈にある時だけ拾う', () => {
  assert.strictEqual(extractTiming('4月に導入を検討します').時期, '4月');
  assert.strictEqual(extractTiming('4月入社の新卒を募集中です'), null);
  // 実測で踏んだ誤爆: 掲載面の「2027年3月卒業見込み／エントリー開始」から3月を拾っていた
  assert.strictEqual(extractTiming('2027年3月卒業見込みの方が対象です。エントリー開始しました'), null);
  assert.strictEqual(extractTiming('選考は6月開始、7月に最終面接を実施します'), null);
  assert.strictEqual(extractTiming('稟議は10月に上げる予定です').時期, '10月');
  // 実測で踏んだ誤爆その2: 掲載面の沿革「2005年 8月 …IT技術導入…」から8月を拾っていた
  const NOW = { now: new Date('2026-09-18') };
  assert.strictEqual(extractTiming('2005年 8月 先進的IT技術導入による販促拡大推進事業の認定', NOW), null);
  assert.strictEqual(extractTiming('2022年 4月 東京証券取引所の市場区分の見直しにより', NOW), null);
  // 未来の年つきは残す（履歴ではなく予定なので）
  assert.strictEqual(extractTiming('2027年4月から導入を検討しています', NOW).時期, '4月');
});

console.log('失敗・資金シグナル: ' + pass + ' pass');
