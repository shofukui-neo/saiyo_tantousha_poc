'use strict';
/**
 * 採用担当者名ハーベスタ＋（クロスソース融合版・マイナビ以外の実績WEB源を横断）
 * ============================================================================
 * harvest-named.js（first-hit-wins カスケード）の上位互換。名前を取れる確率を上げる。
 *
 * 何が違うか:
 *   従来: 1社につき「自社ページ→インタビュー記事」を順に試し、最初の1件で確定。
 *   本版: 1社につき “実績のあるWEB源” を横断して候補を全部集め、name-fusion.js で
 *         クロス検証・信頼度重み・辞書検証を効かせて最良を1件に融合する。
 *
 * 候補源（いずれもマイナビ以外・取得実績あり）:
 *   A) 事前候補（オフライン・即時）: 既存の実績CSVから社名一致で候補を引く。
 *        - Wantedly           data/recruiter-wantedly.csv         （実測 yield ~98%）
 *        - PR TIMES問合せ先   data/leads-prtimes-named-1000.csv   （ラベル付き実名）
 *        - テック媒体         sources/T-tech-names.csv            （GitHub/connpass 実名）
 *        - 既取得アクティブ   data/recruiter-active.csv           （自社ページ等の過去取得）
 *      ※ 取得元/取得手法に「マイナビ」を含む行は方針により除外。
 *   B) ライブ探索（--live 指定時のみ・オンライン）:
 *        - 自社採用ページ深掘り probeRecruitPage
 *        - Webインタビュー記事   probeInterview
 *      事前候補と同じ共通形で pool に足し、事前候補と一致すれば確度が跳ね上がる。
 *
 *   node src/harvest-named-plus.js --in data/leads-recruiter-acquired-1000.csv \
 *        --out data/recruiter-fused.csv                 # オフライン融合（速い）
 *   node src/harvest-named-plus.js --in <list> --out <out> --live --limit 100   # ライブ探索も併用
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, normCompanyName } = require('./csv');
const { fuseCandidates } = require('./name-fusion');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
const IN = getArg('in', path.join('data', 'leads-recruiter-acquired-1000.csv'));
const OUT = getArg('out', path.join('data', 'recruiter-fused.csv'));
const LIMIT = parseInt(getArg('limit', '0'), 10) || 0;
const THRESHOLD = parseFloat(getArg('threshold', '0.62')) || 0.62;
const LIVE = process.argv.includes('--live');
// gBiz主経路モード: 全社にgBizINFOで代表者名(実測93%)を高速付与。--liveと併用ならweb+GeminiがHR名を上乗せ。
//   単独(--gbiz-firstのみ)なら web-crawl不要の速い代表者名パス。
const GBIZ_FIRST = process.argv.includes('--gbiz-first');
const CONCURRENCY = Math.max(1, parseInt(getArg('concurrency', '3'), 10) || 3);
const PER_COMPANY_MS = parseInt(getArg('company-timeout', '120000'), 10) || 120000;

function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }
function pick(rec, keys) { for (const k of keys) if (rec[k]) return rec[k]; return ''; }
const isMynavi = (s) => /マイナビ|mynavi/i.test(String(s || ''));

// ── 事前候補源の定義（列マッピング）。マイナビ由来行は除外する。──────────────
const PRIOR_SOURCES = [
  { file: 'data/recruiter-wantedly.csv',        name: '採用担当者名', conf: '確度',      src: () => 'Wantedly',            role: '役職', dept: '部署', url: '根拠URL', ev: '根拠' },
  { file: 'data/leads-prtimes-named-1000.csv',  name: '採用担当者名', conf: null,        src: () => 'PR TIMES問合せ先',    role: '役職', dept: '',     url: '根拠URL', ev: '' },
  { file: 'sources/T-tech-names.csv',           name: '氏名',        conf: '確度',      src: () => 'テック媒体',           role: '役職', dept: '',     url: '根拠URL', ev: '所属/根拠' },
  { file: 'data/recruiter-active.csv',          name: '採用担当者名', conf: '担当者確度', src: (r) => r['取得元'] || r['取得手法'] || '自社採用ページ', role: '役職', dept: '部署', url: '根拠URL', ev: '根拠' },
];

// 事前候補をロードし、社名キー → 候補配列 の索引を作る。
function loadPriors() {
  const index = new Map(); // normCompanyName -> [candidate]
  let loaded = 0, files = 0;
  for (const s of PRIOR_SOURCES) {
    const abs = path.resolve(s.file);
    if (!fs.existsSync(abs)) { log(`  （事前候補スキップ: ${s.file} が無い）`); continue; }
    let recs = [];
    try { recs = readCsv(fs.readFileSync(abs, 'utf8')).records; } catch (_) { continue; }
    files++;
    let n = 0;
    for (const r of recs) {
      const nm = (r[s.name] || '').trim();
      if (!nm) continue;
      const sourceLabel = s.src(r);
      if (isMynavi(sourceLabel) || isMynavi(r['取得手法'])) continue; // マイナビ以外に限定
      const key = normCompanyName(r['企業名']);
      if (!key) continue;
      const cand = {
        name: nm,
        confidence: s.conf && r[s.conf] ? Number(r[s.conf]) || undefined : undefined,
        role: s.role ? (r[s.role] || '') : '',
        department: s.dept ? (r[s.dept] || '') : '',
        sourceUrl: s.url ? (r[s.url] || '') : '',
        evidence: s.ev ? (r[s.ev] || '') : '',
        source: sourceLabel,
      };
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(cand);
      n++; loaded++;
    }
    log(`  事前候補ロード: ${s.file} → ${n}件`);
  }
  log(`事前候補 合計 ${loaded}件（${files}ファイル・ユニーク社 ${index.size}）`);
  return index;
}

// ライブ探索（任意）。求人媒体・Wantedly以外の3経路を横断し、事前候補と同じ共通形で候補を返す。
//   ① 公式HP深掘り（probeRecruitPage）② インタビュー記事（probeInterview）
//   ③ SNS/オウンドメディア/代表メッセージ（probeSocial・複数候補）
async function liveProbes(company, url) {
  const out = [];
  const { discoverUrl } = require('./search');
  const { probeRecruitPage, visibleText } = require('./probe-recruit-page');
  const { probeInterview } = require('./probe-interview');
  const { probeSocial } = require('./probe-social');
  const { politeGet } = require('./polite');

  // 公式URLが無ければ検索で発見（SNS/HP深掘りの発火に必要）。
  let officialUrl = url;
  if (!officialUrl && !process.argv.includes('--no-discover')) {
    try {
      const deps = { fetchPage: async (u) => { const r = await politeGet(u, { render: 'static' }); return { html: (r && r.html) || '', finalUrl: (r && r.finalUrl) || u }; },
        extractText: (h) => visibleText(h || '') };
      const d = await discoverUrl(company, deps, {});
      if (d && d.url) officialUrl = d.url;
    } catch (_) {}
  }
  // ① 公式HP 深掘り（検索非依存・主経路）: 採用/代表/社員/インタビュー/note を横断
  if (officialUrl) {
    let deepGotName = false;
    try {
      const { probeSiteDeep } = require('./probe-site-deep');
      const deep = await probeSiteDeep(company, officialUrl, { maxPages: 8 });
      for (const c of deep) if (c && c.name) { out.push(c); deepGotName = true; }
    } catch (_) {}
    // 補助: 採用ページ特化プローブ（自己名乗り等の強パターン）。
    //   実測(exp9・30社)で probeSiteDeep が取れた社では固有の追加名は0だったため、
    //   深掘りが空振りした社に限ってフォールバック起動＝リコール維持のまま実行時間を約半減。
    if (!deepGotName) {
      try { const r = await probeRecruitPage(officialUrl, { companyName: company });
        if (r && r.name) out.push({ ...r, source: r.source || '自社採用ページ' }); } catch (_) {}
    }
  }
  // ② インタビュー記事（検索起点・環境により不安定。best-effort）
  if (!process.argv.includes('--no-search')) {
    try { const iv = await probeInterview(company);
      if (iv && iv.name) out.push({ ...iv, source: iv.source || 'Webインタビュー記事/採用ブログ' }); } catch (_) {}
    // ③ SNS/オウンドメディア/代表メッセージ（検索起点・best-effort）
    try { const soc = await probeSocial(company);
      for (const c of soc) if (c && c.name) out.push(c); } catch (_) {}
  }
  return out;
}

// gBizINFO 代表者名フォールバック（Gemini非依存・公的データ）。
//   Web深掘り等で氏名が全く取れなかった社に限り、検索→法人番号→詳細で代表者名を補う。
//   実測(2026-07-05): Web空振り社でも詳細エンドポイント(gbizGet)は代表者名をほぼ返す＝カバレッジの底上げ。
//   ※検索listには代表者名が無く詳細のみ。web-crawlのcompany-timeoutに食われないよう processOne 側で
//     タイムアウトの外から呼ぶ（inlineだと web が90s使い切りgBizに到達しない事があった）。
// gBizの代表者名は肩書きが接着することが多い（「代表取締役社長　山田拓郎」「代表取締役　佐藤花子」）。
// 先頭の肩書きトークンを長い順にループで剥がす（「代表取締役+名前」＝社長/会長サフィックス無しにも対応）。
const GBIZ_TITLE_RE = /^(代表取締役社長|代表取締役会長|代表取締役|代表執行役員|代表執行役|取締役社長|取締役会長|取締役|代表社員|業務執行社員|執行役員|理事長|副理事長|理事|代表理事|会頭|頭取|代表者|会長|社長|副社長|副会長|専務|常務|CEO|COO|CFO|代表|兼|及び|・)[ 　]*/i;
function stripGbizTitle(raw) {
  let s = String(raw || '').replace(/[　\s]+/g, ' ').trim();
  for (let i = 0; i < 4 && GBIZ_TITLE_RE.test(s); i++) s = s.replace(GBIZ_TITLE_RE, '').trim();
  return s.replace(/[ 　]+/g, ' ').trim();
}

