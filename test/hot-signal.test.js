'use strict';
// 採用シグナル判定・採点・差分検出の単体テスト（ネットワーク/APIキー不要）。
//   node test/hot-signal.test.js
// 文面は PR TIMES の実リリース見出しの型を模したもの。asOf を固定して鮮度係数を再現可能にする。
const assert = require('assert');
const {
  detectSignals, detectDeltaSignals, scoreHotLead, talkOpener, rankOf, daysAgo,
} = require('../src/hot-signal');
const { applySnapshot, toInt, toHire, normalizeRow } = require('../src/signal-store');

let pass = 0;
function t(msg, fn) { try { fn(); pass++; console.log('  ✓', msg); } catch (e) { console.error('  ✗', msg, '\n    ', e.message); process.exitCode = 1; } }

const ASOF = '2026-09-08';
// 便利ラッパ：検出されたシグナルキーの配列
const keys = (o) => detectSignals({ asOf: ASOF, date: '2026-09-05', ...o }).signals.map((s) => s.key);

console.log('テキストシグナルの検出:');

t('新工場の建設を「新工場OPEN」と判定', () => {
  const k = keys({ title: '当社、埼玉県に新工場を建設', text: '生産拠点の新設に伴い稼働を開始します。', company: '株式会社テスト製作所' });
  assert.ok(k.includes('新工場OPEN'), k.join(','));
});

t('新工場が立ったら「新拠点開設」は数えない（同一事象の二重計上を防ぐ）', () => {
  const k = keys({ title: '新工場を建設、生産拠点を新設', text: '', company: '株式会社テスト' });
  assert.ok(k.includes('新工場OPEN'));
  assert.ok(!k.includes('新拠点開設'), '新拠点開設が吸収されていない: ' + k.join(','));
});

t('新店舗オープンを判定（文脈語つき）', () => {
  const k = keys({ title: '関西1号店を大阪にグランドオープン', text: '新規出店として展開します。', company: '株式会社テスト' });
  assert.ok(k.includes('新店舗OPEN'), k.join(','));
});

t('「旗艦店」だけで文脈語が無ければ新店舗OPENにしない', () => {
  const k = keys({ title: '旗艦店で新商品の取り扱いを始めました', text: '既存店舗での販売です。', company: '株式会社テスト' });
  assert.ok(!k.includes('新店舗OPEN'), k.join(','));
});

t('採用強化を「大量求人開始」と判定', () => {
  const k = keys({ title: '2027年卒の新卒採用を強化、50名の採用計画', text: '', company: '株式会社テスト' });
  assert.ok(k.includes('大量求人開始'), k.join(','));
});

t('M&A・事業承継を判定', () => {
  const k = keys({ title: '株式会社Aを完全子会社化、グループに参画', text: '', company: '株式会社テスト' });
  assert.ok(k.includes('M&A・事業承継'), k.join(','));
});

t('資金調達を判定（シリーズ表記・億円表記）', () => {
  assert.ok(keys({ title: 'シリーズBラウンドで5億円の資金調達を実施', company: '株式会社テスト' }).includes('資金調達'));
  assert.ok(keys({ title: '第三者割当増資を実施', company: '株式会社テスト' }).includes('資金調達'));
});

t('外国人採用（特定技能・育成就労）を判定', () => {
  assert.ok(keys({ title: '特定技能人材の受入を開始', company: '株式会社テスト' }).includes('外国人採用開始'));
});

t('採用担当者の募集を判定', () => {
  assert.ok(keys({ title: '採用担当を増員、人事チームを新設', company: '株式会社テスト' }).includes('採用担当者募集'));
});

t('ATS導入・採用DXを判定', () => {
  assert.ok(keys({ title: '採用管理システムを導入し採用DXを推進', company: '株式会社テスト' }).includes('ATS導入・採用DX'));
});

console.log('否定ガード（誤爆させない）:');

t('解説記事・ランキングのタイトルは落とす', () => {
  const r = detectSignals({ title: '新卒採用を強化する方法とは｜徹底解説', text: '採用強化のコツ', company: '株式会社メディア', asOf: ASOF });
  assert.strictEqual(r.signals.length, 0);
  assert.match(r.rejected, /guide-article/);
});

t('他社の導入事例紹介は落とす（主語が自社ではない）', () => {
  const r = detectSignals({ title: '【導入事例】A社の採用管理システム活用', text: '採用DXを推進', company: '株式会社ベンダー', asOf: ASOF });
  assert.strictEqual(r.signals.length, 0);
  assert.match(r.rejected, /third-party-case/);
});

