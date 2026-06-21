'use strict';
// 採用担当者「個人名」つきリストを Wantedly募集 から discovery-first で大量取得する。
//
// 背景（recruiter-name-segment-finding / name-acquisition-layer の続き）:
//   個人名が公開で出るのは採用広報が活発な媒体（Wantedly等）。
//   従来の company-first（既存リストの社名→検索→会社一致）は中堅大手母集団で歩留まり0%だった。
//   ＝抽出技術でなく「母集団」の問題。
//   そこで母集団ごと Wantedly 側へ移す:
//     sitemap が公開する全募集URL（数十万件）を起点に、各募集ページから
//     (掲載企業, 投稿者=採用担当者) を直接刈り取る。会社一致ガード不要（会社はページから取る）。
//
// 設計:
//   - sitemap は gzip + S3 への 301。専用 fetchGz（リダイレクト追従＋gunzip）で取得（礼儀の sleep つき）。
//   - 募集ページ取得は polite.js 経由（robots遵守・ホスト別レート制限・ディスクキャッシュ）。
//   - 氏名確定は既存資産: jp-names.isFullName（姓辞書）＝漢字フルネーム。加えてローマ字フルネームも許容
//     （Wantedly は外資/エンジニアでローマ字表記が多く、採用担当者名として実用可能）。
//   - 会社単位で重複排除（1社1行）。投稿IDは連番で同一社が固まるため、プールを stride サンプリングして会社多様性を確保。
//   - 中断/再開対応: 処理済みID journal（JSON）＋ 出力CSVのアトミック書込（.tmp→rename）。
//
// 使い方:
//   node src/harvest-wantedly.js --out data/recruiter-wantedly.csv --target 1000
//   環境変数 SCRAPE_DELAY_MS で取得間隔（既定 polite.js=4000ms。本バッチは2500推奨）。

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const cheerio = require('cheerio');
const { politeGet } = require('./polite');
const { isFullName } = require('./jp-names');
const { normCompanyName, toCsv, readCsv } = require('./csv');

const UA = 'Mozilla/5.0 (compatible; MochicaResearchBot/0.1; +recruiter-list-poc)';
const SITEMAP_INDEX = 'https://www.wantedly.com/sitemaps/sitemap.xml.gz';

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
const OUT = path.resolve(__dirname, '..', getArg('out', 'data/recruiter-wantedly.csv'));
const JOURNAL = OUT.replace(/\.csv$/, '') + '.journal.json';
const TARGET = parseInt(getArg('target', '1000'), 10);
const MAX_FETCH = parseInt(getArg('max-fetch', '6000'), 10);   // 取得上限（暴走/無限ループ防止）
const STRIDE = parseInt(getArg('stride', '0'), 10);            // 0=自動
const FRESH = process.argv.includes('--fresh');

const HEADERS = ['企業名', '公式URL', '採用担当者名', '役職', '部署', '確度', '取得元', '根拠URL', '根拠'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }

// ---- gzip + リダイレクト追従の素朴フェッチ（sitemap専用） ----
function fetchGz(url, depth = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && depth < 6) {
        r.resume();
        return fetchGz(new URL(r.headers.location, url).href, depth + 1).then(resolve, reject);
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        let buf = Buffer.concat(chunks);
        try { buf = zlib.gunzipSync(buf); } catch (_) { /* 非gzipはそのまま */ }
        resolve(buf.toString('utf8'));
      });
    }).on('error', reject);
  });
}

