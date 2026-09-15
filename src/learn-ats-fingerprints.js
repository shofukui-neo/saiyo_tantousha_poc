'use strict';
/**
 * ベンダー指紋辞書の自前学習（層0）
 * ============================================================================
 * 「どのホストがATSベンダーか」を外部記事から持ってこない。自社データだけで作る。
 *
 * 正解ラベルの在り処（実測で確認した唯一の使える源）:
 *   BALESCLOUD リード 22,892件の「カスタム情報：利用中ATS」＝ インサイドセールスが架電時に
 *   本人から聞き取った自己申告。値の分布は
 *     無し 16,967 ／ 採用一括かんりくん 504 ／ sonarATS 260 ／ キャリタスContact 168 ／ AOL 127 …
 *   Webサイト付きでユニーク化すると 陽性889社・陰性8,745社。これが学習と精度検証の土台。
 *   （SFリード86,610件は会社名/電話/採用人数のみでATS列もURLも持たないため、この層では使えない。
 *     MOCHICA既存顧客429社は「MOCHICA導入済」という単一ベンダーの陽性として統合マスタ経由で足す。）
 *
 * 指紋の作り方（2つの独立した根拠しか使わない）:
 *   ① 多テナント性 … 無関係な複数企業のエントリー導線が同じホストに集まる ＝ 定義上ベンダー。
 *                    ラベルが1件も無くても検出できる。辞書が自分で育つのはこの経路。
 *   ② ラベル分布   … そのホストに集まった企業の申告値。ベンダー名の確定と、
 *                    「ATSか / 単なる汎用フォームSaaSか」の判別に使う。
 *                    申告が「無し」ばかりのホストは side='diy'（＝未導入側）に落とす。
 *                    これをやらないと、フォームSaaSを全部ATS扱いして未導入企業を取りこぼす。
 *
 * 精度を自分で測る:
 *   企業単位で train / test に分け、train だけで辞書を作り、test で判定精度を出す。
 *   出力 data/ats-fingerprints-report.md に混同行列まで書く。
 *
 *   node src/learn-ats-fingerprints.js [--train 140] [--test 90] [--conc 6] [--max-pages 5]
 *                                      [--from-ledger] [--refresh] [--no-eval]
 *
 *   --from-ledger … 本番エンリッチの台帳 data/ats-status.json（数万社）から再クラスタリング。
 *                   多テナント性は母数が増えるほど効くので、運用後はこちらが主経路。
 */
const fs = require('fs');
const path = require('path');
const { readCsv, normCompanyName } = require('./csv');
const { probeAts, DICT_PATH } = require('./probe-ats');
const { summarizeAts, rootDomain, registrableDomain, isInfraHost, isSocialHost, isMediaHost } = require('./ats-detect');
const { closeBrowser } = require('./fetch');

const ROOT = path.resolve(__dirname, '..');
const BALES = path.resolve(ROOT, 'data/BALESCLOUDの既存リスト - 202607062007_leadList_utf-8.csv');
const MOCHICA_CUST = path.resolve(ROOT, 'data/MOCHICAの既存顧客リスト - mochica-companies-list.csv');
const MASTER = path.resolve(ROOT, 'data/leads-consolidated-all.csv');
const CACHE = path.resolve(ROOT, 'data/ats-learn-cache.json');
const LEDGER = path.resolve(ROOT, 'data/ats-status.json');
const REPORT = path.resolve(ROOT, 'data/ats-fingerprints-report.md');
const MANUAL = path.resolve(ROOT, 'data/ats-fingerprints-manual.json');   // 人手で確定した指紋（任意）

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
const N_TRAIN = parseInt(getArg('train', '140'), 10);
const N_TEST = parseInt(getArg('test', '90'), 10);
const CONC = Math.max(1, parseInt(getArg('conc', '6'), 10) || 6);
const MAX_PAGES = parseInt(getArg('max-pages', '5'), 10) || 5;
const FROM_LEDGER = process.argv.includes('--from-ledger');
const REFRESH = process.argv.includes('--refresh');
const NO_EVAL = process.argv.includes('--no-eval');

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
function safeWrite(abs, content) {
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, content);
  try { fs.renameSync(tmp, abs); } catch (_) { fs.writeFileSync(abs, content); try { fs.unlinkSync(tmp); } catch (__) {} }
}
function loadJson(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return def; } }

