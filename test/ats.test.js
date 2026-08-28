'use strict';
/**
 * ATS判定（src/ats.js）のテスト
 * =====================================================================
 * 押さえるべき点:
 *   1) 実例URL（career-cloud.asia → 採用一括かんりくん、axol → AOL、hrmos → HARMOS）
 *   2) サブドメイン一致は可・部分文字列一致は不可（career-cloud.asia.evil.com を誤検知しない）
 *   3) 自社ドメインにフォームを埋め込む構成（iframe/script）をHTMLから拾えること
 *   4) 種別の優先（ATS > フォーム > 媒体）。媒体リンクが同居してもATSを主判定にする
 *   5) 汎用フォーム/媒体のみ＝ATS未導入シグナルとして営業メモに出ること
 */
const assert = require('assert');
const { detectAts, detectAtsByUrl, detectAtsByHtml, hostMatches, salesHint, registry } = require('../src/ats');

let pass = 0, fail = 0;
const fails = [];
function ok(label, cond) { if (cond) pass++; else { fail++; fails.push(label); console.log(`  ✗ ${label}`); } }
function eq(label, a, b) { ok(`${label}  (${JSON.stringify(a)} === ${JSON.stringify(b)})`, a === b); }

// ── 1) 実例URL ────────────────────────────────────────────────────────
console.log('\n[1] エントリーURLからのベンダー判定');
const kanrikun = detectAts('https://www.career-cloud.asia/27/form/entry?id=16849397703997');
eq('career-cloud.asia → 採用一括かんりくん', kanrikun.name, '採用一括かんりくん');
eq('  ベンダーはHRクラウド', kanrikun.vendor, 'HRクラウド株式会社');
eq('  種別はATS', kanrikun.kind, 'ats');
ok('  確度は0.9以上', kanrikun.confidence >= 0.9);
eq('axol.jp → AOL', detectAts('https://job.axol.jp/27/s/example/entry').id, 'aol');
eq('mail.axol.jp も同じ（サブドメイン一致）', detectAts('https://mail.axol.jp/x').id, 'aol');
eq('hrmos.co → HRMOS採用', detectAts('https://hrmos.co/pages/example/jobs/1234').id, 'hrmos');
eq('sonar-ats.jp → sonar ATS', detectAts('https://example.sonar-ats.jp/entry').id, 'sonar');
eq('i-web.jp → i-web', detectAts('https://job.i-web.jp/example/').id, 'iweb');
eq('ats.jobcan.jp → ジョブカン採用管理', detectAts('https://ats.jobcan.jp/entry/xxx').id, 'jobcan');
eq('mochica.jp → MOCHICA（自社）', detectAts('https://mochica.jp/entry/abc').id, 'mochica');
ok('  自社フラグが立つ', detectAts('https://mochica.jp/entry/abc').own === true);
eq('スキーム省略URLも判定できる', detectAts('career-cloud.asia/27/form/entry').id, 'kanrikun');
eq('大文字ホストも判定できる', detectAts('HTTPS://JOB.AXOL.JP/27/s/x').id, 'aol');

// ── 2) 誤検知防止 ─────────────────────────────────────────────────────
console.log('\n[2] 誤検知の防止');
ok('部分文字列では一致しない', detectAtsByUrl('https://career-cloud.asia.evil.com/x') === null);
ok('似た別ドメインは一致しない', detectAtsByUrl('https://notcareer-cloud.asia/x') === null);
ok('hostMatches: 完全一致', hostMatches('axol.jp', 'axol.jp'));
ok('hostMatches: サブドメイン', hostMatches('job.axol.jp', 'axol.jp'));
ok('hostMatches: 接尾辞だけの偽物は弾く', !hostMatches('myaxol.jp', 'axol.jp'));
ok('hostMatches: 前方一致の偽物は弾く', !hostMatches('axol.jp.evil.com', 'axol.jp'));
ok('空URLは判定不能', detectAts('').found === false);
ok('非URL文字列は判定不能', detectAts('担当者に確認').found === false);
ok('未登録の自社ドメインは判定不能（URLのみでは）', detectAts('https://example.co.jp/recruit/entry/').found === false);

// ── 3) 埋め込み（自社ドメイン内にATSフォーム） ─────────────────────────
console.log('\n[3] HTML埋め込みからの判定');
const embedHtml = '<html><body><h1>エントリー</h1>' +
  '<iframe src="https://example.sonar-ats.jp/form/abc"></iframe></body></html>';
