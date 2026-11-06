'use strict';
/**
 * 全ソース共通パイプライン（src/sources/*）のテスト ── ネットワーク不要
 * =====================================================================
 * 登録簿の健全性 / 観測の正規化 / 業種の寄せ / アダプタの純ロジック（介護・健康経営・女性活躍）/
 * 名寄せ / ゲート・段階判定・スコアカード を検証する。
 */
const fs = require('fs');
const path = require('path');
const reg = require('../src/sources/registry');
const { normalize } = require('../src/sources/observation');
const { mapIndustry } = require('../src/sources/industry-map');
const { resolveCompanies } = require('../src/sources/resolve');
const { runPipeline, scorecard, pilotSample, stageOf } = require('../src/sources/pipeline');
const kaigo = require('../src/sources/adapters/kaigo-kouhyou');
const kenko = require('../src/sources/adapters/kenko-keiei');
const josei = require('../src/sources/adapters/josei-katsuyaku');
const { createMatchIndex } = require('../src/company-match');
const tos = require('../src/sources/media-tos');
const disc = require('../src/sources/media-discover');
const mx = require('../src/sources/media-extract');
const mreg = require('../src/sources/media-registry');

let pass = 0, fail = 0;
const fails = [];
function ok(label, cond) { if (cond) { pass++; } else { fail++; fails.push(label); console.log(`  ✗ ${label}`); } }
function eq(label, a, b) { ok(`${label}  (${JSON.stringify(a)} === ${JSON.stringify(b)})`, a === b); }

// ── 1) 登録簿 ─────────────────────────────────────────────
console.log('\n[1] 登録簿');
const ids = new Set();
for (const s of reg.list()) {
  ok(`${s.id}: 登録内容に不備なし ${reg.problemsOf(s).join(',')}`, reg.problemsOf(s).length === 0);
  ok(`${s.id}: id が重複しない`, !ids.has(s.id));
  ids.add(s.id);
  if (s.adapter) ok(`${s.id}: アダプタのファイルがある`, fs.existsSync(path.join(__dirname, '..', 'src', 'sources', 'adapters', `${s.adapter}.js`)));
}
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
ok('T3 は収集を拒否', throws(() => reg.assertRunnable(reg.get('indeed'))));
ok('アダプタ未実装は収集を拒否', throws(() => reg.assertRunnable(reg.get('hellowork'))));
ok('T1・規約確認済み・アダプタありは収集可', !throws(() => reg.assertRunnable(reg.get('kaigo-kouhyou'))));
ok('アダプタがあるのに規約確認日が空なら不備', reg.problemsOf({ id: 'x', legal_tier: 'T2', adapter: 'x', reliability: 1 }).length > 0);
ok('登録簿に無いIDは例外', throws(() => reg.get('no-such-source')));

// ── 2) 観測の正規化 ───────────────────────────────────────
console.log('\n[2] 観測の正規化');
let n = normalize({ company_name: ' 株式会社　テスト ', corp_no: '1234-5678-90123', employees: '1,200名', sites: 12, evidence_url: 'https://e' }, 'src', '2026-11-05');
ok('正常な観測は ok', n.ok);
eq('社名の空白を詰める', n.obs.company_name, '株式会社 テスト');
eq('法人番号を13桁に', n.obs.corp_no, '1234567890123');
eq('従業員数「1,200名」→1200', n.obs.employees, 1200);
eq('数値はそのまま', n.obs.sites, 12);
eq('数でない値は null', normalize({ company_name: 'a', evidence_url: 'e', hire_newgrad: '若干名' }, 's', 'd').obs.hire_newgrad, null);
n = normalize({ company_name: 'a' }, 's', 'd');
ok('出典URLが無い観測は不備', !n.ok && n.errors.some((e) => /evidence_url/.test(e)));
ok('社名が無い観測は不備', !normalize({ evidence_url: 'e' }, 's', 'd').ok);