// ---- 学習/検証の母集団を作る ------------------------------------------------
// 申告値の表記ゆれを1つに寄せる（SONAR と sonarATS、キャリタスContact と キャリタスコンタクト等）。
// ※これは「ベンダーの正体を外から調べる」行為ではなく、自社データ内の同一値の名寄せ。
function normVendorLabel(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const k = s.replace(/[\s　]/g, '').toLowerCase();
  if (/^sonar/.test(k)) return 'sonarATS';
  if (/キャリタス/.test(s)) return 'キャリタスContact';
  if (/かんりくん|管理くん/.test(s)) return '採用一括かんりくん';
  return s;
}
// 判定に使えない申告値（ATS名ではない）。陽性から外す。
const NON_VENDOR = /^(無し|なし|その他|不明|LINE公式アカウント|母集団形成の媒体で管理)$/i;

function normalizeSite(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  const url = /^https?:\/\//i.test(s) ? s : 'https://' + s;
  try { const x = new URL(url); return x.origin + (x.pathname === '/' ? '/' : x.pathname); } catch (_) { return ''; }
}

function buildLabeledPool() {
  const pos = new Map(); const neg = new Map();
  const { records } = readCsv(fs.readFileSync(BALES, 'utf8'));
  for (const r of records) {
    const name = (r['会社情報：会社名'] || '').trim();
    const site = normalizeSite(r['会社情報：Webサイト'] || '');
    if (!name || !site) continue;
    const key = normCompanyName(name);
    if (!key) continue;
    const raw = (r['カスタム情報：利用中ATS'] || '').trim();
    if (!raw) continue;
    if (NON_VENDOR.test(raw)) {
      if (/^(無し|なし)$/.test(raw) && !pos.has(key) && !neg.has(key)) neg.set(key, { name, site, label: '無し' });
      continue;
    }
    const vendor = normVendorLabel(raw);
    neg.delete(key);
    if (!pos.has(key)) pos.set(key, { name, site, label: vendor });
  }
  // MOCHICA既存顧客（＝MOCHICA導入済）。顧客CSVにURLが無いので統合マスタで公式URLを引く。
  try {
    const master = readCsv(fs.readFileSync(MASTER, 'utf8')).records;
    const byName = new Map();
    for (const m of master) {
      const k = normCompanyName(m['企業名'] || m['﻿企業名'] || '');
      const u = normalizeSite(m['公式URL'] || '');
      if (k && u && !byName.has(k)) byName.set(k, u);
    }
    const cust = readCsv(fs.readFileSync(MOCHICA_CUST, 'utf8')).records;
    let added = 0;
    for (const c of cust) {
      const name = (c['法人名'] || '').trim();
      const key = normCompanyName(name);
      if (!key || pos.has(key)) continue;
      const site = byName.get(key);
      if (!site) continue;
      neg.delete(key);
      pos.set(key, { name, site, label: 'MOCHICA' });
      added++;
    }
    if (added) log(`MOCHICA既存顧客から陽性 ${added}社を追加（統合マスタで公式URL突合）`);
  } catch (e) { log(`MOCHICA顧客の突合をスキップ: ${e.message}`); }
  return { pos: [...pos.values()], neg: [...neg.values()] };
}

// ベンダー別に均等に取る（1ベンダーで辞書が埋まらないように）。
function stratify(items, n, keyFn) {
  const groups = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  const keys = [...groups.keys()];
  const out = [];
  for (let round = 0; out.length < n; round++) {
    let moved = false;
    for (const k of keys) {
      const g = groups.get(k);
      if (round < g.length) { out.push(g[round]); moved = true; if (out.length >= n) break; }
    }
    if (!moved) break;
  }
  return out;
}

// ---- クロール（結果は企業単位でキャッシュ。再学習は取得ゼロで回る）-----------
async function crawlAll(targets, cache) {
  const todo = targets.filter((t) => REFRESH || !cache[t.key]);
  log(`クロール対象 ${todo.length}社（キャッシュ再利用 ${targets.length - todo.length}社）conc=${CONC}`);
  let idx = 0; let done = 0;
  async function worker() {
    for (;;) {
      const my = idx++;
      if (my >= todo.length) return;
      const t = todo[my];
      let r;
      try {
        // 学習時は辞書を渡さない。辞書に引きずられた判定を学習材料にすると循環参照になる。
        r = await probeAts(t.name, t.site, { maxPages: MAX_PAGES, dict: { hosts: {} }, noCache: REFRESH });
      } catch (e) {
        r = { エラー: String((e && e.message) || e), signals: [], pages: [], 検査ページ数: 0, 学習材料: { hosts: [], scripts: [], metas: [] } };
      }
      cache[t.key] = {
        name: t.name, site: t.site, label: t.label,
        pagesOk: r.検査ページ数 || 0, pagesFailed: r.失敗ページ数 || 0, recruitFound: r.採用ページ到達 === '○',
        // 判定に必要な最小限だけ保存（台帳が肥大しないように）
        signals: (r.signals || []).map((s) => ({
          source: s.source, entry_type: s.entry_type, host: s.host, level: s.level, side: s.side,
          entry_ctx: s.entry_ctx, footer: s.footer, shinsotsu: s.shinsotsu, pageRole: s.pageRole,
          evidence: String(s.evidence || '').slice(0, 160),
        })),
        learn: r.学習材料 || { hosts: [], scripts: [], metas: [] },
        at: new Date().toISOString().slice(0, 10),
      };
      if (++done % 10 === 0) { safeWrite(CACHE, JSON.stringify(cache)); log(`  ${done}/${todo.length} 取得`); }
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));
  safeWrite(CACHE, JSON.stringify(cache));
}