// corporateNumber を渡せば gbizGet 直取り（名前検索のミスマッチ回避・API半減・ほぼ100%）。
// 無ければ名前検索→正規化名の完全一致で法人番号を解決してから詳細取得。
async function gbizRepFallback(company, corporateNumber) {
  if (process.argv.includes('--no-gbiz')) return null;
  try {
    const cfg = require('./config');
    const { gbizAvailable, gbizSearch, gbizGet } = require('./gbiz');
    if (!gbizAvailable(cfg)) return null;
    let cn = String(corporateNumber || '').replace(/\D/g, '');
    let matchNote = '(法人番号直取り)';
    if (cn.length !== 13) {
      // 法人番号が無い時のみ名前検索（一般社名は複数ヒット→正規化名の完全一致を優先、無ければ先頭）
      const hits = await gbizSearch({ name: company, limit: 5 }, cfg);
      if (!hits.length) return null;
      const key = normCompanyName(company);
      const exact = hits.find((h) => normCompanyName(h.name) === key);
      cn = (exact || hits[0]).corporateNumber;
      matchNote = exact ? '(完全一致)' : '(名前検索)';
    }
    if (!cn) return null;
    const d = await gbizGet(cn, cfg);
    if (!d || !d.representativeName) return null;
    const rep = stripGbizTitle(d.representativeName);   // 肩書き接着を剥がす
    if (!rep || rep.length < 2) return null;
    return { name: rep, role: '代表', department: '', confidence: 0.7,
      evidence: 'gBizINFO 法人番号' + cn + matchNote, source: 'gBizINFO(代表者名)', engine: 'gbiz',
      sourceUrl: 'https://info.gbiz.go.jp/hojin/ichiran?hojinBango=' + cn, 法人番号: cn };
  } catch (_) { return null; }
}
function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(onTimeout()), ms);
    Promise.resolve(promise).then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(onTimeout()); });
  });
}

