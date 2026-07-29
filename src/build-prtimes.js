'use strict';
// PR TIMES プレスリリースから企業レコードを量産（無料・検索エンジン非依存・robots遵守）。
// =====================================================================
// 発見（2026-06-26）: 無料Webの最大の壁は「社名→URL解決（無料検索がブロック）」だった。
//   PR TIMES は (a)keyword topicページで採用系リリースを列挙でき、(b)各リリースの会社概要に
//   企業名・公式URL・代表者名・業種・所在地・上場区分が構造化されている＝検索エンジン不要で
//   「URL付き企業レコード」を量産できる。代表者名はほぼ全件に在り＝架電宛名として即利用可。
//   公式URLから自社採用ページを深掘り(probe-recruit-page)すれば採用担当者名(~27%)も付与できる。
//
//   node src/build-prtimes.js --out sources/prtimes-companies.csv --target 1500
//   node src/build-prtimes.js --out sources/prtimes-companies.csv --target 1500 --enrich 300  # 上位300社を自社crawl
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { politeGet } = require('./polite');
const { toCsv, readCsv, normCompanyName } = require('./csv');
const { isPlausiblePersonName } = require('./jp-names');
const { extractPressContact } = require('./press-contact');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
const OUT = getArg('out', path.join('sources', 'prtimes-companies.csv'));
const TARGET = parseInt(getArg('target', '1500'), 10) || 1500;
const MAX_PAGES = parseInt(getArg('pages', '8'), 10) || 8;   // keyword topicごとのページ上限
const ENRICH = parseInt(getArg('enrich', '0'), 10) || 0;     // 公式URLから採用担当者名を付与する社数
const NONLISTED_ONLY = process.argv.includes('--nonlisted'); // 未上場のみ採用

// 採用・人事系のキーワードトピック（採用PRを出す＝能動採用企業に寄る）。
const KEYWORDS = ['新卒採用', '採用', '中途採用', '人事', '採用強化', '採用活動', 'キャリア採用',
  '新入社員', '内定式', '入社式', '採用イベント', 'インターンシップ', '採用サイト', '人材採用',
  '採用ブランディング', '採用開始', '求人', '採用DX', '採用広報', '組織開発',
  // 業界・一般語トピックで量を稼ぐ（採用PRを出す能動企業が広く混ざる）
  '資金調達', '業務提携', '新サービス', '新商品', 'オフィス移転', '事業拡大', 'IPO', '新規事業',
  'キャンペーン', '導入事例', 'SaaS', 'DX', 'AI', 'スタートアップ', '働き方改革', 'EC',
  '福利厚生', '表彰', '受賞', '周年', '社名変更', '新会社', '拠点開設', 'パートナー',
  'アプリ', 'リニューアル', 'コラボ', '販売開始', '予約開始', 'クラウドファンディング', '展示会',
  'セミナー', 'ウェビナー', '調査', 'ランキング', 'キャッシュレス', 'サブスク', 'D2C', 'フィンテック',
  'ヘルスケア', '介護', '保育', '教育', 'EdTech', '不動産', '建設', '物流', '製造業', '飲食',
  '小売', 'アパレル', '美容', '旅行', '観光', 'ペット', '食品', '農業', 'エネルギー', '環境',
  'IoT', 'ロボット', 'ドローン', 'メタバース', 'NFT', 'Web3', 'ゲーム', '動画', 'EC支援', '広告',
  'マーケティング', 'コンサルティング', 'BPO', 'アウトソーシング', '人材', 'HRtech', '営業支援',
  '地方創生', '中小企業', 'ものづくり', 'サステナビリティ', 'SDGs', '健康経営', 'ダイバーシティ',
  // 追加バッチ（さらに量を稼ぐ）
  '新店舗', 'オープン', '開業', '出店', '生産性', '業績', '増収', '黒字', 'M&A', '子会社',
  'ブランド', 'コンテンツ', 'ライブ', 'イベント開催', 'コンテスト', 'モニター', '無料', '値下げ',
  '機能追加', 'アップデート', 'ベータ版', '正式版', 'API', 'プラットフォーム', 'マッチング',
  'シェアリング', 'サブスクリプション', '定期便', 'オンライン', 'リモート', 'ハイブリッド',
  'キャリア', '研修', 'eラーニング', 'リスキリング', '資格', '検定', '認定', '導入', '提携',
  '共同開発', '実証実験', '特許', '受注', '納入', '採択', '補助金', '助成金', 'グッドデザイン',
  // 第3バッチ（1000超えのための追加量）
  '新春', '春', '夏', '秋', '冬', '限定', '記念', 'プレゼント', '体験', '試食', '監修', '共同',
  'リブランディング', 'ロゴ', 'コーポレートサイト', 'オウンドメディア', 'YouTube', 'TikTok', 'Instagram',
  'LINE', 'アプリリリース', 'Android', 'iOS', 'クラウド', 'セキュリティ', 'データ分析', 'BI',
  'マーケ', 'CRM', 'MA', 'SFA', '受付', '予約システム', '決済', 'ポイント', 'ギフト', 'ふるさと納税',
  'サブスクリプションサービス', 'コワーキング', 'シェアオフィス', 'ワーケーション', '移住', '関係人口',
  '一次産業', '水産', '林業', '酪農', '伝統', '工芸', '老舗', '町工場', '製造DX', 'スマートファクトリー'];

