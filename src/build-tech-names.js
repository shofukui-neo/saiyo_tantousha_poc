'use strict';
// 系統D（ネットワーク/既存資産）テック源ビルダー: IT/Web企業向けに GitHub（技術者の実名）と
// connpass（採用イベント主催/登壇者）から「中の人」氏名を収集する。
// ※ 採用担当そのものとは限らない（GitHub=技術者/connpass=主催者）。種別列で区別して出す。
//
//   node src/build-tech-names.js --in leads-mochica-target.csv --out sources/T-tech-names.csv --source both --limit 100
//   GITHUB_TOKEN を置くとGitHubが5000req/h。CONNPASS_API_KEY を置くとconnpassが点火。
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, mergeKey } = require('./csv');
const { findGithubContacts } = require('./scrape-github');
const { findConnpassContacts, configured: cpConfigured } = require('./scrape-connpass');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
const IN = getArg('in', 'leads-mochica-target.csv');
const OUT = getArg('out', path.join('sources', 'T-tech-names.csv'));
const LIMIT = parseInt(getArg('limit', '0'), 10) || 0;
const SOURCE = String(getArg('source', 'both')).toLowerCase(); // github|connpass|both
const PER_MS = parseInt(getArg('company-timeout', '60000'), 10) || 60000;

function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }
function withTimeout(p, ms, onT) {
  return new Promise((res) => { const t = setTimeout(() => res(typeof onT === 'function' ? onT() : onT), ms); p.then((v) => { clearTimeout(t); res(v); }, () => { clearTimeout(t); res(onT && onT()); }); });
}

async function run() {
  const useGh = SOURCE === 'both' || SOURCE === 'github';
  const useCp = SOURCE === 'both' || SOURCE === 'connpass';
  log(`テック源: github=${useGh}${useGh && !process.env.GITHUB_TOKEN ? '(無トークン=低レート)' : ''} connpass=${useCp}${useCp && !cpConfigured() ? '(キー無=skip)' : ''}`);

  const text = fs.readFileSync(path.resolve(IN), 'utf8');
  let { records } = readCsv(text);
  if (LIMIT) records = records.slice(0, LIMIT);

  const headers = ['企業名', '法人番号', '氏名', '種別', '役職', '所属/根拠',
    '取得元媒体', 'チャネル', '根拠URL', '確度', '探索結果', '取得日'];
  const OUTABS = path.resolve(OUT);
  fs.mkdirSync(path.dirname(OUTABS), { recursive: true });

  const out = [];
  const doneKeys = new Set();
  if (!process.argv.includes('--fresh') && fs.existsSync(OUTABS)) {
    try { for (const r of readCsv(fs.readFileSync(OUTABS, 'utf8')).records) { const k = mergeKey(r) + '|' + r['氏名']; doneKeys.add(k); out.push(r); } } catch (_) {}
  }
  const doneCompanies = new Set(out.map((r) => mergeKey(r)));
  const todo = records.filter((r) => !doneCompanies.has(mergeKey(r)));
  log(`対象 ${todo.length}社（既存 ${doneCompanies.size}社スキップ）`);

  const today = new Date().toISOString().slice(0, 10);
  const flush = () => { const tmp = OUTABS + '.tmp'; fs.writeFileSync(tmp, toCsv(headers, out)); fs.renameSync(tmp, OUTABS); };
  let done = 0;

  for (const rec of todo) {
    const name = rec['企業名'] || rec['company_name'] || '';
    if (!name) continue;
    const rows = [];
    await withTimeout((async () => {
      const detail = {};
      if (useGh) {
        try { const g = await findGithubContacts(name, { maxOrgs: 2, maxMembers: 8 }); Object.assign(detail, g.詳細);
          for (const c of g.contacts) rows.push(mk(name, rec, c, 'GitHub')); } catch (e) { detail['GitHub'] = 'err:' + (e.message || '').slice(0, 30); }
      }
      if (useCp) {
        try { const cp = await findConnpassContacts(name, { maxEvents: 10 }); Object.assign(detail, cp.詳細);
          for (const c of cp.contacts) rows.push(mk(name, rec, c, c.kind || 'connpass')); } catch (e) { detail['connpass'] = 'err:' + (e.message || '').slice(0, 30); }
      }
      // 候補ゼロでも探索結果を1行残す（再開・KPIのため）
      if (!rows.length) rows.push({ 企業名: name, 法人番号: rec['法人番号'] || '', 氏名: '', 種別: '', 役職: '', '所属/根拠': '', 取得元媒体: '', チャネル: 'tech', 根拠URL: '', 確度: '', 探索結果: Object.entries(detail).map(([k, v]) => `${k}:${v}`).join(' / '), 取得日: today });
      else rows.forEach((r) => { r['探索結果'] = Object.entries(detail).map(([k, v]) => `${k}:${v}`).join(' / '); });
    })(), PER_MS, () => { rows.push({ 企業名: name, 法人番号: rec['法人番号'] || '', 氏名: '', 種別: '', 役職: '', '所属/根拠': '', 取得元媒体: '', チャネル: 'tech', 根拠URL: '', 確度: '', 探索結果: 'timeout', 取得日: today }); });
    out.push(...rows);
    if (++done % 5 === 0) { flush(); log(`  ${done}/${todo.length}（氏名行 累計 ${out.filter((r) => r['氏名']).length}）`); }
  }
  flush();
  const named = out.filter((r) => r['氏名']).length;
  const companiesWithName = new Set(out.filter((r) => r['氏名']).map((r) => r['企業名'])).size;
  log(`完了: 氏名 ${named}件 / ${companiesWithName}社（出力 ${OUTABS}）`);

  function mk(company, rec, c, media) {
    return {
      企業名: company, 法人番号: rec['法人番号'] || '', 氏名: c.name, 種別: c.kind || c.role || '',
      役職: c.role || '', '所属/根拠': c.company || '', 取得元媒体: media, チャネル: 'tech',
      根拠URL: c.url || '', 確度: c.confidence || '', 探索結果: '', 取得日: today,
    };
  }
}

run().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
