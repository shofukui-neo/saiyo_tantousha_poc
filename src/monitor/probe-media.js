'use strict';
// 媒体「監視可能性」実地プローブ。あらゆる新卒媒体について、実際に検索URLを叩いて
//   ①robots許可 ②取得方式(静的で十分か/JS描画が要るか) ③企業リスト抽出可否 ④鮮度マーカー有無
// を実データで判定し、media-probe.json に蓄積。docs/media-monitorability.md を再生成する。
//
// 設計思想: 求人ボックスの観測器と同じく全取得は polite.js 経由（robots遵守・レート制限・キャッシュ）。
// 失敗(404/JS必須/robots不可)も「実証結果」として正直に記録する。
//   node src/monitor/probe-media.js            # 未プローブを最大 BATCH 件だけ叩く（resume）
//   node src/monitor/probe-media.js --batch 99 # 件数上限を上書き
//   node src/monitor/probe-media.js --fresh     # 全件やり直し
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { politeGet } = require('../polite');
const { CATALOG } = require('./media-catalog');

const OUT_JSON = path.resolve(__dirname, '..', '..', 'data', 'monitor', 'media-probe.json');
const OUT_MD = path.resolve(__dirname, '..', '..', 'docs', 'media-monitorability.md');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
const BATCH = parseInt(getArg('batch', '8'), 10) || 8;
const FRESH = process.argv.includes('--fresh');

const FRESH_RE = /新着|本日|昨日|今日|\d+日前|\d+時間前|掲載日|更新日|締切|公開日|エントリー受付|(?:20[0-9]{2})[\/.年](?:1[0-2]|0?[1-9])[\/.月](?:[0-3]?[0-9])/g;
const COMPANY_RE = /株式会社|有限会社|（株）|\(株\)|合同会社/g;

function analyze(html, query) {
  const len = html.length;
  const $ = cheerio.load(html);
  const bodyText = $('body').text().replace(/\s+/g, ' ');
  const textLen = bodyText.length;
  // JSアプリ判定: ハイドレーション痕跡 + 本文が薄い
  const jsHints = /__NEXT_DATA__|__NUXT__|id="root"|id="app"|data-reactroot|window\.__INITIAL/.test(html);
  const thinText = textLen < 1500;
  const needsJs = jsHints && thinText;
  // 鮮度マーカー
  const fm = bodyText.match(FRESH_RE) || [];
  const freshSamples = [...new Set(fm)].slice(0, 6);
  // 企業密度
  const compHits = (bodyText.match(COMPANY_RE) || []).length;
  const companyLinks = $('a[href*="/company"], a[href*="/companies"], a[href*="/corp"], a[href*="/recruit"]').length;
  // 検索が効いたか（クエリ語が本文に反響 or 企業密度が高い）
  const searchEcho = query ? bodyText.includes(query.replace(/\s+/g, '')) || query.split(/\s+/).some((t) => t.length > 1 && bodyText.includes(t)) : false;
  return { len, textLen, needsJs, jsHints, freshCount: fm.length, freshSamples, compHits, companyLinks, searchEcho };
}

function verdict(p) {
  if (p.robotsBlocked) return 'BLOCKED(robots)';
  if (p.error) return 'ERROR';
  if (!p.http) return 'NO_HTML';
  const a = p.analysis;
  if (!a) return 'NO_HTML';
  const extractable = a.compHits >= 5 || a.companyLinks >= 5;
  if (a.needsJs && !extractable) return 'NEEDS_JS'; // 静的では薄い→Playwright経路が必要
  if (extractable) return a.freshCount > 0 ? 'STATIC_OK+FRESH' : 'STATIC_OK';
  return 'WEAK'; // 取得はできるが企業リストが薄い（検索URL要調整）
}

async function probeOne(m) {
  const url = typeof m.searchUrl === 'function' ? m.searchUrl(m.query || '新卒') : m.url;
  const rec = { name: m.name, tier: m.tier, url, query: m.query || '新卒', ts: new Date().toISOString() };
  try {
    const r = await Promise.race([
      politeGet(url, { render: 'static' }),
      new Promise((res) => setTimeout(() => res({ error: 'timeout' }), 30000)),
    ]);
    if (!r) { rec.error = 'null'; }
    else if (r.blocked) { rec.robotsBlocked = true; rec.reason = r.reason; }
    else if (r.error) { rec.error = String(r.error).slice(0, 80); }
    else if (r.html) { rec.http = true; rec.analysis = analyze(r.html, m.query); }
    else { rec.error = 'no-html'; }
  } catch (e) { rec.error = String(e && e.message || e).slice(0, 80); }
  rec.verdict = verdict(rec);
  return rec;
}

