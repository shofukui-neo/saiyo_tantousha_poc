'use strict';
// 層2（タイミングシグナル）の純ロジック自己テスト（ネットワーク不要）。
// 実行: npm run test:intent
const assert = require('assert');
const S = require('../src/intent/signals');
const { scoreIntent, combineWithFit, decayFactor, talkGuide } = require('../src/intent/score');
const { mergeSignals, signalsToHits, fingerprint } = require('../src/intent/store');
const { parseJobCards, pickRecruitLink, mynaviBase, stripMynaviChrome } = require('../src/intent/collect');

let pass = 0; let fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✔', name); }
  catch (e) { fail++; console.error('  x', name, '->', e.message); }
}
const TODAY = '2026-09-03';

console.log('インテント（層2）判定テスト');

// ============ ① 人事・採用担当の中途求人 ============
t('①確定: 求人票に「母集団形成/採用管理」があれば strength=1', () => {
  const h = S.detectHrMidCareerJob([{
    企業名: '株式会社サンプル', 職種: '人事・採用担当／採用計画の立案', 媒体: '求人ボックス', 掲載: '3日前',
    本文: '新卒・中途の採用業務全般。母集団形成から選考管理までお任せします。',
  }], { companyName: 'サンプル株式会社', 検知日: TODAY });
  assert.ok(h, '検知されるべき');
  assert.strictEqual(h.signal, 'MIDCAREER_HR_JOB');
  assert.strictEqual(h.strength, 1);
  assert.ok(/母集団形成/.test(h.根拠));
});

t('①他社のカードは社名一致で捨てる', () => {
  const h = S.detectHrMidCareerJob([{ 企業名: '別会社株式会社', 職種: '人事・採用担当', 本文: '採用管理' }],
    { companyName: '株式会社サンプル' });
  assert.strictEqual(h, null);
});

t('①人材紹介のCA/RA求人は自社採用でないので除外', () => {
  const h = S.detectHrMidCareerJob([{ 企業名: '(株)エージェント', 職種: 'キャリアアドバイザー／人材紹介', 本文: '求職者の転職支援' }],
    { companyName: '株式会社エージェント' });
  assert.strictEqual(h, null);
});

t('①新卒側の募集（新卒のみ）は中途求人ではない', () => {
  const h = S.detectHrMidCareerJob([{ 企業名: '(株)サンプル', 職種: '人事職（新卒のみ）', 本文: '新卒採用のみの募集です' }],
    { companyName: '(株)サンプル' });
  assert.strictEqual(h, null);
});

t('①その社自身の新卒求人「2027 新卒採用 医療機関」を人事の中途求人と誤認しない', () => {
  const h = S.detectHrMidCareerJob([{ 企業名: '医療法人テスト会', 職種: '2027 新卒採用 医療機関 総合職', 本文: '新卒者を対象とした募集です' }],
    { companyName: '医療法人テスト会' });
  assert.strictEqual(h, null);
});

t('①裸の「採用」だけでは通さない／「採用担当」「人事」なら通す', () => {
  const mk = (職種) => S.detectHrMidCareerJob([{ 企業名: 'A社', 職種, 本文: '' }], { companyName: 'A社' });
  assert.strictEqual(mk('採用に力を入れています 総合職'), null);
  assert.ok(mk('採用担当（中途）'));
  assert.ok(mk('人事・総務'));
});

t('①古い掲載は鮮度で減点される', () => {
  const mk = (掲載) => S.detectHrMidCareerJob([{ 企業名: 'A社', 職種: '人事・採用担当', 本文: '採用管理と母集団形成', 掲載 }], { companyName: 'A社' });
  assert.ok(mk('2日前').strength > mk('120日前').strength);
  assert.strictEqual(S.parsePostedDays('14日以上前'), 14);
  assert.strictEqual(S.parsePostedDays('新着'), 0);
});

// ============ ② 二次募集・秋採用 ============
t('②確定: 現行卒年の二次募集は strength=1', () => {
  const h = S.detectSecondaryRecruit({ text: '2027年3月卒業予定の方へ。二次募集を開始しました。', now: '2026-09-03', 検知日: TODAY });
  assert.strictEqual(h.strength, 1);
  assert.ok(/確定/.test(h.level));
});

t('②否定文は打ち消す（二次募集は行っておりません）', () => {
  const h = S.detectSecondaryRecruit({ text: '二次募集は行っておりません。', now: '2026-09-03' });
  assert.strictEqual(h, null);
});

t('②「応募受付を停止しています」も打ち消す', () => {
  const h = S.detectSecondaryRecruit({ text: '既卒可 現在、応募受付を停止しています。', now: '2026-09-03' });
  assert.strictEqual(h, null);
});

