'use strict';
/**
 * enrich-ats-all — 保有する全企業のエントリーURL判定（フルスイープ）
 * =====================================================================
 * 手元のリスト（BALES／統合マスタ／ターゲット）に載っている企業を**全部**、
 * 公式サイトから採用ページ→エントリー導線までたどって利用ATSを判定する。
 *
 * enrich-ats.js との違い:
 *   enrich-ats.js  … 「エントリーURLが分かっている」CSVに列を足す（1社1〜2fetch）
 *   本スクリプト    … **URLが公式サイトしか無い**状態から採用ページを探しに行く（1社最大3fetch）
 *
 * ■ 1社あたりの手順（見つかった時点で打ち切り）
 *   0) 既知URLのホストだけで判定できるなら取得しない（career-cloud.asia など）
 *   1) 起点ページ取得 → HTML内の埋め込み/リンク（iframe・script・a・form action）から判定
 *   2) 取れなければ採用ページを探す（recruit-page.js の findRecruitLinks／定番パス）→ 取得して判定
 *   3) それでも取れなければ採用ページ内の「エントリー/応募」リンクを1つだけ追って判定
 *
 * ■ 中断・再開
 *   1社1行の追記専用ジャーナル（data/ats-scan/journal.jsonl）に逐次書く。
 *   再実行すると済んだ企業を飛ばして続きから走る（--no-resume で最初から）。
 *   CSVはジャーナルから再生成するので、途中で止めても成果は失われない。
 *
 * 使い方:
 *   node src/enrich-ats-all.js                      # 全社スイープ（数時間・バックグラウンド推奨）
 *   node src/enrich-ats-all.js --conc 16            # 並列数（既定12）
 *   node src/enrich-ats-all.js --limit 200          # 先頭N社だけ（試走）
 *   node src/enrich-ats-all.js --only-unknown       # CRMで利用中ATSが判明済みの社は飛ばす
 *   node src/enrich-ats-all.js --rebuild            # 取得せずジャーナルからCSVだけ作り直す
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, normCompanyName } = require('./csv');
const { getArg, getIntArg, log, atomicWrite } = require('./cli-util');
const { detectAts, detectAtsByUrl, hostOfUrl, salesHint, normalizeAtsName } = require('./ats');
const { politeGet } = require('./polite');
const { findRecruitLinks } = require('./recruit-page');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const OUTDIR = path.resolve(String(getArg('outdir', path.join(DATA, 'ats-scan'))));
const JOURNAL = path.join(OUTDIR, 'journal.jsonl');
const OUT = path.join(OUTDIR, 'ats-scan-all.csv');
const CONC = Math.max(1, getIntArg('conc', 12));
const LIMIT = getIntArg('limit', 0);
const RESUME = !getArg('no-resume', false);
const ONLY_UNKNOWN = !!getArg('only-unknown', false);
const REBUILD = !!getArg('rebuild', false);
const MAX_FETCH = getIntArg('max-fetch', 3);      // 1社あたりの取得上限（サイトに優しく）

// ── 母集団の構築（3系統をホストで名寄せ）──────────────────────────
// 同じ会社が複数リストに出るので「ホスト1つ＝1社」に畳む。採用ページURLが分かっている行を優先。
const SOURCES = [
  { file: path.join(DATA, 'leads-consolidated-all.csv'), name: '企業名', url: '公式URL', recruit: '採用ページURL' },
  { file: path.join(DATA, 'leads-mochica-target.csv'), name: '企業名', url: '公式URL', recruit: '採用ページURL' },
];
/** BALESの最新エクスポート（ファイル名に日時が入るので固定できない）。 */
function latestBales() {
  const hit = fs.readdirSync(DATA).filter((f) => /BALESCLOUD.*leadList.*\.csv$/i.test(f)).sort();
  return hit.length ? path.join(DATA, hit[hit.length - 1]) : '';
}

