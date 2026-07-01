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
const structured = require('../src/structured');
const areacode = require('../src/areacode');
const { addressTokens } = require('../src/search');
const { normalizeDomain, tierOf, callScript, discoveryIcpScore } = require('../src/score');
const { normalizeIcp } = require('../src/icp');
const { recordToRow, keyOfRecord } = require('../src/master-io');
const { geminiToExt } = require('../src/recruiter');
const { guessEmails } = require('../src/email');
const { extractYear, matchIndustry, passesEstablishment } = require('../src/gbiz');
const { scoreRecord, scoreData, scoreIcp, scoreIntent, monthSeason, parseEmployees, priorityOf, negativeAdjust } = require('../src/quality');

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
  check('normalizeJpPhone: 区切り無し3桁市外も市外局番表で正整形', normalizeJpPhone('0722331101'), '072-233-1101');
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
  // 語尾の敬称/助詞/役職の貪欲取り込みを剥がす（精度：validateHitは課長/さん等を弾けないため抽出側で除去）
  const hh = (t) => { const h = heuristicExtract(t); return h.found ? h.name.replace(/[ 　]/g, '') : ''; };
  ok('heuristicExtract: 「山田太郎さん」→山田太郎（敬称を剥がす）', hh('人事ご担当 山田太郎さん') === '山田太郎');
  ok('heuristicExtract: 「鈴木一郎より」→鈴木一郎（助詞を剥がす）', hh('採用担当 鈴木一郎より') === '鈴木一郎');
  ok('heuristicExtract: 「田中花子です」→田中花子', hh('採用担当者：田中花子です') === '田中花子');
  ok('heuristicExtract: 「中村課長 まで」→中村（役職＋助詞を剥がす）', hh('採用担当：中村課長 まで') === '中村');
  ok('heuristicExtract: ひらがな名「渡辺さくら」は保持', hh('人事担当：渡辺さくら への連絡') === '渡辺さくら');
  // 実データ由来の精度: 正規表現の(者)?＋貪欲一致で生じる「者＋後続」ノイズを姓辞書ゲートで排除
  ok('heuristicExtract: 「採用担当者からのメッセージ」を氏名にしない', heuristicExtract('採用担当者からのメッセージ').found === false);
  ok('heuristicExtract: 「採用担当者とのコミュニケーション」を氏名にしない', heuristicExtract('採用担当者とのコミュニケーション').found === false);
  return fail;
}

// ---- 姓ガゼッティア（jp-names）の再現率／精度の回帰固定 ----
// 実データ(代表者名)由来で拡充した姓が解決でき、地名片を姓と誤認しないことを固定する。
function testSurnameDict() {
  let fail = 0;
  const { isFullName, completeSurname, splitName } = require('../src/jp-names');
  const ok = (label, cond) => { if (cond) console.log('✓ ' + label); else { console.log('✗ ' + label); fail++; } };
  // 拡充した実在姓はフルネームとして解決できる（再現率）
  for (const f of ['小田太郎', '安達健一', '島袋美咲', '齊藤隆', '廣瀬学', '宮脇彩', '葛西亮']) {
    ok(`isFullName: 拡充姓「${f}」を解決`, isFullName(f) === true);
  }
  // Wantedly実データ却下分から採取した姓（再現率: 抽出率68.6%→80.3%に寄与）
  for (const f of ['奥田翔', '天野彩', '綿貫翼', '都築博志', '永野健', '福永祐大', '井口卓也', '多田健一', '荻原昌真']) {
    ok(`isFullName: Wantedly採取姓「${f}」を解決`, isFullName(f) === true);
  }
  // 3字姓は3字で照合（2字片が辞書姓でも誤分節しない / 従来nullだった姓を救う）
  ok('splitName: 「久保田聖也」→久保田+聖也（久保で誤分節しない）', JSON.stringify(splitName('久保田聖也')) === JSON.stringify({ sei: '久保田', mei: '聖也' }));
  ok('splitName: 「宇都宮元樹」→宇都宮+元樹（従来nullを救う）', JSON.stringify(splitName('宇都宮元樹')) === JSON.stringify({ sei: '宇都宮', mei: '元樹' }));
  ok('splitName: 2字姓「久保裕子」は久保+裕子のまま（3字姓追加で壊さない）', JSON.stringify(splitName('久保裕子')) === JSON.stringify({ sei: '久保', mei: '裕子' }));
  // 異体字（﨑/髙/邉/澤…）を標準字に正規化して辞書照合（Wantedly投稿者名に54種出現）
  const { normalizeNameKanji } = require('../src/jp-names');
  ok('normalizeNameKanji: 髙→高/﨑→崎/邉→辺', normalizeNameKanji('髙橋山﨑渡邉') === '高橋山崎渡辺');
  ok('isFullName: 異体字「髙橋美羽」を解決（→高橋）', isFullName('髙橋美羽') === true);
  ok('isFullName: 異体字「小松﨑泰広」を解決（→小松崎・3字姓）', isFullName('小松﨑泰広') === true);
  ok('splitName: 「山﨑将司」→山崎+将司（正規化）', JSON.stringify(splitName('山﨑将司')) === JSON.stringify({ sei: '山崎', mei: '将司' }));
  ok('completeSurname: 異体字単独姓「髙」は不可だが「山﨑」→山崎', completeSurname('山﨑') === '山崎');
  // 単独姓は辞書完全一致のみ採用（拡充姓は採る）
  ok('completeSurname: 「小田」を単独姓として採用', completeSurname('小田') === '小田');
  // 地名片・一般語は姓にしない（精度。名古屋の部分片 古屋 も入れていない）
  for (const w of ['中央', '関東', '関西', '中国', '四国', '名古屋', '古屋', '大阪', '東京']) {
    ok(`completeSurname: 地名片「${w}」は姓にしない`, completeSurname(w) === '');
  }
  // 実データ由来: 都市/拠点語が氏名に貼り付くケース（佐藤東京/中野事務所/西信用金庫）を stripNonName で剥がす
  const { stripNonName } = require('../src/jp-names');
  ok('stripNonName: 「佐藤東京」→佐藤（都市名を剥がす）', stripNonName('佐藤東京').replace(/[ 　]/g, '') === '佐藤');
  ok('stripNonName: 「中野事務所」→中野（拠点語を剥がす）', stripNonName('中野事務所').replace(/[ 　]/g, '') === '中野');
  ok('stripNonName: 「西信用金庫」→西（信用金庫を剥がす）', stripNonName('西信用金庫').replace(/[ 　]/g, '') === '西');
  ok('stripNonName: 「池田宛」→池田（宛先語を剥がす）', stripNonName('池田宛').replace(/[ 　]/g, '') === '池田');
  ok('stripNonName: 「山田御中」→山田（御中を剥がす）', stripNonName('山田御中').replace(/[ 　]/g, '') === '山田');
  // 「行」は給名語尾(正行/和行)に頻出→剥がさない（安全性）
  ok('stripNonName: 「田中正行」は保持（行を給名語尾として剥がさない）', stripNonName('田中正行').replace(/[ 　]/g, '') === '田中正行');
  // 役員系の役職（代表/社長/取締役/会長…）も氏名に貼り付くので剥がす（Wantedly投稿者名/会社ページで頻出）
  ok('stripNonName: 「山田代表」→山田', stripNonName('山田代表').replace(/[ 　]/g, '') === '山田');
  ok('stripNonName: 「渡辺代表取締役」→渡辺', stripNonName('渡辺代表取締役').replace(/[ 　]/g, '') === '渡辺');
  ok('stripNonName: 「佐藤社長」→佐藤', stripNonName('佐藤社長').replace(/[ 　]/g, '') === '佐藤');
  // 安全性: 1字名に役職字が含まれても、役職“語”でなければ剥がさない
  ok('stripNonName: 「田中理」は保持（理事の理単独は剥がさない）', stripNonName('田中理').replace(/[ 　]/g, '') === '田中理');
  return fail;
}

