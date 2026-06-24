'use strict';
// 担当者名スクレイピングのボトルネック特定ハーネス（詳細エラーハンドリング・分類集計）。
// =====================================================================
// 目的（ユーザー指定）: 沈黙して握り潰されている失敗を全部開け、各社の結末を分類して
//   「歩留りが低い真の理由」を histogram で特定する。
//   probeRecruitPage と同じ候補ページ走査を、明示的なエラー捕捉つきで再実装する。
//
// 各社を以下のいずれかに分類（最初に該当した時点で確定）:
//   URL_MISSING            公式URL無し（このリストの主因候補）
//   TOP_ROBOTS_BLOCKED     robots.txt で取得禁止
//   TOP_FETCH_ERR:<msg>    トップ取得が例外（DNS/TLS/timeout/HTTP4xx5xx/non-html）
//   TOP_EMPTY              HTMLは返るが本文ほぼ空
//   TOP_SPA_THIN           本文が薄くSPAマーカーあり＝静的取得では中身が出ない（要レンダリング）
//   NO_COMPANY_MATCH       トップに社名が出ない＝URL誤り（他社サイト）
//   NO_RECRUIT_PAGES       採用リンク/定番採用パスが1つも取得できない
//   PAGES_FETCH_ERR        採用ページ候補が全て取得失敗
//   RECRUIT_SPA_THIN       採用ページが薄くSPA＝要レンダリング
//   NO_RECRUIT_CONTEXT     採用ページは取れたが採用/人事の文脈が無い
//   CONTEXT_NO_NAME        採用文脈はあるが抽出器が氏名を見つけられない（母集団＝個人名非掲載）
//   NAME_REJECTED_GATE     氏名候補は出たが検証/社名ゲートで却下
//   NAME_FOUND             取得成功
//
//   node src/diagnose-harvest.js --in leads-recruiter-acquired-1000.csv --limit 60 [--urlonly] [--render]
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, normCompanyName } = require('./csv');
const { politeGet } = require('./polite');
const { fetchPage } = require('./fetch');
const { findRecruitLinks } = require('./recruit-page');
const { pageCorpus, visibleText, extractFromRecruitText } = require('./probe-recruit-page');
const { pageMatchesCompany } = require('./search');
const { isPlausiblePersonName } = require('./jp-names');
const { validateHit } = require('./validate');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
const IN = getArg('in', 'leads-recruiter-acquired-1000.csv');
const OUT = getArg('out', path.join('data', 'diagnose-harvest.csv'));
const LIMIT = parseInt(getArg('limit', '60'), 10) || 60;
const URLONLY = process.argv.includes('--urlonly');   // 公式URL保有社だけを診断（自社ページ経路のボトルネック特定）
const TRY_RENDER = process.argv.includes('--render'); // SPA薄ページをPlaywrightで再取得して中身が出るか確認