function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// PR TIMES「代表者名」ラベル直後の値を整形。ラベル付き＝人名確定なので、isPlausiblePersonNameの
// 厳格ゲート（姓辞書/全漢字/≤6字）に頼らず、末尾の制度語を剥がし軽く検証して受ける（珍姓・かな名・代表取締役肩書きも許容）。
function cleanRepName(raw) {
  let s = String(raw || '').replace(/[ 　]/g, '');
  // 末尾に貼り付く制度語・肩書きを除去
  s = s.replace(/(上場.*|未上場.*|資本金.*|設立.*|電話.*|代表取締役社?長?|代表取締|取締役社?長?|CEO|社長|会長|理事長|院長|店長|園長|代表)$/g, '');
  s = s.replace(/^(代表取締役社?長?|代表取締|取締役|CEO|社長|会長|理事長|代表)/g, '');
  if (s.length < 2 || s.length > 8) return '';
  if (/[A-Za-z0-9０-９@.\/、。（）()]/.test(s)) return '';
  if (/採用|人事|総務|担当|事業|株式|有限|会社|部$|課$|室$|営業|本社|支店/.test(s)) return '';
  if (/^(東京|大阪|名古屋|横浜|本社|当社|同社|弊社)/.test(s)) return '';
  if (!/^[一-龥々ぁ-んァ-ヶ]+$/.test(s)) return '';
  return s;
}

