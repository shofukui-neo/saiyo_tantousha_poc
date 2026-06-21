'use strict';
// 採用担当者「氏名」抽出の精度オフライン監査（ネット不要・再現可能）。
// ------------------------------------------------------------------
// 目的: 「担当者名取得精度」を“追跡できる指標”にする。politeGet の実キャッシュ
//   (data/scrape-cache/*.json) に氏名抽出器を当て、抽出率と品質（辞書フルネーム率など）を集計。
//   ネットワーク不要・robots不要で、辞書/ガードを変えるたびに同じ母集団で回帰比較できる。
//
// 何を測るか:
//   - 抽出率        … キャッシュした募集ページのうち氏名が取れた割合
//   - 辞書フルネーム率 … 取れた氏名のうち姓辞書で姓＋名に解決できた割合（＝確度の代理指標。高いほど良）
//   - bare姓 / loose … 単独姓のみ / 辞書外姓(構造救済) の件数（loose が増えたら要注意）
//   - 長さ分布        … 6字以上は連結誤り(2名くっつき)の兆候
//
// 副産物（辞書ギャップの自動発見）:
//   抽出済みの“良質な氏名”の中で、先頭3字が共通しかつ4字目以降が割れている群を検出する。
//   例: 小田島修司 / 小田島直樹 / 小田島秀一郎 → 「小田島」は3字姓なのに 小田+島… と誤分節している兆候。
//   2字片が辞書姓のものだけを候補に挙げ、人手レビュー用に出力（自動追加はしない＝精度優先）。
//
// 使い方:
//   node src/audit-names.js                       # Wantedly募集ページを監査して指標を表示
//   node src/audit-names.js --limit 500           # 先頭500ページのみ（高速確認）
//   node src/audit-names.js --out data/names-audit.csv   # 抽出全件をCSVに（確認用）
//   npm run audit:names
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { extractPersonName, NAME_ADAPTERS, companyOnPage } = require('./scrape-names');
const { extractRecruiterName } = require('./scrape-base');
const { heuristicExtract } = require('./extract');
const { isFullName, splitName, completeSurname, stripNonName, SURNAMES } = require('./jp-names');
const { toCsv } = require('./csv');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
const CACHE_DIR = path.resolve(__dirname, '..', getArg('cache', 'data/scrape-cache'));
const LIMIT = parseInt(getArg('limit', '0'), 10) || 0;     // 0=全件
const OUT = getArg('out', '');                              // 指定時は抽出全件をCSV出力
// 既定は Wantedly 募集ページ（投稿者名が個人名で載る・キャッシュ最多）。--host で変更可。
const HOST_RE = new RegExp(getArg('match', 'wantedly\\.com/projects/\\d+'));
const MODE = getArg('mode', 'wantedly');                    // wantedly | company | both

function pct(n, d) { return d ? (100 * n / d).toFixed(1) + '%' : '0%'; }

