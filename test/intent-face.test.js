'use strict';
/**
 * 卒年面パーサ（mynavi-face.js）と卒年面シグナル（face-signals.js）の検証。
 * 実ページで踏んだ誤りをそのまま固定する:
 *   - タブのナビ列（募集コース／募集対象／採用フロー）を本文と取り違えて全社コース1になる
 *   - 「諸手当」で区間が切れて初任給の金額に届かない
 *   - 「26～30名」を連結して2630名にする
 */
const assert = require('assert');
const mf = require('../src/intent/mynavi-face');
const { detectFaceSignals, crossYearHeadcount, FACE_SIGNALS } = require('../src/intent/face-signals');

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ✔ ' + name); } catch (e) { console.error('  ✘ ' + name); throw e; } };
const NOW = new Date('2026-09-15T00:00:00Z');
const D = '2026-09-15';

// 実ページ（job.mynavi.jp/28/pc/search/corp58978/）の並びを縮めたもの
const FACE_TEXT = [
  '最終更新日：2026/9/13',
  '募集コース', '募集対象', '採用フロー', '採用後の待遇',       // ← タブのナビ列（本文ではない）
  '募集コース', 'コース名', '受託開発なし', '技術派遣なし',
  '営業職（カーライフアドバイザー）・整備職（テクニカルスタッフ）',
  '福利厚生や社内制度も充実。安心して、長く働ける環境です。',    // ← 共通stopsの語が説明文に出る
  '雇用形態', '正社員', '配属職種', '営業職（カーライフアドバイザー）',
  '配属職種2', '整備職（テクニカルスタッフ）',
  '募集人数 26～30名',
  '募集要項・採用フロー',
  'エントリー方法・採用フロー',
  'マイナビよりエントリー', '会社説明会', '対面にて実施',
  '適性検査', '受検方法', 'WEB受検', '筆記試験', '受験方法', '紙受験',
  '面接（グループ）', '開催回数', ' 1回実施予定', '実施場所', '対面',
  '面接（個別）', '開催回数', ' 1回実施予定', '実施場所', '対面',
  '内々定',
  '採用後の待遇',
  '初任給 （2025年04月実績） 対象 支給額 基本月額 諸手当（一律）／月 大卒・院了 （月給） 228,000円',
  '昇給 年1回（4月）',
].join('\n');

t('ナビ列ではなく本文の募集コースを読み、配属職種の枠数で数える', () => {
  const c = mf.parseCourses(FACE_TEXT);
  assert.strictEqual(c.コース数, 2);
  assert.strictEqual(c.根拠, '配属職種の枠数');
});

t('「諸手当」で切らずに初任給の金額まで届く', () => {
  assert.strictEqual(mf.parseStartingPay(FACE_TEXT).大卒月額, 228000);
});

t('範囲の募集人数は連結せず下限・上限を保つ', () => {
  const h = mf.parseHeadcount(FACE_TEXT);
  assert.deepStrictEqual([h.下限, h.上限], [26, 30]);
  assert.strictEqual(mf.headcountValue(h), 26); // 比較は下限（上振れ表記で増加を作らない）
  assert.strictEqual(mf.parseHeadcount('募集人数 若干名').下限, 1);
  assert.strictEqual(mf.parseHeadcount('募集人数 未定'), null);
});

t('選考フローは段と面接回数を分けて数える', () => {
  const f = mf.parseFlow(FACE_TEXT);
  assert.strictEqual(f.面接回数, 2);            // 「1回実施予定」×2
  assert.ok(f.選考段数 >= 4, '説明会・適性検査・筆記・面接で4段');
  assert.ok(!f.段.includes('内々定') || f.選考段数 < f.段.length);
});

t('「複数回実施予定」は回数無記載でも2回として数える', () => {
  const f = mf.parseFlow('エントリー方法・採用フロー\n面接（個別）\n開催回数\n 複数回実施予定\n内々定');
  assert.strictEqual(f.面接回数, 2);
});

t('マイナビ経由だけなら手作業応募は立たない', () => {
  const e = mf.parseEntryRoutes(FACE_TEXT);
  assert.deepStrictEqual(e.手作業, []);
  assert.strictEqual(e.媒体経由, true);
  assert.strictEqual(detectFaceSignals({ 卒年面: { 28: mf.parseFace(FACE_TEXT, { 卒年: '28' }) } }, { now: NOW, 検知日: D })
    .some(h => h.signal === 'MANUAL_ENTRY'), false);
});