function buildTargets() {
  const byHost = new Map();
  const add = (name, url, recruit, crmAts, src) => {
    const h = hostOfUrl(recruit || url);
    if (!h) return;
    const cur = byHost.get(h);
    if (!cur) { byHost.set(h, { host: h, name: String(name || '').trim(), url: String(url || '').trim(), recruit: String(recruit || '').trim(), crmAts: String(crmAts || '').trim(), src }); return; }
    if (recruit && !cur.recruit) cur.recruit = String(recruit).trim();     // より深いURLを採用
    if (crmAts && !cur.crmAts) cur.crmAts = String(crmAts).trim();         // CRMの実測値も持ち回る
    if (!cur.name && name) cur.name = String(name).trim();
  };
  for (const s of SOURCES) {
    if (!fs.existsSync(s.file)) { log(`  （${path.basename(s.file)} が無いのでスキップ）`); continue; }
    const { records } = readCsv(fs.readFileSync(s.file, 'utf8'));
    for (const r of records) add(r[s.name], r[s.url], r[s.recruit], '', path.basename(s.file));
    log(`  ${path.basename(s.file)} ${records.length}行`);
  }
  const bales = latestBales();
  if (bales) {
    const { records } = readCsv(fs.readFileSync(bales, 'utf8'));
    for (const r of records) add(r['会社情報：会社名'], r['会社情報：Webサイト'], '', r['カスタム情報：利用中ATS'], 'BALES');
    log(`  ${path.basename(bales)} ${records.length}行`);
  }
  return [...byHost.values()];
}

// ── 1社の判定（最大 MAX_FETCH 回の取得で打ち切り）──────────────────
const ENTRY_LINK_RE = /(エントリー|応募|entry|apply|マイページ|プレエントリー)/i;

/** ページ取得。robots拒否・失敗は理由つきで返す（黙って落とさない）。 */
async function fetchPage(url) {
  try {
    const p = await politeGet(url, { render: 'static' });
    if (!p) return { err: 'no-response' };
    if (p.blocked) return { err: 'robots-disallow' };
    if (p.error) return { err: String(p.error).slice(0, 60) };
    if (!p.html) return { err: 'empty' };
    return { html: p.html, finalUrl: p.finalUrl || url };
  } catch (e) { return { err: String((e && e.message) || e).slice(0, 60) }; }
}

/** HTML内の「エントリー/応募」リンク（外部ATSへ飛ぶ導線）を1つ選ぶ。 */
function pickEntryLink(baseUrl, html) {
  const links = findRecruitLinks(baseUrl, html);
  const entry = links.find((l) => ENTRY_LINK_RE.test(l.url));
  return entry ? entry.url : (links.length ? links[0].url : '');
}

async function scanCompany(t) {
  const trail = [];
  let fetches = 0;
  const start = t.recruit || t.url;
  if (!start) return { ...blank(t), 判定経路: '起点URLなし' };

  // 0) URLのホストだけで決まるなら取得しない
  const byUrl = detectAtsByUrl(start);
  if (byUrl && byUrl.kind === 'ats') return { ...pack(t, { found: true, ...byUrl, others: [] }), 判定経路: 'URLホストのみ（取得なし）', 取得回数: '0' };

  // 1) 起点ページ
  const p1 = await fetchPage(start); fetches++;
  if (p1.err) return { ...blank(t), 判定経路: `起点取得失敗（${p1.err}）`, 取得回数: String(fetches) };
  let det = detectAts(start, { html: p1.html, finalUrl: p1.finalUrl });
  trail.push(t.recruit ? '採用ページ' : 'トップ');
  if (det.found && det.kind === 'ats') return { ...pack(t, det), 判定経路: trail.join('→'), 取得回数: String(fetches) };

  let best = det;
  // 手元にある「採用ページらしいページ」。起点が採用ページならそれ自体、トップなら1hop先。
  let page = t.recruit ? { html: p1.html, finalUrl: p1.finalUrl } : null;

  // 2) トップ起点なら採用ページへ1hop
  if (!page && fetches < MAX_FETCH) {
    const links = findRecruitLinks(p1.finalUrl, p1.html).filter((l) => !l.external);
    if (links.length) {
      const p2 = await fetchPage(links[0].url); fetches++;
      if (!p2.err) {
        trail.push('採用ページ');
        page = { html: p2.html, finalUrl: p2.finalUrl };
        const d2 = detectAts(links[0].url, { html: p2.html, finalUrl: p2.finalUrl });
        if (rank(d2) > rank(best)) best = d2;
        if (best.found && best.kind === 'ats') return { ...pack(t, best), 判定経路: trail.join('→'), 取得回数: String(fetches) };
      }
    }
  }

  // 3) 採用ページ内の「エントリー/応募」リンクを1つだけ追う（起点が採用ページの時もここを通る）
  if (page) {
    const entry = pickEntryLink(page.finalUrl, page.html);
    if (entry && hostOfUrl(entry) !== hostOfUrl(page.finalUrl)) {
      // 外部ホストへ飛ぶ導線はURLだけで決まることが多い（取得せずに済む）
      const d3u = detectAtsByUrl(entry);
      if (d3u && rank({ found: true, ...d3u }) > rank(best)) { trail.push('エントリー導線'); best = { found: true, ...d3u, others: [] }; }
    }
    if (entry && (!best.found || best.kind !== 'ats') && fetches < MAX_FETCH) {
      const p3 = await fetchPage(entry); fetches++;
      if (!p3.err) {
        trail.push('エントリーページ');
        const d3 = detectAts(entry, { html: p3.html, finalUrl: p3.finalUrl });
        if (rank(d3) > rank(best)) best = d3;
      }
    }
  }
  return { ...pack(t, best), 判定経路: trail.join('→') || '—', 取得回数: String(fetches) };
}

