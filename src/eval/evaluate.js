'use strict';
// ============================================================================
//  精度評価ハーネス（オフライン・決定論・回帰比較可能）
// ----------------------------------------------------------------------------
//  目的: 「採用担当者名 取得精度」と「ICP適合スコア精度」を“数値で固定”し、
//        リファクタ前後で同じ母集団に当てて精度が下がっていないかを機械判定する。
//
//  なぜオフラインか: data/scrape-cache の実HTMLと data/*.json の実レコードだけを使い、
//        ネットワーク・APIキー・robotsに依存しない。よって何度回しても同じ結果＝回帰比較が成立する。
//
//  返り値 evaluate() は「指標の塊（report）」。CLI(cli.js)がこれを
//        ベースライン保存／ゲート判定／ダッシュボード生成に使う。
// ============================================================================
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const { extractPersonName, NAME_ADAPTERS, companyOnPage } = require('../scrape-names');
const { extractRecruiterName } = require('../scrape-base');
const { heuristicExtract } = require('../extract');
const { isFullName, completeSurname, splitName, stripNonName, SURNAMES } = require('../jp-names');
const { discoveryIcpScore } = require('../score');

const ROOT = path.resolve(__dirname, '..', '..');
const CACHE_DIR = path.join(ROOT, 'data', 'scrape-cache');

// 抽出名が「真のゴミ」か（精度欠陥の指標）。audit-names.js と同一定義で一貫させる。
//  ①辞書でフルネームでも完全一致姓でもない、または
//  ②辞書を通っても地名/役職/宛先のフラグメントを含む（stripNonNameで縮む）。
function isGarbage(name) {
  const c = String(name || '').replace(/[ 　]/g, '');
  if (!c) return false;
  if (!isFullName(c) && !completeSurname(c)) return true;
  if (stripNonName(c).replace(/[ 　]/g, '') !== c) return true;
  return false;
}

// 氏名の「品質ラベル」を1つ返す（精度の質的内訳）。
//  dictFull(姓＋名で辞書解決＝最良) > bareSurname(単独姓のみ) > loose(辞書外姓＝要監視)
function nameQuality(name) {
  const c = String(name || '').replace(/[ 　]/g, '');
  if (!c) return 'empty';
  if (isGarbage(c)) return 'garbage';
  if (isFullName(c)) return 'dictFull';
  if (completeSurname(c)) return 'bareSurname';
  return 'loose';
}

const COMPANY_URL_RE = /recruit|saiyo|採用|career|jinji|company|corp/i;
const WANTEDLY_RE = /wantedly\.com\/projects\/\d+/;