// ---- 指紋のクラスタリング ---------------------------------------------------
const MIN_COMPANIES = 3;      // 多テナント性の下限。2社では偶然（グループ会社の共通サイト等）が混じる。
const LABEL_RATIO = 0.6;      // ラベルの多数決の下限

/**
 * ホスト名と申告ベンダー名の近さ。
 * ============================================================================
 * ラベルは「企業」に付いていて「ホスト」には付いていない。1社が複数の外部ホストに触るので、
 * ATS保有社が使っている“ただのフォームツール”にもATSラベルが乗ってしまう
 * （実測: forms.office.com に {sonarATS,HRPRIME} が乗り、Microsoft FormsがATS扱いされかけた）。
 *
 * ここで効くのが「本物のベンダーのホストなら、社名が申告値に似ている」という自社データ内の一致検査。
 *   hrmos.co  ←→ 「HRMOS」        一致
 *   snar.jp   ←→ 「sonarATS」      一致（snar は sonarats の部分列）
 *   i-webs.jp ←→ 「i-web」         一致
 *   office.com←→ 「sonarATS」      不一致 → ATS認定しない（要確認に落ちる＝安全側）
 * 外部知識ではなく、自社が持っている申告文字列との照合であることに注意。
 */
function hostVendorAffinity(host, label) {
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  // ドメインの先頭ラベル（job.snar.jp なら snar）とベンダー名を比べる
  const parts = String(host || '').split('.').filter((p) => !/^(co|ne|or|ac|go|jp|com|net|org|asia|io|biz)$/.test(p));
  const label0 = norm(label).replace(/(ats|cloud|system|saiyou?|recruit)$/g, '');
  if (label0.length < 3) return false;
  const isSub = (a, b) => {           // a が b の部分列か（文字順を保った飛び飛びの一致）
    let i = 0;
    for (const ch of b) if (ch === a[i]) i++;
    return i === a.length;
  };
  for (const p of parts) {
    const h = norm(p);
    if (h.length < 3) continue;
    if (h.includes(label0) || label0.includes(h)) return true;
    if (h.length >= 4 && isSub(h, label0)) return true;
    if (label0.length >= 4 && isSub(label0, h)) return true;
  }
  return false;
}

/**
 * 企業単位のクロール結果 → ホスト別の指紋。
 * @param {Array<{label:string, signals:Array, learn:object}>} rows
 * @returns {{hosts:object, scripts:object, stats:object}}
 */