// ---- sitemap から全募集IDを収集 ----
async function collectProjectIds() {
  log('sitemap index 取得...');
  const idx = await fetchGz(SITEMAP_INDEX);
  const children = [...idx.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
  log(`子sitemap ${children.length} 件`);
  const ids = new Set();
  for (const child of children) {
    let body;
    try { body = await fetchGz(child); } catch (e) { log(`  skip ${child}: ${e.message}`); continue; }
    const before = ids.size;
    for (const m of body.matchAll(/\/projects\/(\d+)/g)) ids.add(m[1]);
    const added = ids.size - before;
    if (added > 0) log(`  ${child.split('/').pop()} +${added} (cum ${ids.size})`);
    await sleep(800); // S3にも礼儀
  }
  return [...ids];
}

// ---- 募集ページから (企業, 採用担当者名) を抽出 ----
function romajiName(t) {
  // "Taro Yamada" / "John A. Smith" 等の2語以上ローマ字フルネーム
  const m = String(t).trim().match(/^([A-Z][a-zA-Z]+)(?:\s+[A-Z]\.?)?\s+([A-Z][a-zA-Z]+)$/);
  if (!m) return null;
  // ありがちな非人名語を弾く
  const bad = /^(The|And|For|New|Team|Inc|Co|Ltd|Corp|Group|Japan|Tokyo|Osaka|Sales|Engineer|Manager|Career|Wantedly)$/i;
  if (bad.test(m[1]) || bad.test(m[2])) return null;
  return `${m[1]} ${m[2]}`;
}

// FocusedMemberName 専用の緩い人名判定（姓辞書に無い稀姓の救出）。
//   許容: 2〜5字、漢字/ひらがな/カタカナのみ、数字/英字/記号なし、非人名語でない。
const NON_NAME = /(株式会社|有限会社|合同会社|採用|担当|人事|事務|総務|広報|募集|応募|チーム|株式|会社|公式|運営|管理|代表|社員|スタッフ|窓口|部門|事業|本部|支店|お問い)/;
function looksLikeJpName(s) {
  if (!s) return false;
  if (s.length < 2 || s.length > 5) return false;
  if (!/^[一-龥々ぁ-んァ-ヶー]+$/.test(s)) return false; // 漢字/かなのみ
  if (NON_NAME.test(s)) return false;
  if (/^[ぁ-ん]+$/.test(s) && s.length < 3) return false; // 平仮名のみの極短は弾く（ニックネーム保険）
  return true;
}

function extractFromProject(html) {
  const $ = cheerio.load(html);
  // 企業名: 募集ページ上の /companies/ アンカー（最初の非空・短いテキスト）
  let company = '', companyUrl = '';
  $('a[href*="/companies/"]').each((_, a) => {
    if (company) return;
    const t = $(a).text().replace(/\s+/g, ' ').trim();
    if (t && t.length <= 60) { company = t; companyUrl = $(a).attr('href') || ''; }
  });
  if (!company) {
    // og:title 末尾の「… - ○○株式会社の…の採用 - Wantedly」から会社を救出
    const og = $('meta[property="og:title"]').attr('content') || '';
    const m = og.match(/-\s*([^-]*?(?:株式会社|合同会社|有限会社|Inc\.?|Co\.,?|Ltd\.?)[^-]*?)の/);
    if (m) company = m[1].trim();
  }

  // 採用担当者: FocusedMember（主投稿者）を最優先、なければ一般 MemberName。
  //  - 漢字フルネーム: jp-names.isFullName（姓辞書）で検証＝高精度。
  //  - ローマ字フルネーム: romajiName。
  //  - 上記で取れず、かつ FocusedMemberName 要素（構造上「投稿者の表示名」しか入らない）なら、
  //    2〜5字の漢字/かな列を人名として許容（姓辞書に無い稀姓を救出）。誤検出防止に非人名語は除外。
  let name = null, where = '', conf = 0;
  const tryStrict = (raw) => {
    const compact = raw.replace(/[ 　]/g, '');
    if (isFullName(compact)) { name = compact; where = 'kanji'; conf = 0.6; return true; }
    const rj = romajiName(raw);
    if (rj) { name = rj; where = 'romaji'; conf = 0.5; return true; }
    return false;
  };
  for (const sel of ['[class*="FocusedMemberName"]', '[class*="MemberName"]']) {
    $(sel).each((_, e) => { if (!name) { const raw = $(e).text().replace(/\s+/g, ' ').trim(); if (raw) tryStrict(raw); } });
    if (name) break;
  }
  // フォールバック: FocusedMemberName 要素の意味的保証を使った稀姓の救出
  if (!name) {
    $('[class*="FocusedMemberName"]').each((_, e) => {
      if (name) return;
      const compact = $(e).text().replace(/\s+/g, ' ').replace(/[ 　]/g, '').trim();
      if (looksLikeJpName(compact)) { name = compact; where = 'focused'; conf = 0.45; }
    });
  }
  return { company, companyUrl, name, where, conf };
}

// ---- 決定的シャッフル（連番クラスタを崩し会社多様性を上げる。Math.randomは使わない） ----
function strideOrder(ids, stride) {
  const n = ids.length;
  if (n === 0) return [];
  if (!stride || stride < 1) stride = Math.max(1, Math.floor(n / Math.max(1, MAX_FETCH)) || 1);
  // 互いに素になりやすい奇数stride＋大きめ素数オフセットで全要素を一巡する
  let s = stride; while (s > 1 && gcd(s, n) !== 1) s++; // n と互いに素にして全走査を保証
  const order = [];
  for (let i = 0, k = 0; i < n; i++, k = (k + s) % n) order.push(ids[k]);
  return order;
}
function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }

async function main() {
  // 既存出力＋journalの読み込み（再開）
  let out = [];
  const seenCompany = new Set();
  const processed = new Set();
  if (!FRESH && fs.existsSync(OUT)) {
    try {
      const recs = readCsv(fs.readFileSync(OUT, 'utf8')).records;
      for (const r of recs) {
        out.push(r);
        const c = normCompanyName(r['企業名'] || '');
        if (c && r['採用担当者名']) seenCompany.add(c);
      }
    } catch (_) {}
  }
  if (!FRESH && fs.existsSync(JOURNAL)) {
    try { JSON.parse(fs.readFileSync(JOURNAL, 'utf8')).forEach((x) => processed.add(String(x))); } catch (_) {}
  }
  const named = () => out.filter((r) => r['採用担当者名']).length;
  log(`再開: 既存 ${out.length} 行 / 採用担当者名あり ${named()} / 処理済ID ${processed.size}`);

  if (named() >= TARGET) { log(`既に目標 ${TARGET} 達成。終了。`); return; }

  // 募集IDプール
  let ids = await collectProjectIds();
  log(`募集ID プール: ${ids.length} 件`);
  ids = ids.filter((id) => !processed.has(id));
  ids = strideOrder(ids, STRIDE);
  log(`未処理 ${ids.length} 件を stride サンプリング順で処理（取得上限 ${MAX_FETCH}）`);

  const flush = () => {
    const tmp = OUT + '.tmp';
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(tmp, toCsv(HEADERS, out));
    fs.renameSync(tmp, OUT);
    fs.writeFileSync(JOURNAL, JSON.stringify([...processed]));
  };

  let fetched = 0, hit = 0, dead = 0, dup = 0, noname = 0;
  for (const id of ids) {
    if (named() >= TARGET) { log(`目標 ${TARGET} 達成！`); break; }
    if (fetched >= MAX_FETCH) { log(`取得上限 ${MAX_FETCH} 到達。`); break; }
    const url = 'https://www.wantedly.com/projects/' + id;
    let r;
    try { r = await politeGet(url, { render: 'static' }); } catch (e) { r = null; }
    processed.add(id);
    fetched++;
    if (!r || !r.html || r.error || r.blocked) { dead++; }
    else {
      const e = extractFromProject(r.html);
      if (!e.company) { dead++; }
      else {
        const ck = normCompanyName(e.company);
        if (e.name && seenCompany.has(ck)) { dup++; }
        else if (e.name) {
          seenCompany.add(ck);
          out.push({
            企業名: e.company, 公式URL: '', 採用担当者名: e.name,
            役職: '', 部署: '', 確度: e.conf,
            取得元: 'Wantedly募集', 根拠URL: url,
            根拠: e.where === 'romaji' ? 'Wantedly投稿者名(ローマ字)' : 'Wantedly投稿者名',
          });
          hit++;
        } else { noname++; }
      }
    }
    if (fetched % 25 === 0) {
      flush();
      log(`fetched ${fetched} | named ${named()}/${TARGET} (hit ${hit} dup ${dup} noname ${noname} dead ${dead})`);
    }
  }
  flush();
  log(`完了: 採用担当者名あり ${named()} 行 / 総 ${out.length} 行 → ${path.relative(process.cwd(), OUT)}`);
  log(`内訳: fetched ${fetched} hit ${hit} dup ${dup} noname ${noname} dead ${dead}`);
}

module.exports = { extractFromProject, looksLikeJpName, romajiName, strideOrder };

if (require.main === module) {
  main().catch((e) => { console.error('FATAL', e); process.exit(1); });
}