async function run() {
  const priors = loadPriors();
  const text = fs.readFileSync(path.resolve(IN), 'utf8');
  let { records } = readCsv(text);
  if (LIMIT) records = records.slice(0, LIMIT);
  log(`対象 ${records.length}社 ｜ 融合しきい値 ${THRESHOLD} ｜ ライブ探索 ${LIVE ? 'ON' : 'OFF'}`);

  const headers = ['企業名', '法人番号', '採用担当者名', '融合確度', '一致ソース数', 'クロス検証',
    '寄与ソース', '役職', '部署', '根拠URL', '根拠', '公式URL', '取得日'];
  const OUTABS = path.resolve(OUT);
  fs.mkdirSync(path.dirname(OUTABS), { recursive: true });
  const out = [];
  const today = new Date().toISOString().slice(0, 10);

  const stats = { named: 0, agreed: 0, fromPool: 0, liveAdded: 0 };
  let idx = 0;

  async function processOne(rec) {
    const company = pick(rec, ['企業名', 'company_name', '会社名']);
    if (!company) return;
    const url = pick(rec, ['公式URL', 'official_url', 'url']);
    const key = normCompanyName(company);
    const pool = (priors.get(key) || []).slice();
    const priorCount = pool.length;

    const corpNum = pick(rec, ['法人番号', 'corporate_number', 'corporateNumber']);
    // gBiz主経路: 全社に代表者名を付与（法人番号があれば直取りでほぼ100%）。web-crawlより速く確実なので先に取る。
    if (GBIZ_FIRST) {
      const g = await withTimeout(gbizRepFallback(company, corpNum), 20000, () => null);
      if (g) { pool.push(g); stats.gbizAdded = (stats.gbizAdded || 0) + 1; }
    }
    if (LIVE) {
      const live = await withTimeout(liveProbes(company, url), PER_COMPANY_MS, () => []);
      if (live.length) { pool.push(...live); stats.liveAdded += live.length; }
      // gBiz主経路でないときは、web が全く氏名を出せなかった社のみ gBiz でフォールバック（タイムアウト外）。
      if (!GBIZ_FIRST && !pool.some((c) => c && c.name)) {
        const g = await withTimeout(gbizRepFallback(company, corpNum), 20000, () => null);
        if (g) { pool.push(g); stats.gbizAdded = (stats.gbizAdded || 0) + 1; }
      }
    }

    const { best, groups } = fuseCandidates(pool, { threshold: THRESHOLD });
    if (best) {
      stats.named++;
      if (best.agreement) stats.agreed++;
      // プール最良の効用: 候補が2件以上あり、確度最上位を選べた社
      if (pool.length >= 2) stats.fromPool++;
    }
    out.push({
      企業名: company, 法人番号: pick(rec, ['法人番号', 'corporate_number']),
      採用担当者名: best ? best.name : '',
      融合確度: best ? best.confidence : '',
      一致ソース数: best ? best.sourceCount : (groups.length ? 0 : ''),
      クロス検証: best && best.agreement ? '○' : '',
      寄与ソース: best ? best.sources.join(' / ') : '',
      役職: best ? best.role : '', 部署: best ? best.department : '',
      根拠URL: best ? best.sourceUrls.join(' ') : '',
      根拠: best ? best.evidence : '',
      公式URL: url, 取得日: today,
    });
    void priorCount;
  }

  const flush = () => { const tmp = OUTABS + '.tmp'; fs.writeFileSync(tmp, toCsv(headers, out)); fs.renameSync(tmp, OUTABS); };

  if (LIVE) {
    // ライブは並列（ホスト別に politeGet が直列化）
    async function worker() {
      while (true) {
        const my = idx++; if (my >= records.length) return;
        await processOne(records[my]);
        if (out.length % 5 === 0) { flush(); log(`  ${out.length}/${records.length}（氏名 ${stats.named}／一致 ${stats.agreed}）`); }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  } else {
    for (const rec of records) { await processOne(rec); }
  }
  flush();

  const total = out.length;
  log('──────── 融合結果 ────────');
  log(`氏名取得 ${stats.named}/${total}社（${(100 * stats.named / Math.max(1, total)).toFixed(1)}%）`);
  log(`うちクロス検証一致（独立2源以上が同一氏名）: ${stats.agreed}社 ＝ 高確度`);
  log(`うちプール最良を選択（候補2件以上）: ${stats.fromPool}社`);
  if (LIVE) log(`ライブ探索で追加した候補: ${stats.liveAdded}件`);
  if (LIVE) log(`gBizINFO代表者名フォールバックで補完: ${stats.gbizAdded || 0}社`);
  log(`出力: ${OUTABS}`);
}

// スクリプトとして起動された時のみ実行（require時に副作用でパイプラインが走らないようガード）。
if (require.main === module) {
  run().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
}

module.exports = { stripGbizTitle, gbizRepFallback, liveProbes };
