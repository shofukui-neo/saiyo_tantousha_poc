'use strict';
/**
 * 完全新規リストの「名前なし」行に gBiz代表者名 を補完し、連絡先ティアを 名前なし → 代表者名 に昇格
 * ============================================================================
 * ユーザー指定の優先順位（採用担当者名 ＞ 代表者名 ＞ 名前なし）に沿い、採用担当者名が取れなかった
 * 完全新規 ICP完全適合社に、公的登記(gBizINFO)の代表者名を宛名として付与する。法人番号も併せて充填。
 * gBizは新卒インテントを持たないので“新規ソース”には使わない（ICP完全適合の裏取りはマイナビ掲載側）。
 *
 * 使い方: `npm run icp:fresh:rep`  （GBIZ_TOKEN 必須・逐次スロットル・冪等・再開可）
 *   ICP_FRESH_OUT で対象CSVを指定（既定 data/leads-icp-fresh-10000.csv）。
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, normCompanyName } = require('./csv');
const { gbizSearch, gbizGet, gbizAvailable } = require('./gbiz');
const { stripAnn, mkey } = require('./build-icp-fresh-1000');
const { stripGbizTitle } = require('./harvest-named-plus');
const { cleanCrossRefName } = require('./enrich-crossref');
const { scoreMochica } = require('./mochica-fit');

const ROOT = path.resolve(__dirname, '..');
const FILE = process.env.ICP_FRESH_OUT || path.join(ROOT, 'data', 'leads-icp-fresh-10000.csv');
const LIMIT = parseInt(process.env.ICP_FRESH_REP_LIMIT || '0', 10); // 0=全件

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const has = (v) => v && String(v).trim() && String(v).trim() !== '-';

function safeWrite(abs, content) {
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, content);
  for (let i = 0; i < 5; i++) { try { fs.renameSync(tmp, abs); return; } catch (e) { if (e.code === 'EPERM' || e.code === 'EBUSY') { try { fs.writeFileSync(abs, content); fs.unlinkSync(tmp); return; } catch (_) {} } } }
  try { fs.writeFileSync(abs, content); fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch (_) {}
}

async function repByName(company) {
  const q = stripAnn(company) || company; // 【…】（…グループ）等の注記を外して検索
  const cands = await gbizSearch({ name: q, limit: 30 });
  if (!cands || !cands.length) return null;
  const key = mkey(company);
  // 完全一致(注記除去正規化)を優先。無ければ先頭候補は使わない（誤マッチ防止）。
  const hit = cands.find((c) => mkey(c.name) === key);
  if (!hit || !hit.corporateNumber) return null;
  // 代表者名は検索listには無く詳細エンドポイントのみ→法人番号で1社取得（2段）。
  const detail = await gbizGet(hit.corporateNumber);
  const rep = cleanCrossRefName(stripGbizTitle((detail && detail.representativeName) || ''));
  if (!rep || String(rep).replace(/\s/g, '').length < 2) return null;
  return { rep, corporateNumber: hit.corporateNumber };
}

async function run() {
  const abs = path.isAbsolute(FILE) ? FILE : path.join(ROOT, FILE);
  if (!gbizAvailable()) { log('GBIZ_TOKEN 未設定のため実行不可'); process.exitCode = 1; return; }
  if (!fs.existsSync(abs)) { log(`対象CSVが無い: ${abs}`); process.exitCode = 1; return; }
  const { records, headers } = readCsv(fs.readFileSync(abs, 'utf8'));
  const cols = headers && headers.length ? headers : Object.keys(records[0] || {});

  const targets = records.filter((r) => r['連絡先区分'] === '名前なし' && !has(r['代表者名']));
  log(`対象(名前なし×代表者名空): ${targets.length}社 ／ 全${records.length}社`);
  let done = 0, filled = 0, i = 0;
  for (const r of targets) {
    if (LIMIT && i >= LIMIT) break;
    i++;
    let info = null;
    try { info = await repByName(r['企業名']); } catch (_) {}
    if (info) {
      r['代表者名'] = info.rep;
      if (!has(r['法人番号']) && info.corporateNumber) r['法人番号'] = info.corporateNumber;
      r['連絡先区分'] = '代表者名';
      r['架電宛名'] = (has(r['部署']) ? r['部署'] + ' ' : '') + info.rep + ' 様';
      const s = scoreMochica(r);
      if (r['アポ期待度'] !== undefined) r['アポ期待度'] = String(s.total);
      if (r['優先度'] !== undefined) r['優先度'] = s.priority;
      if (r['確信度'] !== undefined) r['確信度'] = String(s.confidence);
      if (r['完全適合根拠'] !== undefined) r['完全適合根拠'] = String(r['完全適合根拠']).replace('名前なし', `代表者名(${info.rep})`);
      filled++;
    }
    if (++done % 25 === 0) { log(`…${done}/${targets.length} 充填 ${filled}`); safeWriteRanked(abs, cols, records); }
  }
  safeWriteRanked(abs, cols, records);
  const t1 = records.filter((r) => r['連絡先区分'] === '採用担当者名').length;
  const t2 = records.filter((r) => r['連絡先区分'] === '代表者名').length;
  const t3 = records.filter((r) => r['連絡先区分'] === '名前なし').length;
  log(`完了: 代表者名 充填 ${filled}社 ｜ ティア 採用担当者名${t1}/代表者名${t2}/名前なし${t3}`);
}

// 連絡先ティア順(採用担当者名→代表者名→名前なし)×アポ期待度降順で並べ直して書き出す
function safeWriteRanked(abs, cols, records) {
  const tv = (r) => (r['連絡先区分'] === '採用担当者名' ? 1 : r['連絡先区分'] === '代表者名' ? 2 : 3);
  records.sort((a, b) => (tv(a) - tv(b)) || ((parseInt(b['アポ期待度']) || 0) - (parseInt(a['アポ期待度']) || 0)));
  safeWrite(abs, toCsv(cols, records));
}

if (require.main === module) run().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
module.exports = { repByName };