const embed = detectAts('https://example.co.jp/recruit/entry/', { html: embedHtml });
eq('iframe埋め込みのsonarを検出', embed.id, 'sonar');
eq('  根拠は埋め込み', embed.source, 'embed');
ok('  確度はURL一致より低い', embed.confidence < 0.95 && embed.confidence >= 0.7);
const scriptHtml = '<script src="//career-cloud.asia/js/form.js"></script>';
eq('プロトコル相対のscriptも拾う', detectAts('https://example.co.jp/', { html: scriptHtml }).id, 'kanrikun');
const actionHtml = '<form action="https://job.axol.jp/27/s/x/entry" method="post"></form>';
eq('form actionからも拾う', detectAts('https://example.co.jp/', { html: actionHtml }).id, 'aol');
ok('自ホストへの参照は無視', detectAtsByHtml('<a href="https://example.co.jp/a">a</a>', 'https://example.co.jp/').length === 0);
ok('相対URLは埋め込み判定に使わない', detectAtsByHtml('<iframe src="/form/entry"></iframe>', 'https://example.co.jp/').length === 0);
const markerHtml = '<div class="wpcf7 wpcf7-form"><input name="your-name"></div>';
eq('マーカー（Contact Form 7）を拾う', detectAts('https://example.co.jp/entry/', { html: markerHtml }).id, 'wpcf7');
ok('  マーカーの確度は埋め込みより低い', detectAts('https://example.co.jp/entry/', { html: markerHtml }).confidence < 0.85);

// ── 4) リダイレクト・優先順位 ─────────────────────────────────────────
console.log('\n[4] リダイレクトと優先順位');
const redir = detectAts('https://example.co.jp/entry', { finalUrl: 'https://job.axol.jp/28/s/x/entry' });
eq('リダイレクト先で判定', redir.id, 'aol');
eq('  根拠はredirect', redir.source, 'redirect');
const mixed = detectAts('https://example.co.jp/recruit/', {
  html: '<iframe src="https://example.sonar-ats.jp/f/1"></iframe><a href="https://job.mynavi.jp/27/pc/">マイナビ</a>',
});
eq('ATSが媒体より優先される', mixed.id, 'sonar');
ok('  媒体は併用として残る', mixed.others.some((o) => o.id === 'mynavi'));
const mediaOnly = detectAts('https://job.rikunabi.com/2027/company/r1234/');
eq('リクナビは媒体として判定', mediaOnly.kind, 'media');
const formOnly = detectAts('https://docs.google.com/forms/d/e/xxxx/viewform');
eq('Googleフォームは汎用フォーム', formOnly.id, 'google-forms');
ok('docs.google.com でもフォーム以外のパスは不一致', detectAtsByUrl('https://docs.google.com/spreadsheets/d/x') === null);

// ── 5) 営業メモ ───────────────────────────────────────────────────────
console.log('\n[5] 営業メモ（リスト運用で使う一言）');
ok('競合ATSはリプレイス提案', /リプレイス/.test(salesHint(detectAts('https://example.sonar-ats.jp/e'))));
ok('自社は既存顧客', /既存顧客/.test(salesHint(detectAts('https://mochica.jp/e'))));
ok('汎用フォームは新規導入提案', /新規導入/.test(salesHint(detectAts('https://form.run/@example'))));
ok('媒体のみはATS未導入の可能性', /未導入/.test(salesHint(detectAts('https://job.rikunabi.com/2027/company/r1/'))));
ok('判定不能は要目視', /目視/.test(salesHint(detectAts('https://example.co.jp/'))));

// ── 6) 定義の健全性 ───────────────────────────────────────────────────
console.log('\n[6] ベンダー定義の健全性');
const reg = registry();
const ids = new Set();
let dupId = '', badKind = '';
for (const v of reg) {
  if (ids.has(v.id)) dupId = v.id;
  ids.add(v.id);
  if (!['ats', 'media', 'form', 'sns'].includes(v.kind)) badKind = `${v.id}:${v.kind}`;
}
eq('IDに重複が無い', dupId, '');
eq('種別が想定内', badKind, '');
ok('主要ベンダーが揃っている',
  ['kanrikun', 'aol', 'hrmos', 'iweb', 'sonar', 'jobcan', 'mochica'].every((id) => ids.has(id)));
// 1ホストが複数ベンダーに割り当てられていないか（判定が非決定になるため）
const hostOwner = new Map();
let dupHost = '';
for (const v of reg) for (const h of v.hosts || []) {
  if (hostOwner.has(h) && hostOwner.get(h) !== v.id) dupHost = `${h}: ${hostOwner.get(h)} vs ${v.id}`;
  hostOwner.set(h, v.id);
}
eq('ホストの重複割当が無い', dupHost, '');

// ── 7) CLI側の純関数（列自動検出・出力列） ────────────────────────────
console.log('\n[7] CLI（enrich-ats）の列まわり');
const { pickUrlColumn, toColumns, OUT_COLS } = require('../src/enrich-ats');
eq('候補名の列を優先', pickUrlColumn(['企業名', 'URL', 'エントリーURL'], []), 'エントリーURL');
eq('候補が無ければURLを含む列', pickUrlColumn(['企業名', '応募ページのURL'], []), '応募ページのURL');
eq('名前で分からなければ値で探す', pickUrlColumn(['企業名', 'リンク'], [{ 企業名: 'A', リンク: 'https://x.jp/' }]), 'リンク');
eq('URLらしき列が無ければ空', pickUrlColumn(['企業名', '電話番号'], [{ 企業名: 'A', 電話番号: '03-1234-5678' }]), '');
const cols = toColumns(detectAts('https://job.axol.jp/27/s/x/entry'), '2026-08-28');
eq('出力列: ATS名', cols.ATS, 'アクセスオンライン（AOL/AOLC）');
eq('出力列: 確度は小数2桁', cols.ATS確度, '0.95');
eq('出力列: 判定日', cols.ATS判定日, '2026-08-28');
ok('出力列は OUT_COLS と一致', OUT_COLS.every((c) => c in cols) && Object.keys(cols).length === OUT_COLS.length);
const miss = toColumns({ found: false, others: [], error: 'robots-disallow' }, '2026-08-28');
eq('取得失敗は根拠列に残る', miss.ATS根拠, '取得失敗:robots-disallow');
eq('  ATS名は空のまま', miss.ATS, '');

