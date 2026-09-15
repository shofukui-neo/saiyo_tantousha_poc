'use strict';
/**
 * 納品リストの宛名を1段ずつ引き上げる（採用担当者名 ＞ 代表者名 ＞ 名前なし）
 * ============================================================================
 * ICP適合の判定はここでは一切いじらない（母集団は固定）。宛名の質だけを上げる加点レイヤ。
 *
 *   Stage A: gBizINFO（公的登記）… 社名完全一致で 法人番号 / 代表者名 / 公式URL を取る
 *            → 代表者名が取れれば ティア3(名前なし) → ティア2(代表者名)
 *   Stage B: 自社サイトの採用ページ深掘り（probeRecruitPage・最大10面/2段リンク）
 *            → 実在の採用担当者名が取れれば ティア1(採用担当者名)。GEMINI_KEY があれば抽出精度が上がる。
 *
 * Wantedly は 2026-08 時点で未ログインの企業検索が不可（projects?q= は社名を無視した推薦結果、
 * companies?q= はログイン壁）。ログイン突破は規約リスクのため実装しない方針に従い、
 * Wantedly は sitemap ハーベスト側（harvest-wantedly.js）の (社名→氏名) 索引でのみ突合する。
 *
 * 使い方: node src/enrich-icp-names.js --file data/leads-icp-fresh-perfect-1000.csv [--stage ab] [--conc 4]
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv } = require('./csv');
const { gbizSearch, gbizGet, gbizAvailable } = require('./gbiz');
const { probeSiteDeep } = require('./probe-site-deep');
const { isPlausiblePersonName } = require('./jp-names');
const { cleanCrossRefName } = require('./enrich-crossref');
const { scoreMochica } = require('./mochica-fit');
const { stripGbizTitle } = require('./harvest-named-plus');
const { mkey } = require('./build-icp-fresh-1000');
const { setScrapeDelay } = require('./polite');

const ROOT = path.resolve(__dirname, '..');
const getArg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const FILE = path.resolve(ROOT, getArg('file', 'data/leads-icp-fresh-perfect-1000.csv'));
const STAGE = String(getArg('stage', 'ab')).toLowerCase();
const CONC = Math.max(1, parseInt(getArg('conc', '4'), 10));
const LIMIT = parseInt(getArg('limit', '0'), 10);
const JOURNAL = FILE.replace(/\.csv$/, '') + '.names.json';

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const has = (v) => v && String(v).trim() && String(v).trim() !== '-';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BAD = new Set(['人材', '人事', '採用', '総務', '担当', '広報', '事務局', '運営', '採用担当', '人事部', '会社', '本社']);

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

// 行の宛名・ティア・スコアを現在値から再構成する
function retier(r) {
  const tier = has(r['採用担当者名']) ? 1 : has(r['代表者名']) ? 2 : 3;
  const contact = tier === 1 ? r['採用担当者名'] : tier === 2 ? r['代表者名'] : '';
  r['連絡先区分'] = tier === 1 ? '採用担当者名' : tier === 2 ? '代表者名' : '名前なし';
  r['架電宛名'] = contact ? ((has(r['部署']) ? r['部署'] + ' ' : '') + contact + ' 様') : (has(r['部署']) ? r['部署'] + ' ご採用ご担当者様' : 'ご採用ご担当者様');
  const s = scoreMochica(r);
  r['アポ期待度'] = String(s.total); r['優先度'] = s.priority; r['確信度'] = String(s.confidence);
  r['MOCHICA適合'] = s.total >= 80 ? '◎' : s.total >= 65 ? '○' : '△';
  return tier;
}

async function run() {
  setScrapeDelay(parseInt(process.env.SCRAPE_DELAY_MS || '1200', 10));
  const { records, headers } = readCsv(fs.readFileSync(FILE, 'utf8'));
  const cols = [...new Set([...(headers && headers.length ? headers : Object.keys(records[0] || {})), '公式URL', '氏名の出所'])];
  const state = fs.existsSync(JOURNAL) ? JSON.parse(fs.readFileSync(JOURNAL, 'utf8')) : { gbiz: [], site: [] };
  const doneG = new Set(state.gbiz || []), doneS = new Set(state.site || []);
  const flush = () => {
    // ティア順（担当者名→代表者名→名前なし）×アポ期待度降順に並べ直し、Noを振り直す
    records.sort((a, b) => {
      const tv = (r) => (r['連絡先区分'] === '採用担当者名' ? 1 : r['連絡先区分'] === '代表者名' ? 2 : 3);
      return (tv(a) - tv(b)) || ((parseInt(b['アポ期待度']) || 0) - (parseInt(a['アポ期待度']) || 0));
    });
    if (records[0] && records[0]['No'] !== undefined) records.forEach((r, i) => { r['No'] = String(i + 1); });
    safeWrite(FILE, toCsv(cols, records));
    fs.writeFileSync(JOURNAL, JSON.stringify({ gbiz: [...doneG], site: [...doneS] }));
  };

  // ── Stage A: gBizINFO（代表者名・法人番号・公式URL）──────────────────
  if (STAGE.includes('a')) {
    if (!gbizAvailable()) log('GBIZ_TOKEN 未設定 → Stage A をスキップ');
    else {
      const targets = records.filter((r) => !has(r['採用担当者名']) && !doneG.has(mkey(r['企業名'])));
      log(`Stage A(gBiz): 対象 ${targets.length}社`);
      let n = 0, rep = 0, url = 0;
      for (const r of targets) {
        if (LIMIT && n >= LIMIT) break;
        n++;
        const key = mkey(r['企業名']);
        doneG.add(key);
        try {
          // gBizの name= は法人格つき表記だと404になる（実測: 「株式会社クックマート」404 / 「クックマート」200）。
          // 突合キー(mkey=注記・法人格を落とした核)で引き、候補側も同じキーで完全一致だけ採る＝誤マッチ0。
          const cands = await gbizSearch({ name: key, limit: 30 });
          const hit = (cands || []).find((c) => mkey(c.name) === key);
          if (hit && hit.corporateNumber) {
            if (!has(r['法人番号'])) r['法人番号'] = hit.corporateNumber;
            const d = await gbizGet(hit.corporateNumber);
            if (d) {
              if (d.websiteUrl && !has(r['公式URL'])) { r['公式URL'] = d.websiteUrl; url++; }
              const rp = goodName(stripGbizTitle(d.representativeName || ''));
              if (rp && !has(r['代表者名'])) {
                r['代表者名'] = rp; rep++;
                if (!has(r['氏名の出所'])) r['氏名の出所'] = 'gBizINFO代表者';
                retier(r);
              }
            }
          }
        } catch (_) { /* 1社の失敗は無視 */ }
        if (n % 25 === 0) { flush(); log(`  …A ${n}/${targets.length} 代表者名+${rep} 公式URL+${url}`); }
        await sleep(250);
      }
      flush();
      log(`Stage A 完了: 代表者名 +${rep}社 ／ 公式URL +${url}社`);
    }
  }

  // ── Stage B: 自社サイトの採用ページ深掘りで「採用担当者名」を取る ────────
  if (STAGE.includes('b')) {
    // 公式URLの供給源: ① gBizのcompany_url（実測ほぼ空） ② 採用メールのドメイン（マイナビ問合せ先から取得済）。
    // マイナビは会社ホームページへの外部リンクを出さないため、②が実質の主経路。
    for (const r of records) {
      if (has(r['公式URL'])) continue;
      const m = String(r['メール'] || '').match(/@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
      if (!m) continue;
      const d = m[1].toLowerCase();
      if (/(gmail|yahoo|outlook|hotmail|icloud|docomo|ezweb|softbank|mynavi|rikunabi)\./.test(d)) continue; // 個人/媒体ドメインは自社サイトでない
      r['公式URL'] = 'https://' + d;
    }
    const targets = records.filter((r) => !has(r['採用担当者名']) && has(r['公式URL']) && !doneS.has(mkey(r['企業名'])));
    log(`Stage B(自社採用ページ): 対象 ${targets.length}社（並列${CONC}）`);
    let idx = 0, done = 0, hit = 0, repHit = 0;
    const worker = async () => {
      while (true) {
        const i = idx++;
        if (i >= targets.length || (LIMIT && i >= LIMIT)) return;
        const r = targets[i];
        doneS.add(mkey(r['企業名']));
        try {
          // 自社サイトを深掘りし、役割ラベル付きの氏名候補を集める（採用担当→ティア1／代表→ティア2）。
          // gBizは代表者名をほとんど公開していない（実測: 名前なし行10社で0件）ため、
          // 会社概要ページに必ず載る代表者名を取りにいくこの経路がティア2の主力になる。
          const cands = await probeSiteDeep(r['企業名'], r['公式URL'], { maxPages: 8 });
          const pick = (roleRe) => (cands || [])
            .filter((c) => c.name && roleRe.test(String(c.role || '')) && goodName(c.name) && isPlausiblePersonName(c.name))
            .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
          const rec = pick(/採用|人事/);
          const rp = pick(/代表|社長/);
          if (rec) {
            r['採用担当者名'] = goodName(rec.name);
            r['役職'] = r['役職'] || rec.role || '採用担当';
            r['氏名の出所'] = '自社採用ページ';
            if (rec.sourceUrl) r['名前根拠URL'] = rec.sourceUrl;
            hit++;
            log(`  ✅[担当] ${r['企業名']} → ${r['採用担当者名']}（自社サイト）`);
          }
          if (rp && !has(r['代表者名'])) {
            r['代表者名'] = goodName(rp.name);
            if (!rec) {
              r['氏名の出所'] = '自社サイト会社概要(代表者)';
              if (rp.sourceUrl) r['名前根拠URL'] = rp.sourceUrl;
              repHit++;
              log(`  ✅[代表] ${r['企業名']} → ${r['代表者名']}（自社サイト）`);
            }
          }
          if (rec || rp) retier(r);
        } catch (_) { /* 1社の失敗は無視 */ }
        if (++done % 20 === 0) { flush(); log(`  …B ${done}/${targets.length} 採用担当者名+${hit} 代表者名+${repHit}`); }
      }
    };
    await Promise.all(Array.from({ length: CONC }, () => worker()));
    flush();
    log(`Stage B 完了: 採用担当者名 +${hit}社 ／ 代表者名 +${repHit}社`);
  }

  flush();
  const t = (n) => records.filter((r) => r['連絡先区分'] === n).length;
  log(`現在のティア: 採用担当者名 ${t('採用担当者名')} / 代表者名 ${t('代表者名')} / 名前なし ${t('名前なし')}（全${records.length}）`);
}

if (require.main === module) run().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
