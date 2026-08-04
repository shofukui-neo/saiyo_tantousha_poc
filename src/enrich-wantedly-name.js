'use strict';
/**
 * ICP完全適合プールの「名前なし／代表者名どまり」行に Wantedly から採用担当者の実名を補完する
 * ============================================================================
 * ユーザー指定の優先順位（採用担当者名 ＞ 代表者名 ＞ 名前なし）を1段引き上げるための層。
 * ICP適合そのものはマイナビ側で裏取り済みなので、ここは「宛名の質」だけを上げる（母集団は変えない）。
 *
 * 経路: Wantedly募集の全文検索（projects?q=社名）→ 各募集ページの掲載企業が対象社と一致するものだけ採用
 *       → 投稿者(FocusedMemberName＝採用窓口)の実名を取る。会社一致ガードは scrape-names.js 側に実装済み。
 * 注意: 中堅大手は Wantedly に居ないことが多く歩留まりは高くない（name-acquisition-layer の実測）。
 *       ゼロ件でもICP適合は損なわれない＝あくまで加点レイヤ。
 *
 * 使い方:
 *   node src/enrich-wantedly-name.js --file data/icp-fresh-pool.csv [--limit 50] [--tier3-only]
 *   SCRAPE_DELAY_MS で礼儀間隔（既定2500ms）。ジャーナルで中断再開可。
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, normCompanyName } = require('./csv');
const { findRecruiterName } = require('./scrape-names');
const { setScrapeDelay } = require('./polite');
const { cleanCrossRefName } = require('./enrich-crossref');
const { scoreMochica } = require('./mochica-fit');

const ROOT = path.resolve(__dirname, '..');
const getArg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const FILE = path.resolve(ROOT, getArg('file', 'data/icp-fresh-pool.csv'));
const LIMIT = parseInt(getArg('limit', '0'), 10);
const TIER3_ONLY = process.argv.includes('--tier3-only');
const JOURNAL = FILE.replace(/\.csv$/, '') + '.wantedly.json';

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const has = (v) => v && String(v).trim() && String(v).trim() !== '-';
// マイナビ側と同じ「氏名でない語」ゲート（部署名・業務語が氏名欄に入るのを防ぐ）
const BAD = new Set(['人材', '人事', '採用', '総務', '担当', '広報', '事務局', '運営', '編集部', '採用担当', '人事部']);

function safeWrite(abs, content) {
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, content);
  for (let i = 0; i < 5; i++) { try { fs.renameSync(tmp, abs); return; } catch (e) { if (e.code === 'EPERM' || e.code === 'EBUSY') { try { fs.writeFileSync(abs, content); fs.unlinkSync(tmp); return; } catch (_) {} } } }
  try { fs.writeFileSync(abs, content); fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch (_) {}
}

async function run() {
  setScrapeDelay(parseInt(process.env.SCRAPE_DELAY_MS || '2500', 10));
  const { records, headers } = readCsv(fs.readFileSync(FILE, 'utf8'));
  const cols = [...new Set([...(headers && headers.length ? headers : Object.keys(records[0] || {})), '名前取得元', '名前根拠URL'])];

  const done = new Set();
  if (fs.existsSync(JOURNAL)) { try { JSON.parse(fs.readFileSync(JOURNAL, 'utf8')).forEach((k) => done.add(k)); } catch (_) {} }

  const targets = records.filter((r) => !has(r['採用担当者名']) && (!TIER3_ONLY || r['連絡先区分'] === '名前なし') && !done.has(normCompanyName(r['企業名'])));
  log(`対象 ${targets.length}社（担当者名なし ／ 済 ${done.size}）／ 全${records.length}社`);

  let n = 0, hit = 0;
  const stat = {};
  for (const r of targets) {
    if (LIMIT && n >= LIMIT) break;
    n++;
    const company = r['企業名'];
    let res = null;
    try { res = await findRecruiterName(company); } catch (e) { res = null; }
    done.add(normCompanyName(company));
    const why = res && res.詳細 && res.詳細.Wantedly ? res.詳細.Wantedly : 'error';
    stat[why] = (stat[why] || 0) + 1;
    const nm = res && res.採用担当者名 ? cleanCrossRefName(res.採用担当者名) : '';
    if (nm && String(nm).replace(/\s/g, '').length >= 2 && !BAD.has(String(nm).replace(/\s/g, ''))) {
      r['採用担当者名'] = nm;
      r['役職'] = r['役職'] || res.役職 || '';
      r['部署'] = r['部署'] || res.部署 || '';
      r['連絡先区分'] = '採用担当者名';
      r['架電宛名'] = (has(r['部署']) ? r['部署'] + ' ' : '') + nm + ' 様';
      r['名前取得元'] = 'Wantedly';
      r['名前根拠URL'] = res.根拠URL || '';
      const s = scoreMochica(r);
      r['アポ期待度'] = String(s.total); r['優先度'] = s.priority; r['確信度'] = String(s.confidence);
      r['MOCHICA適合'] = s.total >= 80 ? '◎' : s.total >= 65 ? '○' : '△';
      if (r['完全適合根拠'] !== undefined) r['完全適合根拠'] = String(r['完全適合根拠']).replace(/名前なし|代表者名\([^)]*\)/, `採用担当者名(${nm}・Wantedly)`);
      hit++;
      log(`  ✅ ${company} → ${nm}（${res.根拠URL}）`);
    }
    if (n % 10 === 0) {
      safeWrite(FILE, toCsv(cols, records));
      fs.writeFileSync(JOURNAL, JSON.stringify([...done]));
      log(`  …${n}/${targets.length} 取得 ${hit}（歩留 ${(hit / n * 100).toFixed(1)}%） ${JSON.stringify(stat)}`);
    }
  }
  safeWrite(FILE, toCsv(cols, records));
  fs.writeFileSync(JOURNAL, JSON.stringify([...done]));
  log(`完了: ${n}社を照会し ${hit}社で採用担当者名を取得（歩留 ${n ? (hit / n * 100).toFixed(1) : 0}%） 内訳 ${JSON.stringify(stat)}`);
}

if (require.main === module) run().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