// ── 8) CRM表記の名寄せ（ツール別リストの土台） ────────────────────────
// BALESの「カスタム情報：利用中ATS」は自由入力。ここが割れるとツール別リストが分裂する。
console.log('\n[8] CRM表記の名寄せ（normalizeAtsName）');
const { normalizeAtsName } = require('../src/ats');
eq('sonarATS → sonar ATS', normalizeAtsName('sonarATS').name, 'sonar ATS');
eq('SONAR も同じツールに寄る', normalizeAtsName('SONAR').id, normalizeAtsName('sonarATS').id);
eq('管理くん → 採用一括かんりくん', normalizeAtsName('管理くん').name, '採用一括かんりくん');
eq('  採用一括かんりくんと同一', normalizeAtsName('採用一括かんりくん').id, normalizeAtsName('管理くん').id);
eq('管理君（漢字）も同一', normalizeAtsName('管理君').id, 'kanrikun');
eq('AOL → アクセスオンライン', normalizeAtsName('AOL').id, 'aol');
eq('i-web と iweb は同一', normalizeAtsName('i-web').id, normalizeAtsName('iweb').id);
eq('HARMOS表記もHRMOSへ', normalizeAtsName('HARMOS').id, 'hrmos');
eq('キャリタスコンタクト → キャリタスContact', normalizeAtsName('キャリタスコンタクト').name, 'キャリタスContact');
eq('全角英字も正規化', normalizeAtsName('ＨＲＭＯＳ').id, 'hrmos');
eq('前後空白を無視', normalizeAtsName('  ジョブカン  ').id, 'jobcan');
eq('ベンダー名が付く', normalizeAtsName('管理くん').vendor, 'HRクラウド株式会社');
eq('MOCHICAは自社フラグ', normalizeAtsName('MOCHICA').own, true);
eq('「無し」はnone', normalizeAtsName('無し').status, 'none');
eq('「なし」もnone', normalizeAtsName('なし').status, 'none');
eq('空はempty', normalizeAtsName('').status, 'empty');
// 未登録の製品名は原文を保持する（勝手にベンダーを推測しない）
const unk = normalizeAtsName('HRPRIME');
eq('未登録はunknown', unk.status, 'unknown');
eq('  名称は原文のまま', unk.name, 'HRPRIME');
eq('  ベンダーは空（推測しない）', unk.vendor, '');
ok('未登録同士は同一IDに寄る', normalizeAtsName('HRPRIME').id === normalizeAtsName('hrprime').id);
ok('別の未登録は別ID', normalizeAtsName('HRPRIME').id !== normalizeAtsName('らくるーと').id);

// ── 9) 全社スイープの突合ロジック ─────────────────────────────────
// 媒体リンク（マイナビ等）はATSの証拠にならない。ここを緩めるとCRM更新の判断を誤らせる。
console.log('\n[9] CRM値とURL判定の突合（crmCompare）');
const { crmCompare } = require('../src/enrich-ats-all');
eq('CRMもURLも同じATS → 一致', crmCompare('sonarATS', 'sonar ATS', 'ats'), '一致');
ok('別ATSなら要確認', /^要確認：不一致/.test(crmCompare('i-web', 'sonar ATS', 'ats')));
ok('CRM「無し」なのにATS検出 → 要確認', /^要確認/.test(crmCompare('無し', '採用一括かんりくん', 'ats')));
ok('CRM「無し」×媒体のみ → 整合（要確認にしない）', !/要確認/.test(crmCompare('無し', 'マイナビ', 'media')));
ok('CRMにATSあり×媒体のみ → 不一致にしない', !/不一致/.test(crmCompare('i-web', 'マイナビ', 'media')));
ok('CRM未記入×ATS検出 → 判明として出る', /判明/.test(crmCompare('', 'HRMOS採用（ハーモス）', 'ats')));
eq('CRM未記入×検出なし → 空', crmCompare('', '', ''), '');
eq('CRM「無し」×検出なし', crmCompare('無し', '', ''), 'CRM「無し」・URLでも検出なし');
eq('CRMのみ（URL未検出）', crmCompare('sonarATS', '', ''), 'CRMのみ（URLでは未検出）');

console.log(`\n合計: ${pass} pass / ${fail} fail`);
if (fail) { console.log('失敗:'); fails.forEach((f) => console.log('  - ' + f)); process.exitCode = 1; }
assert.strictEqual(fail, 0, `${fail}件失敗`);
