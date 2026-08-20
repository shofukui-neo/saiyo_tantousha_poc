'use strict';
/**
 * 新母集団の発掘：あさがくナビ（Ｒｅ就活キャンパス）から ICP完全適合 × 採用6名以上 を刈る
 * ============================================================================
 * なぜこの媒体か（実地調査 2026-08-20）:
 *   マイナビ28卒コーパス30,016社は完全に探索済み（未着手0）で、完全新規×ICP完全適合は1,099社が上限。
 *   過去に納品した分を除くと5社しか残らないため、別の母集団が要る。列挙可能で ICP判定に必要な
 *   構造値を持つのはここだけだった:
 *     ・リクナビ    … sitemapに6,837社あるが企業ページはSPA（HTTPでは空）。従業員数も電話も無く判定不能。
 *     ・キャリタス  … 企業ページの構造値がタブ/セッション越しで、企業URLの列挙もできない。
 *     ・あさがくナビ… sitemapに企業ページ3,314社。SSRなのでHTTPだけで取れる。
 *
 * 1社あたりの取得（安い順に落とす）:
 *   1) /campus/company/baseinfo/{id}/ 企業名(title)/従業員数/業種/所在地/自社サイトURL  約0.5秒
 *      → 完全新規・従業員100-2000名・非IT をここで判定して大半を落とす
 *   2) /campus/company/employ/{id}/   「採用予定人数／実績」から前年度実績・当年予定      約0.5秒
 *      → 年間新卒6名以上でなければ捨てる（実績と予定の大きい方＝マイナビ側と揃える）
 *   3) 自社サイト                      会社概要/問い合わせ面から代表電話（extractPhones）  約1-3秒
 *      → 媒体側に電話が無いため、到達性はここで確定させる
 *
 * 出力: data/icp-gakujo-pool.csv
 * 使い方: node src/harvest-gakujo-icp.js [--limit 0] [--conc 5]
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { readCsv, toCsv } = require('./csv');
const { extractPhones, normalizeJpPhone } = require('./phone');
const { parseEmployees, scoreMochica } = require('./mochica-fit');
const { isExcludedIndustry } = require('./icp-rules');
const { buildExclusion, mkey, cleanDisplay, EMP_MIN, EMP_MAX } = require('./build-icp-fresh-1000');

const ROOT = path.resolve(__dirname, '..');
const getArg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const OUT = path.resolve(ROOT, getArg('out', 'data/icp-gakujo-pool.csv'));
const SEEN = OUT.replace(/\.csv$/, '') + '.seen.txt';
const SITEMAP = path.resolve(ROOT, getArg('sitemap', 'data/sitemaps/gj.xml'));
const CONC = Math.max(1, parseInt(getArg('conc', '5'), 10));
const LIMIT = parseInt(getArg('limit', '0'), 10);
const HIRE_MIN = parseInt(getArg('min', '6'), 10);
const DELAY = parseInt(getArg('delay', '250'), 10);
const PAST = ['data/leads-icp-fresh-perfect-1000.csv', 'data/leads-icp-perfect-named-1000.csv',
  'data/leads-icp-fresh-10000.csv', 'data/leads-icp-fresh-named-1000.csv', 'data/leads-icp-hire6-500.csv'];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const log = (m) => console.log('[' + new Date().toISOString() + '] ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COLS = ['連絡先区分', '企業名', '法人番号', '採用担当者名', '代表者名', '役職', '部署', '架電宛名', '電話番号', 'メール',
  '業種', '従業員数', '本社', '上場', '新卒フラグ', '採用予定人数', '採用実績人数', '募集職種', '掲載媒体', '卒年', '採用ページURL',
  'アポ期待度', '優先度', '確信度', 'MOCHICA適合', 'フィットティア', '完全適合根拠', 'corpID', '公式URL', '検証', '取得日'];

function fetchUrl(url, redirects) {
  if (redirects == null) redirects = 4;
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch (e) { return resolve(''); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8' }, timeout: 20000 }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects > 0) {
        r.resume(); return resolve(fetchUrl(new URL(r.headers.location, u).href, redirects - 1));
      }
      if (r.statusCode !== 200) { r.resume(); return resolve(''); }
      let b = ''; r.setEncoding('utf8');
      r.on('data', (c) => { b += c; if (b.length > 3e6) { req.destroy(); resolve(b); } });
      r.on('end', () => resolve(b));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}
const ent = (s) => String(s || '')
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d))
  .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const toText = (h) => ent(String(h || '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '\n')).replace(/\n\s*\n+/g, '\n');
const after = (t, kw, n) => { const i = t.indexOf(kw); if (i < 0) return ''; const seg = t.slice(i + kw.length, i + kw.length + (n || 90)).split('\n').filter((s) => s.trim())[0]; return (seg || '').trim(); };
function safeWrite(abs, content) {
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, content);
  for (let i = 0; i < 5; i++) { try { fs.renameSync(tmp, abs); return; } catch (e) { if (e.code === 'EPERM' || e.code === 'EBUSY') { try { fs.writeFileSync(abs, content); fs.unlinkSync(tmp); return; } catch (e2) {} } } }
  try { fs.writeFileSync(abs, content); if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
}

const SITE_HINT = /(会社概要|企業概要|会社案内|company|corporate|about|outline|profile|overview|問合せ|問い合わせ|contact|access)/i;
async function phoneFromSite(siteUrl) {
  const top = await fetchUrl(siteUrl);
  if (!top) return { phone: '', src: '' };
  const pages = [{ url: siteUrl, html: top }];
  const hrefs = [...new Set([...top.matchAll(/href=["']([^"']+)["']/g)].map((m) => m[1]))];
  const links = hrefs.filter((h) => SITE_HINT.test(h))
    .map((h) => { try { return new URL(h, siteUrl).href; } catch (e) { return ''; } })
    .filter((h) => h && h.indexOf('http') === 0).slice(0, 3);
  for (const l of links) { const html = await fetchUrl(l); if (html) pages.push({ url: l, html: html }); }
  let best = null;
  for (const p of pages) {
    // extractPhones は「最良の1件＋candidates配列」を持つオブジェクトを返す（配列ではない）
    let cands = [];
    try {
      const pr = extractPhones({ html: p.html, text: toText(p.html), pageBoost: SITE_HINT.test(p.url) ? 2 : 0 }) || {};
      cands = (pr.candidates && pr.candidates.length) ? pr.candidates : (pr.phone ? [pr] : []);
    } catch (e) { cands = []; }
    for (const c of cands) {
      if (!c || c.isFax) continue;
      const norm = normalizeJpPhone(c.phone);
      if (!norm) continue;
      if (!best || c.score > best.score) best = { phone: norm, score: c.score, src: p.url };
    }
  }
  return best ? { phone: best.phone, src: best.src } : { phone: '', src: '' };
}

async function main() {
  if (!fs.existsSync(SITEMAP)) { log('sitemapが無い: ' + SITEMAP); process.exitCode = 1; return; }
  const ids = [...new Set([...fs.readFileSync(SITEMAP, 'utf8').matchAll(/baseinfo\/(\d+)\//g)].map((m) => m[1]))];

  log('除外索引（完全新規の判定用）を構築中…');
  const excl = buildExclusion();
  const past = new Set();
  for (const rel of PAST) {
    const f = path.join(ROOT, rel);
    if (!fs.existsSync(f)) continue;
    try { for (const r of readCsv(fs.readFileSync(f, 'utf8')).records) { const k = mkey(r['企業名']); if (k) past.add(k); } } catch (e) {}
  }
  const ng = new Set();
  const ngFile = path.join(ROOT, 'data', 'ng-companies.txt');
  if (fs.existsSync(ngFile)) for (const l of fs.readFileSync(ngFile, 'utf8').split(/\r?\n/)) { const k = mkey(l); if (k) ng.add(k); }
  log('  過去納品(統合マスタ外)の社名: ' + past.size + ' ／ NG: ' + ng.size);

  const seen = new Set();
  if (fs.existsSync(SEEN)) for (const l of fs.readFileSync(SEEN, 'utf8').split(/\r?\n/)) { const t = l.trim(); if (t) seen.add(t); }
  const rows = [];
  const collected = new Set();
  if (fs.existsSync(OUT)) { try { for (const r of readCsv(fs.readFileSync(OUT, 'utf8')).records) { rows.push(r); const k = mkey(r['企業名']); if (k) collected.add(k); } } catch (e) {} }

  const todo = ids.filter((id) => !seen.has(id));
  const batch = LIMIT ? todo.slice(0, LIMIT) : todo;
  log('あさがくナビ掲載 ' + ids.length + '社 → 未探索 ' + todo.length + '社 ／ 今回 ' + batch.length + '社（並列' + CONC + '）｜既確保 ' + rows.length + '社');

  const st = { got: 0, dropDup: 0, dropEmp: 0, dropIT: 0, dropHire: 0, dropPhone: 0, ok: 0 };
  const flush = () => { safeWrite(OUT, toCsv(COLS, rows)); safeWrite(SEEN, [...seen].join('\n')); };

  let idx = 0, done = 0;
  const worker = async () => {
    while (true) {
      const i = idx++;
      if (i >= batch.length) return;
      const id = batch[i];
      seen.add(id);
      try {
        const h = await fetchUrl('https://www.gakujo.ne.jp/campus/company/baseinfo/' + id + '/');
        if (h) {
          st.got++;
          const t = toText(h);
          const rawTitle = (h.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
          const name = cleanDisplay(ent(rawTitle.replace(/の新卒採用[\s\S]*$/, '').replace(/｜[\s\S]*$/, '').trim()));
          const k = name ? mkey(name) : '';
          if (k && (excl.names.has(k) || past.has(k) || ng.has(k) || collected.has(k))) { st.dropDup++; }
          else if (k) {
            const emp = parseEmployees(after(t, '従業員数', 60));
            const ind = after(t, '業種', 60);
            if (emp == null || emp < EMP_MIN || emp > EMP_MAX) { st.dropEmp++; }
            else if (isExcludedIndustry(ind)) { st.dropIT++; }
            else {
              const addr = after(t, '本社所在地', 60) || after(t, '所在地', 60);
              const site = ([...new Set([...h.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]))]
                .filter((u) => !/gakujo\.ne\.jp|re-katsu|google|facebook|twitter|x\.com|youtube|instagram|line\.me|abc1008|sky-a\.co\.jp|tayori|yahoo|bing/i.test(u)))[0] || '';
              const he = await fetchUrl('https://www.gakujo.ne.jp/campus/company/employ/' + id + '/');
              const te = toText(he);
              const j = te.indexOf('採用予定人数');
              const blk = j < 0 ? '' : te.slice(j, j + 260);
              const jis = +((blk.match(/前年度採用実績[：: ]*\s*(\d{1,4})\s*名/) || [])[1] || 0);
              const yot = +((blk.match(/20\d{2}年卒(?:採用)?予定[：: ]*\s*(\d{1,4})\s*名/) || [])[1] || 0);
              const hire = Math.max(jis, yot);
              if (hire < HIRE_MIN) { st.dropHire++; }
              else if (!site) { st.dropPhone++; }
              else {
                const got = await phoneFromSite(site);
                if (!got.phone) { st.dropPhone++; }
                else {
                  const rec = {
                    企業名: name, corpID: 'gj' + id, 電話番号: got.phone, 業種: ind, 従業員数: String(emp), 本社: addr,
                    新卒フラグ: '新', 採用予定人数: String(hire), 採用実績人数: jis ? String(jis) : '',
                    掲載媒体: 'あさがくナビ', 卒年: '27卒(2027年卒)',
                    採用ページURL: 'https://www.gakujo.ne.jp/campus/company/employ/' + id + '/',
                    公式URL: site, 検証: 'あさがくナビ実取得＋電話は自社サイト(' + String(got.src).slice(0, 60) + ')',
                    取得日: new Date().toISOString().slice(0, 10),
                  };
                  const s = scoreMochica(rec);
                  rec.連絡先区分 = '名前なし';
                  rec.架電宛名 = 'ご採用ご担当者様';
                  rec.アポ期待度 = String(s.total); rec.優先度 = s.priority; rec.確信度 = String(s.confidence);
                  rec.MOCHICA適合 = s.total >= 80 ? '◎' : s.total >= 65 ? '○' : '△';
                  rec.フィットティア = 'S:完全適合(新母集団)';
                  rec.完全適合根拠 = '完全新規(過去納品含め不在)｜あさがくナビ掲載｜従業員' + emp + '名(' + EMP_MIN + '-' + EMP_MAX + ')｜非IT(' + ind + ')｜電話妥当｜年間新卒' + hire + '名' + (jis ? '(前年度実績)' : '(採用予定)');
                  const o = {}; for (const c of COLS) o[c] = rec[c] != null ? String(rec[c]) : '';
                  rows.push(o); collected.add(k); st.ok++;
                  log('  OK ' + name + ' / 従' + emp + ' / ' + String(ind).slice(0, 14) + ' / 採用' + hire + '名 / ' + got.phone + ' -> ' + rows.length);
                }
              }
            }
          }
        }
      } catch (e) { /* 1社の失敗は無視 */ }
      if (++done % 50 === 0) {
        flush();
        log('  ...' + done + '/' + batch.length + ' 取得' + st.got + ' ｜ 既存' + st.dropDup + ' 規模外' + st.dropEmp + ' IT' + st.dropIT + ' 6名未満' + st.dropHire + ' 電話無' + st.dropPhone + ' ｜ 確保' + rows.length);
      }
      await sleep(DELAY);
    }
  };
  await Promise.all(Array.from({ length: CONC }, () => worker()));
  flush();
  log('完了: 確保 ' + rows.length + '社（取得' + st.got + ' 既存' + st.dropDup + ' 規模外' + st.dropEmp + ' IT' + st.dropIT + ' 6名未満' + st.dropHire + ' 電話無' + st.dropPhone + '）');
  log('出力: ' + OUT);
}

if (require.main === module) main().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