t('②留保表現（状況により検討します）は強度を半減して検討段階と明示', () => {
  const h = S.detectSecondaryRecruit({ text: '追加募集は状況により検討しますので、適宜ご確認ください。', now: '2026-09-03' });
  assert.ok(h);
  assert.ok(h.strength <= 0.5, '半減されるべき: ' + h.strength);
  assert.ok(/検討段階/.test(h.level));
});

t('②「既卒可」は掲載バッジとして弱く採る（第二新卒の記述より弱い）', () => {
  const badge = S.detectSecondaryRecruit({ text: '正社員 既卒可 業種 医療機関', now: '2026-09-03' });
  const med = S.detectSecondaryRecruit({ text: '第二新卒の方も歓迎しています', now: '2026-09-03' });
  assert.ok(/既卒可/.test(badge.level));
  assert.ok(badge.strength < med.strength, `${badge.strength} < ${med.strength}`);
});

t('②通年採用は定型文の可能性として弱く採る', () => {
  const h = S.detectSecondaryRecruit({ text: '当社は通年採用を実施しています。', now: '2026-09-03' });
  assert.strictEqual(h.strength, 0.35);
  assert.ok(/定型文/.test(h.level));
});

// ============ ③ 採用専用メール ============
t('③履歴なしなら「保有」まで（新設と言い切らない）', () => {
  const h = S.detectRecruitEmail({ emails: [{ email: 'saiyo@example.co.jp', ownDomain: true }], prevEmails: null });
  assert.ok(/保有/.test(h.level));
  assert.strictEqual(h.詳細.新設, false);
});

t('③前回に無いアドレスなら新設（strength=1）', () => {
  const h = S.detectRecruitEmail({ emails: [{ email: 'recruit@example.co.jp', ownDomain: true }], prevEmails: ['info@example.co.jp'] });
  assert.strictEqual(h.strength, 1);
  assert.strictEqual(h.詳細.新設, true);
});

t('③採用と無関係なアドレスは拾わない（chris@ が hr に語中一致しない）', () => {
  assert.strictEqual(S.isRecruitAddress('chris@example.com'), false);
  assert.strictEqual(S.isRecruitAddress('hr@example.com'), true);
  assert.strictEqual(S.isRecruitAddress('saiyo-info@example.com'), true);
  assert.strictEqual(S.detectRecruitEmail({ emails: ['info@example.com'] }), null);
});

// ============ ④ 採用予定数の前年比増 ============
t('④6名ラインをまたいだら確定（strength=1）', () => {
  const h = S.detectHirePlanIncrease({ series: '2026年8名/2025年4名/2024年3名' });
  assert.strictEqual(h.strength, 1);
  assert.strictEqual(h.詳細.ライン跨ぎ, true);
});

t('④減少・横ばいはシグナルにしない', () => {
  assert.strictEqual(S.detectHirePlanIncrease({ series: '2026年10名/2025年20名' }), null);
  assert.strictEqual(S.detectHirePlanIncrease({ series: '2026年10名/2025年10名' }), null);
});

t('④年系列が1年ぶんしかなければ予定人数の年差分に落ちる', () => {
  assert.strictEqual(S.detectHirePlanIncrease({ series: '2026年10名' }), null);
  const h = S.detectHirePlanIncrease({ series: '2026年10名', plan: 12, prevPlan: 8 });
  assert.ok(h && h.詳細.種別 === '採用予定人数');
});

t('④系列パースは年の重複を潰して降順にする', () => {
  const s = S.parseHireSeries('2024年3名/2026年8名/2025年4名/2026年99名');
  assert.deepStrictEqual(s.map((x) => x.年), [2026, 2025, 2024]);
  assert.strictEqual(s[0].人数, 8);
});

// ============ ⑤ 採用ページ ============
t('⑤前回URLなし→今回あり＝新設', () => {
  const h = S.detectRecruitPageChange({ cur: { url: 'https://a.jp/recruit/', hash: 'x', 長さ: 900 }, prev: { url: '', hash: '', 長さ: 0 } });
  assert.strictEqual(h.strength, 1);
  assert.ok(/新設/.test(h.level));
});

t('⑤本文量が15%以上変われば大幅刷新', () => {
  const h = S.detectRecruitPageChange({ cur: { url: 'https://a.jp/recruit/', hash: 'b', 長さ: 2000 }, prev: { url: 'https://a.jp/recruit/', hash: 'a', 長さ: 1000 } });
  assert.ok(/大幅刷新/.test(h.level));
});