function clusterFingerprints(rows) {
  const hostAgg = new Map();     // host -> { companies:Set, labels:Map, examples:[], ctxHits, roles:Set }
  const scriptAgg = new Map();   // script -> { pos:Set, neg:Set, labels:Map }

  const touch = (map, k) => {
    if (!map.has(k)) map.set(k, { companies: new Set(), labels: new Map(), labelsCtx: new Map(), ctxCompanies: new Set(), examples: [], ctxHits: 0, sigs: 0 });
    return map.get(k);
  };
  for (const row of rows) {
    const cid = normCompanyName(row.name) || row.name;
    const label = row.label || '';
    const isPos = !!label && label !== '無し';
    // ① エントリー文脈で自社ドメイン外へ出たホスト＝ベンダー候補
    const hosts = new Set(); const hostsCtx = new Set();
    for (const s of (row.signals || [])) {
      if (!s.host) continue;
      if (!['ats_vendor', 'generic_form', 'google_form'].includes(s.entry_type)) continue;
      const h = registrableDomain(s.host);
      // 除外規則は後から強化されるので、過去の台帳に残っている証跡もここで弾く
      //（例: 動画/スライド埋め込みをユーティリティ扱いにした後、再クロール無しで効かせる）。
      if (isInfraHost(h) || isSocialHost(h) || isMediaHost(h)) continue;
      hosts.add(h);
      if (s.entry_ctx) hostsCtx.add(h);
      const a = touch(hostAgg, h);
      a.sigs++;
      if (s.entry_ctx) a.ctxHits++;
      if (a.examples.length < 5 && !a.examples.includes(row.name)) a.examples.push(row.name);
    }
    for (const h of hosts) {
      const a = hostAgg.get(h);
      a.companies.add(cid);
      if (label) a.labels.set(label, (a.labels.get(label) || 0) + 1);
    }
    // ラベルは「企業」に付いていて「ホスト」には付いていない。1社が複数ホストに触るので、
    // 全リンクで集計すると他社ベンダーのラベルが混ざる（実測: hrmos.co に sonarATS 等が混入）。
    // その企業が“実際にエントリーを投げている先”＝エントリー文脈のホストだけで集計し直す。
    for (const h of hostsCtx) {
      const a = hostAgg.get(h);
      a.ctxCompanies.add(cid);
      if (label) a.labelsCtx.set(label, (a.labelsCtx.get(label) || 0) + 1);
    }
    // ② script 指紋（陽性に偏るファイル名だけ拾う。CDN/解析は probe 側で除外済み）
    for (const sc of new Set(row.learn && row.learn.scripts ? row.learn.scripts : [])) {
      if (!/\//.test(sc)) continue;                     // 自社配信のJSは指紋にならない
      if (!scriptAgg.has(sc)) scriptAgg.set(sc, { pos: new Set(), neg: new Set(), labels: new Map() });
      const a = scriptAgg.get(sc);
      (isPos ? a.pos : a.neg).add(cid);
      if (isPos) a.labels.set(label, (a.labels.get(label) || 0) + 1);
    }
  }

  const modeLabel = (labels) => {
    const ents = [...labels.entries()].filter(([k]) => k && k !== '無し').sort((a, b) => b[1] - a[1]);
    return ents.length ? ents[0][0] : '';
  };
  const hosts = {};
  for (const [h, a] of hostAgg) {
    const companies = a.companies.size;
    // エントリー文脈のラベルが足りていればそちらを使う（他社ベンダーの混入が消える）。
    const useCtx = [...a.labelsCtx.values()].reduce((s, v) => s + v, 0) >= 2;
    const labels = useCtx ? a.labelsCtx : a.labels;
    const atsN = [...labels.entries()].filter(([k]) => k && k !== '無し').reduce((s, [, v]) => s + v, 0);
    const noneN = labels.get('無し') || 0;
    const labeled = atsN + noneN;
    // ベンダー名との一致は「そのホストが誰のものか」の直接証拠。あれば1社の申告でも採る。
    const named = [...labels.entries()].filter(([k]) => k && k !== '無し');
    const affinity = named.find(([k]) => hostVendorAffinity(h, k));
    let side = 'unknown'; let level = 2;
    if (affinity && atsN >= 1) { side = 'ats'; level = 3; }
    // 一致が取れない場合は、多テナント性とラベルの純度で高い方の基準を要求する
    //   （ATS保有社が“ついでに”使っているツールを取り違えないため）。
    else if (atsN >= 3 && noneN === 0 && a.ctxCompanies.size >= 3 && atsN / (labeled || 1) >= LABEL_RATIO) { side = 'ats'; level = 3; }
    else if (noneN >= 3 && atsN === 0) { side = 'diy'; level = 3; }
    else if (companies >= MIN_COMPANIES && labeled === 0) { side = 'unknown'; level = 2; }
    // 多テナント性が無い（1社でしか見ていない）ホストは辞書に載せない＝その企業の別ドメインの可能性が高い
    if (companies < 2 && side !== 'ats') continue;
    // 一度もエントリー文脈でリンクされていないホストは、エントリーの遷移先ではない（地図/バナー等）。
    if (!a.ctxHits) continue;
    hosts[h] = {
      host: h, vendor: side === 'ats' ? (affinity ? affinity[0] : modeLabel(labels)) : '',
      side, level, 名称一致: affinity ? affinity[0] : '',
      companies, エントリー文脈社数: a.ctxCompanies.size,
      ラベル内訳: Object.fromEntries(labels), ラベル源: useCtx ? 'エントリー文脈' : '全リンク',
      エントリー文脈: a.ctxHits, 企業例: a.examples.slice(0, 3),
    };
  }
  // script 指紋: 陽性側に偏っているものだけ（lift）。判定では level2 の傍証として使う。
  const scripts = {};
  for (const [sc, a] of scriptAgg) {
    const p = a.pos.size; const n = a.neg.size;
    if (p < 3) continue;
    const lift = p / (n + 0.5);
    if (lift < 3) continue;
    scripts[sc] = { script: sc, vendor: modeLabel(a.labels), pos: p, neg: n, lift: Math.round(lift * 10) / 10, side: 'ats', level: 2 };
  }
  return { hosts, scripts };
}

// ---- 精度検証 ---------------------------------------------------------------
function evaluate(rows, dict) {
  // ラベルとの照合。判定は「導入済 / 未導入 / 要確認 / 不明」の4値。
  const cm = {};                                     // `${真}|${判定}` -> n
  const errs = [];
  for (const row of rows) {
    const truth = row.label && row.label !== '無し' ? '導入済' : '未導入';
    // 保存済み signals を辞書で解釈し直す（再クロール不要）
    const sigs = (row.signals || []).map((s) => {
      const fp = dict.hosts[registrableDomain(s.host || '')] || null;
      if (s.entry_type === 'ats_vendor' || s.entry_type === 'generic_form') {
        if (fp && fp.side === 'diy') return { ...s, entry_type: 'generic_form', side: 'diy' };
        if (fp && fp.side === 'ats') return { ...s, entry_type: 'ats_vendor', side: 'ats', vendor: fp.vendor };
        return { ...s, side: 'unknown' };
      }
      return s;
    });
    const r = summarizeAts(sigs, { pagesOk: row.pagesOk, pagesFailed: row.pagesFailed, recruitFound: row.recruitFound });
    const k = `${truth}|${r.ATS判定}`;
    cm[k] = (cm[k] || 0) + 1;
    if ((truth === '導入済' && r.ATS判定 === '未導入') || (truth === '未導入' && r.ATS判定 === '導入済')) {
      if (errs.length < 25) errs.push({ name: row.name, site: row.site, truth, got: r.ATS判定, label: row.label, entry_type: r.entry_type, host: r.entry_host, 根拠: r.根拠.slice(0, 160) });
    }
  }
  const get = (t, g) => cm[`${t}|${g}`] || 0;
  const truthPos = ['導入済', '未導入', '要確認', '不明'].reduce((s, g) => s + get('導入済', g), 0);
  const truthNeg = ['導入済', '未導入', '要確認', '不明'].reduce((s, g) => s + get('未導入', g), 0);
  const decidedPos = get('導入済', '導入済') + get('未導入', '導入済');
  const decidedNeg = get('導入済', '未導入') + get('未導入', '未導入');

  // ---- 母集団補正 ----
  // test は陽性・陰性を半々にしてある（＝ロジック比較のため）。だが実際のリード母集団の
  // ATS保有率はそんなに高くない（自社ラベル実測で約1割）。素の精度をそのまま
  // 「30,290社に適用した時の精度」と読むと大きく過小評価になる。条件付き率から引き直す。
  const 未導入率given導入済 = truthPos ? get('導入済', '未導入') / truthPos : 0;   // ATS保有社を誤って未導入と言う率
  const 未導入率given未導入 = truthNeg ? get('未導入', '未導入') / truthNeg : 0;   // 真の未導入社を未導入と言える率
  const adjust = (base) => {
    const tp = 未導入率given未導入 * (1 - base);
    const fp = 未導入率given導入済 * base;
    return (tp + fp) ? tp / (tp + fp) : null;
  };
  return {
    cm, errs, truthPos, truthNeg,
    導入済精度: decidedPos ? get('導入済', '導入済') / decidedPos : null,          // 導入済と言った時の正しさ
    未導入精度: decidedNeg ? get('未導入', '未導入') / decidedNeg : null,          // 未導入と言った時の正しさ（test母集団=50:50）
    導入済再現: truthPos ? get('導入済', '導入済') / truthPos : null,              // ATS保有社をどれだけ除外できたか
    判定率: (truthPos + truthNeg) ? (decidedPos + decidedNeg) / (truthPos + truthNeg) : 0,
    未導入率given導入済, 未導入率given未導入, adjust,
  };
}

// ---- entry_type の分布（未導入層の中身。営業の分母になる）-------------------
function typeDistribution(rows, dict) {
  const dist = new Map();
  for (const row of rows) {
    const sigs = (row.signals || []).map((s) => {
      const fp = dict.hosts[registrableDomain(s.host || '')] || null;
      if (fp && (s.entry_type === 'ats_vendor' || s.entry_type === 'generic_form')) {
        return { ...s, entry_type: fp.side === 'diy' ? 'generic_form' : 'ats_vendor', side: fp.side };
      }
      return s;
    });
    const r = summarizeAts(sigs, { pagesOk: row.pagesOk, pagesFailed: row.pagesFailed, recruitFound: row.recruitFound });
    const k = `${r.ATS判定}／${r.entry_type}`;
    dist.set(k, (dist.get(k) || 0) + 1);
  }
  return [...dist.entries()].sort((a, b) => b[1] - a[1]);
}

async function run() {
  const cache = loadJson(CACHE, {});
  let trainRows; let testRows;
  let poolStats = { pos: 951, neg: 8685 };   // 母集団補正用（--from-ledger 時はラベルが無いので実測既定値）

  if (FROM_LEDGER) {
    // 本番台帳から再クラスタリング。
    //   多テナント性は母数が効くので、数万社の台帳はラベル付き340社より遥かに強い証拠になる。
    //   さらに台帳の社名を自社ラベル（BALES申告）に突合して、取れる分だけラベルも足す。
    const led = loadJson(LEDGER, {});
    const rows = Object.values(led).filter((v) => v && v.signals);
    const { pos, neg } = buildLabeledPool();
    poolStats = { pos: pos.length, neg: neg.length };
    const labelBy = new Map();
    for (const x of pos) labelBy.set(normCompanyName(x.name), x.label);
    for (const x of neg) if (!labelBy.has(normCompanyName(x.name))) labelBy.set(normCompanyName(x.name), '無し');
    let labeled = 0;
    for (const r of rows) {
      const l = labelBy.get(normCompanyName(r.name || ''));
      if (l) { r.label = l; labeled++; }
    }
    log(`台帳から ${rows.length}社を読み込み（うち自社ラベル突合 ${labeled}社）`);
    trainRows = rows; testRows = [];
  } else {
    const { pos, neg } = buildLabeledPool();
    poolStats = { pos: pos.length, neg: neg.length };
    log(`ラベル母集団: 陽性 ${pos.length}社（ベンダー申告あり）／陰性 ${neg.length}社（申告「無し」）`);
    // train / test はどちらも陽性・陰性を半々で持つ。
    //   test に陰性が入っていないと「未導入と判定した時の正しさ」＝運用で一番効く指標が測れない。
    const trPos = Math.ceil(N_TRAIN / 2); const trNeg = N_TRAIN - trPos;
    const tePos = Math.ceil(N_TEST / 2); const teNeg = N_TEST - tePos;
    const posPick = stratify(pos, trPos + tePos, (x) => x.label);
    // 陰性はCSV順（＝リード登録順）に偏るので、等間隔に間引いて業種の偏りを均す。
    const stride = Math.max(1, Math.floor(neg.length / (trNeg + teNeg)));
    const negPick = neg.filter((_, i) => i % stride === 0).slice(0, trNeg + teNeg);
    const tag = (x) => ({ ...x, key: 'T:' + normCompanyName(x.name) });
    const train = [...posPick.slice(0, trPos), ...negPick.slice(0, trNeg)].map(tag);
    const test = [...posPick.slice(trPos), ...negPick.slice(trNeg)].map(tag);
    log(`train ${train.length}社（陽性${Math.min(trPos, posPick.length)}/陰性${Math.min(trNeg, negPick.length)}）｜test ${test.length}社（陽性${Math.max(0, posPick.length - trPos)}/陰性${Math.max(0, negPick.length - trNeg)}）`);
    await crawlAll([...train, ...test], cache);
    trainRows = train.map((t) => cache[t.key]).filter(Boolean);
    testRows = test.map((t) => cache[t.key]).filter(Boolean);
  }

  const { hosts, scripts } = clusterFingerprints(trainRows);
  const dict = {
    生成日: new Date().toISOString().slice(0, 10),
    学習元: FROM_LEDGER ? '本番台帳 data/ats-status.json（多テナント性のみ）'
      : 'BALESCLOUD「カスタム情報：利用中ATS」自己申告ラベル + MOCHICA既存顧客',
    学習企業数: trainRows.length,
    判定基準: {
      多テナント下限: MIN_COMPANIES, ラベル多数決比: LABEL_RATIO,
      side: 'ats=ATSベンダー(除外対象) / diy=汎用フォームSaaS(未導入側) / unknown=多テナントだが正体不明',
    },
    hosts, scripts, metas: {},
  };
  // 既存辞書は捨てずにマージ（過去に確定した ats/diy 判定は残す。運用で育てるため）
  // 過去の学習結果は捨てずに引き継ぐ（運用で育てるため）。ただし品質ゲートを通す。
  //   ・現行の基準を満たしている（エントリー文脈で1社以上）エントリーだけ
  //   ・過去の判定で現行の判定を上書きしない（古い基準で付いた ats が生き残るのを防ぐ）
  // これを入れないと、初期の緩い基準で ats になった goo.gl / privacymark.jp / youtu.be が
  // 世代を越えて生き残り、辞書を汚し続ける（実測で確認）。
  const prev = loadJson(DICT_PATH, null);
  let carried = 0; let dropped = 0;
  if (prev && prev.hosts) {
    for (const [h, v] of Object.entries(prev.hosts)) {
      const cur = dict.hosts[h];
      if (cur) {
        // ベンダー名との一致で ats を確定したホストは、後から母数が増えて
        // ラベルが薄まっても正体は変わらない。新しい判定が 'unknown'（＝根拠不足）なら維持する。
        // 実測: 台帳600社を足した時、hrmos.co が「無し」ラベルの混入で unknown に落ちた。
        if (v.side === 'ats' && cur.side === 'unknown') {
          dict.hosts[h] = { ...cur, side: 'ats', level: 3, vendor: cur.vendor || v.vendor, 前回確定: true };
          carried++;
        }
        continue;
      }
      if (!(v.エントリー文脈社数 >= 1)) { dropped++; continue; }
      dict.hosts[h] = { ...v, 引継ぎ: true };
      carried++;
    }
    log(`過去辞書からの引継ぎ ${carried}ホスト／基準未達で破棄 ${dropped}ホスト`);
  }
  // 人手で確定したホストを最後に重ねる。生成物を直接編集させないための口。
  const manual = loadJson(MANUAL, null);
  if (manual && manual.hosts) {
    let applied = 0;
    for (const [h, v] of Object.entries(manual.hosts)) {
      dict.hosts[h] = { host: h, companies: 0, ...(dict.hosts[h] || {}), ...v, level: v.level || 3, 人手確定: true };
      applied++;
    }
    dict.人手確定 = applied;
    log(`人手確定の指紋を適用: ${applied}ホスト <${path.relative(ROOT, MANUAL)}>`);
  }
  safeWrite(DICT_PATH, JSON.stringify(dict, null, 1));
  const sides = Object.values(dict.hosts).reduce((a, v) => { a[v.side] = (a[v.side] || 0) + 1; return a; }, {});
  log(`辞書を書き出し: ${path.relative(ROOT, DICT_PATH)}（${Object.keys(dict.hosts).length}ホスト｜ats ${sides.ats || 0} / diy ${sides.diy || 0} / unknown ${sides.unknown || 0}、script指紋 ${Object.keys(scripts).length}）`);

  // ---- レポート ----
  const lines = [];
  lines.push('# ATSベンダー指紋辞書（自前学習）レポート', '');
  lines.push(`生成: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`);
  lines.push(`学習元: ${dict.学習元}｜学習企業 ${trainRows.length}社`, '');
  lines.push('## 学習された指紋（多テナント性の高い順）', '');
  lines.push('| ホスト | side | ベンダー | 企業数 | 文脈社数 | ラベル源 | ラベル内訳 | 企業例 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const v of Object.values(dict.hosts).sort((a, b) => (b.エントリー文脈社数 || 0) - (a.エントリー文脈社数 || 0) || (b.companies || 0) - (a.companies || 0)).slice(0, 60)) {
    lines.push(`| ${v.host} | ${v.side} | ${v.vendor || '-'} | ${v.companies || '-'} | ${v.エントリー文脈社数 != null ? v.エントリー文脈社数 : '-'} | ${v.ラベル源 || '-'} | ${JSON.stringify(v.ラベル内訳 || {})} | ${(v.企業例 || []).join('/')} |`);
  }
  // 正体不明だが多テナント性が高いホスト＝辞書の伸びしろ。人が1回見れば ats/diy が確定する。
  const review = Object.values(dict.hosts)
    .filter((v) => v.side === 'unknown' && (v.エントリー文脈社数 || 0) >= 2)
    .sort((a, b) => (b.エントリー文脈社数 || 0) - (a.エントリー文脈社数 || 0));
  if (review.length) {
    lines.push('', '## 要レビュー（多テナントだが正体不明のホスト）', '');
    lines.push('ここが辞書の伸びしろ。1ホスト確定するごとに「要確認」が数十〜数百社まとめて解ける。');
    lines.push(`確定させるには data/ats-fingerprints-manual.json に \`{"hosts":{"<host>":{"side":"ats"|"diy","vendor":"名称"}}}\` を書いて再学習する。`, '');
    lines.push('| ホスト | 文脈社数 | 企業数 | ラベル内訳 | 企業例 |', '|---|---|---|---|---|');
    for (const v of review.slice(0, 30)) {
      lines.push(`| ${v.host} | ${v.エントリー文脈社数} | ${v.companies} | ${JSON.stringify(v.ラベル内訳 || {})} | ${(v.企業例 || []).join('/')} |`);
    }
  }
  if (Object.keys(scripts).length) {
    lines.push('', '## script指紋（陽性に偏るJS。level2の傍証）', '', '| script | ベンダー | 陽性 | 陰性 | lift |', '|---|---|---|---|---|');
    for (const v of Object.values(scripts).sort((a, b) => b.lift - a.lift).slice(0, 25)) {
      lines.push(`| ${v.script} | ${v.vendor || '-'} | ${v.pos} | ${v.neg} | ${v.lift} |`);
    }
  }

  if (!NO_EVAL && testRows.length) {
    const ev = evaluate(testRows, dict);
    // 実母集団のATS保有率（自社ラベル実測）。母集団補正の事前確率に使う。
    const posN = poolStats.pos; const negN = poolStats.neg;
    const baseRate = (posN + negN) ? posN / (posN + negN) : 0.1;
    const pct = (x) => (x == null ? '-' : `${Math.round(x * 100)}%`);
    log(`精度(test ${testRows.length}社・陽性50%): 未導入精度 ${pct(ev.未導入精度)}／導入済精度 ${pct(ev.導入済精度)}／導入済再現 ${pct(ev.導入済再現)}／判定率 ${pct(ev.判定率)}`);
    log(`  実母集団(ATS保有率${(baseRate * 100).toFixed(1)}%)に引き直した未導入判定の精度: ${pct(ev.adjust(baseRate))}`);
    lines.push('', `## 精度検証（test ${testRows.length}社・学習に使っていない企業）`, '');
    lines.push('真値はBALES自己申告（架電時点）。サイトは現在時点なので、申告後に導入した企業は「誤り」に見える点に注意。', '');
    lines.push('| 真値＼判定 | 導入済 | 未導入 | 要確認 | 不明 |');
    lines.push('|---|---|---|---|---|');
    for (const t of ['導入済', '未導入']) {
      lines.push(`| ${t} | ${ev.cm[`${t}|導入済`] || 0} | ${ev.cm[`${t}|未導入`] || 0} | ${ev.cm[`${t}|要確認`] || 0} | ${ev.cm[`${t}|不明`] || 0} |`);
    }
    lines.push('', `- 未導入と判定した時の正しさ（test母集団=陽性50%）: ${pct(ev.未導入精度)}`);
    lines.push(`- 導入済と判定した時の正しさ: ${pct(ev.導入済精度)}（＝除外し過ぎていないか）`);
    lines.push(`- ATS保有社を除外できた率（再現）: ${pct(ev.導入済再現)}`);
    lines.push(`- 判定率（導入済/未導入まで言い切れた割合）: ${pct(ev.判定率)}`);
    lines.push('', '### 実母集団に引き直した精度', '');
    lines.push('test は陽性・陰性を半々にしてある（ロジックを比較するため）。実際のリード母集団の');
    lines.push(`ATS保有率は自社ラベル実測で **${(baseRate * 100).toFixed(1)}%**（陽性${posN}社 / 陰性${negN}社）なので、`);
    lines.push('素の数字をそのまま「30,290社に適用した時の精度」と読むと大きく過小評価になる。');
    lines.push('条件付き率（下表）は母集団に依存しないので、そこから引き直す。', '');
    lines.push('| 条件付き率 | 値 |');
    lines.push('|---|---|');
    lines.push(`| 真の未導入社を「未導入」と言えた率 | ${pct(ev.未導入率given未導入)} |`);
    lines.push(`| ATS保有社を誤って「未導入」と言った率 | ${pct(ev.未導入率given導入済)} |`);
    lines.push('', '| 母集団のATS保有率 | 「未導入」判定の精度 |');
    lines.push('|---|---|');
    for (const b of [baseRate, 0.05, 0.1, 0.2, 0.3, 0.5]) {
      lines.push(`| ${(b * 100).toFixed(1)}%${Math.abs(b - baseRate) < 1e-9 ? '（自社ラベル実測）' : ''} | ${pct(ev.adjust(b))} |`);
    }
    lines.push('', `→ 実母集団（保有率${(baseRate * 100).toFixed(1)}%）では **未導入判定の精度は ${pct(ev.adjust(baseRate))}** と読む。`);
    lines.push('ただしBALESが触った母集団と統合マスタ全体が同じ保有率とは限らない点は留保。');
    if (ev.errs.length) {
      lines.push('', '### 誤判定サンプル（辞書を育てる材料）', '', '| 企業 | 真値 | 判定 | 申告 | entry_type | host | 根拠 |', '|---|---|---|---|---|---|---|');
      for (const e of ev.errs) lines.push(`| ${e.name} | ${e.truth} | ${e.got} | ${e.label} | ${e.entry_type} | ${e.host || '-'} | ${e.根拠.replace(/\|/g, '/')} |`);
    }
    const dist = typeDistribution(testRows, dict);
    lines.push('', '## entry_type 分布（test）', '', '| 判定／entry_type | 社数 |', '|---|---|');
    for (const [k, v] of dist) lines.push(`| ${k} | ${v} |`);
  }
  safeWrite(REPORT, lines.join('\n'));
  log(`レポート: ${path.relative(ROOT, REPORT)}`);
  await closeBrowser().catch(() => {});
}

if (require.main === module) run().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
module.exports = { clusterFingerprints, evaluate, buildLabeledPool, normVendorLabel, stratify };
