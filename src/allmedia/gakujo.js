'use strict';
/**
 * あさがくナビ（Ｒｅ就活キャンパス）全掲載企業ハーベスト
 * =====================================================================
 * robots.txt の Sitemap（navi_sitemap.xml → recruit_sitemap.xml）に baseinfo/{id}/ が全社分載る（2026-10-15: 1,458社）。
 *   baseinfo … 社名(title)・従業員数・業種・本社所在地・上場（株式）
 *   employ   … 「採用予定人数／実績」= 20XX年卒予定 N名 ／ 前年度採用実績 N名
 * 電話は媒体に無い（統合側で他媒体・CRMの値を当てる）。
 *
 * 出力: data/allmedia/gakujo.json（baseinfo ID → 構造値）
 * 使い方: node src/allmedia/gakujo.js [--conc 3] [--delay 250] [--limit 0]
 */
const path = require('path');
const { fetchHtml, allowed, toText, ent, oneLine, Journal, runPool, log, getArg } = require('./http');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'data', 'allmedia', 'gakujo.json');
const CONC = parseInt(getArg('conc', '3'), 10);
const DELAY = parseInt(getArg('delay', '250'), 10);
const LIMIT = parseInt(getArg('limit', '0'), 10);
const B = 'https://www.gakujo.ne.jp/campus';

// 見出し行の直後の値（toText は見出しと値を改行で分ける）
function after(t, kw, max = 160) {
  const i = t.indexOf(kw);
  if (i < 0) return '';
  const lines = t.slice(i + kw.length, i + kw.length + max).split('\n').map((s) => s.trim()).filter(Boolean);
  return lines[0] || '';
}
function afterBlock(t, kw, stop, max = 200) {
  const i = t.indexOf(kw);
  if (i < 0) return '';
  let seg = t.slice(i + kw.length, i + kw.length + max);
  for (const s of stop) { const k = seg.indexOf(s); if (k > 0) seg = seg.slice(0, k); }
  return oneLine(seg.replace(/\n\s*／\s*\n/g, '／'));
}

function parseBase(html, id) {
  const title = ent((html.match(/<title>([^<]*)<\/title>/) || [])[1] || '');
  if (!title || /ページが見つかりません/.test(title)) return null;
  const name = oneLine(title.replace(/の新卒採用[\s\S]*$/, '').replace(/[|｜][\s\S]*$/, ''));
  const t = toText(html);
  return {
    id, 企業名: name,
    従業員数: afterBlock(t, '従業員数', ['本社所在地', '事業内容', '株式'], 120),
    業種: afterBlock(t, '業種', ['職種', '本社', '働き方'], 160),
    本社所在地: after(t, '本社所在地', 120),
    上場: ((t.match(/\n株式\n([^\n]+)/) || [])[1] || '').trim(), // 「株式会社」に当たらないよう見出し行そのものを探す
    url: B + '/company/baseinfo/' + id + '/',
  };
}
function parseEmploy(html) {
  const t = toText(html);
  const i = t.indexOf('採用予定人数');
  const blk = i < 0 ? '' : oneLine(t.slice(i, i + 260));
  const prev = (blk.match(/前年度採用実績[：: ]*\s*(\d{1,4})\s*名/) || [])[1];
  const plan = (blk.match(/(20\d{2})年卒(?:採用)?予定[：: ]*\s*(\d{1,4})\s*名/) || []);
  return {
    前年度実績: prev ? +prev : null, 予定卒年: plan[1] ? +plan[1] : null, 予定人数: plan[2] ? +plan[2] : null,
    採用本文: blk.slice(0, 200), 掲載本文: oneLine(t).slice(0, 3000),
  };
}

async function main() {
  const sm = await fetchHtml(B + '/recruit_sitemap.xml');
  const ids = [...new Set([...sm.matchAll(/company\/baseinfo\/(\d+)\//g)].map((m) => m[1]))];
  const hasEmploy = new Set([...sm.matchAll(/company\/employ\/(\d+)\//g)].map((m) => m[1]));
  log(`あさがくナビ sitemap: baseinfo ${ids.length}社 ／ employ ${hasEmploy.size}社`);
  const j = new Journal(OUT);
  let todo = ids.filter((id) => !j.has(id));
  if (LIMIT) todo = todo.slice(0, LIMIT);
  let ok = 0;
  await runPool(todo, async (id) => {
    const u = B + '/company/baseinfo/' + id + '/';
    if (!(await allowed(u))) { j.set(id, { id, 失敗: 'robots' }); return; }
    const r = parseBase(await fetchHtml(u), id);
    if (!r) { j.set(id, { id, 失敗: '取得できず' }); return; }
    if (hasEmploy.has(id)) Object.assign(r, parseEmploy(await fetchHtml(B + '/company/employ/' + id + '/')));
    j.set(id, r); ok++;
  }, { conc: CONC, delay: DELAY, every: 100, onFlush: () => j.flush(), onProgress: (d, t) => log(`  あさがく ${d}/${t} 取得${ok}`) });
  log(`完了: 台帳 ${j.size}社 → ${path.relative(ROOT, OUT)}`);
}
if (require.main === module) main().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });

module.exports = { parseBase, parseEmploy, OUT };