// キャッシュファイル名を決定論順（辞書順）で返す。limit>0 で先頭から間引き。
function listCache(limit) {
  if (!fs.existsSync(CACHE_DIR)) return [];
  const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json')).sort();
  return limit > 0 ? files.slice(0, limit) : files;
}
function readCache(f) {
  try { return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8')); } catch (_) { return null; }
}
function pct(n, d) { return d ? +(100 * n / d).toFixed(2) : 0; }

// ── 氏名抽出トラック（Wantedly募集ページ：個人名が実際に載る母集団） ──
//  recall（抽出率）と precision（ゴミ率・辞書フルネーム率）の両面を測る。
function evalNamesWantedly(scanLimit) {
  const wAdapter = NAME_ADAPTERS.find((a) => a.name === 'Wantedly');
  const files = listCache(0);
  let pages = 0, extracted = 0, author = 0, context = 0;
  const q = { dictFull: 0, bareSurname: 0, loose: 0, garbage: 0, empty: 0 };
  const lenDist = {};
  const items = {};          // url -> 抽出名（per-item 回帰差分用）
  for (const f of files) {
    if (scanLimit && pages >= scanLimit) break;
    const j = readCache(f);
    if (!j || !WANTEDLY_RE.test(j.url || '')) continue;
    pages++;
    const got = extractPersonName(j.html, { authorSel: wAdapter.authorSel });
    const name = got ? String(got.name || '').replace(/[ 　]/g, '') : '';
    items[j.url] = name;
    if (!name) continue;
    extracted++;
    if (got.where === 'author') author++; else context++;
    q[nameQuality(name)]++;
    lenDist[name.length] = (lenDist[name.length] || 0) + 1;
  }
  return {
    track: 'wantedly',
    pagesScanned: pages,
    extracted,
    extractionRate: pct(extracted, pages),     // recall 代理（高いほど良）
    dictFullRate: pct(q.dictFull, extracted),  // precision-質（高いほど良）
    garbage: q.garbage,
    garbageRate: pct(q.garbage, extracted),    // 精度欠陥（0であるべき・増えたら退行）
    loose: q.loose,
    bareSurname: q.bareSurname,
    bySource: { author, context },
    lengthDist: lenDist,
    items,
  };
}

// ── 氏名抽出トラック（会社採用ページ：個人名は非公開が大半。precision重視） ──
//  抽出されたものが“真のゴミ”でないことを継続検証する（再現率は構造的に低い）。
function evalNamesCompany(scanLimit) {
  const files = listCache(0);
  let pages = 0, baseHit = 0, heurHit = 0, baseGarbage = 0, heurGarbage = 0;
  const items = {};
  for (const f of files) {
    if (scanLimit && pages >= scanLimit) break;
    const j = readCache(f);
    if (!j || WANTEDLY_RE.test(j.url || '') || !COMPANY_URL_RE.test(j.url || '')) continue;
    pages++;
    const $ = cheerio.load(j.html || '');
    $('script,style,noscript').remove();
    const text = $('body').text().replace(/\s+/g, ' ').slice(0, 20000);
    const b = extractRecruiterName(text);
    const bn = b && b.name ? String(b.name).replace(/[ 　]/g, '') : '';
    if (bn) { baseHit++; if (isGarbage(bn)) baseGarbage++; }
    const h = heuristicExtract(text);
    const hn = h && h.found && h.name ? String(h.name).replace(/[ 　]/g, '') : '';
    if (hn) { heurHit++; if (isGarbage(hn)) heurGarbage++; }
    items[j.url] = bn;       // base経路を per-item 回帰の代表とする
  }
  return {
    track: 'company',
    pagesScanned: pages,
    baseHit, heurHit,
    baseExtractionRate: pct(baseHit, pages),
    garbage: baseGarbage + heurGarbage,        // 精度欠陥（0であるべき）
    baseGarbage, heurGarbage,
    items,
  };
}

// ── ICP適合スコア トラック（純ロジック・完全決定論） ──
//  discoveryIcpScore は同じ入力に同じ出力。リファクタで“1件でもスコアが動いたら退行”。
function evalIcp(recordLimit) {
  const file = path.join(ROOT, 'data', 'gbiz-records.json');
  let arr = [];
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    arr = Array.isArray(j) ? j : (j.records || Object.values(j));
  } catch (_) { arr = []; }
  if (recordLimit) arr = arr.slice(0, recordLimit);

  const items = {};          // key -> score（per-item 完全一致検証用）
  const scoreDist = {};      // 10点刻みヒストグラム
  let sum = 0, scored = 0;
  const scores = [];
  for (const r of arr) {
    const key = r['法人番号'] || r['企業名'];
    if (!key) continue;
    const emp = Number(r['従業員数']);
    const h = {
      employees: Number.isFinite(emp) ? emp : null,
      websiteUrl: r['公式URL'] || '',
      representativeName: r['代表者名'] || '',
      subsidy: !!String(r['補助金'] || '').trim(),
      establishmentYear: r['設立年'] || '',
    };
    const s = discoveryIcpScore(h);
    items[key] = s;
    scores.push(s);
    sum += s; scored++;
    const bucket = Math.min(100, Math.floor(s / 10) * 10);
    scoreDist[bucket] = (scoreDist[bucket] || 0) + 1;
  }
  scores.sort((a, b) => a - b);
  const median = scores.length ? scores[Math.floor(scores.length / 2)] : 0;
  return {
    track: 'icp',
    recordsScored: scored,
    meanScore: scored ? +(sum / scored).toFixed(2) : 0,
    medianScore: median,
    scoreDist,
    items,
  };
}

/**
 * 全トラックを評価して1つのreportを返す。
 * @param {{namesLimit?:number, icpLimit?:number}} opts
 */
function evaluate(opts = {}) {
  const namesLimit = opts.namesLimit != null ? opts.namesLimit : 1500;
  const icpLimit = opts.icpLimit != null ? opts.icpLimit : 0;
  return {
    schema: 1,
    namesLimit, icpLimit,
    cacheDir: path.relative(ROOT, CACHE_DIR),
    tracks: {
      wantedly: evalNamesWantedly(namesLimit),
      company: evalNamesCompany(namesLimit),
      icp: evalIcp(icpLimit),
    },
  };
}

module.exports = { evaluate, isGarbage, nameQuality };
