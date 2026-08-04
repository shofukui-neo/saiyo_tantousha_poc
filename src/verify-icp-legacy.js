'use strict';
/**
 * v1で作った完全新規プール(757社)の ICP完全適合を「会社概要ページの構造値」で検証し直す
 * ============================================================================
 * v1 は従業員数を本文の自由文マッチで拾っていたため、規模帯(100-2000)の判定を誤る行が混ざる。
 *   実例: すかいらーくグループ = v1「533名」→ 会社概要の実値「正社員5,779名／クルー98,327名」＝規模帯外。
 * また業種列が空のままで、非IT条件が“判定されずに素通り”していた。
 * ここで全行の outline.html を引き直し、業種／従業員数／本社／上場 を実データで埋め、
 *   ③規模フィット(100-2000) ④非IT
 * を再判定する。落ちた行は削除ではなく別ファイル(-rejected)に退避して監査可能にする。
 *
 * 使い方: `npm run icp:verify`   （対象は ICP_VERIFY_FILE、既定 data/leads-icp-fresh-10000.csv）
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv } = require('./csv');
const { MynaviScraper } = require('./scrape-mynavi');
const { parseEmployees, scoreMochica } = require('./mochica-fit');
const { isExcludedIndustry } = require('./icp-rules');
const { EMP_MIN, EMP_MAX } = require('./build-icp-fresh-1000');

const ROOT = path.resolve(__dirname, '..');
const FILE = process.env.ICP_VERIFY_FILE || path.join(ROOT, 'data', 'leads-icp-fresh-10000.csv');
const OUT = process.env.ICP_VERIFY_OUT || path.join(ROOT, 'data', 'icp-legacy-verified.csv');
const REJ = OUT.replace(/\.csv$/, '') + '-rejected.csv';
const GRAD_YEAR = process.env.MYNAVI_GRAD_YEAR || '28';
const DELAY = parseInt(process.env.ICP_VERIFY_DELAY_MS || '500', 10);

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function safeWrite(abs, content) {
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, content);
  for (let i = 0; i < 5; i++) { try { fs.renameSync(tmp, abs); return; } catch (e) { if (e.code === 'EPERM' || e.code === 'EBUSY') { try { fs.writeFileSync(abs, content); fs.unlinkSync(tmp); return; } catch (_) {} } } }
  try { fs.writeFileSync(abs, content); fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch (_) {}
}

async function run() {
  const { records } = readCsv(fs.readFileSync(FILE, 'utf8'));
  const cols = [...new Set([...Object.keys(records[0] || {}), '本社', '上場', '検証'])];
  // 再開: 既に検証済みの corpID は引き直さない
  const doneMap = new Map();
  for (const f of [OUT, REJ]) {
    if (!fs.existsSync(f)) continue;
    try { for (const r of readCsv(fs.readFileSync(f, 'utf8')).records) if (r.corpID) doneMap.set(String(r.corpID), r); } catch (_) {}
  }
  const kept = [], rejected = [];
  const pending = [];
  for (const r of records) {
    const prev = doneMap.get(String(r.corpID || ''));
    if (prev) { (String(prev['検証'] || '').startsWith('NG') ? rejected : kept).push(prev); continue; }
    pending.push(r);
  }
  log(`検証対象 ${pending.length}社（済 ${kept.length + rejected.length}）／ 全${records.length}社`);
  if (!pending.length) { log('新たに検証する行なし'); return finish(kept, rejected, cols); }

  const sc = new MynaviScraper({ gradYear: GRAD_YEAR });
  await sc.launch();
  let n = 0;
  try {
    for (const r of pending) {
      n++;
      const id = String(r.corpID || '').trim();
      if (!id) { r['検証'] = 'NG:corpID無し'; rejected.push(r); continue; }
      const o = await sc.scrapeOutline(id).catch(() => ({ ok: false }));
      if (!o.ok) { r['検証'] = 'NG:会社概要を取得できず'; rejected.push(r); await sleep(DELAY); continue; }
      // 実データで上書き（v1の自由文マッチ値は信用しない）
      if (o.業種) r['業種'] = o.業種;
      if (o.従業員数) r['従業員数'] = o.従業員数;
      r['本社'] = o.本社 || r['本社'] || '';
      r['上場'] = o.上場 || '';
      const emp = parseEmployees(o.従業員数);
      if (emp == null) { r['検証'] = 'NG:従業員数を確認できず'; rejected.push(r); await sleep(DELAY); continue; }
      if (emp < EMP_MIN || emp > EMP_MAX) { r['検証'] = `NG:従業員${emp}名=規模帯外(${EMP_MIN}-${EMP_MAX})`; rejected.push(r); await sleep(DELAY); continue; }
      if (isExcludedIndustry(o.業種)) { r['検証'] = `NG:IT/ソフト=絶対除外(${o.業種})`; rejected.push(r); await sleep(DELAY); continue; }
      // 規模が変われば期待度も変わる＝再採点
      const s = scoreMochica(r);
      r['アポ期待度'] = String(s.total); r['優先度'] = s.priority; r['確信度'] = String(s.confidence);
      r['MOCHICA適合'] = s.total >= 80 ? '◎' : s.total >= 65 ? '○' : '△';
      r['完全適合根拠'] = String(r['完全適合根拠'] || '').replace(/従業員\d+名\([^)]*\)/, `従業員${emp}名(${EMP_MIN}-${EMP_MAX})`)
        .replace(/｜非IT/, `｜非IT(${o.業種})`);
      r['検証'] = 'OK:会社概要で実確認';
      kept.push(r);
      if (n % 25 === 0) { log(`  …${n}/${pending.length} 合格${kept.length} 不合格${rejected.length}`); finish(kept, rejected, cols); }
      await sleep(DELAY);
    }
  } finally { await sc.close().catch(() => {}); }
  finish(kept, rejected, cols);
  const why = {};
  for (const r of rejected) { const k = String(r['検証'] || '').split('(')[0]; why[k] = (why[k] || 0) + 1; }
  log(`完了: 合格 ${kept.length}社 / 不合格 ${rejected.length}社 ${JSON.stringify(why)}`);
}

function finish(kept, rejected, cols) {
  safeWrite(OUT, toCsv(cols, kept));
  safeWrite(REJ, toCsv(cols, rejected));
}

if (require.main === module) run().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