t('自治体・学校の発信は企業リードにしない', () => {
  const r = detectSignals({ title: '新拠点を開設します', text: '', company: '○○市役所', asOf: ASOF });
  assert.strictEqual(r.signals.length, 0);
  assert.match(r.rejected, /not-company/);
});

t('社名では見分けられない自治体を業種で落とす（実例: 横須賀市の工場立地リリース）', () => {
  const r = detectSignals({ title: '【夏島町への新たな工場立地】拡張移転', text: '国内第二工場として横須賀工場を稼働します。', company: '横須賀市', industry: '官公庁・地方自治体', asOf: ASOF });
  assert.strictEqual(r.signals.length, 0);
  assert.match(r.rejected, /not-company/);
});

t('業種を連結せず個別に見る（「○○大学」＋業種があっても落とす）', () => {
  const r = detectSignals({ title: '新拠点を開設', company: '国際なんとか大学', industry: '教育', asOf: ASOF });
  assert.match(r.rejected, /not-company/);
});

t('海外の新工場は国内採用ニーズにしない（実例: タイ/グアテマラ工場）', () => {
  const r = detectSignals({ title: 'タイのアルミ新工場が竣工し、開所式を開催', text: '需要拡大を背景に生産能力を3倍に増強', company: '株式会社テスト', asOf: ASOF });
  assert.ok(!r.signals.some((s) => s.key === '新工場OPEN'), JSON.stringify(r.signals));
});

t('国内地名が同居していれば海外語があっても新工場OPENとして残す', () => {
  const r = detectSignals({ title: '中国向け輸出拡大を受け、佐賀県に新工場を建設', text: '', company: '株式会社テスト', asOf: ASOF });
  assert.ok(r.signals.some((s) => s.key === '新工場OPEN'), JSON.stringify(r.signals));
});

t('シグナル語が1つも無ければ no-signal', () => {
  const r = detectSignals({ title: '春の新商品を発売しました', text: '数量限定です。', company: '株式会社テスト', asOf: ASOF });
  assert.strictEqual(r.rejected, 'no-signal');
});

console.log('差分シグナル（スナップショット比較でしか出ないもの）:');

t('求人 3件→12件 を「求人急増」と判定', () => {
  const s = detectDeltaSignals({ jobs: 3, seen: true }, { jobs: 12 }, { asOf: ASOF });
  assert.ok(s.some((x) => x.key === '求人急増'), JSON.stringify(s));
});

t('求人 4件→6件（+50%）は「求人増加」どまり', () => {
  const s = detectDeltaSignals({ jobs: 4, seen: true }, { jobs: 6 }, { asOf: ASOF });
  assert.ok(s.some((x) => x.key === '求人増加'));
  assert.ok(!s.some((x) => x.key === '求人急増'));
});

t('求人 8件→9件（微増）はシグナルにしない', () => {
  const s = detectDeltaSignals({ jobs: 8, seen: true }, { jobs: 9 }, { asOf: ASOF });
  assert.strictEqual(s.filter((x) => /求人急増|求人増加/.test(x.key)).length, 0);
});

t('前回未観測なら「新規掲載開始」', () => {
  const s = detectDeltaSignals(null, { jobs: 5 }, { asOf: ASOF });
  assert.ok(s.some((x) => x.key === '新規掲載開始'));
});

t('初回観測から90日超で「求人長期掲載」（採れていない仮説）', () => {
  const s = detectDeltaSignals({ jobs: 5, seen: true }, { jobs: 5, firstSeen: '2026-05-01' }, { asOf: ASOF });
  const hit = s.find((x) => x.key === '求人長期掲載');
  assert.ok(hit, JSON.stringify(s));
  assert.match(hit.evidence, /130日間/);
});

t('掲載期間が短ければ長期掲載にしない', () => {
  const s = detectDeltaSignals({ jobs: 5, seen: true }, { jobs: 5, firstSeen: '2026-08-20' }, { asOf: ASOF });
  assert.ok(!s.some((x) => x.key === '求人長期掲載'));
});

t('採用予定人数の引き上げを検出', () => {
  const s = detectDeltaSignals({ hire: 5, jobs: 3, seen: true }, { hire: 15, jobs: 3 }, { asOf: ASOF });
  assert.ok(s.some((x) => x.key === '採用人数増'));
});

console.log('採点（HOT SCORE）:');