// ── 3) 業種の寄せ ─────────────────────────────────────────
console.log('\n[3] 業種の寄せ');
eq('情報通信業 → IT除外ラベル', mapIndustry('情報通信業'), 'ソフトウェア・情報通信');
eq('情報・通信業（東証33業種）→ IT除外ラベル', mapIndustry('情報・通信業'), 'ソフトウェア・情報通信');
eq('医療，福祉 → 介護', mapIndustry('医療，福祉'), '介護・保育・医療法人等');
eq('福祉 → 介護', mapIndustry('福祉'), '介護・保育・医療法人等');
eq('小売業 → 流通小売', mapIndustry('小売業'), '流通・小売・物販');
eq('卸売業，小売業 → 流通小売', mapIndustry('卸売業，小売業'), '流通・小売・物販');
eq('保険業 → 金融', mapIndustry('保険業'), '金融・保険');
eq('その他金融業 → 金融', mapIndustry('その他金融業'), '金融・保険');
eq('陸運業 → 運輸', mapIndustry('陸運業'), '運輸・交通・物流・倉庫');
eq('製造業は寄せない（原文のまま）', mapIndustry('製造業'), '製造業');
eq('医療法人の括りは社名が医療法人なら介護', mapIndustry('医療法人、社会福祉法人、健康保険組合等保険者', '医療法人社団 青葉会'), '介護・保育・医療法人等');
eq('同じ括りでも健康保険組合は寄せない', mapIndustry('医療法人、社会福祉法人、健康保険組合等保険者', '○○健康保険組合'), '医療法人、社会福祉法人、健康保険組合等保険者');
eq('空は空', mapIndustry(''), '');
ok('情報通信の寄せ先は IT除外に当たる', require('../src/icp-rules').isExcludedIndustry(mapIndustry('情報通信業')));

// ── 4) 介護アダプタ ───────────────────────────────────────
console.log('\n[4] 介護アダプタ');
const html = `
  <a href="/content/12300000/jigyosho_110_all_20260709180319.csv">110</a>
  <a href="/content/12300000/jigyosho_150_all_20260709180445.csv">150</a>
  <a href="/content/12300000/jigyosho_110_all_20260115100000.csv">110 old</a>
  <a href="/content/12300000/jigyosho_110.csv">legacy</a>`;
const links = kaigo.pickLatestLinks(html);
eq('最新の出力回だけを選ぶ（2本）', links.length, 2);
ok('古い回を混ぜない', links.every((l) => l.ts.startsWith('20260709')));
ok('絶対URLにする', links[0].url.startsWith('https://www.mhlw.go.jp/content/'));
const office = (o) => Object.assign({ 法人の名称: '社会福祉法人 さくら会', 法人番号: '', 都道府県名: '北海道', 市区町村名: '札幌市', サービスの種類: '訪問介護', URL: 'https://sakura.example', 定員: '' }, o);
const folded = kaigo.foldByOperator([
  office({ 事業所番号: '1', 事業所名: 'さくら訪問', 電話番号: '011-111-1111' }),
  office({ 事業所番号: '2', 事業所名: 'さくら会 法人本部', 電話番号: '011-222-2222', サービスの種類: '通所介護', 定員: '30' }),
  office({ 事業所番号: '2', 事業所名: 'さくら会 法人本部', 電話番号: '011-222-2222', サービスの種類: '居宅介護支援' }),
  office({ 事業所番号: '3', 事業所名: 'さくら青森', 電話番号: '017-333-3333', 都道府県名: '青森県' }),
  office({ 法人の名称: '', 事業所番号: '9' }),
  office({ 法人の名称: '株式会社ひまわり', 法人番号: '1234567890123', 事業所番号: '7', 電話番号: '03-0000-0000', 都道府県名: '東京都' }),
], 'https://csv');
eq('法人単位に畳む（法人名なしの行は捨てる）', folded.length, 2);
const sakura = folded.find((o) => /さくら/.test(o.company_name));
eq('拠点数=事業所番号のユニーク数', sakura.sites, 3);
eq('最多の都道府県', sakura.pref, '北海道');
eq('電話は本部を名乗る事業所を優先', sakura.phone, '011-222-2222');
eq('電話の種別を付帯情報に残す', sakura.extra.電話の種別, '事業所');
eq('業種は介護の勝ち筋ラベル', sakura.industry, '介護・保育・医療法人等');
eq('定員を合計', sakura.extra.定員合計, 30);
eq('法人番号を拾う', folded.find((o) => /ひまわり/.test(o.company_name)).corp_no, '1234567890123');