t('⑤初回観測（履歴なし）は新設と言わない', () => {
  const h = S.detectRecruitPageChange({ cur: { url: 'https://a.jp/recruit/', hash: 'x', 長さ: 900 }, prev: null });
  assert.ok(h === null || !/新設/.test(h.level));
});

t('⑤媒体面の最終更新日が直近14日なら「いま触っている」', () => {
  const h = S.detectRecruitPageChange({ cur: { url: 'https://job.mynavi.jp/27/x', 更新日: '2026/8/29' }, prev: null, now: '2026-09-03' });
  assert.ok(h && /直近更新/.test(h.level));
  assert.strictEqual(S.daysSince('2026/8/29', new Date('2026-09-03')), 5);
});

// ============ ⑥ LINE ============
t('⑥前回「無」→今回「有」かつ採用用途＝新規取得で確定', () => {
  const h = S.detectLineRecruit({ line: { 判定: '有', 用途: '採用', ID: '@abc' }, prev: { 判定: '無' } });
  assert.strictEqual(h.strength, 1);
  assert.ok(/新規取得/.test(h.level));
});

t('⑥履歴なしの保有は中どまり', () => {
  const h = S.detectLineRecruit({ line: { 判定: '有', 用途: '採用' }, prev: null });
  assert.ok(h.strength < 1);
});

t('⑥LINE無しは検知しない', () => {
  assert.strictEqual(S.detectLineRecruit({ line: { 判定: '無' } }), null);
});

// ============ ⑦ インターン・合説 ============
t('⑦前回0件→今回ありなら新規開始（strength=1）', () => {
  const h = S.detectInternship({ text: '仕事体験を開催します', 件数: 2, prev: { 件数: 0 } });
  assert.strictEqual(h.strength, 1);
});

t('⑦0件なら検知しない（ナビ文言だけで立たない）', () => {
  assert.strictEqual(S.detectInternship({ text: 'インターンシップ＆キャリア', 件数: 0 }), null);
});

t('⑦合説は履歴がなければ弱く採る', () => {
  const h = S.detectExpo({ text: 'マイナビ主催合同説明会に出展します' });
  assert.ok(h && h.strength === 0.35);
  assert.ok(S.detectExpo({ text: '合同説明会に出展します', prev: { 出展: false } }).strength === 1);
});

// ============ スコアリング ============
t('スコア: 最強シグナル1本でA階層に届く', () => {
  const hits = [S.detectHrMidCareerJob([{ 企業名: 'A社', 職種: '人事・採用担当', 本文: '母集団形成と採用管理', 掲載: '1日前' }],
    { companyName: 'A社', 検知日: TODAY })];
  const r = scoreIntent(hits, { now: new Date(TODAY) });
  assert.strictEqual(r.階層, 'A');
  assert.ok(r.スコア >= 40, String(r.スコア));
  assert.ok(talkGuide(r).length > 20, '推奨トークが出る');
});

t('スコア: 古い検知は半減期で減衰する', () => {
  const h = S.detectSecondaryRecruit({ text: '二次募集を開始しました', now: '2026-09-03', 検知日: '2026-08-04' });
  const 新 = scoreIntent([{ ...h, 検知日: TODAY }], { now: new Date(TODAY) }).スコア;
  const 旧 = scoreIntent([h], { now: new Date(TODAY) }).スコア;
  assert.ok(旧 < 新 * 0.6, `30日で半減するはず: 新${新} 旧${旧}`);
  assert.ok(Math.abs(decayFactor(h, new Date(TODAY)) - 0.5) < 0.05);
});

t('スコア: シグナル0本はD階層', () => {
  const r = scoreIntent([], { now: new Date(TODAY) });
  assert.strictEqual(r.階層, 'D');
  assert.strictEqual(r.スコア, 0);
});

t('スコア: 層1（アポ期待度）との合成はタイミング寄り', () => {
  assert.strictEqual(combineWithFit(100, 0), 55);
  assert.strictEqual(combineWithFit(0, 100), 45);
});

// ============ 台帳（履歴） ============
t('台帳: 未検知シグナルは過去の検知日のまま持ち越し、期限切れで落ちる', () => {
  const now = new Date('2026-09-03');
  const prev = {
    SECONDARY_RECRUIT: { signal: 'SECONDARY_RECRUIT', 名称: '二次', 半減期日: 30, weight: 28, strength: 1, 最終検知日: '2026-08-25', 検知回数: 1 },
    INTERN_NEW: { signal: 'INTERN_NEW', 名称: 'IS', 半減期日: 60, weight: 10, strength: 1, 最終検知日: '2025-01-01', 検知回数: 1 },
  };
  const merged = mergeSignals(prev, [], { now });
  assert.ok(merged.SECONDARY_RECRUIT, '9日前の検知は生きている');
  assert.ok(!merged.INTERN_NEW, '1年以上前の検知は期限切れで落ちる');
  const hits = signalsToHits(merged);
  assert.strictEqual(hits[0].検知日, '2026-08-25');
});