t('熱度5×鮮度高×ICP適合はSランク', () => {
  const sigs = detectSignals({ title: '新工場を建設、100名の採用計画', company: '株式会社テスト', date: '2026-09-05', asOf: ASOF }).signals;
  const sc = scoreHotLead({ signals: sigs, emp: 400, hire: 10, industry: '製造業', phone: '03-1234-5678', contactName: '山田 太郎' });
  assert.strictEqual(sc.rank, 'S', `score=${sc.score}`);
});

t('同じシグナルでも古ければランクが落ちる（鮮度係数）', () => {
  const mk = (date) => scoreHotLead({
    signals: detectSignals({ title: '新工場を建設', company: '株式会社テスト', date, asOf: ASOF }).signals,
    emp: 400, hire: 10, industry: '製造業',
  }).score;
  assert.ok(mk('2026-09-05') > mk('2026-01-05'), '古いシグナルの方が高得点になっている');
});

t('IT業種は減点される（ICPの絶対除外を採点にも反映）', () => {
  const sigs = detectSignals({ title: '新拠点を開設', company: '株式会社テスト', date: '2026-09-05', asOf: ASOF }).signals;
  const it = scoreHotLead({ signals: sigs, emp: 400, industry: 'ソフトウェア' }).score;
  const mfg = scoreHotLead({ signals: sigs, emp: 400, industry: '製造業' }).score;
  assert.ok(it < mfg, `IT=${it} 製造=${mfg}`);
});

t('規模フロア未満（従業員100名未満）は減点される', () => {
  const sigs = detectSignals({ title: '新拠点を開設', company: '株式会社テスト', date: '2026-09-05', asOf: ASOF }).signals;
  assert.ok(scoreHotLead({ signals: sigs, emp: 30 }).score < scoreHotLead({ signals: sigs, emp: 400 }).score);
});

t('従業員数が不明なとき、合同会社は規模の代理指標で減点される', () => {
  const sigs = detectSignals({ title: '新店舗をオープン、採用を強化', company: 'テスト合同会社', date: '2026-09-05', asOf: ASOF }).signals;
  const godo = scoreHotLead({ signals: sigs, company: 'テスト合同会社' }).score;
  const kk = scoreHotLead({ signals: sigs, company: '株式会社テスト' }).score;
  assert.ok(godo < kk, `合同=${godo} 株式=${kk}`);
});

t('従業員数が判明していれば法人格の代理指標は使わない（実測値を優先）', () => {
  const sigs = detectSignals({ title: '新店舗をオープン', company: 'テスト合同会社', date: '2026-09-05', asOf: ASOF }).signals;
  const sc = scoreHotLead({ signals: sigs, company: 'テスト合同会社', emp: 400 });
  assert.ok(sc.reasons.some((r) => /主戦場/.test(r)));
  assert.ok(!sc.reasons.some((r) => /合同\/有限会社/.test(r)));
});

t('シグナルを並べても逓減で満点にはならない', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ key: 'k' + i, heat: 5, issue: '', days: 0 }));
  assert.ok(scoreHotLead({ signals: many }).score <= 100);
});

t('シグナル0件なら0点・Cランク', () => {
  const sc = scoreHotLead({ signals: [] });
  assert.strictEqual(sc.score, 0);
  assert.strictEqual(sc.rank, 'C');
});

t('ランク境界（80=S / 65=A / 50=B / 49=C）', () => {
  assert.strictEqual(rankOf(80), 'S');
  assert.strictEqual(rankOf(79), 'A');
  assert.strictEqual(rankOf(65), 'A');
  assert.strictEqual(rankOf(64), 'B');
  assert.strictEqual(rankOf(50), 'B');
  assert.strictEqual(rankOf(49), 'C');
});

console.log('トーク生成:');

t('長期掲載は「歩留まりに課題では」という採用課題営業の入り方になる', () => {
  const sig = detectDeltaSignals({ jobs: 3, seen: true }, { jobs: 3, firstSeen: '2026-05-01' }, { asOf: ASOF })
    .find((s) => s.key === '求人長期掲載');
  const talk = talkOpener(sig, '株式会社テスト');
  assert.match(talk, /株式会社テスト様/);
  assert.match(talk, /歩留まり/);
});

t('社名が切り出しトークに差し込まれる', () => {
  assert.match(talkOpener({ key: '資金調達' }, '株式会社サンプル'), /株式会社サンプル様の資金調達/);
});

t('未知のシグナルには空文字を返す（例外にしない）', () => {
  assert.strictEqual(talkOpener({ key: '存在しない' }, '株式会社テスト'), '');
  assert.strictEqual(talkOpener(null, '株式会社テスト'), '');
});

