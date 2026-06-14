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
const { normalizeDomain, tierOf, callScript, discoveryIcpScore } = require('../src/score');
const { normalizeIcp } = require('../src/icp');
const { recordToRow, keyOfRecord } = require('../src/master-io');
const { geminiToExt } = require('../src/recruiter');
const { guessEmails } = require('../src/email');
const { extractYear, matchIndustry, passesEstablishment } = require('../src/gbiz');

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
  check('normalizeJpPhone: 東京03(ハイフン無し)→整形', normalizeJpPhone('0312345678'), '03-1234-5678');
  check('normalizeJpPhone: 区切り付きはそのまま尊重(3桁市外)', normalizeJpPhone('072-233-1101'), '072-233-1101');
  check('normalizeJpPhone: 区切り無し3桁市外はハイフンを捏造しない', normalizeJpPhone('0722331101'), '0722331101');
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

// ---- 統合パイプライン（究極の営業リスト）純ロジック検証（ネットワーク不要） ----
function testPipelineLogic() {
  let fail = 0;
  const ok = (label, cond) => { if (cond) console.log('✓ ' + label); else { console.log('✗ ' + label); fail++; } };

  // ドメイン正規化
  ok('normalizeDomain: protocol/www/パスを除去', normalizeDomain('https://www.Example.co.jp/about?x=1') === 'example.co.jp');
  ok('normalizeDomain: 空は空', normalizeDomain('') === '');

  // Tier 判定
  ok('tierOf: 担当者0.9+メール0.9 → A', tierOf(0.9, 0.9, true) === 'A');
  ok('tierOf: 担当者0.7（閾値超）→ B', tierOf(0.7, 0, false) === 'B');
  ok('tierOf: 代表者ありのみ → C', tierOf(0, 0, true) === 'C');
  ok('tierOf: 何も無し → D', tierOf(0, 0, false) === 'D');

  // 架電呼称
  ok('callScript: 新卒シグナルで敬称調整', callScript({ buyer_persona: { departments: ['人事部'] }, primary_value_prop: '新卒採用SaaS' }) === '人事部 新卒採用ご担当者様');

  // ICPスコア（従業員スイートスポット）
  ok('discoveryIcpScore: 150名+HP+代表者 → 満点100', discoveryIcpScore({ employees: 150, websiteUrl: 'x', representativeName: 'y' }) === 100);
  ok('discoveryIcpScore: 従業員不明はニュートラル寄り', discoveryIcpScore({ employees: null, websiteUrl: '', representativeName: '' }) === 20);

  // ICP 正規化（手動設定の補完）
  const icp = normalizeIcp({ source: 'manual' }, { ICP_INDUSTRIES: ['IT'], ICP_PREFECTURES: ['東京都'], ICP_EMP_MIN: 50, ICP_EMP_MAX: 300, ICP_DEPARTMENT: '人事部' });
  ok('normalizeIcp: 手動の業種/地域/従業員を反映', icp.target_industries[0] === 'IT' && icp.geography[0] === '東京都' && icp.company_size.employees_max === 300);
  ok('normalizeIcp: 既定部署を補完', icp.buyer_persona.departments[0] === '人事部');

  // マスタ行整形・upsertキー
  const headers = ['企業名', '法人番号', 'Tier'];
  const row = recordToRow({ '企業名': 'A社', 'Tier': 'B' }, headers);
  ok('recordToRow: ヘッダ順に整形（欠損は空）', row.length === 3 && row[0] === 'A社' && row[1] === '' && row[2] === 'B');
  ok('keyOfRecord: 法人番号優先', keyOfRecord({ '法人番号': '123', '企業名': 'A社' }) === 'c:123');
  ok('keyOfRecord: 法人番号無しは企業名', keyOfRecord({ '企業名': 'A社' }) === 'n:A社');

  // Gemini レスポンス → ext 変換（AI経路でも検証ゲートに乗る形）
  const ext = geminiToExt({ found: true, name: '山田 太郎', title: '採用担当', department: '人事部', snippet: '採用担当の山田です', confidence: 0.8 });
  const v = validateHit(ext);
  ok('geminiToExt+validateHit: AI抽出も検証ゲートを通過', v.hit === true);

  // メール候補生成
  const emails = guessEmails('example.co.jp', { EMAIL_ROLES: ['info', 'recruit'] });
  ok('guessEmails: 役割アドレスを生成', emails[0] === 'info@example.co.jp' && emails[1] === 'recruit@example.co.jp');

  return fail;
}

// ---- gBizINFO 発掘フィルタ（GAS Layer1.5 移植分）純ロジック検証（ネットワーク不要） ----
function testGbizLogic() {
  let fail = 0;
  const ok = (label, cond) => { if (cond) console.log('✓ ' + label); else { console.log('✗ ' + label); fail++; } };

  // 西暦抽出
  ok('extractYear: "1995-04-01" → 1995', extractYear('1995-04-01') === '1995');
  ok('extractYear: 空は空', extractYear('') === '');

  // 業種KWフィルタ（事業概要＋営業品目への部分一致）
  const h = { businessSummary: '総合建設業を営む', businessItems: ['土木一式工事'] };
  ok('matchIndustry: 事業概要に「建設」がヒット', matchIndustry(h, ['建設', '医療'], false).matchedKw === '建設');
  ok('matchIndustry: 営業品目に「土木」がヒット', matchIndustry({ businessSummary: '', businessItems: ['土木一式工事'] }, ['土木'], false).matchedKw === '土木');
  ok('matchIndustry: KW未指定なら常に通過', matchIndustry(h, [], false).keep === true);
  ok('matchIndustry: 不一致は除外', matchIndustry(h, ['医療'], false).keep === false);
  // 事業概要・営業品目が空のとき keepWhenNoData に従う
  const empty = { businessSummary: '', businessItems: [] };
  ok('matchIndustry: データ空＋keep=false で除外', matchIndustry(empty, ['建設'], false).keep === false);
  ok('matchIndustry: データ空＋keep=true で残す', matchIndustry(empty, ['建設'], true).keep === true);

  // 設立年フィルタ（現在年を注入して時間に依存しない検証）
  ok('passesEstablishment: minYears=0 は常に通過', passesEstablishment('2024', 0, 2026) === true);
  ok('passesEstablishment: 設立5年で min5 を満たす', passesEstablishment('2021', 5, 2026) === true);
  ok('passesEstablishment: 設立3年は min5 で除外', passesEstablishment('2023', 5, 2026) === false);
  ok('passesEstablishment: 設立年不明は通過（取りこぼし防止）', passesEstablishment('', 5, 2026) === true);

  // スコア加点（補助金＝買いシグナル / 設立継続性）
  ok('discoveryIcpScore: 補助金フラグで加点', discoveryIcpScore({ employees: 200, websiteUrl: '', representativeName: '', subsidy: true }) > discoveryIcpScore({ employees: 200, websiteUrl: '', representativeName: '' }));
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
  console.log('\n--- 統合パイプライン（究極の営業リスト）ロジック検証 ---');
  failures += testPipelineLogic();
  console.log('\n--- gBizINFO 発掘フィルタ（業種KW/設立年/補助金）検証 ---');
  failures += testGbizLogic();

  if (failures > 0) { console.error(`\nSELFTEST FAILED: ${failures} case(s)`); process.exit(1); }
  console.log('\nSELFTEST PASSED ✓  (抽出→検証→集計 ＋ スプレッドシートI/O ロジックが正常動作)');
}

run().catch(e => { console.error('SELFTEST ERROR', e); process.exit(1); });
