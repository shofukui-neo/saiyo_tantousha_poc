'use strict';
// ネットワーク・APIキー不要でパイプライン（抽出→検証→集計）を検証する。
const fs = require('fs');
const path = require('path');
const { extractText } = require('../src/fetch');
const { extractContact, heuristicExtract, looksLikePersonName } = require('../src/extract');
const { validateHit } = require('../src/validate');
const { summarize, printSummary } = require('../src/metrics');
const { rowsToCompanies, resultToRow, OUTPUT_HEADERS } = require('../src/io-common');
const { readJsonResponse } = require('../src/gas');
const { extractPhones, normalizeJpPhone } = require('../src/phone');
const { decodeDdgHref, isExcludedDomain, parseDdgHtml, scoreCandidates, pageMatchesCompany, companyCore } = require('../src/search');
const { extractCompanyNames } = require('../src/discover');

function read(f) { return fs.readFileSync(path.join(__dirname, f), 'utf8'); }

async function testGasJsonGuard() {
  let fail = 0;
  const makeRes = (body, contentType = 'application/json') => ({
    status: 200,
    statusText: 'OK',
    url: 'https://script.google.com/macros/s/test/exec',
    headers: { get: (key) => String(key).toLowerCase() === 'content-type' ? contentType : '' },
    text: async () => body,
  });

  try {
    const ok = await readJsonResponse(makeRes('{"companies":[{"homepage_url":"https://a.example"}]}'), 'GAS GET');
    if (!ok || !Array.isArray(ok.companies) || ok.companies[0].homepage_url !== 'https://a.example') {
      console.log('✗ readJsonResponse 正常系のJSON解析に失敗');
      fail++;
    } else {
      console.log('✓ readJsonResponse: 正常なJSONを読める');
    }
  } catch (e) {
    console.log('✗ readJsonResponse 正常系で例外: ' + e.message);
    fail++;
  }

  try {
    await readJsonResponse(makeRes('<!doctype html><html>oops</html>', 'text/html'), 'GAS GET');
    console.log('✗ readJsonResponse HTML をJSON扱いしてしまった');
    fail++;
  } catch (e) {
    const ok = /JSON以外/.test(e.message);
    if (!ok) {
      console.log('✗ readJsonResponse HTML時の例外メッセージが不十分: ' + e.message);
      fail++;
    } else {
      console.log('✓ readJsonResponse: HTML応答を分かりやすく拒否できる');
    }
  }

  try {
    await readJsonResponse(makeRes('<!doctype html><html lang="en-US" dir="ltr"><head><base href="https://accounts.google.com/v3/signin/">signin</head></html>', 'text/html'), 'GAS GET');
    console.log('✗ readJsonResponse signin HTML を見逃した');
    fail++;
  } catch (e) {
    const ok = /Googleログイン画面/.test(e.message);
    if (!ok) {
      console.log('✗ readJsonResponse signin時の例外メッセージが不十分: ' + e.message);
      fail++;
    } else {
      console.log('✓ readJsonResponse: Googleログイン画面を特定できる');
    }
  }

  return fail;
}

// ---- スプレッドシートI/Oの純粋ロジック検証（ネットワーク不要） ----
function testSheetHelpers() {
  let fail = 0;
  const rows = [
    ['company_name', 'homepage_url', 'status'], // header (row 1)
    ['A社', 'https://a.example', ''],            // row 2
    ['', 'https://blank-name.example', ''],      // row 3 (名前空でもURLあれば対象)
    ['名前のみ株式会社', '', ''],                  // row 4 (URL空でも企業名から自動発見するので対象)
    ['D社', 'https://d.example', 'HIT'],         // row 5 (既存status)
  ];
  const comps = rowsToCompanies(rows);
  const ok1 = comps.length === 4;
  const ok2 = comps[0].row === 2 && comps[0].homepage_url === 'https://a.example';
  const nameOnly = comps.find(c => c.name === '名前のみ株式会社');
  const ok3 = !!nameOnly && nameOnly.row === 4 && nameOnly.homepage_url === '';
  const dcorp = comps.find(c => c.name === 'D社');
  const ok4 = !!dcorp && dcorp.row === 5 && dcorp.status === 'HIT';
  const pending = comps.filter(c => !c.status);
  const ok5 = pending.length === 3; // A社, blank-name, 名前のみ
  if (!ok1) { console.log(`✗ rowsToCompanies 件数: expected 4 got ${comps.length}`); fail++; } else console.log('✓ rowsToCompanies: 企業名 or URL がある4件を対象');
  if (!ok2) { console.log('✗ rowsToCompanies 行番号/URL マッピング不正'); fail++; } else console.log('✓ rowsToCompanies: 行番号(row=2)とURLが正しい');
  if (!ok3) { console.log('✗ rowsToCompanies URL空でも企業名行を残せていない'); fail++; } else console.log('✓ rowsToCompanies: URL空でも企業名行は対象(row=4)');
  if (!ok4) { console.log('✗ rowsToCompanies 行番号/status 保持 不正'); fail++; } else console.log('✓ rowsToCompanies: 既存statusと行番号を保持(row=5)');
  if (!ok5) { console.log(`✗ ONLY_PENDING抽出: expected 3 got ${pending.length}`); fail++; } else console.log('✓ ONLY_PENDING: status空欄の3件のみ抽出');

  const row = resultToRow({ status: 'HIT', resolved_url: 'https://a.example', phone: '03-1234-5678', name: '佐藤 花子', role: '人事部', confidence: 0.62, pages_checked: 2, elapsed_ms: 1234 });
  const ok6 = row.length === OUTPUT_HEADERS.length;
  const ok7 = row[0] === 'HIT' && row[1] === 'https://a.example' && row[2] === '03-1234-5678' && row[3] === '佐藤 花子' && row[6] === 0.62;
  if (!ok6) { console.log(`✗ resultToRow 列数: expected ${OUTPUT_HEADERS.length} got ${row.length}`); fail++; } else console.log(`✓ resultToRow: 列数が ${OUTPUT_HEADERS.length} で一致`);
  if (!ok7) { console.log('✗ resultToRow 値マッピング不正'); fail++; } else console.log('✓ resultToRow: status/url/phone/name/confidence が正しく整形');
  return fail;
}

