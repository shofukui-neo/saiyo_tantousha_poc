'use strict';
/**
 * マイナビ2028 掲載企業「全社」の列挙（corpID × 社名）
 * ============================================================================
 * フリーワード検索は汎用語で母集団のほぼ全量を返す（実測: "会社"=29,869社 / "株式会社"=28,674社）。
 * ページ送り（次の100社）で全面を辿り、corpID と表示社名を丸ごと取り切る。
 * これがあれば「完全新規かどうか」は社名の照合だけで判定でき、既存社に1回もスクレイプを払わずに済む
 * ＝ キーワード単位の discovery より圧倒的に効率が良く、母集団の“底”も確定できる。
 *
 * 出力: data/mynavi-2028-corpus.csv（corpID, 企業名, 発見語）— 1面ごとに追記保存（中断しても残る）
 * 使い方: `npm run mynavi:corpus`   MYNAVI_CORPUS_WORDS / MYNAVI_CORPUS_MAXPAGES で調整
 */
const fs = require('fs');
const path = require('path');
const { toCsv, readCsv } = require('./csv');
const { MynaviScraper, CONFIG } = require('./scrape-mynavi');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.MYNAVI_CORPUS_OUT || path.join(ROOT, 'data', 'mynavi-2028-corpus.csv');
const GRAD_YEAR = process.env.MYNAVI_GRAD_YEAR || '28';
const MAXPAGES = parseInt(process.env.MYNAVI_CORPUS_MAXPAGES || '320', 10);
const WORDS = (process.env.MYNAVI_CORPUS_WORDS || '会社,株式会社,当社,新卒,募集').split(',').map((s) => s.trim()).filter(Boolean);

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COLS = ['corpID', '企業名', '発見語'];

function safeWrite(abs, content) {
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, content);
  for (let i = 0; i < 5; i++) { try { fs.renameSync(tmp, abs); return; } catch (e) { if (e.code === 'EPERM' || e.code === 'EBUSY') { try { fs.writeFileSync(abs, content); fs.unlinkSync(tmp); return; } catch (_) {} } } }
  try { fs.writeFileSync(abs, content); fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch (_) {}
}

async function run() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const rows = [];
  const known = new Set();
  if (fs.existsSync(OUT)) {
    try { for (const r of readCsv(fs.readFileSync(OUT, 'utf8')).records) { if (r.corpID && !known.has(r.corpID)) { known.add(r.corpID); rows.push(r); } } } catch (_) {}
    log(`再開: 既知 ${rows.length}社`);
  }

  const sc = new MynaviScraper({ gradYear: GRAD_YEAR });
  await sc.launch();
  try {
    for (const word of WORDS) {
      const page = await sc.context.newPage();
      let total = 0, pageNo = 0, added = 0;
      try {
        await page.goto(CONFIG.searchUrl(GRAD_YEAR, word), { waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
        total = await page.evaluate(() => { const e = document.querySelector('input[name="idListMax"]'); return e ? parseInt(e.value, 10) || 0 : 0; }).catch(() => 0);
        log(`🔤 "${word}": 掲載 ${total}社 → 全面を辿る（最大${MAXPAGES}面）`);
        while (pageNo < MAXPAGES) {
          const items = await page.evaluate(() => {
            const res = []; const s = {};
            for (const a of Array.from(document.querySelectorAll('a[href]'))) {
              const m = (a.getAttribute('href') || '').match(/corp(\d+)\/outline/);
              if (!m || s[m[1]]) continue; s[m[1]] = 1;
              res.push({ id: m[1], name: (a.innerText || '').replace(/\s+/g, ' ').trim() });
            }
            return res;
          }).catch(() => []);
          pageNo++;
          let fresh = 0;
          for (const it of items) {
            if (!it.id || known.has(it.id)) continue;
            known.add(it.id); rows.push({ corpID: it.id, 企業名: it.name, 発見語: word }); fresh++; added++;
          }
          if (pageNo % 10 === 0 || fresh === 0) { safeWrite(OUT, toCsv(COLS, rows)); log(`  …"${word}" ${pageNo}面 / 累計 ${rows.length}社（この語で+${added}）`); }
          if (!items.length) break;
          const next = page.locator('a:has-text("次の100社")').first();
          if (!(await next.count().catch(() => 0))) break;
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {}),
            next.click({ timeout: 12000 }).catch(() => {}),
          ]);
          await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
          await sleep(500);
        }
      } catch (e) { log(`  "${word}" 中断: ${String(e).slice(0, 80)}`); } finally { await page.close().catch(() => {}); }
      safeWrite(OUT, toCsv(COLS, rows));
      log(`✔ "${word}" 完了: ${pageNo}面 ／ 新規+${added} ／ 累計 ${rows.length}社`);
    }
  } finally { safeWrite(OUT, toCsv(COLS, rows)); await sc.close().catch(() => {}); }
  log(`完了: マイナビ${GRAD_YEAR}卒 掲載企業 ${rows.length}社 → ${OUT}`);
}

if (require.main === module) run().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