function loadAcc() { try { return JSON.parse(fs.readFileSync(OUT_JSON, 'utf8')); } catch (_) { return {}; } }
function saveAcc(acc) {
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(acc, null, 2));
}

const V_ICON = {
  'STATIC_OK+FRESH': '◎ 静的OK・鮮度あり', 'STATIC_OK': '○ 静的OK', 'NEEDS_JS': '△ JS描画必要',
  'WEAK': '▽ 取得弱(URL要調整)', 'OUT': '－ 構造的に対象外', 'BLOCKED(robots)': '✕ robots不可', 'ERROR': '✕ エラー', 'NO_HTML': '✕ HTML無',
};

function regenReport(acc) {
  const all = Object.values(acc);
  const byTier = {};
  for (const r of all) (byTier[r.tier] = byTier[r.tier] || []).push(r);
  const lines = [];
  lines.push('# 新卒媒体 監視可能性マトリクス（実地プローブ結果）');
  lines.push('');
  lines.push(`- 最終更新: ${new Date().toISOString()}　／　プローブ済: ${all.length}媒体`);
  const counts = {};
  for (const r of all) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  lines.push(`- 内訳: ${Object.entries(counts).map(([k, v]) => `${V_ICON[k] || k}=${v}`).join(' ／ ')}`);
  lines.push('');
  const TIER_JA = { major: '大手総合', regional: '地方系', specialized: '専門職/理系/逆求人', aggregator: '横断/口コミ' };
  for (const tier of ['major', 'regional', 'specialized', 'aggregator']) {
    const rows = byTier[tier];
    if (!rows || !rows.length) continue;
    lines.push(`## ${TIER_JA[tier] || tier}`);
    lines.push('');
    lines.push('| 媒体 | 判定 | 鮮度マーカー | 企業密度 | 備考 |');
    lines.push('|------|------|-------------|---------|------|');
    for (const r of rows.sort((a, b) => a.verdict.localeCompare(b.verdict))) {
      const a = r.analysis || {};
      const fresh = a.freshCount ? `${a.freshCount}件 (${(a.freshSamples || []).slice(0, 3).join('/')})` : '—';
      const dens = r.http ? `株式会社×${a.compHits || 0}, link×${a.companyLinks || 0}` : '—';
      const note = r.note || (r.robotsBlocked ? 'robots disallow' : (r.error || (a.needsJs ? 'JSアプリ' : '')));
      lines.push(`| ${r.name} | ${V_ICON[r.verdict] || r.verdict} | ${fresh} | ${dens} | ${note} |`);
    }
    lines.push('');
  }
  lines.push('## 凡例');
  lines.push('- ◎/○=静的取得で企業リスト抽出可（求人ボックスと同じ静的経路で観測器化できる）');
  lines.push('- △=JS描画が必要（Playwright経路 scrape-base.js に寄せれば可能、低速）');
  lines.push('- ▽=取得はできるが検索URL/セレクタ要調整　✕=robots不可・到達不可（監視対象外 or 別経路要）');
  fs.writeFileSync(OUT_MD, lines.join('\n'));
}

module.exports = { analyze, verdict, probeOne, regenReport, loadAcc, saveAcc, FRESH_RE, COMPANY_RE };

if (require.main !== module) return;

(async () => {
  const acc = FRESH ? {} : loadAcc();
  const todo = CATALOG.filter((m) => !acc[m.name]).slice(0, BATCH);
  console.log(`[probe] カタログ${CATALOG.length}媒体中、未プローブ ${CATALOG.filter((m) => !acc[m.name]).length} ｜ 今回 ${todo.length}件を実証`);
  for (const m of todo) {
    const rec = await probeOne(m);
    acc[m.name] = rec;
    saveAcc(acc);
    const a = rec.analysis || {};
    console.log(`  ${rec.verdict.padEnd(16)} ${m.name}　鮮度${a.freshCount || 0} 企業${a.compHits || 0}/${a.companyLinks || 0}　${rec.error || rec.reason || ''}`);
  }
  regenReport(acc);
  const done = Object.keys(acc).length;
  const remain = CATALOG.filter((m) => !acc[m.name]).length;
  console.log(`[probe] 完了: 累計${done}/${CATALOG.length}媒体　残り${remain}　→ ${path.relative(process.cwd(), OUT_MD)}`);
})();