t('メール・郵送での応募受付は手作業動線として確定で立つ', () => {
  const text = FACE_TEXT.replace('マイナビよりエントリー',
    'マイナビよりエントリー\n履歴書を郵送にて提出\n詳細はメールにてご応募ください');
  const routes = mf.parseEntryRoutes(text);
  assert.ok(routes.手作業.includes('メール') && routes.手作業.includes('郵送'));
  const h = detectFaceSignals({ 卒年面: { 28: mf.parseFace(text, { 卒年: '28' }) } }, { now: NOW, 検知日: D })
    .find(x => x.signal === 'MANUAL_ENTRY');
  assert.strictEqual(h.strength, 1);
  assert.ok(/郵送|メール/.test(h.根拠));
});

// ---- 卒年面どうしの差（履歴ゼロでも前年比が言える）----
const face = (o) => ({ 卒年: String(o.gy), url: `https://job.mynavi.jp/${o.gy}/x/`, 更新日: o.更新日 || '',
  募集人数: o.人数 != null ? { 下限: o.人数, 上限: o.人数, 表記: `${o.人数}名`, 確度: '強' } : null,
  選考フロー: o.flow || null, エントリー: o.entry || null,
  募集コース: o.コース ? { コース数: o.コース, 根拠: '配属職種の枠数', 引用: '' } : null,
  初任給: o.給 ? { 大卒月額: o.給, 実績年: '2025', 引用: '' } : null, 本文長: 5000 });

t('募集人数の前年比は観測台帳ゼロでも2面から出せる', () => {
  const ev = { 卒年面: { 27: face({ gy: 27, 人数: 4 }), 28: face({ gy: 28, 人数: 9 }) } };
  const c = crossYearHeadcount(ev);
  assert.deepStrictEqual([c.prevPlan, c.plan], [4, 9]);
  assert.strictEqual(c.前年, 27);
  assert.strictEqual(c.卒年, 28);
  assert.strictEqual(crossYearHeadcount({ 卒年面: { 28: face({ gy: 28, 人数: 9 }) } }), null, '1面だけなら前年比は言わない');
});

t('次年度面を現行面より新しく更新していれば始動として立つ', () => {
  const ev = { 卒年面: { 27: face({ gy: 27, 更新日: '2026/4/1' }), 28: face({ gy: 28, 更新日: '2026/9/13' }) } };
  const h = detectFaceSignals(ev, { now: NOW, 検知日: D }).find(x => x.signal === 'NEXT_FACE_LIVE');
  assert.strictEqual(h.strength, 1);
  assert.strictEqual(h.詳細.次年度, 28);
  // 次年度面が古いまま＝まだ動いていない
  const 静 = { 卒年面: { 27: face({ gy: 27, 更新日: '2026/9/13' }), 28: face({ gy: 28, 更新日: '2026/2/4' }) } };
  assert.strictEqual(detectFaceSignals(静, { now: NOW, 検知日: D }).some(x => x.signal === 'NEXT_FACE_LIVE'), false);
});

t('両面が同時期の更新なら「次年度面始動」は立たない（掲載面更新の二度数えを防ぐ）', () => {
  // 実測200社で4割が「次年度面を直近更新」に該当した。S5（掲載面を直近更新）と
  // 同じ事実なので、現行面より明確に新しい場合だけを採る。
  const ev = { 卒年面: { 27: face({ gy: 27, 更新日: '2026/9/13' }), 28: face({ gy: 28, 更新日: '2026/9/13' }) } };
  assert.strictEqual(detectFaceSignals(ev, { now: NOW, 検知日: D }).some(x => x.signal === 'NEXT_FACE_LIVE'), false);
  // 現行面が取れない（片面だけ）なら比較できないので立てない
  const 片面 = { 卒年面: { 28: face({ gy: 28, 更新日: '2026/9/13' }) } };
  assert.strictEqual(detectFaceSignals(片面, { now: NOW, 検知日: D }).some(x => x.signal === 'NEXT_FACE_LIVE'), false);
});

t('初任給は台帳の前回額と比べ、上がった時だけ立つ', () => {
  // 初任給欄は「前年4月実績」で、マイナビは次年度面にも同じ額を載せる（実測19社で差ゼロ）。
  // 卒年面どうしでは検知できないため、比較相手は前回観測（台帳）。
  const ev = { 卒年面: { 28: face({ gy: 28, 給: 240000 }) } };
  const h = detectFaceSignals(ev, { now: NOW, 検知日: D, prev: { 卒年面: { 28: { 初任給: 220000 } } } })
    .find(x => x.signal === 'PAY_RAISE');
  assert.strictEqual(h.詳細.差分, 20000);
  assert.strictEqual(h.strength, 1);
  // 履歴なし＝初回観測では立たない（S3/S5/S6 と同じ「要履歴」型）
  assert.strictEqual(detectFaceSignals(ev, { now: NOW, 検知日: D }).some(x => x.signal === 'PAY_RAISE'), false);
  // 据え置き・引き下げでは立たない
  for (const 前 of [240000, 260000]) {
    assert.strictEqual(detectFaceSignals(ev, { now: NOW, 検知日: D, prev: { 卒年面: { 28: { 初任給: 前 } } } })
      .some(x => x.signal === 'PAY_RAISE'), false);
  }
  // 卒年がずれていれば（実績年が違う）比べない
  assert.strictEqual(detectFaceSignals(ev, { now: NOW, 検知日: D, prev: { 卒年面: { 27: { 初任給: 200000 } } } })
    .some(x => x.signal === 'PAY_RAISE'), false);
});