// ---- 採用担当者「個人名」取得層（Wantedly/ハローワーク）純ロジック検証（ネットワーク不要） ----
function testNameScraping() {
  const { firstFullName, extractPersonName, pickDetailUrls, namesMatch, companyOnPage } = require('../src/scrape-names');
  const cheerio = require('cheerio');
  let fail = 0;
  const ok = (label, cond) => { if (cond) console.log('✓ ' + label); else { console.log('✗ ' + label); fail++; } };
  // firstFullName: 姓辞書(jp-names)で検証。肩書き連結・分かち書きを許容し、一般語は弾く。
  ok('firstFullName: 「山田 太郎 | 人事担当」→山田太郎', firstFullName('山田 太郎 | 人事担当') === '山田太郎');
  ok('firstFullName: 連結「佐藤花子」を許容', firstFullName('佐藤花子') === '佐藤花子');
  ok('firstFullName: 役割語「採用担当」は人名にしない', firstFullName('採用担当') === null);
  ok('firstFullName: 法人格付き社名は人名にしない', firstFullName('株式会社テスト') === null);
  // 役割語/役職/地名が氏名に貼り付く現実形（jp-names.stripNonName 共有ガード）
  ok('firstFullName: 「田中花子採用担当」→田中花子（役割語を剥がす）', firstFullName('田中花子採用担当') === '田中花子');
  ok('firstFullName: 「採用担当 中村課長」→中村（役職を剥がし単独姓を採用）', firstFullName('採用担当 中村課長') === '中村');
  ok('firstFullName: 地名片「関東支店」は人名にしない', firstFullName('関東支店') === null);
  // extractPersonName: (1)採用文脈は高確度、(2)投稿者セレクタは中確度
  const ctx = extractPersonName('<body><p>採用担当：高橋 健一</p></body>');
  ok('extractPersonName: 採用文脈から高橋健一(conf0.7)', !!ctx && ctx.name === '高橋健一' && ctx.confidence === 0.7);
  const auth = extractPersonName('<body><div class="UserName">中村 さくら</div></body>', { authorSel: ['[class*="UserName"]'] });
  ok('extractPersonName: 投稿者セレクタから中村さくら(conf0.5)', !!auth && auth.name === '中村さくら' && auth.where === 'author');
  ok('extractPersonName: 個人名が無ければnull', extractPersonName('<body><p>採用担当者まで</p></body>') === null);
  // 投稿者セレクタを本文ヒューリスティックより優先（本文の募集説明ノイズで正しい投稿者名を上書きしない）
  const pri = extractPersonName('<body><div class="MemberName">大畑 健</div><p>採用担当 大畑健 小学校教員出身</p></body>', { authorSel: ['[class*="MemberName"]'] });
  ok('extractPersonName: 投稿者セレクタを本文より優先（大畑健、小学ノイズを上書きしない）', !!pri && pri.name === '大畑健' && pri.where === 'author');
  // pickDetailUrls: 対象セレクタのリンクのみ・絶対URL化・上限
  const urls = pickDetailUrls('<body><a href="/projects/1">A</a><a href="/projects/2">B</a><a href="/x">x</a></body>',
    'https://www.wantedly.com/search', ['a[href*="/projects/"]'], 'テスト', 2);
  ok('pickDetailUrls: projectsリンクのみ2件を絶対URLで返す',
    urls.length === 2 && urls[0] === 'https://www.wantedly.com/projects/1');
  // namesMatch: 法人格・表記揺れを吸収して会社一致（無関係企業は不一致）
  ok('namesMatch: 法人格違いでも一致（株式会社FLINTERS≈FLINTERS）', namesMatch('株式会社FLINTERS', 'FLINTERS') === true);
  ok('namesMatch: 無関係企業は不一致', namesMatch('株式会社FLINTERS', '日産化学株式会社') === false);
  // companyOnPage: companySel の最初の非空テキストを掲載企業として返す
  const $c = cheerio.load('<body><a href="/companies/x">株式会社テスト</a><a href="/companies/y">別会社</a></body>');
  ok('companyOnPage: 最初の会社リンク名を返す', companyOnPage($c, ['a[href*="/companies/"]']) === '株式会社テスト');
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

// ---- 構造化抽出(JSON-LD/sitemap) 純ロジック検証（ネットワーク不要） ----
function testStructured() {
  let fail = 0;
  const ok = (label, cond) => { if (cond) console.log('✓ ' + label); else { console.log('✗ ' + label); fail++; } };
  const html = '<html><head><script type="application/ld+json">' +
    JSON.stringify({ '@context': 'https://schema.org', '@type': 'Organization', name: 'サンプル株式会社', telephone: '03-1234-5678', address: { addressRegion: '東京都', addressLocality: '港区', streetAddress: '1-2-3' } }) +
    '</script></head><body>x</body></html>';
  const org = structured.extractOrganization(html);
  ok('structured.extractOrganization: name/telephone/address抽出', !!org && org.name === 'サンプル株式会社' && org.telephone === '03-1234-5678' && org.address.includes('港区'));
  ok('structured.extractOrganization: JSON-LD無しはnull', structured.extractOrganization('<html><body>no jsonld</body></html>') === null);
  const xml = '<urlset><url><loc>https://e.jp/</loc></url><url><loc>https://e.jp/company/</loc></url><url><loc>https://e.jp/contact/</loc></url></urlset>';
  const locs = structured.parseSitemapLocs(xml);
  ok('structured.parseSitemapLocs: locを3件抽出', locs.length === 3);
  const ranked = structured.rankSitemapUrls(locs);
  ok('structured.rankSitemapUrls: 会社概要/問い合わせを上位に', ranked.length === 2 && /company|contact/.test(ranked[0]));
  return fail;
}

// ---- 市外局番テーブル 純ロジック検証（ネットワーク不要） ----
function testAreacode() {
  let fail = 0;
  const eq = (label, got, exp) => { if (got === exp) console.log('✓ ' + label); else { console.log(`✗ ${label}: expected ${JSON.stringify(exp)} got ${JSON.stringify(got)}`); fail++; } };
  eq('areacode.formatLandline: 東京03(2桁市外)', areacode.formatLandline('0312345678'), '03-1234-5678');
  eq('areacode.formatLandline: 大阪周辺072(3桁市外)', areacode.formatLandline('0722331101'), '072-233-1101');
  eq('areacode.formatLandline: 横浜045(3桁市外)', areacode.formatLandline('0451234567'), '045-123-4567');
  eq('areacode.prefectureForNumber: 045→神奈川県', areacode.prefectureForNumber('045-123-4567'), '神奈川県');
  eq('areacode.prefectureForNumber: 06→大阪府', areacode.prefectureForNumber('06-1234-5678'), '大阪府');
  return fail;
}

// ---- 所在地トークン化（同名照合） 検証 ----
function testAddressTokens() {
  let fail = 0;
  const toks = addressTokens('東京都千代田区丸の内1-1-1');
  const ok = toks.includes('東京都') && toks.some(t => t.includes('千代田区'));
  if (ok) console.log('✓ addressTokens: 都道府県＋市区を抽出'); else { console.log('✗ addressTokens: ' + JSON.stringify(toks)); fail++; }
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

// ---- リスト品質スコアリング（4ディメンション加重）検証 ----
function testQualityLogic() {
  let fail = 0;
  const ok = (label, cond) => { if (cond) console.log('✓ ' + label); else { console.log('✗ ' + label); fail++; } };
  const icp = { target_industries: ['SaaS', 'IT'], geography: ['東京都'] };
  const c = require('../src/config');
  const fixedNow = new Date('2026-11-15T00:00:00+09:00'); // 11月＝計画ピーク(係数100)

  // 従業員数パース
  ok('parseEmployees: "150名 [ICP60]" → 150', parseEmployees('150名 [ICP60]') === 150);
  ok('parseEmployees: 空 → null', parseEmployees('') === null);

  // 季節係数
  ok('monthSeason: 11月=100(計画ピーク)', monthSeason(11, c) === 100);
  ok('monthSeason: 8月=55(中だるみ)', monthSeason(8, c) === 55);

  // ICP適合：スイートスポット規模＋業種＋地域一致は高得点
  const icpHigh = scoreIcp({ '従業員数': 150, '業種': 'SaaS', '都道府県': '東京都', '設立年': '2010', '補助金': '○' }, icp, c);
  const icpLow = scoreIcp({ '従業員数': 5000, '業種': '製造', '都道府県': '北海道' }, icp, c);
  ok('scoreIcp: ICP適合企業 > 非適合企業', icpHigh.score > icpLow.score);

  // データ品質：妥当な電話＋メール＋担当者＋URL＋新しい取得日は高得点
  const dataHigh = scoreData({ '電話番号': '03-1234-5678', 'メール': 'a@x.co.jp', 'メール確度': 0.95, '採用担当者名': '山田 太郎', '公式URL': 'https://x.co.jp', '取得日': fixedNow.toISOString() }, c, fixedNow.getTime());
  const dataLow = scoreData({ '電話番号': '', 'メール': '', '採用担当者名': '', '公式URL': '' }, c, fixedNow.getTime());
  ok('scoreData: 充実データ > 欠損データ', dataHigh.score > dataLow.score);
  ok('scoreData: 不正な電話番号は満点にしない', scoreData({ '電話番号': '123-4567', '公式URL': 'https://x' }, c, fixedNow.getTime()).score < dataHigh.score);

  // 採用インテント：出稿データありは本スコア、無しは代理推定フラグ
  const intentReal = scoreIntent({ '新卒出稿': '○', '出稿媒体数': '3', '出稿継続性': '○' }, c);
  const intentProxy = scoreIntent({ '採用担当者名': '山田 太郎', '担当者確度': 0.8, '根拠URL': 'https://x.co.jp/recruit' }, c);
  ok('scoreIntent: 出稿データありは proxy=false', intentReal.proxy === false && intentReal.score > 0);
  ok('scoreIntent: 担当者HIT代理シグナルで加点(proxy=true)', intentProxy.proxy === true && intentProxy.score > 20);

  // 優先度の閾値
  ok('priorityOf: 75→今週架電', priorityOf(75, c) === '今週架電');
  ok('priorityOf: 50→ナーチャリング', priorityOf(50, c) === 'ナーチャリング');
  ok('priorityOf: 30→後回し', priorityOf(30, c) === '後回し');

  // ネガティブ調整（除外フラグ）
  ok('negativeAdjust: 除外フラグで大幅減点', negativeAdjust({ '除外フラグ': '○' }).penalty >= 100);

  // 総合スコア：高品質レコードは 0-100 に収まり、優先度が付く
  const full = scoreRecord({ '従業員数': 150, '業種': 'SaaS', '都道府県': '東京都', '設立年': '2010', '電話番号': '03-1234-5678', 'メール': 'a@x.co.jp', 'メール確度': 0.95, '採用担当者名': '山田 太郎', '公式URL': 'https://x.co.jp', '根拠URL': 'https://x.co.jp/recruit', '担当者確度': 0.8, '取得日': fixedNow.toISOString() }, { icp, now: fixedNow, c });
  ok('scoreRecord: 総合は0-100', full.total >= 0 && full.total <= 100);
  ok('scoreRecord: 4ディメンションを返す', full.dims && ['icp', 'intent', 'data', 'timing'].every((k) => typeof full.dims[k] === 'number'));
  ok('scoreRecord: 優先度が付与される', ['今週架電', 'ナーチャリング', '後回し'].includes(full.priority));
  // 除外フラグ付きは総合スコアが下がる
  const excluded = scoreRecord(Object.assign({ '除外フラグ': '○' }, { '従業員数': 150, '業種': 'SaaS', '都道府県': '東京都', '電話番号': '03-1234-5678', 'メール': 'a@x.co.jp', 'メール確度': 0.95, '採用担当者名': '山田 太郎', '公式URL': 'https://x.co.jp', '取得日': fixedNow.toISOString() }), { icp, now: fixedNow, c });
  ok('scoreRecord: 除外フラグで総合が下がる', excluded.total < full.total);

  return fail;
}

function testCsvKeys() {
  let fail = 0;
  const ok = (label, cond) => { if (cond) console.log('✓ ' + label); else { console.log('✗ ' + label); fail++; } };
  const { normCorpNumber, normCompanyName, mergeKey, truthy } = require('../src/csv');
  ok('normCorpNumber: 13桁抽出', normCorpNumber('法人番号 1010001000001 ') === '1010001000001');
  ok('normCorpNumber: 桁不足はnull扱い', normCorpNumber('12345') === '');
  ok('normCompanyName: 法人格除去で一致', normCompanyName('株式会社イータ') === normCompanyName('イータ㈱'));
  ok('normCompanyName: （株）表記も除去', normCompanyName('（株）アルファ') === normCompanyName('アルファ株式会社'));
  ok('mergeKey: 法人番号を優先', mergeKey({ '法人番号': '1010001000001', '企業名': 'X' }) === 'C:1010001000001');
  ok('mergeKey: 番号無しは正規化社名', mergeKey({ '企業名': '株式会社イータ' }) === 'N:イータ');
  ok('truthy: ○/掲載中/1 を真と判定', truthy('○') && truthy('掲載中') && truthy('1') && !truthy(''));
  return fail;
}

function testMergeLogic() {
  let fail = 0;
  const ok = (label, cond) => { if (cond) console.log('✓ ' + label); else { console.log('✗ ' + label); fail++; } };
  const { mergeSources } = require('../src/merge');
  const c = require('../src/config');
  const sources = [
    { system: 'A', source: 'マイナビ', intent: 3, records: [{ '企業名': '株式会社アルファ', '法人番号': '1010001000001', '新卒フラグ': '○', '掲載媒体数': '2' }] },
    { system: 'B', source: 'gBizINFO', intent: 1, records: [{ '企業名': 'アルファ株式会社', '法人番号': '1010001000001', '従業員数': '180', '都道府県': '東京都', '代表者名': '山田太郎' }] },
    { system: 'C', source: 'PR TIMES', intent: 5, records: [{ '企業名': '株式会社アルファ', '法人番号': '1010001000001', 'プレスリリース': '増員', '採用ページ更新': '○' }] },
    { system: 'B', source: 'gBizINFO', intent: 1, records: [{ '企業名': '株式会社ベータ', '法人番号': '2020002000002', '従業員数': '120' }] },
  ];
  const { master, stats } = mergeSources(sources, c);
  const alpha = master.find((m) => m['法人番号'] === '1010001000001');
  ok('mergeSources: 法人番号で3ソースが1社に統合', master.length === 2 && alpha && alpha['ソース数'] === 3);
  ok('mergeSources: 役割固定で属性=B由来(従業員数/代表者名)', alpha['従業員数'] === '180' && alpha['代表者名'] === '山田太郎');
  ok('mergeSources: 新卒フラグ=A由来で立つ', alpha['新卒フラグ'] === '○');
  ok('mergeSources: intent★=系統C(5)＋トリガーで最大化', alpha['intent★'] === 5);
  ok('mergeSources: 取得元媒体に全ソースを連結', /マイナビ/.test(alpha['取得元媒体']) && /gBizINFO/.test(alpha['取得元媒体']) && /PR TIMES/.test(alpha['取得元媒体']));
  ok('mergeSources: 起点=系統A(新卒メディア)', alpha['起点系統'] === 'A');
  ok('mergeSources: 統計 unique=2 / 重複排除=2', stats.unique === 2 && stats.dedupRemoved === 2);
  return fail;
}

function testQualityExtras() {
  let fail = 0;
  const ok = (label, cond) => { if (cond) console.log('✓ ' + label); else { console.log('✗ ' + label); fail++; } };
  const { scoreRecord, gradeOf, scoreTiming, scoreIntent } = require('../src/quality');
  const c = require('../src/config');
  const icp = { target_industries: ['SaaS'], geography: ['東京都'] };
  const now = new Date('2026-08-15T00:00:00+09:00'); // 8月＝中だるみ(55)
  // 新卒フラグは出稿データ無しでも実シグナル扱い
  const flagged = scoreIntent({ '新卒フラグ': '○' }, c);
  ok('scoreIntent: 新卒フラグで proxy=false（背骨）', flagged.proxy === false && flagged.score >= 40);
  // intent★トリガーで proxy が外れる
  const trig = scoreIntent({ 'プレスリリース': '増員', '採用ページ更新': '○' }, c);
  ok('scoreIntent: 系統Cトリガーで★加点・proxy外れ', trig.stars >= 1 && trig.proxy === false);
  // 属性ランク
  ok('gradeOf: ICP高=A', gradeOf({ icp: 80 }, c) === 'A');
  ok('gradeOf: ICP中=B', gradeOf({ icp: 60 }, c) === 'B');
  ok('gradeOf: ICP低=C', gradeOf({ icp: 30 }, c) === 'C');
  // ゴールデンタイム：辞退シグナルで8月でもタイミング満点
  const t = scoreTiming({ '辞退シグナル': '○' }, c, now);
  ok('scoreTiming: 辞退シグナルで満点(ゴールデンタイム)', t.score === 100);
  // intent★割り込み：属性B以上＋★5でナーチャ→今週架電に昇格
  const rec = { '従業員数': '150', '業種': 'SaaS', '都道府県': '東京都', 'プレスリリース': 'x', '採用ページ更新': '○', 'インテント': '調査', '辞退シグナル': '○', 'intent★': '5' };
  const s = scoreRecord(rec, { icp, now, c });
  ok('scoreRecord: grade/stars を返す', ['A', 'B', 'C'].includes(s.grade) && typeof s.stars === 'number');
  return fail;
}

function testSourceKpiLogic() {
  let fail = 0;
  const ok = (label, cond) => { if (cond) console.log('✓ ' + label); else { console.log('✗ ' + label); fail++; } };
  const { computeSourceKpi, buildOutcomeIndex, sourcesOf, oNum } = require('../src/source-kpi');
  const c = require('../src/config');
  ok('oNum: 数値はそのまま', oNum('3') === 3);
  ok('oNum: ○は1', oNum('○') === 1);
  ok('oNum: 空は0', oNum('') === 0);
  ok('sourcesOf: origin=起点ソースのみ', JSON.stringify(sourcesOf({ '取得元媒体': 'A+B', '起点ソース': 'A' }, 'origin')) === '["A"]');
  ok('sourcesOf: touch=全ソース', JSON.stringify(sourcesOf({ '取得元媒体': 'A+B', '起点ソース': 'A' }, 'touch')) === '["A","B"]');
  const leads = [
    { '企業名': 'A社', '法人番号': '1010001000001', '取得元媒体': 'マイナビ', '起点ソース': 'マイナビ', '品質スコア': '80' },
    { '企業名': 'B社', '法人番号': '2020002000002', '取得元媒体': 'マイナビ', '起点ソース': 'マイナビ', '品質スコア': '40' },
    { '企業名': 'C社', '法人番号': '3030003000003', '取得元媒体': 'gBizINFO', '起点ソース': 'gBizINFO', '品質スコア': '70' },
  ];
  const outcomes = [
    { '法人番号': '1010001000001', '接続': '1', 'アポ': '1', '受注': '1', 'コスト': '3000' },
    { '法人番号': '2020002000002', '接続': '1', 'アポ': '0', '受注': '0', 'コスト': '2000' },
    { '法人番号': '3030003000003', '接続': '0', 'アポ': '0', '受注': '0', 'コスト': '2500' },
  ];
  const idx = buildOutcomeIndex(outcomes, c);
  const { rows } = computeSourceKpi(leads, idx, { attr: 'origin', c });
  const mynavi = rows.find((r) => r.source === 'マイナビ');
  ok('computeSourceKpi: マイナビ件数2', mynavi && mynavi.count === 2);
  ok('computeSourceKpi: マイナビ受注率=50%', mynavi && Math.abs(mynavi.wonRate - 0.5) < 1e-9);
  ok('computeSourceKpi: マイナビ適合率=50%(80点のみ)', mynavi && Math.abs(mynavi.fitRate - 0.5) < 1e-9);
  return fail;
}

// ---- 媒体ページ・スクレイパの純抽出ロジック検証（実DOM由来のfixtureで回帰固定・ネットワーク不要）----
function testMediaScrapers() {
  let fail = 0;
  const ok = (label, cond) => { if (cond) console.log('✓ ' + label); else { console.log('✗ ' + label); fail++; } };
  const { extractCompanyFacts, extractIntentSignals, extractRecruiterName, emptyResult } = require('../src/scrape-base');
  const { RikunabiScraper } = require('../src/scrape-rikunabi');

  // 共通スキーマの空テンプレ
  const tpl = emptyResult('株式会社サンプル', 'リクナビ掲載');
  ok('emptyResult: 共通スキーマ＋媒体掲載列を持つ', tpl.企業名 === '株式会社サンプル' && 'リクナビ掲載' in tpl && '従業員数' in tpl);

  // キャリタス corp 実テキスト（probeで捕獲：アフラック生命保険）
  const ctText = 'アフラック生命保険株式会社 4.08 2,938 フォロワー 企業データ 総資産： 13兆926億円 従業員数 4874人 創業/設立 1974 受付状況 本選考エントリー受付中';
  const ctFacts = extractCompanyFacts({ text: ctText });
  ok('キャリタス: 従業員数 4874 を抽出', ctFacts.従業員数 === '4874');
  ok('キャリタス: 設立 1974 を抽出', ctFacts.設立 === '1974');

  // ONE CAREER 企業ページ実テキスト（probeで捕獲：ワンキャリア社）
  const ocText = '企業情報 本社：東京都 資本金：59百万円 売上高：7,576百万円 従業員数：307名（平均臨時雇用者数148名）※2026年3月時点';
  const ocFacts = extractCompanyFacts({ text: ocText });
  ok('ONE CAREER: 従業員数 307 を抽出', ocFacts.従業員数 === '307');
  ok('ONE CAREER: 資本金 59百万円 を抽出（百万円表記）', ocFacts.資本金 === '59百万円');

  // リクナビ 本選考ビュー実テキスト（probeで捕獲：アイリスオーヤマ）
  const rkText = '新卒採用 アイリスオーヤマ株式会社 半導体・電子機器メーカー、食品・飲料メーカー、製造・メーカー 27年卒 宮城県、埼玉県、東京都 営業、SCM/生産管理/購買/物流、人事、広報/IR、商品企画、マーケティング・広告・宣伝 デザイン職';
  const rres = emptyResult('アイリスオーヤマ', 'リクナビ掲載');
  new RikunabiScraper()._readNewGrad(rkText, rres);
  ok('リクナビ: 卒年 27年卒 を抽出', rres.卒年 === '27年卒');
  ok('リクナビ: 職種を複数抽出（営業/人事/広報/企画等）',
    /営業/.test(rres.募集職種) && /人事/.test(rres.募集職種) && Number(rres.募集職種数) >= 4);

  // 従業員数: 体験談ノイズ("社員1人")を避け、本来の従業員数を採る
  ok('従業員数: 体験談"社員1人"を拾わず従業員数を採る',
    extractCompanyFacts({ text: '社員1人が活躍中 … 従業員数 5,000名' }).従業員数 === '5000');
  ok('従業員数: 括弧ラベル付き"従業員数（単体）21,404人"を採る',
    extractCompanyFacts({ text: '従業員数（単体）21,404人' }).従業員数 === '21404');
  // 募集職種: 職種語を含まない断片ノイズ（"ント"等）は採らない
  ok('募集職種: 断片ノイズ"ント"を弾く', !extractIntentSignals('マネジメント職').募集職種 || /営業|企画|職/.test(extractIntentSignals('募集職種 営業').募集職種));
  ok('募集職種: 職種語を含む実体は採る', /営業/.test(extractIntentSignals('募集職種：営業、エンジニア').募集職種));

  // 卒年表記ゆれ
  ok('卒年: "2027" を拾う', extractIntentSignals('2027年度採用').卒年 === '2027' || extractIntentSignals('2027年度採用').卒年 === '2027年');
  ok('卒年: "28卒" を拾う', extractIntentSignals('28卒 募集中').卒年 === '28卒');

  // 採用担当者名（人名辞書ゲート）
  const nm = extractRecruiterName('人事部 採用担当 早瀬 峻介 へお問い合わせください');
  ok('担当者名: 「早瀬 峻介」を抽出し部署/役職も付随', nm.name === '早瀬 峻介' && /人事/.test(nm.dept) && /採用担当/.test(nm.role));
  ok('担当者名: 役割語のみ（採用担当）は人名にしない', !extractRecruiterName('採用担当 までご連絡').name);
  // 採用窓口の部署(人事/総務/採用/管理)直後の氏名は採るが、事業部の社員インタビュー名は採らない（正しさ）
  ok('担当者名: 「総務部 松田龍治」は採用窓口→抽出', extractRecruiterName('連絡先 総務部 松田 龍治 TEL').name.replace(/[ 　]/g, '') === '松田龍治');
  ok('担当者名: 「マーケティング部 新垣凜」(社員インタビュー)は抽出しない', !extractRecruiterName('社員インタビュー トレードマーケティング部 新垣 凜').name);
  ok('担当者名: 「営業部 宇野修平」(先輩の声)は抽出しない', !extractRecruiterName('先輩インタビュー 営業部 宇野 修平 read more').name);
  // 姓＋一般語の誤検出（人事関連→関連）を looksLikePersonName ブロックリストで弾く
  ok('担当者名: 「人事関連」は氏名にしない（関連=一般語）', !extractRecruiterName('組織・人事関連 Recruit').name);
  ok('担当者名: 実在の関姓「採用担当 関根太郎」は抽出', extractRecruiterName('人事部 採用担当 関根 太郎').name.replace(/[ 　]/g, '') === '関根太郎');
  // 役職/地名が氏名に貼り付く現実形（jp-names.stripNonName 共有化で精度/再現率を両立）
  const baseName = (t) => (extractRecruiterName(t).name || '').replace(/[ 　]/g, '');
  ok('担当者名: 「中村課長」→中村（役職を氏名に含めない）', baseName('問合せ先 人事部 採用担当 中村課長 03-1111-1111') === '中村');
  ok('担当者名: 「山田太郎部長」→山田太郎', baseName('人事部 採用担当 山田太郎部長') === '山田太郎');
  ok('担当者名: 「田中花子採用担当」→田中花子（役割語を剥がす）', baseName('お問合せ 人事部 田中花子採用担当 mail@x.jp') === '田中花子');
  ok('担当者名: 「関東支店」は氏名にしない（地名片を弾く）', baseName('問合せ先 人事課 関東支店 048-000-0000') === '');
  ok('担当者名: 地名片「中央」は氏名にしない', baseName('管理部 中央 までご連絡') === '');

  // 採用メールのローカル部から姓を推定（中堅大手の数少ない個人名レバー。マイナビ実取得 Tsagara@→相良 で実証）
  const { nameFromEmail } = require('../src/romaji-name');
  const surOf = (e) => { const r = nameFromEmail(e); return r ? r.surname : ''; };
  ok('nameFromEmail: 「Tsagara@…」→相良（先頭イニシャル除去）', surOf('Tsagara@tos-kk.co.jp') === '相良');
  ok('nameFromEmail: 「ksato@…」→佐藤', surOf('ksato@x.co.jp') === '佐藤');
  ok('nameFromEmail: 「yamada.t@…」→山田', surOf('yamada.t@x.jp') === '山田');
  ok('nameFromEmail: ロール系「recruit@/saiyou@/info@」は姓にしない', !surOf('recruit@x.jp') && !surOf('saiyou@x.jp') && !surOf('info@x.jp'));
  // 拡張した姓（ランク~200）も拾う（マイナビ実走の取りこぼし補完: ogura→小倉, takeda→武田 等）
  ok('nameFromEmail: 「ogura.a@」→小倉（拡張姓）', surOf('ogura.a@tsuuden.co.jp') === '小倉');
  ok('nameFromEmail: 「seiichiro_takeda@」→武田（given_surname形）', surOf('seiichiro_takeda@x.co.jp') === '武田');
  ok('nameFromEmail: 「yoshimi.inoue@」→井上', surOf('yoshimi.inoue@x.co.jp') === '井上');
  return fail;
}

// ---- マイナビ『問合せ先』ブロックの構造分解（実産出経路）の精度回帰固定 ----
// 役割語/役職/地名が氏名に貼り付く・部署の直後に来る現実のレイアウトで、再現率と精度の両立を固定する。
function testMynaviContact() {
  let fail = 0;
  const { parseContactBlock } = require('../src/scrape-mynavi');
  const ok = (label, cond) => { if (cond) console.log('✓ ' + label); else { console.log('✗ ' + label); fail++; } };
  const nameOf = (t) => (parseContactBlock(t).採用担当者名 || '').replace(/[ 　]/g, '');
  // 実取得の本命形（部署→氏名→電話→メール）
  ok('問合せ先: 「人事総務部 野崎瑠美 …」→野崎瑠美（辞書外姓を構造で救出）', nameOf('問合せ先 人事総務部 野崎瑠美 03-6878-3814 saiyo@x.co.jp') === '野崎瑠美');
  // 氏名に役割語が貼り付く（再現率：旧来は取りこぼし）
  ok('問合せ先: 「田中花子採用担当」→田中花子（役割語を剥がす）', nameOf('お問合せ 人事部 田中花子採用担当 mail@x.jp') === '田中花子');
  ok('問合せ先: 「採用担当 山田太郎」→山田太郎', nameOf('お問い合わせ 人事部 採用担当 山田太郎 TEL:03-1234-5678') === '山田太郎');
  // 氏名に役職が貼り付く（部署照合が役職の「課」を飲み込まないこと）
  ok('問合せ先: 「中村課長」→中村（役職を剥がし、部署に飲ませない）', nameOf('問合せ先 人事部 採用担当 中村課長 03-1111-1111') === '中村');
  ok('問合せ先: 「山田太郎部長」→山田太郎', nameOf('問合せ先 人事部 山田太郎部長 03-1111-1111') === '山田太郎');
  // 多部署連結でも氏名を取れる
  ok('問合せ先: 「総務部人事課 佐々木」→佐々木', nameOf('問合せ先 総務部人事課 佐々木 03-1111-2222') === '佐々木');
  // 村/市で終わる頻出姓を地名と誤って捨てない（辞書完全一致の単独姓は採る）
  ok('問合せ先: 「西村」→西村（村で終わる姓を救う）', nameOf('問合せ先 人事部 西村 03-1111-1111') === '西村');
  // 精度：地名・組織語・役割のみは氏名にしない
  ok('問合せ先: 「関東支店」は氏名にしない', nameOf('問合せ先 人事課 関東支店 048-000-0000') === '');
  ok('問合せ先: 地名片「中央」は氏名にしない（辞書完全姓でない）', nameOf('問合せ先 管理部 中央 03-1111-1111') === '');
  ok('問合せ先: 「採用グループ」役割のみは氏名にしない', nameOf('問合せ先 人材開発部 採用グループ 03-0000-0000') === '');
  ok('問合せ先: 部署キーワードが無い面では辞書フルネームのみ（経営企画室 新規事業→∅）', nameOf('問合せ先 経営企画室 新規事業 03-2222-3333') === '');
  // 姓＋一般語の誤検出（人事関連→関連）を共通ブロックリストで弾く（scrape-base/scrape-namesと一貫）
  ok('問合せ先: 「人事部 関連」は氏名にしない（関連=一般語）', nameOf('問合せ先 人事部 関連 03-1-1') === '');
  ok('問合せ先: 実在の関姓「人事部 関根太郎」は抽出', nameOf('問合せ先 人事部 関根太郎 03-1-1') === '関根太郎');
  return fail;
}

// ---- 採用SNS／LinkedIn 検索結果タイトルからの氏名抽出（純ロジック・ネットワーク不要）----
// 「氏名 - 所属 - 役職 | 媒体」形式の公開タイトルを分解し、会社一致＋役割語＋姓辞書で氏名を確定する。
function testSocialScraping() {
  let fail = 0;
  const ok = (label, cond) => { if (cond) console.log('✓ ' + label); else { console.log('✗ ' + label); fail++; } };
  const { splitTitleSegments, extractNameFromResult, roleHit } = require('../src/scrape-social');
  const nameOf = (r, t, o) => { const g = extractNameFromResult(r, t, o); return g ? g.name : ''; };

  // セグメント分割（各種区切り・媒体ブランド語の分離）
  const segs = splitTitleSegments('山田 太郎 - 株式会社サンプル 採用担当 | LinkedIn');
  ok('SNS: タイトルを氏名/所属/媒体に分割', segs[0] === '山田 太郎' && segs.includes('LinkedIn'));

  // 役割語の検出（config.ROLE_KEYWORDS 再利用）
  ok('SNS: 役割語「採用担当」を検出', roleHit('新卒採用担当をしています') !== '');
  ok('SNS: 役割語が無ければ空', roleHit('プロダクトデザイナー') === '');

  // LinkedIn 形式: 氏名＋会社一致＋役割 → 抽出
  const li = { title: '山田 太郎 - 株式会社サンプル 採用担当 | LinkedIn', snippet: '株式会社サンプルの採用担当です', url: 'https://jp.linkedin.com/in/taro-yamada', domain: 'linkedin.com' };
  ok('LinkedIn: 会社一致＋役割で「山田太郎」を抽出', nameOf(li, '株式会社サンプル') === '山田太郎');

  // 会社が一致しない結果は氏名を出さない（誤帰属の排除）
  ok('LinkedIn: 別会社のプロフィールは抽出しない', nameOf(li, '株式会社まったく別') === '');

  // 役割語が無く requireRole の既定（true）では出さない／false なら出す
  const noRole = { title: '佐藤 花子 - 株式会社サンプル | Wantedly', snippet: '株式会社サンプルのメンバー', url: 'https://www.wantedly.com/id/x', domain: 'wantedly.com' };
  ok('SNS: 役割語なし＋requireRole(既定)で抽出しない', nameOf(noRole, '株式会社サンプル') === '');
  ok('SNS: 役割語なしでも requireRole:false なら抽出（広報投稿想定）', nameOf(noRole, '株式会社サンプル', { requireRole: false }) === '佐藤花子');

  // 媒体ブランド語そのものは氏名にしない／姓辞書で検証できないトークンも出さない
  const brandOnly = { title: 'LinkedIn', snippet: '', url: 'https://linkedin.com', domain: 'linkedin.com' };
  ok('SNS: ブランド語のみのタイトルは抽出しない', nameOf(brandOnly, '株式会社サンプル', { requireRole: false }) === '');
  const noName = { title: '採用情報 - 株式会社サンプル 採用担当 | LinkedIn', snippet: '採用担当', url: 'https://linkedin.com/x', domain: 'linkedin.com' };
  ok('SNS: 氏名トークンが無い（役割語のみ）タイトルは抽出しない', nameOf(noName, '株式会社サンプル') === '');
  return fail;
}

// ---- 半自動リサーチ補助（ワークシート生成／結果取込）の純ロジック検証 ----
// 自動アクセスはせず、人が集めた結果を姓辞書＋会社一致で検証して名寄せする経路を固定する。
function testResearchAssist() {
  let fail = 0;
  const ok = (label, cond) => { if (cond) console.log('✓ ' + label); else { console.log('✗ ' + label); fail++; } };
  const { buildRow, CHANNELS } = require('../src/research-queue');
  const { fromWorksheet, fromLines, dedup } = require('../src/ingest-research');

  // ワークシート: 各媒体の人手検索URLを社名入りで生成
  const row = buildRow('株式会社サンプル', '1234567890123');
  ok('queue: LinkedIn/X/Facebook の検索URLを生成', /linkedin\.com\/search/.test(row['LinkedIn']) &&
    /x\.com\/search/.test(row['X(Twitter)']) && /facebook\.com\/search/.test(row['Facebook']));
  ok('queue: 社名がURLエンコードで埋まる', decodeURIComponent(row['LinkedIn']).includes('株式会社サンプル'));

  // ワークシート取込: 姓辞書で検証（役割語だけの記入は弾く）
  const ws = fromWorksheet([
    { '企業名': '株式会社サンプル', '採用担当者名': '山田太郎', '役職': '人事部長', '根拠URL': 'u1', '見つかった媒体': 'LinkedIn' },
    { '企業名': '株式会社別', '採用担当者名': '採用担当' }, // 役割語のみ→却下
    { '企業名': '株式会社空', '採用担当者名': '' },         // 空→却下
  ]);
  ok('ingest(worksheet): 有効1件のみ採用（役割語/空を却下）', ws.length === 1 && ws[0]['採用担当者名'] === '山田太郎');
  ok('ingest(worksheet): 役職・根拠URL・媒体を保持', ws[0]['役職'] === '人事部長' && ws[0]['根拠URL'] === 'u1' && ws[0]['取得元媒体'] === 'LinkedIn');

  // 行テキスト取込: タイトル文を会社一致＋姓辞書ゲートに通す
  const fl = fromLines([
    '株式会社サンプル\t山田 太郎 - 株式会社サンプル 採用担当 | LinkedIn https://linkedin.com/in/x',
    '株式会社サンプル\t採用情報 - 株式会社サンプル 採用担当',   // 氏名なし→却下
    '株式会社別\t佐藤 花子 - 全然ちがう会社',                  // 会社不一致→却下
  ].join('\n'));
  ok('ingest(lines): 会社一致＋氏名ありの1件のみ採用', fl.length === 1 && fl[0]['採用担当者名'] === '山田太郎');
  ok('ingest(lines): URLを根拠として保持', fl[0]['根拠URL'] === 'https://linkedin.com/in/x');

  // 重複排除（同一社×氏名は確度の高い方を残す）
  const dd = dedup([
    { '企業名': '株式会社サンプル', '採用担当者名': '山田太郎', '担当者確度': 0.5 },
    { '企業名': '株式会社サンプル', '採用担当者名': '山田太郎', '担当者確度': 0.65 },
  ]);
  ok('ingest: 同一社×氏名は確度の高い方に集約', dd.length === 1 && Number(dd[0]['担当者確度']) === 0.65);
  return fail;
}

// ---- Google Workspace（社内資産）抽出の純ロジック検証（ネットワーク・認証不要部分）----
function testGoogleContacts() {
  let fail = 0;
  const ok = (label, cond) => { if (cond) console.log('✓ ' + label); else { console.log('✗ ' + label); fail++; } };
  const { parseFrom, contactFromMessage, collectPlainText } = require('../src/google-contacts');
  const { configured } = require('../src/google-auth');

  ok('parseFrom: 「氏名 <addr>」を分解', (() => { const p = parseFrom('山田太郎 <Taro@x.co.jp>'); return p.display === '山田太郎' && p.email === 'taro@x.co.jp'; })());
  ok('parseFrom: アドレスのみ', parseFrom('info@x.co.jp').email === 'info@x.co.jp');

  // Gmailのmultipart payloadから text/plain を集約
  const payload = { mimeType: 'multipart/alternative', parts: [
    { mimeType: 'text/plain', body: { data: Buffer.from('本文テキスト', 'utf8').toString('base64') } },
    { mimeType: 'text/html', body: { data: Buffer.from('<p>無視</p>', 'utf8').toString('base64') } },
  ] };
  ok('collectPlainText: text/plainのみ集約', collectPlainText(payload).join('') === '本文テキスト');

  // From表示名が日本語フルネーム → 抽出（会社はドメイン手がかりで担保）
  const c1 = contactFromMessage([{ name: 'From', value: '田中花子 <hanako@sample.co.jp>' }], '株式会社サンプルの採用担当です', '株式会社サンプル');
  ok('contact: From表示名「田中花子」を抽出', c1 && c1.name === '田中花子' && c1.where === 'from-display');
  // 表示名なし → メールのローカル部から姓推定（romaji-name）
  const c2 = contactFromMessage([{ name: 'From', value: 'ksato@sample.co.jp' }], '株式会社サンプル', '株式会社サンプル');
  ok('contact: 表示名なしはローカル部から姓推定（ksato→佐藤）', c2 && c2.name === '佐藤' && c2.where === 'email-localpart');
  // ロール系アドレスは姓にしない
  const c3 = contactFromMessage([{ name: 'From', value: 'recruit@sample.co.jp' }], 'テキスト', '株式会社サンプル');
  ok('contact: recruit@ 等ロール系は氏名にしない', !c3 || !c3.name);

  ok('google-auth: 未設定なら configured()=false（安全スキップ）', typeof configured() === 'boolean');
  return fail;
}

// ---- プレスリリース「お問い合わせ先」担当者抽出（精度優先・断片排除）検証 ----
// 実測歩留まりは低い（PR TIMESは問合せボタン化）が、取れた時の精度＝断片/役割語/組織語を出さないことを固定。
function testPressContact() {
  let fail = 0;
  const ok = (label, cond) => { if (cond) console.log('✓ ' + label); else { console.log('✗ ' + label); fail++; } };
  const { extractPressContact } = require('../src/press-contact');
  const nameOf = (t) => { const r = extractPressContact(t); return r ? r.name : ''; };

  ok('press: 「人事部 採用担当：山田太郎」→山田太郎＋メール', (() => {
    const r = extractPressContact('本件に関するお問い合わせ先 株式会社サンプル 人事部 採用担当：山田太郎 TEL: 03-1234-5678 E-mail: saiyo@sample.co.jp');
    return r && r.name === '山田太郎' && r.email === 'saiyo@sample.co.jp' && /人事|採用/.test(r.role + r.dept);
  })());
  ok('press: 「広報部 担当 佐藤花子」→佐藤花子', nameOf('【お問い合わせ先】 広報部 担当 佐藤花子 Tel 06-1111-2222') === '佐藤花子');
  ok('press: 「コーポレート本部 田中一郎」(ラベルなし部署+氏名)→田中一郎', nameOf('報道関係者からのお問い合わせ ○○株式会社 コーポレート本部 田中一郎 mail@x.co.jp') === '田中一郎');
  // 精度: 役割語のみ・氏名なし・断片連結は出さない
  ok('press: 役割語のみ「採用担当 まで」は氏名にしない', nameOf('お問い合わせ先 採用担当 までご連絡ください') === '');
  ok('press: 氏名なし「経営企画室 新規事業」は出さない', nameOf('本リリースに関するお問い合わせ 経営企画室 新規事業 03-0000-0000') === '');
  ok('press: 断片連結「小沢 お問」「関連リンク」を氏名にしない', nameOf('お問い合わせ先 広報 お問い合わせはこちら 関連リンク 詳細') === '');
  ok('press: マーカーが無ければ抽出しない', nameOf('本日新サービスを発表しました。詳細はサイトをご覧ください。') === '');
  return fail;
}

// ---- テック源（GitHub技術者／connpassイベント）氏名抽出の純ロジック検証 ----
// IT/Web企業に限り公開APIで実名が構造的に取れる。ハンドルでなく実名のみ採用、社名一致で誤帰属排除。
function testTechSources() {
  let fail = 0;
  const ok = (label, cond) => { if (cond) console.log('✓ ' + label); else { console.log('✗ ' + label); fail++; } };
  const { looksLikeRealName, orgCandidatesFromUrl } = require('../src/scrape-github');
  const { presentersFromDescription, configured } = require('../src/scrape-connpass');

  // 実名らしさ: 英字フルネーム/漢字フルネームは採用、ハンドルは却下
  ok('github: 「Taro Yamada」は実名', looksLikeRealName('Taro Yamada'));
  ok('github: 「柏木大輔」は実名', looksLikeRealName('柏木大輔'));
  ok('github: ハンドル「xy_01」「dqneo」は却下', !looksLikeRealName('xy_01') && !looksLikeRealName('dqneo'));
  ok('github: 単一英単語「mercari」は却下', !looksLikeRealName('mercari'));

  // connpass description から登壇者/主催の氏名を姓辞書ゲートで抽出
  const pres = presentersFromDescription('<p>登壇者：山田太郎（人事）、スピーカー 佐藤花子 司会 田中</p>');
  ok('connpass: 「登壇者：山田太郎」「スピーカー 佐藤花子」を抽出', pres.includes('山田太郎') && pres.includes('佐藤花子'));
  ok('connpass: 単独姓「田中」(役割直後でない)は拾わない', !pres.includes('田中'));
  ok('connpass: キー未設定なら configured()=false（安全スキップ）', configured() === false);

  // ドメイン→orgログイン候補（eTLD+1でSLDを畳む・汎用ベンダードメインは空）
  ok('github: cybozu.co.jp→候補cybozu', orgCandidatesFromUrl('https://cybozu.co.jp/').includes('cybozu'));
  ok('github: corp.freee.co.jp→候補freee（サブドメイン畳み）', orgCandidatesFromUrl('https://corp.freee.co.jp/').includes('freee'));
  ok('github: 汎用ベンダー dell.com は候補ゼロ（誤帰属遮断）', orgCandidatesFromUrl('https://www.dell.com/ja-jp').length === 0);
  ok('github: ikea.com も候補ゼロ', orgCandidatesFromUrl('https://www.ikea.com/jp/ja/').length === 0);
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
    // 抽出はローカル処理（OLLAMA_URL未設定時はヒューリスティック）。外部AI APIへの課金は発生しない。
    const ext = await extractContact({ text, companyName: c.name });
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
  console.log('\n--- 姓ガゼッティア（再現率拡充／地名片の精度）検証 ---');
  failures += testSurnameDict();
  console.log('\n--- 採用担当者名取得層（Wantedly/ハローワーク）ロジック検証 ---');
  failures += testNameScraping();
  console.log('\n--- 企業名 自動発見 検証 ---');
  failures += testDiscover();
  console.log('\n--- 構造化抽出(JSON-LD/sitemap) 検証 ---');
  failures += testStructured();
  console.log('\n--- 市外局番テーブル 検証 ---');
  failures += testAreacode();
  console.log('\n--- 所在地トークン化 検証 ---');
  failures += testAddressTokens();
  console.log('\n--- URL発見（検索）ロジック 検証 ---');
  failures += testSearch();
  console.log('\n--- スプレッドシートI/O ヘルパー検証 ---');
  failures += testSheetHelpers();
  failures += await testGasJsonGuard();
  console.log('\n--- 統合パイプライン（究極の営業リスト）ロジック検証 ---');
  failures += testPipelineLogic();
  console.log('\n--- gBizINFO 発掘フィルタ（業種KW/設立年/補助金）検証 ---');
  failures += testGbizLogic();
  console.log('\n--- リスト品質スコアリング（4ディメンション加重）検証 ---');
  failures += testQualityLogic();
  console.log('\n--- CSV/名寄せキー（法人番号・社名正規化）検証 ---');
  failures += testCsvKeys();
  console.log('\n--- 多系統マージ・名寄せ（役割固定/intent★/出所）検証 ---');
  failures += testMergeLogic();
  console.log('\n--- スコアリング拡張（新卒フラグ軸/トリガー★/属性ランク/ゴールデンタイム）検証 ---');
  failures += testQualityExtras();
  console.log('\n--- ソース別KPI（下流・利回り評価）検証 ---');
  failures += testSourceKpiLogic();
  console.log('\n--- 媒体ページ・スクレイパ（リクナビ/キャリタス/ONE CAREER）抽出ロジック検証 ---');
  failures += testMediaScrapers();
  console.log('\n--- マイナビ『問合せ先』構造分解（担当者名の精度／再現率）検証 ---');
  failures += testMynaviContact();
  console.log('\n--- 採用SNS／LinkedIn 検索結果からの氏名抽出（会社一致／役割語／姓辞書）検証 ---');
  failures += testSocialScraping();
  console.log('\n--- 半自動リサーチ補助（ワークシート生成／結果取込）検証 ---');
  failures += testResearchAssist();
  console.log('\n--- Google Workspace 社内資産抽出（From/署名/メール姓推定）検証 ---');
  failures += testGoogleContacts();
  console.log('\n--- プレスリリース「お問い合わせ先」担当者抽出（精度優先）検証 ---');
  failures += testPressContact();
  console.log('\n--- テック源（GitHub技術者／connpassイベント）氏名抽出 検証 ---');
  failures += testTechSources();

  if (failures > 0) { console.error(`\nSELFTEST FAILED: ${failures} case(s)`); process.exit(1); }
  console.log('\nSELFTEST PASSED ✓  (抽出→検証→集計 ＋ スプレッドシートI/O ロジックが正常動作)');
}

run().catch(e => { console.error('SELFTEST ERROR', e); process.exit(1); });
