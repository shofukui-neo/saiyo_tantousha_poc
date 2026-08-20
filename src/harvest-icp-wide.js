'use strict';
/**
 * 幅を広げた再探索：規模帯を広げて「過去に渡した分と1社も被らない」ICP適合×採用6名以上を刈る
 * ============================================================================
 * 背景（2026-08-20 実測）:
 *   マイナビ28卒コーパス30,016社のうち、既存CRM（統合マスタ30,290＋BALES＋MOCHICA顧客＋SF全リード）
 *   と過去納品リストに社名が無いのは **2,347社だけ**。27卒側の追加分を足しても2,694社が母集団の全量。
 *   このうち従来ICP（従業員100〜2000名）で通ったものは既に納品済みなので、残りは
 *   「規模帯から外れて落とした社」が大半（v2実測: 探索1,598社中977社=61%が規模外）。
 *   ユーザー判断（2026-08-20）で規模帯を 50〜3000名 に広げ、他の条件は据え置いて刈り直す。
 *
 * 高速化の勘所:
 *   マイナビの会社概要(outline.html)は **Playwright無しの素のHTTPで取得できる**（実測0.3秒）。
 *   しかも1枚に 業種／従業員数／本社／電話番号／過去3年間の新卒採用者数 が全部載っている＝
 *   ICP判定に必要な一次情報がワンショットで揃う（旧パイプラインは1社12秒かけて巡回していた）。
 *   HTML→テキスト化のとき表が「15 | 名」と割れるので、数字と「名」を結合してから実績を読む。
 *
 * ハード条件（1つでも欠けたら捨てる）:
 *   ① 完全新規（既存CRM＋過去納品リストのいずれにも社名が不在）
 *   ② 新卒インテント（マイナビ掲載を実取得）
 *   ③ 従業員 EMP_MIN〜EMP_MAX 名（既定 50〜3000）
 *   ④ 非IT   ⑤ 電話番号が妥当   ⑥ 年間新卒採用6名以上（会社概要の実績＝直近年）
 *
 * 出力: data/icp-wide-pool.csv ／ 採用人数は data/hire-count.json にも追記
 * 使い方: node src/harvest-icp-wide.js [--emp-min 50] [--emp-max 3000] [--conc 6] [--limit 0]
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { readCsv, toCsv } = require('./csv');
const { extractOutlineFacts } = require('./scrape-mynavi');
const { extractHireRecord } = require('./enrich-hire-record');
const { extractPhones, normalizeJpPhone } = require('./phone');
const { parseEmployees, scoreMochica } = require('./mochica-fit');
const { isExcludedIndustry } = require('./icp-rules');
const { buildExclusion, mkey, cleanDisplay } = require('./build-icp-fresh-1000');

const ROOT = path.resolve(__dirname, '..');
const getArg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const OUT = path.resolve(ROOT, getArg('out', 'data/icp-wide-pool.csv'));
const SEEN = OUT.replace(/\.csv$/, '') + '.seen.txt';
const LEDGER = path.resolve(ROOT, 'data/hire-count.json');
const EMP_MIN = parseInt(getArg('emp-min', '50'), 10);
const EMP_MAX = parseInt(getArg('emp-max', '3000'), 10);
const HIRE_MIN = parseInt(getArg('min', '6'), 10);
const CONC = Math.max(1, parseInt(getArg('conc', '6'), 10));
const LIMIT = parseInt(getArg('limit', '0'), 10);
const DELAY = parseInt(getArg('delay', '120'), 10);
const CORPORA = [['data/mynavi-2028-corpus.csv', '28'], ['data/mynavi-2027-corpus.csv', '27']];
// 「過去に渡したリスト」= 統合マスタに入っていない直近の成果物すべて（ユーザー指定 2026-08-20）
const PAST = ['data/leads-icp-fresh-perfect-1000.csv', 'data/leads-icp-perfect-named-1000.csv',
  'data/leads-icp-fresh-10000.csv', 'data/leads-icp-fresh-named-1000.csv', 'data/leads-icp-hire6-500.csv',
  'data/icp-fresh-pool.csv', 'data/icp-legacy-verified.csv', 'data/icp-hire6-pool-27.csv', 'data/icp-gakujo-pool.csv'];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const log = (m) => console.log('[' + new Date().toISOString() + '] ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COLS = ['連絡先区分', '企業名', '法人番号', '採用担当者名', '代表者名', '役職', '部署', '架電宛名', '電話番号', 'メール',
  '業種', '従業員数', '本社', '上場', '新卒フラグ', '採用予定人数', '採用実績人数', '採用実績3年', '募集職種', '掲載媒体', '卒年',
  '採用ページURL', 'アポ期待度', '優先度', '確信度', 'MOCHICA適合', 'フィットティア', '完全適合根拠', 'corpID', '検証', '取得日'];

function fetchUrl(url, redirects) {
  if (redirects == null) redirects = 3;
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch (e) { return resolve(''); }
    const req = https.get(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8' }, timeout: 20000 }, (r) => {
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
  .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"');
// HTMLをテキスト化。表のセルが「15 | 名」と割れるので数字と単位を結合してから解析器に渡す。
function toText(h) {
  let t = String(h || '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '\n');
  t = ent(t).replace(/\n\s*\n+/g, '\n');
  return t.replace(/(\d)\s*名/g, '$1名').replace(/(\d)\s*%/g, '$1%');
}
// 会社概要テキストから代表電話を取る。ラベル直後が最優先、駄目なら extractPhones で拾い直す
// （実測: 「電話番号（人事課）」「026－268-0050」のような表記で厳格正規表現だけだと1割弱を取り逃す）。
function phoneFrom(html, t) {
  const raw = (t.match(/電話番号[^0-9０-９]{0,8}([0-9０-９][0-9０-９\-‐－―ー()（） ]{8,21})/) || [])[1] || '';
  let phone = normalizeJpPhone(raw);
  if (phone) return phone;
  try {
    const pr = extractPhones({ html: html, text: t }) || {};
    const list = (pr.candidates && pr.candidates.length) ? pr.candidates : (pr.phone ? [pr] : []);
    for (const c of list) { if (c.isFax) continue; const nz = normalizeJpPhone(c.phone); if (nz) return nz; }
  } catch (e) {}
  return '';
}

function safeWrite(abs, content) {
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, content);
  for (let i = 0; i < 5; i++) { try { fs.renameSync(tmp, abs); return; } catch (e) { if (e.code === 'EPERM' || e.code === 'EBUSY') { try { fs.writeFileSync(abs, content); fs.unlinkSync(tmp); return; } catch (e2) {} } } }
  try { fs.writeFileSync(abs, content); if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
}

async function main() {
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
  log('  過去に渡したリスト（統合マスタ外）の社名: ' + past.size + ' ／ NG: ' + ng.size);

  const seen = new Set();
  if (fs.existsSync(SEEN)) for (const l of fs.readFileSync(SEEN, 'utf8').split(/\r?\n/)) { const t = l.trim(); if (t) seen.add(t); }
  const rows = [];
  const collected = new Set();
  if (fs.existsSync(OUT)) { try { for (const r of readCsv(fs.readFileSync(OUT, 'utf8')).records) { rows.push(r); const k = mkey(r['企業名']); if (k) collected.add(k); } } catch (e) {} }
  let ledger = {};
  if (fs.existsSync(LEDGER)) { try { ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8')) || {}; } catch (e) {} }

  // 候補：社名が既存にも過去納品にも無い社だけ（ここで9割落ちるのでHTTPを1回も払わない）
  const cand = [];
  const dedup = new Set();
  for (const [rel, gy] of CORPORA) {
    const f = path.join(ROOT, rel);
    if (!fs.existsSync(f)) continue;
    let n = 0;
    for (const r of readCsv(fs.readFileSync(f, 'utf8')).records) {
      const id = String(r.corpID || '').trim();
      const k = mkey(r['企業名']);
      if (!id || !k) continue;
      const key = gy + ':' + id;
      if (dedup.has(key) || seen.has(key)) continue;
      if (excl.names.has(k) || past.has(k) || ng.has(k) || collected.has(k)) continue;
      dedup.add(key); cand.push({ id, gy, name: r['企業名'] }); n++;
    }
    log('  ' + path.basename(rel) + ' → 候補 ' + n + '社');
  }
  const batch = LIMIT ? cand.slice(0, LIMIT) : cand;
  log('再探索の対象 ' + batch.length + '社（従業員' + EMP_MIN + '〜' + EMP_MAX + '名・年間新卒' + HIRE_MIN + '名以上・並列' + CONC + '）｜既確保 ' + rows.length + '社');
  if (!batch.length) { log('対象なし。終了。'); return; }

  const st = { got: 0, dup: 0, emp: 0, it: 0, phone: 0, hire: 0, noRec: 0, ok: 0 };
  const flush = () => { safeWrite(OUT, toCsv(COLS, rows)); safeWrite(SEEN, [...seen].join('\n')); safeWrite(LEDGER, JSON.stringify(ledger, null, 1)); };

  let idx = 0, done = 0;
  const worker = async () => {
    while (true) {
      const i = idx++;
      if (i >= batch.length) return;
      const c = batch[i];
      seen.add(c.gy + ':' + c.id);
      try {
        const url = 'https://job.mynavi.jp/' + c.gy + '/pc/search/corp' + c.id + '/outline.html';
        const html = await fetchUrl(url);
        if (html) {
          st.got++;
          const t = toText(html);
          const h1 = ent(((html.match(/<h1[^>]*>([\s\S]{0,120}?)<\/h1>/) || [])[1] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
          const name = cleanDisplay(h1 || c.name);
          const k = name ? mkey(name) : '';
          if (k && (excl.names.has(k) || past.has(k) || ng.has(k) || collected.has(k))) { st.dup++; }
          else if (k) {
            const facts = extractOutlineFacts(t);
            const emp = parseEmployees(facts.従業員数);
            const ind = facts.業種 || '';
            if (emp == null || emp < EMP_MIN || emp > EMP_MAX) { st.emp++; }
            else if (!ind || isExcludedIndustry(ind)) { st.it++; }
            else {
              let phone = phoneFrom(html, t);
              let rec = extractHireRecord(t);
              // 28卒面は掲載が始まったばかりで電話や採用実績が空のことがある。同じcorpIDの別卒年面を1回だけ引く
              // （h1の社名が一致するときだけ採用。corpIDは卒年をまたいで安定だが、取り違えは致命的なので必ず突合）。
              if (!phone || !rec) {
                const alt = c.gy === '28' ? '27' : '28';
                const h2 = await fetchUrl('https://job.mynavi.jp/' + alt + '/pc/search/corp' + c.id + '/outline.html');
                if (h2) {
                  const raw2 = (h2.match(/<h1[^>]*>([^]{0,120}?)<\/h1>/) || [])[1] || '';
                  const h1b = ent(raw2.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
                  if (h1b && mkey(cleanDisplay(h1b)) === k) {
                    const t2 = toText(h2);
                    if (!phone) phone = phoneFrom(h2, t2);
                    if (!rec) rec = extractHireRecord(t2);
                  }
                }
              }
              if (!phone) { st.phone++; }
              else {
                if (!rec) { st.noRec++; }
                else if (rec.人数 < HIRE_MIN) { st.hire++; }
                else {
                  ledger[c.id] = Object.assign(ledger[c.id] || {}, {
                    企業名: name, 実績人数: String(rec.人数), 実績年: String(rec.年),
                    実績3年: rec.系列.map((x) => x.年 + '年' + x.人数 + '名').join('/'),
                    実績根拠: rec.出所 + '（マイナビ' + c.gy + '卒面）｜' + rec.系列.map((x) => x.年 + '年' + x.人数 + '名').join('・'),
                    実績照会済: true,
                  });
                  const o0 = {
                    企業名: name, corpID: c.id, 電話番号: phone, 業種: ind, 従業員数: String(emp),
                    本社: facts.本社 || '', 上場: facts.上場 || '', 新卒フラグ: '新',
                    採用予定人数: String(rec.人数), 採用実績人数: String(rec.人数),
                    採用実績3年: rec.系列.map((x) => x.年 + '年' + x.人数 + '名').join('/'),
                    掲載媒体: 'マイナビ', 卒年: c.gy + '卒(20' + c.gy + '年卒)', 採用ページURL: url,
                    検証: 'マイナビ会社概要をHTTP実取得（業種/従業員数/電話/新卒採用実績）',
                    取得日: new Date().toISOString().slice(0, 10),
                  };
                  const s = scoreMochica(o0);
                  o0.連絡先区分 = '名前なし';
                  o0.架電宛名 = 'ご採用ご担当者様';
                  o0.アポ期待度 = String(s.total); o0.優先度 = s.priority; o0.確信度 = String(s.confidence);
                  o0.MOCHICA適合 = s.total >= 80 ? '◎' : s.total >= 65 ? '○' : '△';
                  o0.フィットティア = 'S:完全適合(規模帯拡張)';
                  o0.完全適合根拠 = '完全新規(既存CRM＋過去納品に不在)｜マイナビ' + c.gy + '卒掲載｜従業員' + emp + '名(' + EMP_MIN + '-' + EMP_MAX + ')｜非IT(' + ind + ')｜電話妥当｜年間新卒' + rec.人数 + '名(' + rec.年 + '年実績)';
                  const o = {}; for (const col of COLS) o[col] = o0[col] != null ? String(o0[col]) : '';
                  rows.push(o); collected.add(k); st.ok++;
                  log('  OK ' + name + ' / 従' + emp + ' / ' + String(ind).slice(0, 16) + ' / 採用' + rec.人数 + '名(' + rec.年 + ') / ' + phone + ' -> ' + rows.length);
                }
              }
            }
          }
        }
      } catch (e) { /* 1社の失敗は無視 */ }
      if (++done % 100 === 0) {
        flush();
        log('  ...' + done + '/' + batch.length + ' 取得' + st.got + ' ｜ 既出' + st.dup + ' 規模外' + st.emp + ' IT' + st.it + ' 電話無' + st.phone + ' 実績なし' + st.noRec + ' 6名未満' + st.hire + ' ｜ 確保' + rows.length);
      }
      await sleep(DELAY);
    }
  };
  await Promise.all(Array.from({ length: CONC }, () => worker()));
  flush();
  log('完了: 確保 ' + rows.length + '社（取得' + st.got + ' 既出' + st.dup + ' 規模外' + st.emp + ' IT' + st.it + ' 電話無' + st.phone + ' 実績なし' + st.noRec + ' 6名未満' + st.hire + '）');
  log('出力: ' + OUT);
}

if (require.main === module) main().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