// ── 5) 健康経営アダプタ ───────────────────────────────────
console.log('\n[5] 健康経営アダプタ');
const kl = kenko.pickLatestLinks('<a href="https://kenko-keiei.jp/u/nintei2026_daikibo20260512.xlsx"></a><a href="https://kenko-keiei.jp/u/nintei2026_daikibo20260309.xlsx"></a><a href="https://kenko-keiei.jp/u/nintei2026_chusho20260512.xlsx"></a>');
eq('部門ごとに1本', kl.length, 2);
ok('同じ部門は新しい日付を選ぶ', kl.find((l) => l.kind === 'daikibo').url.endsWith('20260512.xlsx'));
// ExcelJS の行は穴あき配列
const sparse = (arr) => { const a = []; arr.forEach((v, i) => { if (v !== undefined) a[i] = v; }); return a; };
const sheet = [
  sparse([undefined, '健康経営優良法人2026 認定法人一覧']),
  sparse(['No.', '認定法人名', '法人番号', '加入保険者', '都道府県', '市区町村', '業種']),
  sparse([1, '株式会社サンプル物産', 1234567890123, '協会けんぽ', '大阪府', '大阪市', '小売業']),
  sparse(['No.', '認定法人名', '法人番号', '加入保険者', '都道府県', '市区町村', '業種']),
  sparse([2, '株式会社サンプル製作所', 2234567890123, '協会けんぽ', '愛知県', '名古屋市', '製造業']),
  sparse([3, '', '', '', '', '', '']),
];
const kr = kenko.rowsOfSheet(sheet, 'daikibo', 'ホワイト500', 'https://x');
eq('繰り返しの見出し行を会社として読まない', kr.length, 2);
eq('小売業の大規模部門は51名以上', kr[0].employees_min, 51);
eq('製造業の大規模部門は301名以上', kr[1].employees_min, 301);
eq('中小規模部門は下限を置かない', kenko.rowsOfSheet(sheet, 'chusho', 's', 'u')[0].employees_min, null);
eq('業種を寄せる', kr[0].industry, '流通・小売・物販');
eq('サービス業の大規模部門は101名以上', kenko.minEmployeesForLarge('サービス業（他に分類されないもの）'), 101);

// ── 6) 女性活躍アダプタ（列の自動判定）────────────────────
console.log('\n[6] 女性活躍アダプタ');
const col = josei.detectColumns(['企業名', '法人番号', '都道府県', '業種', '常時雇用する労働者の数', '女性労働者の割合', '新卒採用者に占める女性の割合', '採用した労働者に占める女性労働者の割合']);
eq('社名列', col.name, '企業名');
eq('労働者数（割合の列は拾わない）', col.employees, '常時雇用する労働者の数');
eq('新卒採用人数と読める列が無ければ空', col.hire, '');
eq('採用を含む列は付帯情報用に全部拾う', col.hireCols.length, 2);
eq('新卒採用人数の列があれば拾う', josei.detectColumns(['会社名', '新卒採用者数']).hire, '新卒採用者数');

// ── 7) 名寄せ ─────────────────────────────────────────────
console.log('\n[7] 名寄せ');
const ob = (o) => Object.assign({ evidence_url: 'https://e/' + o.source_id, extra: {}, signal: null }, o);
const companies = resolveCompanies([
  ob({ source_id: 'kaigo-kouhyou', company_name: '社会福祉法人 さくら会', phone: '011-222-2222', sites: 12, industry: '介護・保育・医療法人等' }),
  ob({ source_id: 'kenko-keiei', company_name: '社会福祉法人さくら会', corp_no: '9999999999999', industry: '介護・保育・医療法人等', industry_raw: '福祉', pref: '北海道' }),
  ob({ source_id: 'kenko-keiei', company_name: '株式会社エー', corp_no: '1111111111111' }),
  ob({ source_id: 'josei-katsuyaku', company_name: 'エー株式会社', corp_no: '1111111111111', employees: 450 }),
], { reliabilityOf: (id) => ({ 'kenko-keiei': 1, 'kaigo-kouhyou': 1, 'josei-katsuyaku': 0.9 }[id]) });
eq('社名の表記ゆれと法人番号で2社に畳む', companies.length, 2);
const s2 = companies.find((c) => /さくら/.test(c.company_name));
eq('両ソースを持つ', s2.sources.length, 2);
eq('法人番号は後から来たソースでも埋まる', s2.corp_no, '9999999999999');
eq('電話の出典を残す', s2.src.phone, 'kaigo-kouhyou');
eq('業種(原文)の出典を残す', s2.src.industry_raw, 'kenko-keiei');
const a = companies.find((c) => c.corp_no === '1111111111111');
eq('法人番号一致で社名が違っても合流', a.sources.length, 2);
eq('従業員数は josei から', a.employees, 450);
const homonyms = resolveCompanies([
  ob({ source_id: 'kaigo-kouhyou', company_name: '有限会社さくら', corp_no: '2222222222222', pref: '北海道' }),
  ob({ source_id: 'kaigo-kouhyou', company_name: '有限会社さくら', corp_no: '3333333333333', pref: '沖縄県' }),
  ob({ source_id: 'kenko-keiei', company_name: '有限会社さくら', corp_no: '3333333333333', industry: '介護・保育・医療法人等' }),
]);
eq('同名でも法人番号が違えば別会社', homonyms.length, 2);
eq('法人番号で正しい方に合流', homonyms.find((c) => c.corp_no === '3333333333333').sources.length, 2);
eq('もう一方には合流しない', homonyms.find((c) => c.corp_no === '2222222222222').sources.length, 1);