t('選考の多段化は最頻の4段では立たず、5段以上か面接3回以上でのみ立つ', () => {
  const flow = (段数, 面接) => ({ 段: ['会社説明会', 'エントリーシート', '適性検査', '筆記試験', '面接'].slice(0, 段数), 選考段数: 段数, 面接回数: 面接, オンライン: false, 引用: '' });
  const light = { 卒年面: { 28: face({ gy: 28, flow: flow(2, 1) }) } };
  assert.strictEqual(detectFaceSignals(light, { now: NOW, 検知日: D }).some(x => x.signal === 'SELECTION_LOAD'), false);
  // 4段は実測200社の最頻値（56社）。最頻値では順位が作れないので採らない。
  const mode = { 卒年面: { 28: face({ gy: 28, flow: flow(4, 2) }) } };
  assert.strictEqual(detectFaceSignals(mode, { now: NOW, 検知日: D }).some(x => x.signal === 'SELECTION_LOAD'), false);
  const heavy = { 卒年面: { 28: face({ gy: 28, flow: { 段: ['会社説明会', 'エントリーシート', '適性検査', '筆記試験', '面接'], 選考段数: 5, 面接回数: 3, オンライン: true, 引用: '' } }) } };
  const h = detectFaceSignals(heavy, { now: NOW, 検知日: D }).find(x => x.signal === 'SELECTION_LOAD');
  assert.strictEqual(h.strength, 1);
});

t('コース複線は3本以上、増えていれば確定', () => {
  assert.strictEqual(detectFaceSignals({ 卒年面: { 28: face({ gy: 28, コース: 2 }) } }, { now: NOW, 検知日: D })
    .some(x => x.signal === 'COURSE_MULTI'), false);
  const ev = { 卒年面: { 27: face({ gy: 27, コース: 3 }), 28: face({ gy: 28, コース: 5 }) } };
  const h = detectFaceSignals(ev, { now: NOW, 検知日: D }).find(x => x.signal === 'COURSE_MULTI');
  assert.strictEqual(h.詳細.増分, 2);
  assert.strictEqual(h.strength, 1);
});

t('卒年面が無ければ追加5軸は一切立たない（未検知と欠測を混同しない）', () => {
  assert.deepStrictEqual(detectFaceSignals({}, { now: NOW, 検知日: D }), []);
  assert.deepStrictEqual(detectFaceSignals({ 卒年面: {} }, { now: NOW, 検知日: D }), []);
});

t('数え方を変えた履歴とは比べない（インターンが一斉に「新規開始」に化けない）', () => {
  // is.html の数え方を .box02カセット → プログラム見出し に直した時、旧ルールで
  // 0件と記録された3,202社が全部「インターンを新規開始」に化けるところだった。
  const store = require('../src/intent/store');
  const { detectInternship } = require('../src/intent/signals');
  const st = { version: 1, companies: {
    旧: { 企業名: '旧ルール', インターン: { 件数: 0 }, シグナル: {} },
    新: { 企業名: '新ルール', インターン: { 件数: 0, 版: 2 }, シグナル: {} },
  } };
  // 旧ルールの記録は「履歴なし」扱い → 弱（新規かは履歴待ち）
  assert.strictEqual(store.prevOf(st, '旧').インターン, null);
  const 旧 = detectInternship({ text: 'インターンシップ', 件数: 2, prev: store.prevOf(st, '旧').インターン, 検知日: D });
  assert.ok(/履歴待ち/.test(旧.level), '旧ルールの0件を根拠に「新規開始」と言わない');
  // 同じルールで0件だった社は、本当に新規開始として立てて良い
  const 新 = detectInternship({ text: 'インターンシップ', 件数: 2, prev: store.prevOf(st, '新').インターン, 検知日: D });
  assert.ok(/新規開始/.test(新.level));
});