const KIND_RANK = { ats: 3, form: 2, media: 1, sns: 0 };
const rank = (d) => (d && d.found ? (KIND_RANK[d.kind] || 0) * 10 + (d.confidence || 0) : -1);

const HEADERS = ['企業名', 'ホスト', 'ATS', 'ATSベンダー', 'ATS種別', 'ATS確度', 'ATS根拠', 'ATS併用',
  '営業メモ', 'CRM利用中ATS', 'CRMとの一致', '判定経路', '取得回数', '起点URL', '判定日'];
const TODAY = new Date().toISOString().slice(0, 10);

function blank(t) {
  return { 企業名: t.name, ホスト: t.host, ATS: '', ATSベンダー: '', ATS種別: '', ATS確度: '', ATS根拠: '',
    ATS併用: '', 営業メモ: '判定不能（要目視）', CRM利用中ATS: t.crmAts || '', CRMとの一致: crmCompare(t.crmAts, '', ''),
    判定経路: '', 取得回数: '0', 起点URL: t.recruit || t.url, 判定日: TODAY };
}
function pack(t, det) {
  return { 企業名: t.name, ホスト: t.host,
    ATS: det.found ? det.name : '', ATSベンダー: det.found ? det.vendor : '',
    ATS種別: det.found ? det.kindLabel : '', ATS確度: det.found ? det.confidence.toFixed(2) : '',
    ATS根拠: det.found ? det.evidence : '', ATS併用: (det.others || []).map((o) => o.name).join(' / '),
    営業メモ: salesHint(det), CRM利用中ATS: t.crmAts || '',
    CRMとの一致: crmCompare(t.crmAts, det.found ? det.name : '', det.found ? det.kind : ''),
    起点URL: t.recruit || t.url, 判定日: TODAY };
}
/**
 * CRMの手入力値とURL判定を突き合わせる。
 * 媒体リンク（マイナビ等）はATSの証拠にならないので、ATS種別の時だけ「一致/不一致」を判定する。
 * それ以外は事実だけ書き、CRMが古いのかURLが弱いのかを人が読んで分けられるようにする。
 */
function crmCompare(crmRaw, detected, kind) {
  const crm = normalizeAtsName(crmRaw);
  const isAts = kind === 'ats';
  if (crm.status === 'empty') {
    if (isAts) return `CRM未記入→URLで判明（${detected}）`;
    return detected ? `CRM未記入・URLは${detected}のみ（ATS未特定）` : '';
  }
  if (crm.status === 'none') {
    if (isAts) return `要確認：CRMは「無し」だがURLでは${detected}`;
    return detected ? `CRM「無し」と整合（URLは${detected}のみ）` : 'CRM「無し」・URLでも検出なし';
  }
  // CRMにツール名がある
  if (isAts) return crm.name === detected ? '一致' : `要確認：不一致（CRM:${crm.name}／URL:${detected}）`;
  return detected ? `CRMのみ（URLは${detected}のみ）` : 'CRMのみ（URLでは未検出）';
}

// ── ジャーナル（追記専用・再開可能）──────────────────────────────
function loadJournal() {
  const rows = new Map();
  if (!fs.existsSync(JOURNAL)) return rows;
  for (const line of fs.readFileSync(JOURNAL, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o && o.ホスト) rows.set(o.ホスト, o); } catch (_) { /* 壊れ行は捨てる */ }
  }
  return rows;
}
function writeCsv(rows) {
  atomicWrite(OUT, '﻿' + toCsv(HEADERS, [...rows.values()]));
}