// ── 8) ゲート・段階・スコアカード ──────────────────────────
console.log('\n[8] ゲート・段階・スコアカード');
const idx = createMatchIndex();
idx.addName('株式会社既存顧客', 'MOCHICA顧客');
idx.addName('株式会社カワデン', 'BALES既存');
const exclusion = { idx };
const poolIdx = createMatchIndex();
poolIdx.addName('株式会社未納品', '既存母集団');
poolIdx.addName('株式会社かわでん', '既存母集団');
const pool = { idx: poolIdx };
const C = (o) => Object.assign({ sources: ['t'], evidence: ['https://e'], extra: {}, src: {}, signals: [] }, o);
const cs = [
  C({ company_name: '株式会社既存顧客', phone: '03-1', employees: 300 }),
  C({ company_name: '株式会社未納品', phone: '03-2', employees: 300 }),
  C({ company_name: '札幌市', phone: '011-1' }),
  C({ company_name: '株式会社ソフト', industry: 'ソフトウェア・情報通信', employees: 300 }),
  C({ company_name: '株式会社小規模', employees: 30 }),
  C({ company_name: '株式会社不明', industry: '製造業' }),
  C({ company_name: '株式会社推定', employees_min: 301 }),
  C({ company_name: '社会福祉法人 拠点会', sites: 12, phone: '011-9' }),
  C({ company_name: '株式会社名指し', employees: 400, hire_newgrad: 8, phone: '03-3', recruiter_name: '山田 太郎', industry: '流通・小売・物販' }),
  C({ company_name: '株式会社採用少', employees: 400, hire_newgrad: 2, phone: '03-4', recruiter_name: '佐藤 花子' }),
  C({ company_name: '株式会社かわでん', phone: '03-5', employees: 300 }),
  C({ company_name: '有限会社おなじ', corp_no: '4444444444444', phone: '03-6', employees: 300 }),
  C({ company_name: '有限会社おなじ', corp_no: '5555555555555', phone: '03-7', employees: 120 }),
];
const res = runPipeline(cs, { exclusion, pool, date: '2026-11-05' });
const reason = (name) => (res.excluded.find((e) => e.c.company_name === name) || {}).row?.除外理由;
const stage = (name) => (res.kept.find((k) => k.c.company_name === name) || {}).c?.stage;
eq('既存顧客は除外', reason('株式会社既存顧客'), '既存');
eq('既存母集団は除外しない', stage('株式会社未納品'), 'L2');
ok('既存母集団の印が付く', res.kept.find((k) => k.c.company_name === '株式会社未納品').row.既存母集団 === '1');
eq('官公庁は除外', reason('札幌市'), '官公庁');
eq('ITは除外', reason('株式会社ソフト'), 'IT/ソフト');
eq('従業員100名未満と判明は除外', reason('株式会社小規模'), 'ICPフロア未満');
eq('採用2名と判明は除外', reason('株式会社採用少'), 'ICPフロア未満');
eq('規模の裏付けが無ければ L0', stage('株式会社不明'), 'L0');
eq('下限推定301名・電話なしは L1', stage('株式会社推定'), 'L1');
eq('拠点12・電話ありは L2', stage('社会福祉法人 拠点会'), 'L2');
eq('担当者名・電話・新卒8名は L3', stage('株式会社名指し'), 'L3');
eq('段階の高い順に並ぶ', res.kept[0].c.company_name, '株式会社名指し');
ok('採点が付く', typeof res.kept[0].row.アポ期待度 === 'number');
eq('母集団に社名一致していてもマスタに表記ゆれ一致なら除外', reason('株式会社かわでん'), '既存');
eq('同名の別法人は1社だけ残す', res.kept.filter((k) => k.c.company_name === '有限会社おなじ').length, 1);
eq('残すのは上位（従業員の多い方ではなく並び順の上）', res.kept.find((k) => k.c.company_name === '有限会社おなじ').c.corp_no, res.kept.filter((k) => k.c.company_name === '有限会社おなじ')[0].c.corp_no);
ok('落とした同名は除外明細に理由つきで残る', res.excluded.some((e) => e.row.除外理由 === '同名の別法人'));
const fresh = runPipeline(cs.map((c) => Object.assign({}, c)), { exclusion, pool, freshOnly: true });
ok('--fresh-only は既存母集団も落とす', fresh.excluded.some((e) => e.row.除外理由 === '既存母集団(未納品)'));
eq('拠点数の閾値は変えられる', stageOf(C({ company_name: 'x', sites: 5, phone: '1' }), { minSites: 5 }).stage, 'L2');
const card = scorecard(res, ['t'])[0];
eq('スコアカード: 社数', card.社数, 13);
eq('スコアカード: 既存除外', card.除外.既存, 2);
eq('スコアカード: 同名の別法人', card.除外.同名の別法人, 1);
eq('スコアカード: 新規率（既存2・既存母集団1を除く）', card.新規率, 76.9);
eq('スコアカード: L3', card.段階.L3, 1);
eq('パイロット抽出は再現可能', pilotSample(cs, 3).map((c) => c.company_name).join(), pilotSample(cs, 3).map((c) => c.company_name).join());
eq('パイロット抽出の件数', pilotSample(cs, 3).length, 3);