t('台帳→prevOf→detectAll の一巡で、次サイクルに初任給引上げが立つ', () => {
  // S20 は初回0件が正しい仕様なので、「次サイクルで本当に立つ」ことまで固定しておかないと
  // 死んだ軸を載せていても気づけない。
  const store = require('../src/intent/store');
  const { detectAll } = require('../src/intent/signals');
  const 面 = (額) => ({ 卒年: '28', url: 'https://job.mynavi.jp/28/x/', 更新日: '2026/9/1',
    募集人数: null, 選考フロー: null, エントリー: null, 募集コース: null,
    初任給: { 大卒月額: 額, 実績年: '2025' }, 本文長: 5000 });
  const state = { version: 1, companies: {} };
  const ev1 = { 企業名: '検証社', 卒年面: { 28: 面(220000) }, メール: [], 取得ソース: [], エラー: [] };
  store.record(state, 'N:検証社', ev1, [], { now: new Date('2026-08-01') });
  // 台帳は本文を持たず構造値だけを残す
  assert.strictEqual(state.companies['N:検証社'].卒年面['28'].初任給, 220000);
  assert.ok(!('引用' in state.companies['N:検証社'].卒年面['28']));

  const ev2 = { ...ev1, 卒年面: { 28: 面(240000) } };
  const hit = detectAll(ev2, store.prevOf(state, 'N:検証社'), { 検知日: D, now: NOW })
    .find(h => h.signal === 'PAY_RAISE');
  assert.ok(hit, '次サイクルでは立つ');
  assert.strictEqual(hit.詳細.差分, 20000);
  // 初回（台帳に無い社）では立たない
  assert.strictEqual(detectAll(ev2, store.prevOf({ companies: {} }, 'N:未観測'), { 検知日: D, now: NOW })
    .some(h => h.signal === 'PAY_RAISE'), false);
});

t('A階層への単独昇格は最上位の重みの「確定」だけ（他の軸では昇格しない）', () => {
  // 軸を増やしてA閾値を40→48.4に上げた結果、最強シグナル(重み40)が単独でAに
  // 届かなくなった。設計の約束を昇格条件として明示的に戻してある。
  // ただし“確定なら何でも昇格”にすると閾値を上げた意味が消えるので、最上位の重みに限る。
  const { scoreIntent, TOP_WEIGHT, TIERS } = require('../src/intent/score');
  const mk = (signal, weight, level, 半減期日 = 45) => ([{ signal, 名称: 'x', 列: 'S1_人事中途求人',
    weight, 半減期日, level, strength: 1, 根拠: 'x', 詳細: {}, 検知日: D }]);
  assert.strictEqual(TOP_WEIGHT, 40);
  assert.ok(TIERS[0].min > TOP_WEIGHT, 'A閾値は最大重みより上（だから昇格条件が要る）');

  const 最強確定 = scoreIntent(mk('MIDCAREER_HR_JOB', 40, '確定(採用オペ文言あり)'), { now: NOW });
  assert.strictEqual(最強確定.階層, 'A');

  // 同じ最強シグナルでも「確定」でなければ昇格しない
  assert.notStrictEqual(scoreIntent(mk('MIDCAREER_HR_JOB', 40, '中(人事ロールの中途求人)'), { now: NOW }).階層, 'A');
  // 重みが下の軸は「確定」でも昇格しない
  assert.notStrictEqual(scoreIntent(mk('SECONDARY_RECRUIT', 28, '確定(二次・追加募集)'), { now: NOW }).階層, 'A');
  // 古くて減衰した最強シグナルでも昇格しない
  const 古い = [{ signal: 'MIDCAREER_HR_JOB', 名称: 'x', 列: 'S1_人事中途求人', weight: 40, 半減期日: 45,
    level: '確定(採用オペ文言あり)', strength: 1, 根拠: 'x', 詳細: {}, 検知日: '2026-06-01' }];
  assert.notStrictEqual(scoreIntent(古い, { now: NOW }).階層, 'A');
});

t('卒年面5軸は列・重み・半減期が一意で、他系統と衝突しない', () => {
  // 軸の総数は系統を足すたびに増える（21軸→29軸: 昨年度の失敗4軸＋資金4軸を追加）。
  // ここで見たいのは「face群の5軸が他とぶつかっていないこと」なので、総数は
  // SIGNAL_LIST から取って、一意性だけを固定する。
  const { SIGNAL_LIST } = require('../src/intent/signals');
  const ids = Object.keys(FACE_SIGNALS);
  const n = SIGNAL_LIST.length;
  assert.strictEqual(ids.length, 5);
  assert.ok(n >= 21, '軸数=' + n);
  assert.strictEqual(new Set(SIGNAL_LIST.map(s => s.列)).size, n);
  assert.strictEqual(new Set(SIGNAL_LIST.map(s => s.順位)).size, n);
  for (const id of ids) assert.ok(FACE_SIGNALS[id].weight > 0 && FACE_SIGNALS[id].半減期日 > 0);
});

console.log('卒年面シグナル: ' + pass + ' pass');