// 抽出名が誤検出か。①辞書でフルネームでも完全一致姓でもない、または
// ②辞書を通っても地名/役職/宛先のフラグメントを含む（池田宛/西信用金 等＝stripNonNameで縮む）。
function isGarbage(name) {
  const c = String(name || '').replace(/[ 　]/g, '');
  if (!isFullName(c) && !completeSurname(c)) return true;
  if (stripNonName(c).replace(/[ 　]/g, '') !== c) return true;
  return false;
}
function loadPages() {
  return fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json'));
}
function readCache(f) {
  try { return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8')); } catch (_) { return null; }
}

// 既知姓の「末尾の字」集合（辞書自身から導出）。真の3字姓の3字目はこの集合に入る（島/田/川/野…）。
// 給名専用字（将/大/雄/真…）は姓の末尾字でないため、偶然の先頭3字一致（菊池将人/菊池将太）を弾ける。
const SURNAME_LAST_CHARS = new Set([...SURNAMES].map((s) => s.slice(-1)));

// ── Wantedly募集ページ監査（投稿者セレクタ経路）──
function auditWantedly() {
  const wAdapter = NAME_ADAPTERS.find((a) => a.name === 'Wantedly');
  const files = loadPages();

  let pages = 0, hit = 0, authorHit = 0, ctxHit = 0;
  let dictFull = 0, bareSur = 0, looseOnly = 0;
  const byLen = {};
  const rows = [];                 // CSV用（出力指定時）
  const longNames = [];            // 6字以上（連結誤りの兆候）
  const looseNames = [];           // 辞書外姓（要監視）
  const prefix3 = new Map();       // 3字姓ギャップ検出: 先頭3字 -> Set(4字目以降)

  for (const f of files) {
    if (LIMIT && pages >= LIMIT) break;
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8')); } catch (_) { continue; }
    if (!j || !HOST_RE.test(j.url || '')) continue;
    pages++;
    const got = extractPersonName(j.html, { authorSel: wAdapter.authorSel });
    if (!got) continue;
    hit++;
    if (got.where === 'author') authorHit++; else ctxHit++;
    const n = String(got.name || '').replace(/[ 　]/g, '');
    byLen[n.length] = (byLen[n.length] || 0) + 1;
    if (OUT) {
      // 成果物(営業リスト)形式: 掲載企業名も併記して (企業名, 採用担当者名, 根拠URL) を作る
      const $c = cheerio.load(j.html);
      const company = companyOnPage($c, wAdapter.companySel) || '';
      rows.push({ 企業名: company, 採用担当者名: got.name, 確度: got.confidence, 取得元媒体: 'Wantedly', 根拠URL: j.url });
    }

    if (isFullName(n)) {
      dictFull++;
      // 3字姓ギャップ検出: 2字片が辞書姓 かつ 名が2字以上 のとき、先頭3字を集計
      const sp = splitName(n);
      if (sp && sp.sei.length === 2 && SURNAMES.has(sp.sei) && n.length >= 4) {
        const p3 = n.slice(0, 3), rest = n.slice(3);
        if (!prefix3.has(p3)) prefix3.set(p3, new Set());
        prefix3.get(p3).add(rest);
      }
    } else if (completeSurname(n)) {
      bareSur++;
    } else {
      looseOnly++;
      looseNames.push(n);
    }
    // 6字以上で、姓＋名(名≤3字)に綺麗に割れないものだけ連結誤りの疑いとして拾う（佐々木龍一郎=3+3は除外）。
    if (n.length >= 6) { const sp = splitName(n); if (!sp || !sp.mei || sp.mei.length > 3) longNames.push(n); }
  }

  // ── レポート ──
  console.log('=== 採用担当者名 抽出 精度監査（オフライン・キャッシュ） ===');
  console.log(`キャッシュ: ${CACHE_DIR}`);
  console.log(`対象ページ(${HOST_RE.source}): ${pages}`);
  console.log(`氏名抽出: ${hit}（抽出率 ${pct(hit, pages)}） 内訳 author:${authorHit} context:${ctxHit}`);
  console.log(`品質: 辞書フルネーム ${dictFull}（${pct(dictFull, hit)}）｜ bare姓 ${bareSur}｜ 辞書外姓(loose) ${looseOnly}`);
  const lens = Object.keys(byLen).map(Number).sort((a, b) => a - b);
  console.log('長さ分布: ' + lens.map((l) => `${l}字:${byLen[l]}`).join('  '));

  if (looseNames.length) {
    console.log(`\n[要監視] 辞書外姓(loose) ${looseNames.length}件: ` + [...new Set(looseNames)].slice(0, 30).join(' '));
  }
  if (longNames.length) {
    console.log(`\n[要確認] 6字以上 ${longNames.length}件（連結誤りの兆候）: ` + [...new Set(longNames)].slice(0, 30).join(' '));
  }

  // 3字姓ギャップ候補: 先頭3字共通で名が3通り以上割れ、かつ3字目が「姓の末尾字」＝3字姓の可能性が高い。
  // （偶然の給名前方一致 菊池将人/将太 は 将 が姓末尾字でないため除外される）
  const gaps = [...prefix3.entries()]
    .filter(([p3, rests]) => rests.size >= 3 && SURNAME_LAST_CHARS.has(p3[2]))
    .map(([p3, rests]) => ({ p3, variety: rests.size, examples: [...rests].slice(0, 3).map((r) => p3 + r) }))
    .sort((a, b) => b.variety - a.variety);
  if (gaps.length) {
    console.log('\n[辞書ギャップ候補] 先頭3字が共通・名が割れている＝3字姓の可能性（人手レビュー用・自動追加はしない）:');
    for (const g of gaps.slice(0, 20)) {
      console.log(`  ${g.p3}（${g.variety}通り）例: ${g.examples.join(' / ')}`);
    }
  }

  if (OUT) {
    // 企業名が取れた行のみ・(企業名, 採用担当者名)で重複排除＝実用的な担当者名リスト
    const seen = new Set();
    const deliver = rows.filter((r) => {
      if (!r.企業名) return false;
      const k = r.企業名 + '|' + r.採用担当者名;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const abs = path.resolve(__dirname, '..', OUT);
    fs.writeFileSync(abs, toCsv(['企業名', '採用担当者名', '確度', '取得元媒体', '根拠URL'], deliver));
    const companies = new Set(deliver.map((r) => r.企業名)).size;
    console.log(`\n成果物(担当者名リスト)出力: ${abs}`);
    console.log(`  ユニーク(企業×担当者): ${deliver.length}件 / 企業数: ${companies}（Wantedlyキャッシュ由来・SME母集団で個人名が実取得できる実証）`);
  }
}

// ── 会社採用ページ監査（本文テキスト経路: scrape-base / extract heuristic）──
// この母集団は個人名がそもそも非公開で抽出率は低い（[[recruiter-name-segment-finding]]）。
// 目的は再現率でなく「精度」: 抽出されたものが“真のゴミ”(非姓・非フルネーム)でないことを継続検証する。
const COMPANY_URL_RE = /recruit|saiyo|採用|career|jinji|company|corp/i;
function auditCompany() {
  const files = loadPages();
  let pages = 0, baseHit = 0, heurHit = 0;
  const baseGarbage = [], heurGarbage = [];
  const baseNames = [];
  for (const f of files) {
    if (LIMIT && pages >= LIMIT) break;
    const j = readCache(f);
    if (!j || /wantedly\.com/.test(j.url || '') || !COMPANY_URL_RE.test(j.url || '')) continue;
    pages++;
    const $ = cheerio.load(j.html || '');
    $('script,style,noscript').remove();
    const text = $('body').text().replace(/\s+/g, ' ').slice(0, 20000);
    const b = extractRecruiterName(text);
    if (b.name) { baseHit++; baseNames.push(b.name); if (isGarbage(b.name)) baseGarbage.push(b.name); }
    const h = heuristicExtract(text);
    if (h.found && h.name) { heurHit++; if (isGarbage(h.name)) heurGarbage.push(h.name); }
  }
  console.log('\n=== 会社採用ページ 抽出 精度監査（本文テキスト経路）===');
  console.log(`対象ページ: ${pages}（この母集団は個人名非公開が大半・抽出率は低い）`);
  console.log(`scrape-base 抽出: ${baseHit}（${pct(baseHit, pages)}）｜ heuristic 抽出: ${heurHit}`);
  console.log(`[精度] 真のゴミ(非姓・非フルネーム): scrape-base ${baseGarbage.length}件 / heuristic ${heurGarbage.length}件 ` +
    ((baseGarbage.length || heurGarbage.length) ? '← 要修正' : '✓ ゼロ'));
  if (baseGarbage.length) console.log('  base:', [...new Set(baseGarbage)].slice(0, 30).join(' '));
  if (heurGarbage.length) console.log('  heuristic:', [...new Set(heurGarbage)].slice(0, 30).join(' '));
  console.log('抽出名サンプル: ' + [...new Set(baseNames)].slice(0, 20).join(' '));
  // 精度退行を機械判定できるよう、ゴミ検出時は非ゼロ終了
  return baseGarbage.length + heurGarbage.length;
}

// ── 再現率ギャップ検出（Wantedly: 投稿者名は載るが辞書外姓で却下されたページを採取）──
// 却下された氏名らしいテキストを先頭2字（＝候補姓）で集計し、人手で精査して辞書追加する出発点にする。
// 役割語(採用/人事/担当)・3字姓の切詰・1字片は機械的に除外し、ノイズを抑える。
const ROLE_NOISE = /採用|人事|担当|責任|窓口|事務|総務|広報|部門|部署|スタッフ|メンバ/;
function auditRecallGaps() {
  const wAdapter = NAME_ADAPTERS.find((a) => a.name === 'Wantedly');
  const files = loadPages();
  let pages = 0, noExtract = 0, rejected = 0;
  const cand2 = new Map();   // 候補姓(先頭2字) -> Set(却下フルネーム)
  for (const f of files) {
    if (LIMIT && pages >= LIMIT) break;
    const j = readCache(f);
    if (!j || !/wantedly\.com\/projects\/\d+/.test(j.url || '')) continue;
    pages++;
    if (extractPersonName(j.html, { authorSel: wAdapter.authorSel })) continue;
    noExtract++;
    const $ = cheerio.load(j.html);
    let txt = '';
    for (const sel of wAdapter.authorSel) { $(sel).each((_, el) => { if (txt) return; const t = $(el).text().replace(/\s+/g, ' ').trim(); if (t) txt = t; }); }
    if (!txt) continue;
    const compact = txt.replace(/[ 　]/g, '');
    // 氏名らしい(2-5字漢字)が辞書で解決できない＝候補。役割語ノイズと1字姓は除外。
    if (!/^[一-龥々]{3,5}$/.test(compact) || isFullName(compact) || ROLE_NOISE.test(compact)) continue;
    rejected++;
    const p2 = compact.slice(0, 2);
    if (!cand2.has(p2)) cand2.set(p2, new Set());
    cand2.get(p2).add(compact);
  }
  console.log('\n=== Wantedly 再現率ギャップ（投稿者名は載るが辞書外姓で未抽出）===');
  console.log(`対象: ${pages}ページ / 未抽出 ${noExtract} / 氏名らしい却下 ${rejected}`);
  // 異なるフルネームが2通り以上ある候補＝実在姓の可能性が高い（同一人物の重複投稿を除外）
  const ranked = [...cand2.entries()]
    .map(([p2, set]) => ({ p2, variety: set.size, examples: [...set].slice(0, 3) }))
    .filter((c) => c.variety >= 2)
    .sort((a, b) => b.variety - a.variety);
  console.log(`候補姓（異なる氏名2通り以上で出現＝実在姓らしい）: ${ranked.length}件`);
  for (const c of ranked.slice(0, 40)) {
    console.log(`  ${c.p2}（${c.variety}名）例: ${c.examples.join(' / ')}`);
  }
  console.log('※ 上記を人手精査し、標準姓のみ jp-names の SURNAME_LIST に追加（地名/役割/中国姓は除外）。');
}

function main() {
  if (!fs.existsSync(CACHE_DIR)) { console.error('キャッシュ無し:', CACHE_DIR); process.exit(1); }
  let garbage = 0;
  if (MODE === 'wantedly' || MODE === 'both') auditWantedly();
  if (MODE === 'company' || MODE === 'both') garbage += auditCompany();
  if (MODE === 'recall') auditRecallGaps();
  // company監査でゴミが出たら精度退行として非ゼロ終了（CI/回帰で検出可能に）
  if (garbage > 0) process.exitCode = 1;
}

main();