// ── 9) 新卒媒体: 利用規約の一次判定 ─────────────────────────
console.log('\n[9] 媒体の利用規約');
const kinds = (t) => tos.scanTerms(t).map((h) => h.kind);
ok('スクレイピング禁止を検出', kinds('当サイトに対するスクレイピング等の行為を禁止します。').includes('automated'));
ok('自動的な手段での取得の禁止を検出', kinds('ロボット等の自動的な手段により情報を取得することはできません。').includes('automated'));
ok('営業目的の利用の禁止を検出', kinds('掲載情報を営業目的で利用することを禁止します。').includes('commercial'));
ok('箇条書きの禁止行為（項目に「禁止」の語なし）を検出',
  kinds('禁止事項 当サイトの利用にあたっては、以下行為を禁止します。 詐欺行為 当サイトに掲載される情報を、商用目的に利用する行為').includes('commercial'));
ok('「個人使用（非商用）のみ」を商用利用の禁止として検出', kinds('当サイトのコンテンツは、個人使用（非商用）のみに限りご利用いただけるものとします。').includes('commercial'));
eq('禁止の無い文は拾わない', kinds('当サイトへのリンクは自由です。広告の掲載をご希望の方はお問い合わせください。').length, 0);
const tl = tos.findTermsLinks('<a href="/sitepolicy/index.html">マイナビサイトポリシー</a><a href="/privacy/">プライバシーポリシー</a><a href="/kiyaku">利用規約</a>', 'https://x.example/');
ok('サイトポリシーを規約として拾う', tl.includes('https://x.example/sitepolicy/index.html'));
ok('利用規約を拾う', tl.includes('https://x.example/kiyaku'));
ok('プライバシーポリシーは規約にしない', !tl.includes('https://x.example/privacy/'));