console.log('日付ユーティリティ:');

t('和暦以外の各表記から経過日数を出す', () => {
  assert.strictEqual(daysAgo('2026-09-01', ASOF), 7);
  assert.strictEqual(daysAgo('2026/9/1', ASOF), 7);
  assert.strictEqual(daysAgo('2026年9月1日 10:00', ASOF), 7);
  assert.strictEqual(daysAgo('', ASOF), null);
  assert.strictEqual(daysAgo('日付不明', ASOF), null);
});

console.log('signal-store（時系列台帳）:');

t('2日分を取り込むと求人急増が出る', () => {
  const store = { version: 1, updated: '', companies: {} };
  const d1 = applySnapshot(store, [{ 企業名: '株式会社テスト', 求人数: '3' }], { date: '2026-09-01', source: 'mynavi' });
  assert.ok([...d1.values()].some((v) => v.signals.some((s) => s.key === '新規掲載開始')), '初日は新規掲載開始');
  const d2 = applySnapshot(store, [{ 企業名: '株式会社テスト', 求人数: '12' }], { date: '2026-09-08', source: 'mynavi' });
  assert.ok([...d2.values()].some((v) => v.signals.some((s) => s.key === '求人急増')), '2日目は求人急増');
});

t('同日に同じ企業が2行来ても二重に数えない', () => {
  const store = { version: 1, updated: '', companies: {} };
  applySnapshot(store, [{ 企業名: '株式会社テスト', 求人数: '3' }], { date: '2026-09-01' });
  const d = applySnapshot(store, [
    { 企業名: '株式会社テスト', 求人数: '12' },
    { 企業名: '株式会社テスト', 求人数: '12' },
  ], { date: '2026-09-08' });
  const c = store.companies[Object.keys(store.companies)[0]];
  assert.strictEqual(c.jobs, 12, '同日重複行で求人数が合算されている');
  assert.strictEqual(c.history.filter((h) => h.date === '2026-09-08').length, 1, '履歴が1日2点になっている');
  assert.strictEqual(d.size, 1);
});

t('掲載が消えて復活したら掲載期間を数え直す', () => {
  const store = { version: 1, updated: '', companies: {} };
  applySnapshot(store, [{ 企業名: '株式会社テスト', 求人数: '3' }], { date: '2026-05-01' });
  applySnapshot(store, [{ 企業名: '別会社', 求人数: '1' }], { date: '2026-08-01' });   // テスト社は非掲載
  applySnapshot(store, [{ 企業名: '株式会社テスト', 求人数: '3' }], { date: '2026-09-08' });
  const c = Object.values(store.companies).find((x) => x.name === '株式会社テスト');
  assert.strictEqual(c.firstSeen, '2026-09-08', `firstSeen=${c.firstSeen}（古い掲載開始日を引きずっている）`);
});

console.log('数値パース（実データの表記ゆれ）:');

t('採用人数のレンジは下限を採る（「11～15名」→11）', () => {
  assert.strictEqual(toHire('11～15名'), 11);
  assert.strictEqual(toHire('6～10名'), 6);
});

t('複数コースの採用人数は下限の合計（「31～35名 / 16～20名」→47）', () => {
  assert.strictEqual(toHire('31～35名 / 16～20名'), 47);
});

t('採用人数を数字連結しない（1115 のような値を作らない）', () => {
  assert.notStrictEqual(toHire('11～15名'), 1115);
  assert.strictEqual(toHire(''), null);
  assert.strictEqual(toHire('若干名'), null);
});

t('従業員数は最初の数値を採る（後続の年月を巻き込まない）', () => {
  assert.strictEqual(toInt('550'), 550);
  assert.strictEqual(toInt('1,234名'), 1234);
  assert.strictEqual(toInt('約120名(2026年4月現在)'), 120);
  assert.strictEqual(toInt(''), null);
});

t('マイナビ合説CSVの列名をそのまま読める', () => {
  const r = normalizeRow({ 企業名: '株式会社北里', 電話番号: '03-0000-0000', 採用人数: '6～10名', 従業員数: '87', 担当者名: '採用担当', 業種: '医療', 都道府県: '東京都' });
  assert.strictEqual(r.hire, 6);
  assert.strictEqual(r.emp, 87);
  assert.strictEqual(r.name, '株式会社北里');
  assert.ok(r.key);
});

console.log(`\n${pass}件のテストが通りました。`);
