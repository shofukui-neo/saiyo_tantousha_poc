'use strict';
/**
 * ATS未導入判定の一括付与（リスト運用層）
 * ============================================================================
 * 任意のリードCSVに「ATS判定 / entry_type / entry_host / ATSベンダー / 重症度 …」列を足す。
 * MOCHICA受注ドライバの実測トップが「他社ATS未導入」なので、この列があるだけで
 * 30,290社の統合マスタが「かけるべき順」に並び替えられる。
 *
 * 台帳（data/ats-status.json）に社単位で結果を貯めるので、
 *   ・別のCSVに同じ社が居れば取得ゼロで再利用できる
 *   ・中断しても続きから走る（--refresh で強制再取得）
 *   ・貯まった台帳を learn-ats-fingerprints.js --from-ledger に食わせると辞書が育つ
 *     （多テナント性は母数が増えるほど効く＝運用するほど「要確認」が減る自己強化ループ）
 *
 *   node src/enrich-ats.js --in data/leads-consolidated-all.csv [--out 別ファイル]
 *                          [--conc 6] [--limit 0] [--max-pages 5] [--refresh] [--render]
 *                          [--only-callable]   電話番号のある社だけ（架電対象に絞って回す）
 *
 * 大量処理のコツ: 死んでいるドメインの取得待ちが支配的なので
 *   SCRAPE_MAX_RETRY=1 PER_PAGE_TIMEOUT_MS=8000 SCRAPE_DELAY_MS=1500 を付けると体感が段違いに速い。
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, mergeKey, normCompanyName } = require('./csv');
const { probeAts, loadDict } = require('./probe-ats');
const { atsTalkGuide } = require('./ats-detect');
const { closeBrowser } = require('./fetch');

const ROOT = path.resolve(__dirname, '..');
function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
const IN = path.resolve(ROOT, getArg('in', 'data/leads-consolidated-all.csv'));
const OUT = path.resolve(ROOT, getArg('out', getArg('in', 'data/leads-consolidated-all.csv')));
const LEDGER = path.resolve(ROOT, getArg('ledger', 'data/ats-status.json'));
const CONC = Math.max(1, parseInt(getArg('conc', '6'), 10) || 6);
const LIMIT = parseInt(getArg('limit', '0'), 10) || 0;
const MAX_PAGES = parseInt(getArg('max-pages', '5'), 10) || 5;
const REFRESH = process.argv.includes('--refresh');
const ONLY_CALLABLE = process.argv.includes('--only-callable');
const RENDER = process.argv.includes('--render') ? 'auto' : undefined;

// 入力CSVの列名ゆれ（自作リスト / BALES取込形式 / GAS時代のヘッダ）を吸収する。
const NAME_KEYS = ['企業名', '﻿企業名', '会社名', '会社情報：会社名', 'company_name'];
const URL_KEYS = ['公式URL', '会社情報：Webサイト', 'homepage_url', 'URL', '公式サイト', 'ホームページ', 'resolved_url'];
const RECRUIT_KEYS = ['採用ページURL', 'recruit_url'];
const TEL_KEYS = ['電話番号', '会社情報：電話番号', 'phone', 'TEL'];
const pick = (rec, keys) => { for (const k of keys) { const v = (rec[k] || '').trim(); if (v) return v; } return ''; };

// 付与する列（既存CSVの末尾に追加。既にあれば上書き）
const OUT_COLS = ['ATS判定', 'ATS確度', 'entry_type', 'entry_host', 'ATSベンダー', 'ATS重症度', 'エントリー動線', 'ATSトーク指針', 'ATS根拠', 'ATS検査日'];

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
// undici の Parser.finish assert(!this.paused) がソケット終端で投げる未捕捉例外を1社の失敗に留める（実測: 2026-09-03、特定ホストで再現）。
// 例外を飲むと当該 fetch は永久に解決しないため、worker 側で PROBE_TIMEOUT_MS の打ち切りも併用する。
process.on('uncaughtException', (e) => { log('uncaughtException(継続): ' + String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 140)); });
const PROBE_TIMEOUT_MS = parseInt(process.env.PROBE_TIMEOUT_MS || '90000', 10);
function safeWrite(abs, content) {
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, content);
  try { fs.renameSync(tmp, abs); } catch (_) { fs.writeFileSync(abs, content); try { fs.unlinkSync(tmp); } catch (__) {} }
}
function loadLedger() { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch (_) { return {}; } }

// 台帳キー: 法人番号/社名（mergeKey）→ 取れなければ公式URLのホスト。
function ledgerKey(rec, url) {
  const mk = mergeKey({ 法人番号: rec['法人番号'] || '', 企業名: pick(rec, NAME_KEYS) });
  if (mk) return mk;
  const n = normCompanyName(pick(rec, NAME_KEYS));
  if (n) return 'N:' + n;
  try { return 'U:' + new URL(url).host.replace(/^www\./, ''); } catch (_) { return ''; }
}

function applyToRecord(rec, r) {
  rec['ATS判定'] = r.ATS判定 || '不明';
  rec['ATS確度'] = String(r.確度 != null ? r.確度 : '');
  rec['entry_type'] = r.entry_type || 'none';
  rec['entry_host'] = r.entry_host || '';
  rec['ATSベンダー'] = r.ベンダー || '';
  rec['ATS重症度'] = String(r.重症度 != null ? r.重症度 : '');
  rec['エントリー動線'] = r.動線内訳 || '';
  rec['ATSトーク指針'] = r.トーク指針 || atsTalkGuide(r.ATS判定, r.entry_type, r.ベンダー);
  rec['ATS根拠'] = r.根拠 || '';
  rec['ATS検査日'] = r.検査日 || new Date().toISOString().slice(0, 10);
}

async function run() {
  if (!fs.existsSync(IN)) { console.error(`入力CSVが見つかりません: ${IN}`); process.exitCode = 1; return; }
  const { records, headers } = readCsv(fs.readFileSync(IN, 'utf8'));
  const cols = (headers && headers.length ? headers.slice() : Object.keys(records[0] || {}));
  for (const c of OUT_COLS) if (!cols.includes(c)) cols.push(c);
  const ledger = loadLedger();
  const dict = loadDict(true);
  const dictSize = Object.keys((dict && dict.hosts) || {}).length;
  log(`入力 ${records.length}社 <${path.relative(ROOT, IN)}>｜台帳 ${Object.keys(ledger).length}社｜指紋辞書 ${dictSize}ホスト｜conc=${CONC}`);
  if (!dictSize) log('※ 指紋辞書が空です。外部ホストは全て「要確認」になります。先に npm run ats:learn を回してください。');

  // ① 台帳ヒットは取得せずに反映（別リストで調べ済みの社を再取得しない）
  const todo = [];
  let reused = 0; let noUrl = 0; let skipped = 0;
  for (const rec of records) {
    const url = pick(rec, URL_KEYS);
    const key = ledgerKey(rec, url);
    if (!REFRESH && key && ledger[key]) { applyToRecord(rec, ledger[key]); reused++; continue; }
    if (ONLY_CALLABLE && !pick(rec, TEL_KEYS)) { skipped++; continue; }
    if (!/^https?:\/\//i.test(url)) {
      applyToRecord(rec, { ATS判定: '不明', 確度: 0, entry_type: 'none', 根拠: '公式URLなし（先にURL補完が必要）' });
      noUrl++; continue;
    }
    todo.push({ rec, url, key, name: pick(rec, NAME_KEYS), recruitUrl: pick(rec, RECRUIT_KEYS) });
  }
  const targets = LIMIT > 0 ? todo.slice(0, LIMIT) : todo;
  log(`台帳再利用 ${reused}社／URL無し ${noUrl}社／対象外 ${skipped}社／今回取得 ${targets.length}社`);

  const flush = () => {
    safeWrite(OUT, toCsv(cols, records));
    safeWrite(LEDGER, JSON.stringify(ledger));
  };

  let idx = 0; let done = 0;
  const tally = { 未導入: 0, 導入済: 0, 要確認: 0, 不明: 0 };
  async function worker() {
    for (;;) {
      const my = idx++;
      if (my >= targets.length) return;
      const t = targets[my];
      let r;
      try {
        let timer;
        r = await Promise.race([
          probeAts(t.name, t.url, { maxPages: MAX_PAGES, recruitUrl: t.recruitUrl, dict, noCache: REFRESH, render: RENDER }),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('probe timeout ' + PROBE_TIMEOUT_MS + 'ms')), PROBE_TIMEOUT_MS); }),
        ]).finally(() => clearTimeout(timer));
      } catch (e) {
        r = { ATS判定: '不明', 確度: 0, entry_type: 'none', 根拠: '取得エラー: ' + String((e && e.message) || e) };
      }
      const entry = {
        ATS判定: r.ATS判定, 確度: r.確度, entry_type: r.entry_type, entry_host: r.entry_host,
        ベンダー: r.ベンダー, 重症度: r.重症度, 動線内訳: r.動線内訳, 根拠: r.根拠,
        トーク指針: r.トーク指針 || atsTalkGuide(r.ATS判定, r.entry_type, r.ベンダー),
        検査ページ数: r.検査ページ数, 公式URL: t.url, name: t.name, site: t.url,
        pagesOk: r.検査ページ数, pagesFailed: r.失敗ページ数, recruitFound: r.採用ページ到達 === '○',
        // 辞書の再学習（--from-ledger）に要る素材。判定は保存された signals から再現できる。
        signals: (r.signals || []).map((s) => ({
          source: s.source, entry_type: s.entry_type, host: s.host, level: s.level, side: s.side,
          entry_ctx: s.entry_ctx, footer: s.footer, shinsotsu: s.shinsotsu, pageRole: s.pageRole,
          evidence: String(s.evidence || '').slice(0, 160),
        })),
        learn: r.学習材料 || { hosts: [], scripts: [], metas: [] },
        検査日: new Date().toISOString().slice(0, 10),
      };
      if (t.key) ledger[t.key] = entry;
      applyToRecord(t.rec, entry);
      tally[r.ATS判定] = (tally[r.ATS判定] || 0) + 1;
      if (++done % 25 === 0) { flush(); log(`  ${done}/${targets.length}｜未導入${tally.未導入} 導入済${tally.導入済} 要確認${tally.要確認} 不明${tally.不明}`); }
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));
  await closeBrowser().catch(() => {});
  flush();

  // ② 全体サマリ（営業がどの層を何社さばくかの分母）
  const all = {}; const types = {}; const sev = {};
  for (const rec of records) {
    const j = (rec['ATS判定'] || '未調査').trim();
    all[j] = (all[j] || 0) + 1;
    if (j === '未導入') {
      const t = rec['entry_type'] || 'none';
      types[t] = (types[t] || 0) + 1;
      const s = rec['ATS重症度'] || '';
      if (s) sev[s] = (sev[s] || 0) + 1;
    }
  }
  log(`完了: ${path.relative(ROOT, OUT)}`);
  log(`  ATS  未導入 ${all.未導入 || 0}／導入済 ${all.導入済 || 0}／要確認 ${all.要確認 || 0}／不明 ${all.不明 || 0}／未調査 ${all.未調査 || 0}（全${records.length}社）`);
  log(`  未導入の内訳(entry_type): ${Object.entries(types).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' / ') || '-'}`);
  log(`  重症度分布: ${Object.entries(sev).sort((a, b) => b[0] < a[0] ? -1 : 1).map(([k, v]) => `${k}:${v}社`).join(' / ') || '-'}`);
  log(`  台帳: ${path.relative(ROOT, LEDGER)}（${Object.keys(ledger).length}社。別リストでも再利用／ats:learn --from-ledger で辞書が育ちます）`);
}

if (require.main === module) run().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
module.exports = { run, applyToRecord, ledgerKey, OUT_COLS };