// ---- 電話番号抽出の検証（ネットワーク不要） ----
function testPhone() {
  let fail = 0;
  const check = (label, got, expect) => {
    if (got === expect) { console.log(`✓ ${label}`); }
    else { console.log(`✗ ${label}: expected ${JSON.stringify(expect)} got ${JSON.stringify(got)}`); fail++; }
  };
  check('normalizeJpPhone: 固定(ハイフン無し)→整形', normalizeJpPhone('0312345678'), '03-1234-5678');
  check('normalizeJpPhone: 携帯11桁', normalizeJpPhone('090-1234-5678'), '090-1234-5678');
  check('normalizeJpPhone: フリーダイヤル', normalizeJpPhone('0120-123-456'), '0120-123-456');
  check('normalizeJpPhone: 全角→半角', normalizeJpPhone('０３－１２３４－５６７８'), '03-1234-5678');
  check('normalizeJpPhone: 郵便番号は除外', normalizeJpPhone('123-4567'), null);
  check('normalizeJpPhone: "00"始まりは除外', normalizeJpPhone('0001074853'), null);
  // 適格請求書発行事業者の登録番号（T+13桁）を電話番号と誤検出しない
  const reg = extractPhones({ text: '適格請求書発行事業者 登録番号：T4290001074853 をご確認ください' });
  check('extractPhones: 登録番号(13桁連番)を電話と誤検出しない', reg.phone, null);

  // tel: リンクと本文。FAXより本命TELを選ぶ
  const html = '<html><body>お問い合わせ TEL: 03-1234-5678 FAX: 03-1234-9999 ' +
    '<a href="tel:03-1234-5678">お電話はこちら</a></body></html>';
  const text = 'お問い合わせ TEL: 03-1234-5678 FAX: 03-1234-9999';
  const r = extractPhones({ html, text });
  if (r.phone === '03-1234-5678' && !r.isFax) console.log('✓ extractPhones: tel:リンク/TEL近接の本命番号を選択（FAXを回避）');
  else { console.log(`✗ extractPhones: expected 03-1234-5678(non-fax) got ${JSON.stringify({ phone: r.phone, isFax: r.isFax })}`); fail++; }
  return fail;
}

// ---- 担当者名ヒューリスティック（外部AI API不使用）の検証 ----
function testName() {
  let fail = 0;
  const ok = (label, cond) => { if (cond) console.log('✓ ' + label); else { console.log('✗ ' + label); fail++; } };
  ok('looksLikePersonName: 役割語/見出し語を人名と誤認しない（舞台裏）', looksLikePersonName('舞台裏') === false);
  ok('looksLikePersonName: 役割語を弾く（採用担当）', looksLikePersonName('採用担当') === false);
  ok('looksLikePersonName: 実在しそうな氏名は許可（山田 太郎）', looksLikePersonName('山田 太郎') === true);
  // 「舞台裏（人事…」のような誤検出パターンを拾わない
  const bad = heuristicExtract('採用の舞台裏（人事メンバー紹介）はこちら');
  ok('heuristicExtract: 「舞台裏（人事」を担当者名として拾わない', bad.found === false);
  // 明示的な「採用担当：氏名」は拾う
  const good = heuristicExtract('採用担当：佐藤 花子 までお問い合わせください');
  ok('heuristicExtract: 「採用担当：佐藤 花子」を抽出', good.found === true && good.name === '佐藤 花子');
  return fail;
}

