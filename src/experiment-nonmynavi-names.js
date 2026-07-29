'use strict';
/**
 * 実験: 非マイナビ媒体から採用担当者「個人名」が本当に取れるかの実測プローブ
 * =====================================================================
 * 目的（ユーザー要件）: マイナビ依存を脱し、他媒体でも担当者名を取れるか試行錯誤する。
 * カタログの promising 非マイナビ媒体（逆求人/IT/理系/インターン等）を対象に、
 * トップ→媒体内の詳細/企業/スカウト系ページを浅く巡回し、
 *   (a) 媒体ページ自体に個人名が露出するか（extractFromRecruitText）
 *   (b) 外部の企業公式リンク数（company-site hop の見込み）
 * を媒体ごとに実測して言い切れる材料を出す。
 *
 * 出力: data/experiment-nonmynavi.csv / data/experiment-nonmynavi.json
 * robots/レート/キャッシュは polite.js。中断耐性: 媒体ごとに逐次flush。
 */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { politeGet } = require('./polite');
const { fetchText } = require('./fetch');
const { pageCorpus, extractFromRecruitText } = require('./probe-recruit-page');
const { registrableDomain } = require('./fetch');
const { toCsv } = require('./csv');
const cfg = require('./config');

const ROOT = path.resolve(__dirname, '..');
const CATALOG = path.join(ROOT, 'data', 'media-catalog.json');
const getArg = (n, d) => { const i = process.argv.indexOf('--' + n); if (i < 0) return d; const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; };
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const atomic = (p, t) => { const tmp = p + '.tmp'; fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(tmp, t); fs.renameSync(tmp, p); };

// 詳細/企業/スカウト/メンバー系の媒体内リンク＝個人名が眠りやすい深いページのヒント
const DETAIL_HINT = /(company|companies|corp|kigyo|kaisha|会社|企業|detail|show|scout|offer|member|people|人|担当|recruit|job|jobs|posting|internship|event|セミナー|説明会|interview|インタビュー|\/id\/|\/\d{3,})/i;

async function crawlMedia(m, maxPages) {
  const out = { name: m.name, cat: m.cat, strategy: m.strategy, url: m.url,
    reachable: '', pagesFetched: 0, onPageNames: 0, sampleNames: [], companyLinks: 0, detailPages: 0, note: '' };
  let host = ''; try { host = new URL(m.url).host.replace(/^www\./, ''); } catch { out.note = 'bad-url'; return out; }

  const visited = new Set();
  const queue = [m.url];
  const companyDomains = new Set();
  const names = new Set();
  while (queue.length && out.pagesFetched < maxPages) {
    const u = queue.shift(); if (visited.has(u)) continue; visited.add(u);
    let r; try { r = await politeGet(u, { render: 'static' }); } catch (e) { continue; }
    if (!r || r.blocked || r.error || !r.html) { if (out.pagesFetched === 0) { out.reachable = 'no'; out.note = (r && (r.reason || r.error)) ? String(r.reason || r.error).slice(0, 40) : 'blocked'; } continue; }
    out.reachable = 'yes';
    out.pagesFetched++;

    // (a) このページに採用担当者名が露出するか
    try {
      const corpus = pageCorpus(r.html);
      const hit = extractFromRecruitText(corpus);
      if (hit && hit.name && !names.has(hit.name)) { names.add(hit.name); }
    } catch (_) {}

    // リンク収集: 外部企業候補 と 媒体内の深掘りヒント
    const $ = cheerio.load(r.html);
    $('a[href]').each((_, a) => {
      const href = $(a).attr('href'); if (!href) return;
      let abs; try { abs = new URL(href, r.finalUrl || u).href; } catch { return; }
      if (!/^https?:/.test(abs)) return;
      const clean = abs.replace(/[#?].*$/, '');
      let lu; try { lu = new URL(abs); } catch { return; }
      const lh = lu.host.replace(/^www\./, '');
      const external = lh !== host && !host.endsWith('.' + lh) && !lh.endsWith('.' + host);
      const excluded = cfg.EXCLUDE_DOMAINS.some((d) => lh === d || lh.endsWith('.' + d));
      if (external && !excluded) {
        const reg = registrableDomain(lh); if (reg) companyDomains.add(reg);
      } else if (!external && DETAIL_HINT.test(lu.pathname + lu.search) && !visited.has(clean) && queue.length < maxPages * 4) {
        out.detailPages++;
        queue.push(clean);
      }
    });
  }
  out.companyLinks = companyDomains.size;
  out.onPageNames = names.size;
  out.sampleNames = [...names].slice(0, 5);
  return out;
}

async function main() {
  const cat = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
  const maxPages = parseInt(getArg('max-pages', '10'), 10);
  const filter = String(getArg('cats', '逆求人|IT特化|理系|インターン|マスコミ|グローバル|外資'));
  const re = new RegExp(filter);
  const targets = cat.media.filter((m) => m.url && re.test(m.cat) && m.strategy !== 'blocked-or-login'
    && (!m.probe || m.probe.reachable !== 'no'));
  log(`実験対象: ${targets.length}媒体（cats=${filter}, 各最大${maxPages}p）`);

  const outCsv = path.join(ROOT, 'data', 'experiment-nonmynavi.csv');
  const outJson = path.join(ROOT, 'data', 'experiment-nonmynavi.json');
  const HEAD = ['name', 'cat', 'strategy', 'reachable', 'pagesFetched', 'detailPages', 'onPageNames', 'sampleNames', 'companyLinks', 'note'];
  const rows = [];
  let i = 0;
  for (const m of targets) {
    i++;
    const r = await crawlMedia(m, maxPages).catch((e) => ({ name: m.name, cat: m.cat, strategy: m.strategy, reachable: 'err', note: String(e && e.message || e).slice(0, 40), pagesFetched: 0, detailPages: 0, onPageNames: 0, sampleNames: [], companyLinks: 0 }));
    rows.push(r);
    log(`  [${i}/${targets.length}] ${r.name}: 到達${r.reachable} p${r.pagesFetched} 詳細${r.detailPages} 名前${r.onPageNames}${r.sampleNames && r.sampleNames.length ? ' ('+r.sampleNames.join('/')+')' : ''} 企業リンク${r.companyLinks} ${r.note||''}`);
    atomic(outCsv, toCsv(HEAD, rows.map((x) => ({ ...x, sampleNames: (x.sampleNames || []).join(' / ') }))));
    atomic(outJson, JSON.stringify(rows, null, 2));
  }

  const withNames = rows.filter((r) => r.onPageNames > 0);
  const L = '──────────────────────────────────────────────';
  console.log('\n' + L);
  console.log('  非マイナビ媒体 氏名露出 実測サマリ');
  console.log(L);
  console.log(`  対象媒体            : ${rows.length}`);
  console.log(`  到達OK              : ${rows.filter((r) => r.reachable === 'yes').length}`);
  console.log(`  媒体ページに個人名  : ${withNames.length}媒体`);
  withNames.forEach((r) => console.log(`     - ${r.name} (${r.cat}): ${r.sampleNames.join(' / ')}`));
  console.log(`  企業リンク10+保持   : ${rows.filter((r) => (r.companyLinks || 0) >= 10).length}媒体（company-site hop 見込み）`);
  console.log(L);
  console.log(`  出力: ${outCsv}`);
  console.log(`        ${outJson}\n`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
