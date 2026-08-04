'use strict';
/**
 * 「別の卒年ページ」から採用担当者名を取り直す（採用担当者名の最有力レバー）
 * ============================================================================
 * 同じ企業でも 27卒ページと28卒ページでは 伝言板／採用担当者メッセージ／問合せ先 の中身が違い、
 * 片方だけに担当者の実名が出ていることがある（実測: 名前なし12社を逆の卒年で引き直して2社=17%で氏名取得）。
 * gBiz代表者名(0%)・自社サイト深掘り(数%)・Wantedly(到達不可)より圧倒的に歩留まりが良い。
 *
 * 高速化: corpID は卒年をまたいで安定している（実測: corp99334 は27卒/28卒とも クックマート(株)）。
 *   → 社名検索を挟まず `/{他卒年}/pc/search/corp{同じID}/…` を直接叩ける（1社35秒→10秒）。
 *   ただし取り違え防止に、必ず outline の h1 と社名を突合してから氏名を採用する。
 *
 * ICP判定には一切触らない（規模/業種/電話は元の卒年ページの実データのまま）。氏名だけを持ち帰る。
 *
 * 使い方: node src/enrich-mynavi-crossyear.js --file data/leads-icp-fresh-perfect-1000.csv [--conc 3]
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv } = require('./csv');
const { MynaviScraper } = require('./scrape-mynavi');
const { scoreMochica } = require('./mochica-fit');
const { cleanCrossRefName } = require('./enrich-crossref');
const { mkey } = require('./build-icp-fresh-1000');

const ROOT = path.resolve(__dirname, '..');
const getArg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const FILE = path.resolve(ROOT, getArg('file', 'data/leads-icp-fresh-perfect-1000.csv'));
const CONC = Math.max(1, parseInt(getArg('conc', '3'), 10));
const LIMIT = parseInt(getArg('limit', '0'), 10);
const JOURNAL = FILE.replace(/\.csv$/, '') + '.crossyear.json';

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const has = (v) => v && String(v).trim() && String(v).trim() !== '-';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// マイナビ面の業務語が氏名欄に混ざるのを防ぐ（build-icp-fresh-v2 と同じゲート）
const BAD = new Set(['人材', '人事', '採用', '総務', '業界研究', '会社研究', '企業研究', '専門', '人材開発', '説明会', '募集', '担当', '部門', '管理', '事務', '窓口', '総合職', '技術職', '営業職', '会社説明', '仕事']);

function safeWrite(abs, content) {
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, content);
  for (let i = 0; i < 5; i++) { try { fs.renameSync(tmp, abs); return; } catch (e) { if (e.code === 'EPERM' || e.code === 'EBUSY') { try { fs.writeFileSync(abs, content); fs.unlinkSync(tmp); return; } catch (_) {} } } }
  try { fs.writeFileSync(abs, content); fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch (_) {}
}
const goodName = (raw) => {
  const n = cleanCrossRefName(raw);
  if (!n) return '';
  const flat = String(n).replace(/\s/g, '');
  if (flat.length < 2 || BAD.has(flat)) return '';
  return n;
};

async function run() {
  const { records, headers } = readCsv(fs.readFileSync(FILE, 'utf8'));
  const cols = [...new Set([...(headers && headers.length ? headers : Object.keys(records[0] || {})), '氏名の出所'])];
  const done = new Set();
  if (fs.existsSync(JOURNAL)) { try { JSON.parse(fs.readFileSync(JOURNAL, 'utf8')).forEach((k) => done.add(k)); } catch (_) {} }

  const flush = () => {
    records.sort((a, b) => {
      const tv = (r) => (r['連絡先区分'] === '採用担当者名' ? 1 : r['連絡先区分'] === '代表者名' ? 2 : 3);
      return (tv(a) - tv(b)) || ((parseInt(b['アポ期待度']) || 0) - (parseInt(a['アポ期待度']) || 0));
    });
    if (records[0] && records[0]['No'] !== undefined) records.forEach((r, i) => { r['No'] = String(i + 1); });
    safeWrite(FILE, toCsv(cols, records));
    fs.writeFileSync(JOURNAL, JSON.stringify([...done]));
  };

  // 行を「引き直す卒年」で束ねる（現在の掲載年の逆）
  const buckets = { 27: [], 28: [] };
  for (const r of records) {
    if (has(r['採用担当者名'])) continue;
    if (done.has(mkey(r['企業名']))) continue;
    if (!has(r['corpID'])) continue;
    const cur = (String(r['採用ページURL'] || '').match(/job\.mynavi\.jp\/(\d{2})\//) || [])[1] || '28';
    const other = cur === '28' ? '27' : '28';
    buckets[other].push(r);
  }
  log(`対象: 27卒で引き直す ${buckets[27].length}社 ／ 28卒で引き直す ${buckets[28].length}社（済 ${done.size}）`);

  let hit = 0, checked = 0, mismatch = 0;
  for (const gy of ['27', '28']) {
    const targets = LIMIT ? buckets[gy].slice(0, LIMIT) : buckets[gy];
    if (!targets.length) continue;
    const sc = new MynaviScraper({ gradYear: gy });
    await sc.launch();
    let idx = 0;
    const worker = async () => {
      while (true) {
        const i = idx++;
        if (i >= targets.length) return;
        const r = targets[i];
        done.add(mkey(r['企業名']));
        try {
          const id = String(r['corpID']).trim();
          // ① 同一社であることを h1 で確認（corpIDは卒年をまたいで安定だが、取り違えは致命的なので必ず突合）
          const o = await sc.scrapeOutline(id);
          checked++;
          if (!o.ok || !o.企業名 || mkey(o.企業名) !== mkey(r['企業名'])) { mismatch++; continue; }
          // ② 氏名だけを取りにいく（ICP事実は元の卒年ページの値を維持）
          const got = await sc.scrapeByCorp(id, r['企業名']);
          const nm = goodName(got && got.採用担当者名);
          if (!nm) continue;
          r['採用担当者名'] = nm;
          r['役職'] = r['役職'] || got.役職 || '';
          r['部署'] = r['部署'] || got.部署 || '';
          if (!has(r['メール']) && got.メール) r['メール'] = got.メール;
          r['氏名の出所'] = `マイナビ${gy}卒(${got.パターン || '担当者面'})`;
          r['連絡先区分'] = '採用担当者名';
          r['架電宛名'] = (has(r['部署']) ? r['部署'] + ' ' : '') + nm + ' 様';
          if (r['ICP根拠'] !== undefined) r['ICP根拠'] = String(r['ICP根拠']).replace(/｜(代表者名|採用担当者名)\([^)]*\)$/, '') + `｜採用担当者名(${nm})`;
          const s = scoreMochica(r);
          r['アポ期待度'] = String(s.total); r['優先度'] = s.priority; r['確信度'] = String(s.confidence);
          r['MOCHICA適合'] = s.total >= 80 ? '◎' : s.total >= 65 ? '○' : '△';
          hit++;
          log(`  ✅ ${r['企業名']} → ${nm}（マイナビ${gy}卒・${got.パターン || ''}）`);
        } catch (_) { /* 1社の失敗は無視 */ }
        if (checked % 25 === 0) { flush(); log(`  …${gy}卒 ${checked}社照会 取得${hit} 別社スキップ${mismatch}`); }
        await sleep(200);
      }
    };
    await Promise.all(Array.from({ length: CONC }, () => worker()));
    await sc.close().catch(() => {});
    flush();
    log(`✔ ${gy}卒 完了 ｜ 累計 取得${hit} / 照会${checked}`);
  }
  flush();
  const t = (n) => records.filter((r) => r['連絡先区分'] === n).length;
  log(`完了: 採用担当者名 +${hit}社（照会${checked} 別社スキップ${mismatch}）`);
  log(`ティア: 採用担当者名 ${t('採用担当者名')} / 代表者名 ${t('代表者名')} / 名前なし ${t('名前なし')}`);
}

if (require.main === module) run().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
