'use strict';
/**
 * 公式URL・法人番号の補完（gBizINFO 名前検索）
 * =====================================================================
 * 公式URLが空の行について gBizINFO を社名（＋都道府県）で検索し、正規化社名が一致した
 * 法人の company_url / corporate_number を埋める。ATS判定（enrich-ats.js）は公式URLが
 * 無いと「不明」にしかならないため、その前段として使う。
 *
 *   node src/enrich-url-gbiz.js --in data/xxx.csv [--out 同じ] [--limit 0] [--refresh]
 *
 * - gBiz は並列で 429 になるので src/gbiz.js の直列スロットル（既定700ms間隔）に従う
 * - 取得結果は data/gbiz-url-cache.json に社単位で貯め、再実行時は取得しない
 * - 付与列: 公式URL（空のときだけ）, 法人番号（空のときだけ）, URL補完元
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, normCompanyName, stripAnnotations, toHalfWidth } = require('./csv');
const { gbizAvailable, gbizSearch, gbizGet } = require('./gbiz');
const cfg = require('./config');

const ROOT = path.resolve(__dirname, '..');
const getArg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const IN = path.resolve(ROOT, getArg('in', ''));
const OUT = path.resolve(ROOT, getArg('out', getArg('in', '')));
const CACHE = path.resolve(ROOT, getArg('cache', 'data/gbiz-url-cache.json'));
const LIMIT = parseInt(getArg('limit', '0'), 10) || 0;
const REFRESH = process.argv.includes('--refresh');
const log = (m) => console.log('[' + new Date().toISOString() + '] ' + m);

const PREF_RE = /(北海道|東京都|(?:京都|大阪)府|[一-龥]{2,3}県)/;
// gBiz の name パラメータは部分一致。法人格と括弧注釈を外した「中核名」で投げる
function queryName(name) {
  let s = stripAnnotations(toHalfWidth(String(name || '')).replace(/[㈱㈲㈳㈿]/g, '')).trim();
  for (const f of ['株式会社', '有限会社', '合同会社', '合資会社', '合名会社']) s = s.split(f).join('');
  return s.replace(/\s+/g, '').trim();
}

async function resolveOne(name, pref) {
  const q = queryName(name);
  if (!q) return null;
  const want = normCompanyName(name);
  const tryParams = [{ name: q, prefecture: '' }];
  let hits = [];
  for (const p of tryParams) {
    const params = { name: p.name, limit: 50 };
    hits = await gbizSearch(params, cfg);
    if (hits.length) break;
  }
  if (!hits.length) return { status: 'nohit' };
  const exact = hits.filter((h) => normCompanyName(h.name) === want);
  let pick = null;
  if (exact.length === 1) pick = exact[0];
  else if (exact.length > 1) {
    // 同名複数: 都道府県一致 → URL保有 の順で選ぶ
    const byPref = pref ? exact.filter((h) => String(h.prefecture || '').includes(pref)) : [];
    pick = (byPref.length ? byPref : exact).find((h) => h.websiteUrl) || (byPref.length ? byPref : exact)[0];
    if (byPref.length === 0 && pref && exact.length > 1) return { status: 'ambiguous', n: exact.length };
  } else return { status: 'nomatch', n: hits.length };
  // 検索APIの応答は company_url を落とすことが多い（実測60社で0件）。法人番号の詳細APIで引き直す（実測12社中5社にURL）
  let url = pick.websiteUrl || '';
  if (!url && pick.corporateNumber) {
    const d = await gbizGet(pick.corporateNumber, cfg);
    if (d && d.websiteUrl) url = d.websiteUrl;
  }
  return { status: 'ok', corporateNumber: pick.corporateNumber, url, prefecture: pick.prefecture || '', gbizName: pick.name };
}

async function main() {
  if (!IN || !fs.existsSync(IN)) { console.error('--in を指定してください'); process.exitCode = 1; return; }
  if (!gbizAvailable(cfg)) { console.error('GBIZ_TOKEN 未設定'); process.exitCode = 1; return; }
  const { records, headers } = readCsv(fs.readFileSync(IN, 'utf8'));
  const cols = headers.slice();
  for (const c of ['公式URL', '法人番号', 'URL補完元']) if (!cols.includes(c)) cols.push(c);
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (_) {}
  const g = (r, k) => String(r[k] == null ? '' : r[k]).trim();
  const todo = records.filter((r) => !/^https?:\/\//i.test(g(r, '公式URL')));
  const targets = LIMIT ? todo.slice(0, LIMIT) : todo;
  log(`入力 ${records.length}社／URL空 ${todo.length}社／今回 ${targets.length}社／キャッシュ ${Object.keys(cache).length}社`);
  const st = { ok: 0, url: 0, nohit: 0, nomatch: 0, ambiguous: 0, cached: 0 };
  const flush = () => { fs.writeFileSync(OUT, toCsv(cols, records)); fs.writeFileSync(CACHE, JSON.stringify(cache)); };
  let done = 0;
  for (const r of targets) {
    const name = g(r, '企業名');
    const key = 'N:' + normCompanyName(name);
    const pref = (g(r, '都道府県') || g(r, '本社')).match(PREF_RE) ? (g(r, '都道府県') || g(r, '本社')).match(PREF_RE)[1] : '';
    let res = (!REFRESH && cache[key]) ? cache[key] : null;
    if (res) st.cached++;
    else { try { res = await resolveOne(name, pref); } catch (e) { res = { status: 'error', msg: String(e && e.message || e).slice(0, 80) }; } cache[key] = Object.assign({ at: new Date().toISOString().slice(0, 10) }, res || {}); }
    if (res && res.status === 'ok') {
      st.ok++;
      if (res.url) { st.url++; if (!g(r, '公式URL')) r['公式URL'] = res.url; r['URL補完元'] = 'gBizINFO(社名一致' + (res.prefecture ? '/' + res.prefecture : '') + ')'; }
      if (res.corporateNumber && !g(r, '法人番号')) r['法人番号'] = res.corporateNumber;
    } else if (res && st[res.status] != null) st[res.status]++;
    if (++done % 50 === 0) { flush(); log(`  ${done}/${targets.length} 一致${st.ok} URL付与${st.url} 該当なし${st.nohit} 不一致${st.nomatch} 同名複数${st.ambiguous} (キャッシュ${st.cached})`); }
  }
  flush();
  log(`完了: 一致${st.ok} URL付与${st.url} 該当なし${st.nohit} 不一致${st.nomatch} 同名複数${st.ambiguous} → ${path.relative(ROOT, OUT)}`);
}
if (require.main === module) main().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
module.exports = { queryName, resolveOne };