// ---- 企業名の自動発見（テキストからの抽出）検証（ネットワーク不要） ----
function testDiscover() {
  let fail = 0;
  const ok = (label, cond) => { if (cond) console.log('✓ ' + label); else { console.log('✗ ' + label); fail++; } };
  const text = '東京のIT企業: サイボウズ株式会社、株式会社メルカリ、freee株式会社 などが有名です。詳しくは一覧をご覧ください。';
  const names = extractCompanyNames(text);
  ok('extractCompanyNames: 後置「サイボウズ株式会社」を抽出', names.includes('サイボウズ株式会社'));
  ok('extractCompanyNames: 前置「株式会社メルカリ」を抽出', names.includes('株式会社メルカリ'));
  ok('extractCompanyNames: 英字混じり「freee株式会社」を抽出', names.includes('freee株式会社'));
  // 重複（同じ社名が複数回）を1件に正規化
  const dup = extractCompanyNames('株式会社テスト 株式会社テスト テスト株式会社');
  ok('extractCompanyNames: 重複を除去', dup.filter(n => companyCore(n) === 'テスト').length === 1);
  // 法人格が無い語は拾わない
  ok('extractCompanyNames: 法人格の無い語は拾わない', extractCompanyNames('東京 IT ベンチャー 一覧').length === 0);
  return fail;
}

// ---- URL発見（検索）純ロジックの検証（ネットワーク不要） ----
function testSearch() {
  let fail = 0;
  const ok = (label, cond) => { if (cond) console.log('✓ ' + label); else { console.log('✗ ' + label); fail++; } };

  ok('decodeDdgHref: uddgリダイレクトを実URLへ復元',
    decodeDdgHref('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.co.jp%2F&rut=x') === 'https://example.co.jp/');
  ok('isExcludedDomain: 求人媒体(indeed)を除外', isExcludedDomain('jp.indeed.com') === true);
  ok('isExcludedDomain: 公式(co.jp)は除外しない', isExcludedDomain('example.co.jp') === false);
  ok('companyCore: 法人格を除去', companyCore('テスト工業株式会社') === 'テスト工業');
  ok('pageMatchesCompany: タイトル一致を検出',
    pageMatchesCompany('テスト工業株式会社', 'テスト工業 | 会社概要', 'ようこそ') === true);
  ok('pageMatchesCompany: 無関係ページは不一致',
    pageMatchesCompany('テスト工業株式会社', 'まったく別のサイト', '関係ない本文') === false);

  // DDG風HTMLをパース→スコアリング。公式(co.jp)が求人媒体より上位に来ること。
  const ddg = `<div class="result web-result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://jp.indeed.com/cmp/テスト工業')}">テスト工業の求人 | Indeed</a>
      <a class="result__snippet">テスト工業の採用情報</a>
    </div>
    <div class="result web-result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://test-kogyo.co.jp/')}">テスト工業株式会社｜公式サイト</a>
      <a class="result__snippet">テスト工業株式会社の会社概要・採用情報</a>
    </div>`;
  const cands = parseDdgHtml(ddg);
  ok('parseDdgHtml: 候補を2件抽出', cands.length === 2);
  const scored = scoreCandidates(cands, 'テスト工業株式会社');
  ok('scoreCandidates: 求人媒体を除外し公式のみ残る', scored.length === 1 && /test-kogyo\.co\.jp/.test(scored[0].url));
  return fail;
}

async function run() {
  const cases = [
    { name: 'サンプル株式会社', file: 'fixture.html', expect: 'HIT' },
    { name: 'テスト工業株式会社', file: 'fixture-negative.html', expect: 'MISS' },
  ];
  const results = [];
  let failures = 0;

  for (const c of cases) {
    const text = extractText(read(c.file));
    // 抽出はローカルのヒューリスティックのみ（外部AI API不使用）
    const ext = extractContact({ text, companyName: c.name });
    const v = validateHit(ext);
    const status = v.hit ? 'HIT' : 'MISS';
    const ok = status === c.expect;
    if (!ok) failures++;
    console.log(`${ok ? '✓' : '✗'} ${c.name}: expected=${c.expect} got=${status}` +
      (ext.found ? ` | name="${ext.name}" role="${ext.role}" conf=${ext.confidence}` : '') +
      (v.reasons && v.reasons.length ? ` | reasons=[${v.reasons.join('; ')}]` : ''));
    results.push({
      company: c.name, status, resolved_url: 'https://example.com', phone: status === 'HIT' ? '03-1234-5678' : '',
      name: ext.name || '', role: ext.role || '',
      confidence: ext.confidence || 0, pages_checked: 1, elapsed_ms: 1,
    });
  }

  printSummary(summarize(results));

  console.log('--- 電話番号抽出 検証 ---');
  failures += testPhone();
  console.log('\n--- 担当者名ヒューリスティック 検証 ---');
  failures += testName();
  console.log('\n--- 企業名 自動発見 検証 ---');
  failures += testDiscover();
  console.log('\n--- URL発見（検索）ロジック 検証 ---');
  failures += testSearch();
  console.log('\n--- スプレッドシートI/O ヘルパー検証 ---');
  failures += testSheetHelpers();
  failures += await testGasJsonGuard();

  if (failures > 0) { console.error(`\nSELFTEST FAILED: ${failures} case(s)`); process.exit(1); }
  console.log('\nSELFTEST PASSED ✓  (抽出→検証→集計 ＋ スプレッドシートI/O ロジックが正常動作)');
}

run().catch(e => { console.error('SELFTEST ERROR', e); process.exit(1); });