// ── 10) 新卒媒体: 企業詳細の型の学習 ───────────────────────
console.log('\n[10] 媒体の巡回設定');
eq('型: 数字IDを伏せる', disc.templateOf('https://m.example/company/12345/'), '/company/:id/');
eq('型: クエリは値を伏せる', disc.templateOf('https://m.example/detail.php?id=9&p=2'), '/detail.php?id&p');
eq('型: 卒年と企業IDを伏せる', disc.templateOf('https://job.mynavi.jp/27/pc/search/corp12345/outline.html'), '/:id/pc/search/:id/outline.html');
ok('型の正規表現が同じ型に当たる', disc.matchesDetail('https://m.example/company/999/', disc.templateToRegex('/company/:id/')));
ok('型の正規表現が別の型に当たらない', !disc.matchesDetail('https://m.example/company/999/jobs/', disc.templateToRegex('/company/:id/')));
ok('クエリ型はキーで判定', disc.matchesDetail('https://m.example/detail.php?p=1&id=3', disc.templateToRegex('/detail.php?id&p')));
ok('ID部分は検索クエリに当たらない（/recruit/?kinmu_id=… は /recruit/:id ではない）', !disc.matchesDetail('https://m.example/recruit/?kinmu_id=&gyosyu_id=g08', disc.templateToRegex('/recruit/:id')));
const L = (p, text) => ({ url: 'https://m.example' + p, text });
const learned = disc.learnDetailPattern([
  L('/interview/1/', '株式会社A 先輩の声'), L('/interview/2/', '株式会社B 先輩の声'), L('/interview/3/', '株式会社C 先輩の声'), L('/interview/4/', '株式会社D 先輩の声'),
  L('/company/11/', '株式会社A'), L('/company/12/', '株式会社B'), L('/company/13/', '株式会社C'),
  L('/about/', '株式会社メディア運営'), L('/news/1/', 'お知らせ'),
]);
eq('企業ページらしい型を、先輩紹介の型より優先', learned && learned.template, '/company/:id/');
eq('社名アンカーが3件未満の型は採らない', disc.learnDetailPattern([L('/company/1/', '株式会社A'), L('/company/2/', '株式会社B')]), null);
const smUrls = [...Array(30)].map((_, i) => `https://m.example/campus/company/baseinfo/${i}/`)
  .concat([...Array(40)].map((_, i) => `https://m.example/column/${i}/`));
eq('サイトマップ: 企業らしい型を先頭に', disc.rankSitemapTemplates(smUrls, { minCount: 20 })[0].template, '/campus/company/baseinfo/:id/');
const smi = disc.parseSitemap('<sitemapindex><sitemap><loc>https://m.example/s1.xml</loc></sitemap></sitemapindex>');
ok('サイトマップ索引を見分ける', smi.isIndex && smi.locs[0] === 'https://m.example/s1.xml');
eq('CDATA と &amp; を戻す', disc.parseSitemap('<urlset><url><loc><![CDATA[https://m.example/d?a=1&amp;b=2]]></loc></url></urlset>').locs[0], 'https://m.example/d?a=1&b=2');
eq('内部リンクだけを拾う', disc.internalLinks('<a href="/company/1/">株式会社A</a><a href="https://other.example/">外部</a><a href="/login">ログイン</a>', 'https://m.example/').length, 1);

// ── 11) 新卒媒体: 企業詳細からの抽出 ───────────────────────
console.log('\n[11] 媒体の企業詳細の抽出');
eq('社名: 先輩紹介の飾りを剥がす', mx.cleanCompanyName('中尾 一輝さん 株式会社財宝 就職するなら地元鹿児島で。'), '株式会社財宝');
eq('社名: 接尾の株式会社を残す', mx.cleanCompanyName('山二システムサービス株式会社60分でシステム開発会社をサクッと理解'), '山二システムサービス株式会社');
eq('社名: 二重の社名を1つに', mx.cleanCompanyName('株式会社ウイズ・ワン株式会社ウイズ・ワン Web会社説明会'), '株式会社ウイズ・ワン');
eq('社名: 「の新卒採用・就活情報」を落とす', mx.cleanCompanyName('株式会社ブロンコビリーの新卒採用・就活情報'), '株式会社ブロンコビリー');
eq('社名: 「の長期インターンに参加」を落とす', mx.cleanCompanyName('株式会社南国ソフトの長期インターンに参加'), '株式会社南国ソフト');
eq('社名: 媒体名の区切りを落とす', mx.cleanCompanyName('トヨタ自動車株式会社の会社概要 | マイナビ2027'), 'トヨタ自動車株式会社');
eq('社名: （株）を株式会社に', mx.cleanCompanyName('（株）サンプル | 採用情報'), '株式会社サンプル');
eq('社名: 法人格が無ければ空', mx.cleanCompanyName('マイナビ2027 | 新卒採用'), '');
const page = `<html><head><title>株式会社サンプル物流の会社概要 | テスト就活ナビ</title></head><body>
  <h1>株式会社サンプル物流</h1>
  <dl><dt>本社所在地</dt><dd>福岡県福岡市博多区1-2-3</dd><dt>従業員数</dt><dd>420名</dd><dt>業種</dt><dd>陸運業</dd>
  <dt>募集人数</dt><dd>8〜12名</dd><dt>電話番号</dt><dd>092-123-4567</dd></dl>
  <p>採用担当 人事部 山田 太郎</p>
  <a href="https://www.sample-butsuryu.co.jp/">企業ホームページ</a><a href="https://twitter.com/x">X</a></body></html>`;