const RECRUIT_CONTEXT = /(採用|recruit|新卒|エントリー|人事|キャリア|募集|join|careers)/i;
const NAME_CONTEXT = /(採用担当|人事担当|採用責任者|人事部|採用部|新卒採用|採用チーム|採用メンバー|採用スタッフ|リクルーター|人材開発|人材戦略|スタッフ紹介|社員紹介|メンバー紹介)/;
const SPA_MARKER = /__NEXT_DATA__|id=["']root["']|id=["']app["']|ng-version|data-reactroot|data-vue|window\.__NUXT__/i;

function textLenOf(html) { try { return visibleText(html).replace(/\s+/g, '').length; } catch (_) { return 0; } }
function isSpaThin(html) { const len = textLenOf(html); return len < 300 && SPA_MARKER.test(html || ''); }

// トップ取得を明示エラーで返す（politeGetの戻りを分解）。renderはstatic固定。
async function getPage(url, useRender) {
  try {
    const r = await politeGet(url, { render: useRender ? 'auto' : 'static' });
    if (!r) return { code: 'NULL' };
    if (r.blocked) return { code: 'ROBOTS' };
    if (r.error) return { code: 'ERR', msg: String(r.error).slice(0, 60) };
    if (!r.html) return { code: 'EMPTY' };
    return { code: 'OK', html: r.html, finalUrl: r.finalUrl || url, rendered: !!r.rendered };
  } catch (e) { return { code: 'ERR', msg: String(e && e.message || e).slice(0, 60) }; }
}

// 採用ページ候補URL群（probeRecruitPageと同じ構成）
function candidatePages(baseUrl, topHtml) {
  const links = findRecruitLinks(baseUrl, topHtml).filter((l) => !l.external).map((l) => l.url);
  let origin = ''; try { origin = new URL(baseUrl).origin; } catch (_) {}
  const recruitBases = [];
  for (const l of links.slice(0, 2)) { try { recruitBases.push(new URL(l).toString().replace(/\/+$/, '')); } catch (_) {} }
  const NAME_SUBPATHS = ['/staff/', '/member/', '/interview/', '/message/', '/people/'];
  const deep = [];
  for (const b of recruitBases) for (const sp of NAME_SUBPATHS) deep.push(b + sp);
  const fb = origin ? [origin + '/recruit/staff/', origin + '/recruit/member/', origin + '/recruit/interview/',
    origin + '/recruit/message/', origin + '/company/', origin + '/about/'] : [];
  return { links, candidates: [...new Set([...links, ...deep, ...fb])].slice(0, 6) };
}

async function diagnoseCompany(rec) {
  const name = rec['企業名'] || rec['company_name'] || '';
  const url = rec['公式URL'] || rec['official_url'] || rec['url'] || '';
  const out = { 企業名: name, 公式URL: url, outcome: '', detail: '', pages: 0, recruitPages: 0, topTextLen: 0 };
  if (!url) { out.outcome = 'URL_MISSING'; return out; }

  // 1) トップ取得
  const top = await getPage(url, false);
  if (top.code === 'ROBOTS') { out.outcome = 'TOP_ROBOTS_BLOCKED'; return out; }
  if (top.code === 'ERR') { out.outcome = 'TOP_FETCH_ERR'; out.detail = top.msg; return out; }
  if (top.code === 'EMPTY' || top.code === 'NULL') { out.outcome = 'TOP_EMPTY'; return out; }
  const topLen = textLenOf(top.html);
  out.topTextLen = topLen;
  if (topLen < 300 && SPA_MARKER.test(top.html)) {
    // SPA薄ページ。--render指定時はレンダリングして中身が出るか確認
    if (TRY_RENDER) {
      const r2 = await getPage(url, true);
      if (r2.code === 'OK' && textLenOf(r2.html) >= 300) { top.html = r2.html; out.detail = 'rendered-recovered'; out.topTextLen = textLenOf(r2.html); }
      else { out.outcome = 'TOP_SPA_THIN'; out.detail = 'render-no-help'; return out; }
    } else { out.outcome = 'TOP_SPA_THIN'; return out; }
  }
  // 2) 社名ゲート（URL誤り検出）
  if (!pageMatchesCompany(name, '', visibleText(top.html))) { out.outcome = 'NO_COMPANY_MATCH'; return out; }

  // 3) 採用ページ候補を走査
  const { candidates } = candidatePages(top.finalUrl || url, top.html);
  if (!candidates.length) { out.outcome = 'NO_RECRUIT_PAGES'; return out; }

  let fetched = 0, recruitCtx = 0, nameCtx = 0, rejected = 0, spaThin = 0;
  let firstName = '', firstNameRejectReason = '';
  const order = [...candidates, top.finalUrl || url];
  for (const pageUrl of order) {
    let html = pageUrl === (top.finalUrl || url) ? top.html : null;
    if (!html) {
      const r = await getPage(pageUrl, false);
      if (r.code !== 'OK') continue;
      html = r.html;
      if (isSpaThin(html)) { spaThin++; continue; }
    }
    fetched++;
    const corpus = pageCorpus(html);
    if (RECRUIT_CONTEXT.test(corpus)) recruitCtx++;
    if (NAME_CONTEXT.test(corpus)) nameCtx++;
    const hit = extractFromRecruitText(corpus);
    if (hit && hit.name) {
      const v = validateHit({ ...hit }, {});
      const okName = isPlausiblePersonName(hit.name);
      const okCompany = pageMatchesCompany(name, '', visibleText(html));
      if (v.hit && okName && okCompany) {
        out.outcome = 'NAME_FOUND'; out.detail = hit.name + ' @ ' + pageUrl.split('/').slice(2).join('/').slice(0, 40);
        out.pages = fetched; out.recruitPages = recruitCtx; return out;
      }
      if (!firstName) { firstName = hit.name; firstNameRejectReason = !v.hit ? 'validateHit' : (!okName ? 'nameGate' : 'companyGate'); rejected++; }
    }
  }
  out.pages = fetched; out.recruitPages = recruitCtx;
  if (firstName) { out.outcome = 'NAME_REJECTED_GATE'; out.detail = firstName + '/' + firstNameRejectReason; return out; }
  if (!fetched) { out.outcome = (spaThin ? 'RECRUIT_SPA_THIN' : 'PAGES_FETCH_ERR'); out.detail = 'spaThin=' + spaThin; return out; }
  if (nameCtx === 0 && recruitCtx === 0) { out.outcome = 'NO_RECRUIT_CONTEXT'; return out; }
  out.outcome = 'CONTEXT_NO_NAME'; out.detail = 'recruitCtxPages=' + recruitCtx + ' nameCtxPages=' + nameCtx + ' spaThin=' + spaThin;
  return out;
}

async function run() {
  const text = fs.readFileSync(path.resolve(IN), 'utf8');
  let { records } = readCsv(text);
  if (URLONLY) records = records.filter((r) => r['公式URL']);
  records = records.slice(0, LIMIT);

  const headers = ['企業名', '公式URL', 'outcome', 'detail', 'pages', 'recruitPages', 'topTextLen'];
  const out = [];
  const hist = {};
  console.log(`[診断] ${records.length}社（URLONLY=${URLONLY} RENDER=${TRY_RENDER}）`);
  let i = 0;
  for (const rec of records) {
    let row;
    try { row = await diagnoseCompany(rec); }
    catch (e) { row = { 企業名: rec['企業名'], 公式URL: rec['公式URL'] || '', outcome: 'HARNESS_ERR', detail: String(e && e.message || e).slice(0, 60) }; }
    out.push(row);
    hist[row.outcome] = (hist[row.outcome] || 0) + 1;
    if (++i % 10 === 0) console.log(`  ${i}/${records.length}  ${row.企業名} → ${row.outcome} ${row.detail || ''}`);
  }
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(path.resolve(OUT), toCsv(headers, out));

  console.log('\n=== ボトルネック histogram（' + records.length + '社） ===');
  for (const [k, v] of Object.entries(hist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(4)}  ${(100 * v / records.length).toFixed(1).padStart(5)}%  ${k}`);
  }
  console.log('出力:', path.resolve(OUT));
}

run().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