// ── 既知クラッシュの握りつぶし ───────────────────────────────────
// undici（Node標準fetchの実装）がレスポンス終端で稀に投げるアサーション。
// ソケットのイベントハンドラから飛んでくるので await の try/catch では捕まえられず、
// そのままプロセスが落ちる（実測: 1万社スイープの1,350社目で死亡）。
// この既知例外だけ握りつぶして走り続ける。取得中のリクエストは fetchStatic の
// AbortController（15秒）が必ず落とすので、ワーカーが永久に止まることはない。
let undiciSkips = 0;
function guardUndiciCrash() {
  process.on('uncaughtException', (e) => {
    const s = String((e && e.stack) || e);
    if (e && e.code === 'ERR_ASSERTION' && /undici/.test(s)) { undiciSkips++; return; }
    throw e;   // それ以外は落とす（壊れた状態のまま走らせない）
  });
}

// ── メイン ───────────────────────────────────────────────────────
async function run() {
  guardUndiciCrash();
  fs.mkdirSync(OUTDIR, { recursive: true });
  log('母集団を構築中…');
  const targets = buildTargets();
  log(`ユニークホスト ${targets.length}社`);

  const done = RESUME ? loadJournal() : new Map();
  if (done.size) log(`ジャーナルから ${done.size}社を再開スキップ`);
  if (REBUILD) { writeCsv(done); log(`ジャーナルからCSVを再生成: ${OUT}（${done.size}社）`); return summarize(done); }

  let queue = targets.filter((t) => !done.has(t.host));
  if (ONLY_UNKNOWN) {
    const before = queue.length;
    queue = queue.filter((t) => normalizeAtsName(t.crmAts).status !== 'known');
    log(`CRMで判明済みの ${before - queue.length}社を除外（--only-unknown）`);
  }
  if (LIMIT) queue = queue.slice(0, LIMIT);
  log(`今回の対象 ${queue.length}社 ／ 並列${CONC}・1社最大${MAX_FETCH}取得`);
  if (!queue.length) { writeCsv(done); return summarize(done); }

  const jfd = fs.openSync(JOURNAL, 'a');
  const t0 = Date.now();
  let idx = 0, processed = 0, hit = 0, atsHit = 0;

  async function worker() {
    while (true) {
      const my = idx++;
      if (my >= queue.length) return;
      const t = queue[my];
      let row;
      try { row = await scanCompany(t); }
      catch (e) { row = { ...blank(t), 判定経路: 'エラー:' + String((e && e.message) || e).slice(0, 40) }; }
      done.set(t.host, row);
      fs.writeSync(jfd, JSON.stringify(row) + '\n');   // 1社ごとに追記＝いつ落ちても失わない
      if (row.ATS) { hit++; if (row.ATS種別 === '採用管理システム') atsHit++; }
      if (++processed % 50 === 0) {
        writeCsv(done);
        const rate = processed / ((Date.now() - t0) / 60000);
        const eta = (queue.length - processed) / Math.max(rate, 0.01);
        log(`  ${processed}/${queue.length}（判明 ${hit}・うちATS ${atsHit}）｜${rate.toFixed(1)}社/分・残り約${Math.round(eta)}分`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));
  fs.closeSync(jfd);
  writeCsv(done);
  log(`完了: ${processed}社を判定（判明 ${hit}・うちATS ${atsHit}）／累計 ${done.size}社`);
  if (undiciSkips) log(`  （undiciの既知アサーションを ${undiciSkips}回スキップ）`);
  summarize(done);
}

function summarize(rows) {
  const tally = new Map(), kind = new Map(), mismatch = [];
  for (const r of rows.values()) {
    const k = r.ATS || '（判定不能）';
    tally.set(k, (tally.get(k) || 0) + 1);
    const kk = r.ATS種別 || '—';
    kind.set(kk, (kind.get(kk) || 0) + 1);
    if (/^要確認/.test(r.CRMとの一致 || '')) mismatch.push(r);
  }
  console.log(`\n[ats-scan] 種別内訳`);
  for (const [k, n] of [...kind.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${k}`);
  console.log(`\n[ats-scan] ツール別（上位25）`);
  for (const [k, n] of [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${String(n).padStart(6)}  ${k}`);
  console.log(`\n[ats-scan] CRMとURL判定の食い違い ${mismatch.length}社（CRMが古い可能性・監査対象）`);
  for (const r of mismatch.slice(0, 10)) console.log(`    ${r.企業名}：${r.CRMとの一致}`);
  console.log(`\n[ats-scan] 出力 ${OUT}`);
  console.log(`  ジャーナル ${JOURNAL}（再開可能。--rebuild でCSVだけ作り直し）`);
}

if (require.main === module) run().catch((e) => { console.error('FATAL', (e && e.stack) || e); process.exitCode = 1; });
module.exports = { scanCompany, buildTargets, crmCompare, HEADERS };
