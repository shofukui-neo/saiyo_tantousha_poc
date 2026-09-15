'use strict';
/**
 * 公式LINE利用有無の一括付与（リスト運用層）
 * ============================================================================
 * 任意のリードCSVに「公式LINE / LINE用途 / LINEトーク指針」列を足す。
 * 架電前に相手の公式LINE有無が判っていれば、最大級のお断り「公式LINE使ってるから足りてる」に
 * 事前に構えられる（docs/分析-接続後断り理由とアポ獲得トーク.md）。
 *
 * 台帳（data/line-official.json）に社単位で結果を貯めるので、
 *   ・別のCSVに同じ社が居れば取得ゼロで再利用できる
 *   ・中断しても続きから走る（--refresh で強制再取得）
 *
 *   node src/enrich-line-official.js --in data/leads-icp-hire6-500.csv [--out 別ファイル]
 *                                    [--conc 4] [--limit 0] [--verify] [--refresh] [--render] [--max-pages 6]
 *
 *   --verify   … page.line.me で @ID の実在まで確認する（1社あたり数秒増。確度95まで上がる）
 *   --render   … 静的HTMLが薄い（JS描画）サイトをブラウザで描画して見る。精度は上がるが重い
 *   --refresh  … 台帳とキャッシュを無視して取り直す
 *   --limit N  … 先頭N社だけ処理（試走用）
 *
 * 大量処理のコツ: 死んでいるドメインの取得待ちが支配的なので
 *   SCRAPE_MAX_RETRY=1 PER_PAGE_TIMEOUT_MS=8000 SCRAPE_DELAY_MS=1500 を付けると体感が段違いに速い。
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, mergeKey, normCompanyName } = require('./csv');
const { probeLineOfficial } = require('./probe-line');
const { lineTalkGuide } = require('./line-official');
const { closeBrowser } = require('./fetch');

const ROOT = path.resolve(__dirname, '..');
function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
const IN = path.resolve(ROOT, getArg('in', 'data/leads-icp-hire6-500.csv'));
const OUT = path.resolve(ROOT, getArg('out', getArg('in', 'data/leads-icp-hire6-500.csv')));
const LEDGER = path.resolve(ROOT, getArg('ledger', 'data/line-official.json'));
const CONC = Math.max(1, parseInt(getArg('conc', '4'), 10) || 4);
const LIMIT = parseInt(getArg('limit', '0'), 10) || 0;
const MAX_PAGES = parseInt(getArg('max-pages', '6'), 10) || 6;
const VERIFY = process.argv.includes('--verify');
const REFRESH = process.argv.includes('--refresh');
// 既定は静的取得のみ（大量処理でのメモリ枯渇を避ける既存方針）。--render でJSレンダリングに昇格可。
const RENDER = process.argv.includes('--render') ? 'auto' : 'static';

// 入力CSVの列名ゆれ（自作リスト / BALES取込形式 / GAS時代のヘッダ）を吸収する。
const NAME_KEYS = ['企業名', '会社名', '会社情報：会社名', 'company_name'];
const URL_KEYS = ['公式URL', '会社情報：Webサイト', 'homepage_url', 'URL', '公式サイト', 'ホームページ', 'resolved_url'];
const RECRUIT_KEYS = ['採用ページURL', 'recruit_url'];
const pick = (rec, keys) => { for (const k of keys) { const v = (rec[k] || '').trim(); if (v) return v; } return ''; };

// 付与する列（既存CSVの末尾に追加。既にあれば上書き）
const OUT_COLS = ['公式LINE', 'LINE確度', 'LINE ID', 'LINE URL', 'LINE用途', 'LINEトーク指針', 'LINE根拠', 'LINE検査日'];

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
function safeWrite(abs, content) {
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, content);
  try { fs.renameSync(tmp, abs); } catch (_) { fs.writeFileSync(abs, content); try { fs.unlinkSync(tmp); } catch (__) {} }
}
function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch (_) { return {}; }
}
// 台帳キー: 法人番号/社名（mergeKey）→ 取れなければ公式URLのホスト。
function ledgerKey(rec, url) {
  const mk = mergeKey({ 法人番号: rec['法人番号'] || '', 企業名: pick(rec, NAME_KEYS) });
  if (mk) return mk;
  const n = normCompanyName(pick(rec, NAME_KEYS));
  if (n) return 'N:' + n;
  try { return 'U:' + new URL(url).host.replace(/^www\./, ''); } catch (_) { return ''; }
}

function applyToRecord(rec, r) {
  rec['公式LINE'] = r.判定 || '不明';
  rec['LINE確度'] = String(r.確度 != null ? r.確度 : '');
  rec['LINE ID'] = r.ID || '';
  rec['LINE URL'] = r.URL || '';
  rec['LINE用途'] = r.用途 || '';
  rec['LINEトーク指針'] = r.トーク指針 || lineTalkGuide(r.判定, r.用途);
  rec['LINE根拠'] = r.根拠 || '';
  rec['LINE検査日'] = r.検査日 || new Date().toISOString().slice(0, 10);
}

async function run() {
  if (!fs.existsSync(IN)) { console.error(`入力CSVが見つかりません: ${IN}`); process.exitCode = 1; return; }
  const { records, headers } = readCsv(fs.readFileSync(IN, 'utf8'));
  const cols = (headers && headers.length ? headers.slice() : Object.keys(records[0] || {}));
  for (const c of OUT_COLS) if (!cols.includes(c)) cols.push(c);
  const ledger = loadLedger();
  log(`入力 ${records.length}社 <${path.relative(ROOT, IN)}>｜台帳 ${Object.keys(ledger).length}社｜conc=${CONC}${VERIFY ? '｜実在検証ON' : ''}`);

  // ① 台帳ヒットは取得せずに反映（別リストで調べ済みの社を再取得しない）
  const todo = [];
  let reused = 0; let noUrl = 0;
  for (const rec of records) {
    const url = pick(rec, URL_KEYS);
    const key = ledgerKey(rec, url);
    if (!REFRESH && key && ledger[key]) { applyToRecord(rec, ledger[key]); reused++; continue; }
    if (!REFRESH && (rec['公式LINE'] || '').trim() && (rec['公式LINE'] || '').trim() !== '不明') { reused++; continue; }
    if (!/^https?:\/\//i.test(url)) {
      applyToRecord(rec, { 判定: '不明', 確度: 0, 根拠: '公式URLなし（先にURL補完が必要）', 用途: '' });
      noUrl++; continue;
    }
    todo.push({ rec, url, key, name: pick(rec, NAME_KEYS), recruitUrl: pick(rec, RECRUIT_KEYS) });
  }
  const targets = LIMIT > 0 ? todo.slice(0, LIMIT) : todo;
  log(`台帳再利用 ${reused}社／URL無し ${noUrl}社／今回取得 ${targets.length}社`);

  const flush = () => {
    safeWrite(OUT, toCsv(cols, records));
    safeWrite(LEDGER, JSON.stringify(ledger, null, 1));
  };

  let idx = 0; let done = 0;
  const tally = { 有: 0, 無: 0, 要確認: 0, 不明: 0 };
  async function worker() {
    for (;;) {
      const my = idx++;
      if (my >= targets.length) return;
      const t = targets[my];
      let r;
      try {
        r = await probeLineOfficial(t.name, t.url, {
          maxPages: MAX_PAGES, verify: VERIFY, recruitUrl: t.recruitUrl, render: RENDER, noCache: REFRESH,
        });
      } catch (e) {
        r = { 判定: '不明', 確度: 0, 根拠: '取得エラー: ' + String((e && e.message) || e), 用途: '' };
      }
      const entry = {
        判定: r.判定, 確度: r.確度, ID: r.ID, URL: r.URL, 用途: r.用途, 根拠: r.根拠,
        トーク指針: r.トーク指針 || lineTalkGuide(r.判定, r.用途),
        検査ページ数: r.検査ページ数, 実在検証: r.実在検証 || '', 公式URL: t.url,
        検査日: new Date().toISOString().slice(0, 10),
      };
      if (t.key) ledger[t.key] = entry;
      applyToRecord(t.rec, entry);
      tally[r.判定] = (tally[r.判定] || 0) + 1;
      if (++done % 20 === 0) { flush(); log(`  ${done}/${targets.length}｜有${tally.有} 無${tally.無} 要確認${tally.要確認} 不明${tally.不明}`); }
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));
  await closeBrowser().catch(() => {});
  flush();

  // ② 全体サマリ（営業がどのトークで何社さばくかの分母）
  const all = { 有: 0, 無: 0, 要確認: 0, 不明: 0 };
  const use = {};
  for (const rec of records) {
    const j = (rec['公式LINE'] || '不明').trim();
    all[j] = (all[j] || 0) + 1;
    if (j === '有') { const u = rec['LINE用途'] || '不明'; use[u] = (use[u] || 0) + 1; }
  }
  log(`完了: ${path.relative(ROOT, OUT)}`);
  log(`  公式LINE  有 ${all.有 || 0}／無 ${all.無 || 0}／要確認 ${all.要確認 || 0}／不明 ${all.不明 || 0}（全${records.length}社）`);
  log(`  用途内訳（有の社）: ${Object.entries(use).map(([k, v]) => `${k} ${v}`).join(' / ') || '-'}`);
  log(`  台帳: ${path.relative(ROOT, LEDGER)}（${Object.keys(ledger).length}社。別リストでも再利用されます）`);
}

if (require.main === module) run().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
module.exports = { run, applyToRecord, ledgerKey, OUT_COLS };