t('台帳: 再検知で最終検知日が更新され回数が増える', () => {
  const now = new Date('2026-09-03');
  const prev = { SECONDARY_RECRUIT: { signal: 'SECONDARY_RECRUIT', 名称: '二次', 半減期日: 30, weight: 28, strength: 1, 最終検知日: '2026-08-25', 初回検知日: '2026-08-01', 検知回数: 1 } };
  const h = S.detectSecondaryRecruit({ text: '二次募集を開始しました', now, 検知日: TODAY });
  const merged = mergeSignals(prev, [h], { now });
  assert.strictEqual(merged.SECONDARY_RECRUIT.最終検知日, TODAY);
  assert.strictEqual(merged.SECONDARY_RECRUIT.初回検知日, '2026-08-01');
  assert.strictEqual(merged.SECONDARY_RECRUIT.検知回数, 2);
});

t('台帳: 指紋は空白差では動かない', () => {
  assert.strictEqual(fingerprint('採用  情報\nです'), fingerprint('採用 情報 です'));
  assert.notStrictEqual(fingerprint('採用情報'), fingerprint('採用情報2'));
});

// ============ 収集層の純ロジック ============
t('収集: 求人ボックスのカードから社名・職種・鮮度を取る', () => {
  const html = `<section class="p-result_card"><h2 class="p-result_title--ver2">
    <a href="/jb/abc" class="p-result_name">人事・採用担当</a></h2>
    <div class="p-result_companyName">株式会社サンプル</div>
    <div class="p-result_updatedAt_hyphen">6日前</div></section>`;
  const cards = parseJobCards(html, '求人ボックス');
  assert.strictEqual(cards.length, 1);
  assert.strictEqual(cards[0].企業名, '株式会社サンプル');
  assert.strictEqual(cards[0].職種, '人事・採用担当');
  assert.strictEqual(cards[0].掲載, '6日前');
});

t('収集: トップから採用ページのリンクを選ぶ（外部ドメインは選ばない）', () => {
  const html = `<a href="/company/">会社概要</a><a href="/recruit/newgrad/">新卒採用</a>
    <a href="https://other.example.com/recruit/">他社の採用</a>`;
  assert.strictEqual(pickRecruitLink(html, 'https://a.co.jp/'), 'https://a.co.jp/recruit/newgrad/');
});

t('収集: マイナビの卒年面とcorpIDをURLから復元', () => {
  const m = mynaviBase({ '採用ページURL': 'https://job.mynavi.jp/27/pc/search/corp71837/outline.html' }, { corpID: '' });
  assert.strictEqual(m.id, '71837');
  assert.strictEqual(m.gy, '27');
});

t('収集: 共通ナビ文言を落とす（タブだけでインターン検知しない）', () => {
  const t2 = stripMynaviChrome('会社概要\nインターンシップ＆キャリア\n説明会・セミナー\n本文');
  assert.ok(!t2.includes('インターンシップ＆キャリア'));
  assert.ok(t2.includes('本文'));
});

// ============ 束ね ============
t('detectAll: エビデンス一式から複数シグナルが立つ', () => {
  const ev = {
    企業名: '株式会社テスト',
    掲載本文: '2027年3月卒 追加募集を開始しました。',
    採用実績系列: '2026年9名/2025年4名',
    メール: [{ email: 'saiyo@test.co.jp', ownDomain: true }],
    インターン件数: 3,
    LINE: { 判定: '有', 用途: '採用', ID: '@test' },
    採用ページ: { url: 'https://test.co.jp/recruit/', hash: 'h', 長さ: 1000 },
  };
  const hits = S.detectAll(ev, null, { 検知日: TODAY, now: new Date(TODAY) });
  const ids = hits.map((h) => h.signal);
  assert.ok(ids.includes('SECONDARY_RECRUIT'));
  assert.ok(ids.includes('HIRE_PLAN_UP'));
  assert.ok(ids.includes('RECRUIT_EMAIL'));
  assert.ok(ids.includes('INTERN_NEW'));
  assert.ok(ids.includes('LINE_RECRUIT'));
  const r = scoreIntent(hits, { now: new Date(TODAY) });
  assert.ok(r.スコア > 40 && r.階層 === 'A', JSON.stringify(r.内訳));
  assert.ok(r.根拠.includes('追加募集'));
});

console.log(`\n合計: ${pass} pass / ${fail} fail`);
if (fail) process.exitCode = 1;