// リリースHTMLの会社概要ブロックから企業レコードを構造抽出。
function parseRelease(html) {
  const $ = cheerio.load(html);
  const rec = { 企業名: '', 公式URL: '', 業種: '', 都道府県: '', 電話番号: '', 代表者名: '', 上場: '', 設立: '', 取得元: 'PR TIMES' };
  rec.企業名 = (($('title').text() || '').split(/[|｜]/).slice(-1)[0] || '').replace(/のプレスリリース.*$/, '').trim();
  const t = $('body').text().replace(/[ \t　]+/g, ' ');
  // 会社概要ブロック（ラベル連結）。会社名〜設立/資本金の範囲を作業領域に。
  const seg = (t.match(/会社名[\s\S]{0,500}?(?:設立|資本金|関連リンク|プレスリリース詳細)/) || [t])[0];
  const pick = (re) => { const m = seg.match(re); return m ? m[1].trim() : ''; };
  rec.公式URL = pick(/URL\s*(https?:\/\/[a-zA-Z0-9.\-\/_%?=&#~]+)/);
  rec.業種 = pick(/業種\s*([^\s：:]{2,14}?)(?:本社|所在地|電話|代表|URL)/);
  rec.都道府県 = (seg.match(/(北海道|東京都|京都府|大阪府|.{2,3}県)/) || [''])[0];
  rec.電話番号 = pick(/電話番号\s*([0-9０-９][\d０-９\-－]{7,})/);
  // 代表者名: ラベル直後の連結値を広めに取り、cleanRepName で整形（珍姓・かな名も拾う）。
  rec.代表者名 = cleanRepName(pick(/代表者(?:名)?[：:\s]*([一-龥々ぁ-んァ-ヶ]{2,12}(?:[ 　][一-龥々ぁ-んァ-ヶ]{1,8})?)/));
  rec.上場 = pick(/上場\s*(未上場|東証[^\s]{0,6}|名証[^\s]{0,4}|上場)/);
  rec.設立 = (seg.match(/設立\s*((?:19|20)\d{2})\s*年/) || [, ''])[1];
  // 追加レバー: 本文末尾の「お問い合わせ先 担当：氏名」を拾う（採用系リリースは人事/採用担当のことが多い）。
  // 実測歩留まりは低い（PR TIMESは問合せをボタン化しており本文露出は稀）が、取れた時はラベル付き＝高確度。
  const bodyText = ($('article').first().text() || $('main').first().text() || $('body').text()).replace(/[ \t　]+/g, ' ');
  const contact = extractPressContact(bodyText);
  if (contact && contact.name) { rec.採用担当者名 = contact.name; rec.担当役職 = contact.role || contact.dept || ''; }
  return rec;
}

// keyword topic を辿って採用系リリースURLを集める（ページング・robots遵守）。
async function collectReleaseUrls(target) {
  const urls = new Set();
  const enc = encodeURIComponent;
  // 一般フィードも種に
  for (const f of ['https://prtimes.jp/index.rdf', 'https://prtimes.jp/main/html/index/']) {
    const r = await politeGet(f, { render: 'static', text: f.endsWith('.rdf') }).catch(() => null);
    const b = r && (r.body || r.html) || '';
    for (const m of b.matchAll(/https?:\/\/prtimes\.jp\/main\/html\/rd\/p\/[0-9.]+\.html/g)) urls.add(m[0]);
  }
  for (const kw of KEYWORDS) {
    if (urls.size >= target * 2) break;
    for (let pg = 1; pg <= MAX_PAGES; pg++) {
      const u = `https://prtimes.jp/topics/keywords/${enc(kw)}` + (pg > 1 ? `?page=${pg}` : '');
      const r = await politeGet(u, { render: 'static' }).catch(() => null);
      if (!r || r.blocked || !r.html) break;
      const before = urls.size;
      for (const m of r.html.matchAll(/\/main\/html\/rd\/p\/[0-9.]+\.html/g)) urls.add('https://prtimes.jp' + m[0]);
      const added = urls.size - before;
      if (added === 0) break;     // このキーワードは打ち止め
    }
    log(`  keyword「${kw}」まで 累計リリースURL ${urls.size}`);
  }
  return [...urls];
}

async function run() {
  const OUTABS = path.resolve(OUT);
  fs.mkdirSync(path.dirname(OUTABS), { recursive: true });
  const byCompany = new Map();
  if (!process.argv.includes('--fresh') && fs.existsSync(OUTABS)) {
    try { for (const r of readCsv(fs.readFileSync(OUTABS, 'utf8')).records) { const k = normCompanyName(r['企業名']); if (k) byCompany.set(k, r); } } catch (_) {}
    if (byCompany.size) log(`再開: 既存 ${byCompany.size}社`);
  }
  const headers = ['企業名', '代表者名', '採用担当者名', '架電宛名', '公式URL', '業種', '都道府県', '電話番号', '上場', '設立', '取得元', '根拠URL', '取得日'];
  const flush = () => { const tmp = OUTABS + '.tmp'; fs.writeFileSync(tmp, toCsv(headers, [...byCompany.values()])); fs.renameSync(tmp, OUTABS); };

  log(`PR TIMES リリースURL収集（目標 ${TARGET}社）…`);
  const relUrls = await collectReleaseUrls(TARGET);
  log(`リリースURL ${relUrls.length}件 → 会社概要をパース`);

  const today = new Date().toISOString().slice(0, 10);
  let done = 0;
  for (const u of relUrls) {
    if (byCompany.size >= TARGET) break;
    const r = await politeGet(u, { render: 'static' }).catch(() => null);
    done++;
    if (!r || !r.html) continue;
    const rec = parseRelease(r.html);
    if (!rec.企業名) continue;
    // 非ターゲット除外（自治体・官公庁・大学・外国法人の機種依存社名）
    if (/(市役所|町役場|村役場|県庁|区役所|官公庁|地方自治体|大学$|高等学校|中学校|小学校)/.test(rec.企業名 + rec.業種)) continue;
    if (NONLISTED_ONLY && rec.上場 && !/未上場/.test(rec.上場)) continue;
    const key = normCompanyName(rec.企業名);
    if (!key || byCompany.has(key)) continue;
    const repOk = !!rec.代表者名;   // cleanRepName で整形・検証済み
    byCompany.set(key, {
      企業名: rec.企業名, 代表者名: rec.代表者名, 採用担当者名: rec.採用担当者名 || '',
      架電宛名: rec.採用担当者名 ? `${rec.採用担当者名} 様` : (repOk ? `${rec.代表者名} 様` : ''), 公式URL: rec.公式URL,
      業種: rec.業種, 都道府県: rec.都道府県, 電話番号: rec.電話番号,
      上場: rec.上場, 設立: rec.設立, 取得元: 'PR TIMES', 根拠URL: u, 取得日: today,
    });
    if (byCompany.size % 20 === 0) { flush(); log(`  ${byCompany.size}/${TARGET}社（代表者名つき）`); }
  }
  flush();
  const withRep = [...byCompany.values()].filter((r) => r['代表者名']).length;
  const withUrl = [...byCompany.values()].filter((r) => r['公式URL']).length;
  log(`収集完了: ${byCompany.size}社 ｜ 代表者名 ${withRep} ｜ 公式URL ${withUrl}`);

  // 任意: 公式URLから採用担当者名を付与（自社ページ深掘り）
  if (ENRICH > 0) {
    const { probeRecruitPage } = require('./probe-recruit-page');
    const targets = [...byCompany.values()].filter((r) => r['公式URL'] && !r['採用担当者名']).slice(0, ENRICH);
    log(`採用担当者名エンリッチ: ${targets.length}社を自社ページ深掘り`);
    let got = 0;
    for (const row of targets) {
      let hit = null; try { hit = await probeRecruitPage(row['公式URL'], { companyName: row['企業名'], maxPages: 5 }); } catch (_) {}
      if (hit && hit.name) { row['採用担当者名'] = hit.name; row['架電宛名'] = `${hit.name} 様`; got++; }
      if (++done % 10 === 0) flush();
    }
    flush();
    log(`エンリッチ完了: 採用担当者名 +${got}社`);
  }
  log(`出力: ${OUTABS}`);
}

run().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