const d = mx.extractDetail(page, 'https://navi.example/company/1/', { mediaName: 'テスト就活ナビ' });
eq('詳細: 社名', d.company_name, '株式会社サンプル物流');
eq('詳細: 従業員数', String(d.employees), '420');
eq('詳細: 募集人数の範囲は下限', d.hire_newgrad, 8);
eq('詳細: 本社の都道府県', d.pref, '福岡県');
eq('詳細: 公式サイト（SNSは拾わない）', d.url, 'https://www.sample-butsuryu.co.jp/');
eq('詳細: 業種を寄せる', d.industry, '運輸・交通・物流・倉庫');
eq('詳細: 電話', d.phone, '092-123-4567');
eq('詳細: 掲載媒体を付帯情報に', d.extra.掲載媒体, 'テスト就活ナビ');
eq('詳細: 社名が取れないページは捨てる', mx.extractDetail('<title>特集 | ナビ</title><h1>就活の始め方</h1>', 'https://navi.example/f/1'), null);
const obsM = [...Array(10)].map((_, i) => ({ phone: i < 6 ? '0120-000-000' : `03-000${i}-0000`, extra: {} }));
eq('媒体側の代表番号（多くのページに同じ番号）を落とす', mx.dropMediaPhones(obsM).join(), '0120-000-000');
ok('落とした番号は付帯情報に残す', obsM[0].phone === '' && obsM[0].extra.媒体側の番号として除外 === '0120-000-000');
ok('個社の番号は残す', obsM[9].phone === '03-0009-0000');

// ── 12) 新卒媒体: 登録簿への合流 ───────────────────────────
console.log('\n[12] 媒体の登録簿');
eq('ID はホスト名から', mreg.idOf('https://www.kagojob.jp/', new Set()), 'm-kagojob-jp');
eq('同じホストはパスの先頭を足す', mreg.idOf('https://www.jobkita.jp/shukatsu/', new Set(['m-jobkita-jp'])), 'm-jobkita-jp-shukatsu');
ok('IT特化は静的に除外', /IT除外/.test(mreg.staticExclusion({ url: 'https://x', cat: '3-IT特化' })));
ok('URL未確定は静的に除外', /URL未確定/.test(mreg.staticExclusion({ url: '', cat: '1-大手総合' })));
eq('active の媒体はアダプタつき', mreg.toEntry({ id: 'm-x', name: 'x', cat: '2-地方特化', status: 'active', legal_tier: 'T2', tos_checked_at: '2026-11-05' }).adapter, 'media');
eq('T3 の媒体はアダプタなし', mreg.toEntry({ id: 'm-y', name: 'y', cat: '1-大手総合', status: 'active', legal_tier: 'T3', tos_checked_at: '2026-11-05' }).adapter, null);
eq('人の判断（tos_override）が自動判定より優先', mreg.toEntry({ id: 'm-z', name: 'z', cat: '1', status: 'active', legal_tier: 'T2', tos_checked_at: 'd', tos_override: { legal_tier: 'T3' } }).legal_tier, 'T3');
eq('地方特化は ICP ◎', mreg.toEntry({ id: 'm-w', name: 'w', cat: '2-地方特化', status: 'planned' }).icp_prior, '◎');
ok('登録簿に媒体が合流している', reg.list().some((s) => s.media));

console.log(`\n結果: ${pass} 件成功 / ${fail} 件失敗`);
if (fail) { console.log(fails.map((f) => '  - ' + f).join('\n')); process.exit(1); }
