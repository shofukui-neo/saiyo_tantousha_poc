'use strict';
/**
 * 全新卒媒体 × ICP適合 × 採用6名以上 × 接触50名以上 × インテント重視 ── 10,000社 → BALES取込形式
 * ============================================================================
 * マイナビだけに頼らず、列挙できる新卒媒体の掲載企業を1つの母集団に束ねる:
 *   マイナビ（28卒/27卒 再列挙＋会社概要） / キャリタス就活（全掲載・企業ページ＋本選考詳細）
 *   / リクナビ（sitemap全社・企業ページの埋め込みJSON） / あさがくナビ（sitemap全社）
 * 収集は src/allmedia/*.js、ここは「名寄せ → 属性の確定 → ゲート → 採点 → 並べ替え → 出力」だけを持つ。
 *
 * ── 絶対条件（ゲート）──────────────────────────────────────────
 *   ① 採用人数6名以上 … 媒体に載る**実績**（若者雇用促進法の過去3年採用者数）の最新年。
 *                       実績が無い社は 予定人数 → CRMヒアリング値 の順（--hire-basis で許容範囲を決める）
 *   ② 接触人数50名以上 … 公開媒体に一次情報が無いので「実測があれば実測、無ければ推定」:
 *                       実測 = BALESのエントリー数 / キャリタスのフォロワー数（その社をフォローした学生数）
 *                       推定 = 採用人数 × 15.4（社内実測51件の 採用1名あたりエントリー数の中央値）
 *                       BALESで「接触人数不足」「接触人数が30人以下」と記録済みの社は除外（判明して下回る）
 *   ③ ICP（icp-rules.js）… 非IT／官公庁でない／従業員100名以上（判明していて下回る社だけ落とす）
 *   ④ 架電禁止リスト・MOCHICA既存顧客・BALESアプローチ禁止 は無条件除外。電話番号が無い社も出さない。
 *
 * ── 並べ替え（ICP適合 × インテント）────────────────────────────
 *   総合優先度 = combineWithFit(インテントスコア, ICPスコアv5) = 0.55×インテント + 0.45×ICP（score.js の既定）
 *   インテントは intent-analyze の観測（マイナビ各面・21軸）＋ 他媒体の構造値から立つシグナル
 *   （採用実績の前年比増・インターン件数・合説出展・追加募集文言・採用専用メール）を同じ scoreIntent で採点。
 *
 * ── 出力 ──────────────────────────────────────────────────────
 *   data/leads-allmedia-10000.csv            … 詳細（根拠・出所つき）
 *   data/leads-bales-allmedia-new.csv        … BALES未登録＝そのまま新規取込できる266列
 *   data/leads-bales-allmedia-existing.csv   … BALES登録済＝システム管理情報：ID 付き（更新取込用）
 *   data/leads-allmedia-10000-report.md      … ファネル・分布・注意点
 *
 * 使い方: node --max-old-space-size=6144 src/build-allmedia-10000.js [--target 10000] [--hire-basis 実績|予定|ヒアリング]
 *         [--intent data/leads-intent-wide.csv,data/leads-allmedia-intent.csv] [--dump-pool data/allmedia/pool.csv]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readCsv, toCsv, parseCsv } = require('./csv');
const { normalizeJpPhone } = require('./phone');
const { parseEmployees, scoreMochica } = require('./mochica-fit');
const { ICP, isExcludedIndustry, isGovernmentOrg, classifyOrgType } = require('./icp-rules');
const ng = require('./ng-guard');
const { mkey, cleanDisplay } = require('./build-icp-fresh-1000');
const { SIGNALS, parseHireSeries, detectHirePlanIncrease, detectInternship, detectExpo, detectSecondaryRecruit, detectRecruitEmail } = require('./intent/signals');
const { scoreIntent, combineWithFit, talkGuide, whyNow } = require('./intent/score');
const { loadLedger, isDelivered } = require('./delivered-ledger');
const { isPlausiblePersonName } = require('./jp-names');

const ROOT = path.resolve(__dirname, '..');
const D = (p) => path.join(ROOT, 'data', p);
const getArg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const TARGET = parseInt(getArg('target', '10000'), 10);
const HIRE_BASIS = getArg('hire-basis', 'ヒアリング'); // 実績 | 予定 | ヒアリング（右ほど緩い）
const HIRE_RULE = getArg('hire-rule', 'avg3');        // latest（最新年の実績のみ）| avg3（最新年が谷なら直近3年平均・既定）
const FILL_EMP_MIN = parseInt(getArg('fill-emp-min', '50'), 10); // 準適合（目標に届かない時の補充）の従業員下限
const INTENT_FILES = getArg('intent', 'data/leads-intent-wide.csv').split(',').map((s) => s.trim()).filter(Boolean);
const OUT = path.resolve(ROOT, getArg('out', 'data/leads-allmedia-10000.csv'));
const DUMP_POOL = getArg('dump-pool', '');
const NOW = new Date();
const pad2 = (n) => String(n).padStart(2, '0');
// 日付は現地時刻（JST）で書く。toISOString はUTCなので深夜帯に前日の日付になる。
const TODAY = `${NOW.getFullYear()}-${pad2(NOW.getMonth() + 1)}-${pad2(NOW.getDate())}`;

// 接触人数の推定倍率（BALES エントリー数×採用人数帯 51件の実測。2026-10-15 較正）
const CONTACT_RATIO_MED = 15.4;
const CONTACT_RATIO_P25 = 8.3;
const CONTACT_MIN = ICP.ENTRY_MIN; // 50

const log = (m) => console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const g = (r, k) => String(r && r[k] != null ? r[k] : '').trim();
const readJson = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {});
const num = (v) => { const n = parseInt(String(v == null ? '' : v).replace(/[,，]/g, ''), 10); return Number.isFinite(n) ? n : null; };

const PREFS = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'];
const prefsIn = (s) => { const t = String(s || ''); return PREFS.filter((p) => t.includes(p)); };
const cleanAddr = (s) => String(s || '').replace(/\s*MAP\s*$/, '').replace(/^〒?\s*\d{3}-?\d{4}\s*/, '').trim();
const firstSeg = (s) => String(s || '').split(/[｜|／/]/)[0].trim();

// ============================================================================
// 1. 名寄せの器
// ============================================================================
// 同名別社（「株式会社サンエイ」が県違いで複数）を混ぜないよう、本社県が両方判明していて交わらない時は別エンティティ。
const byKey = new Map();
const entities = [];
function entityFor(name, prefHint) {
  const k = mkey(name);
  if (!k) return null;
  const pf = prefsIn(prefHint);
  const list = byKey.get(k) || [];
  let e = list.find((x) => !pf.length || !x.prefs.size || pf.some((p) => x.prefs.has(p)));
  if (!e) {
    e = { key: k, prefs: new Set(), src: {}, names: new Set() };
    list.push(e); byKey.set(k, list); entities.push(e);
  }
  for (const p of pf) e.prefs.add(p);
  e.names.add(String(name).trim());
  return e;
}

// ============================================================================
// 2. 媒体ソースの読み込み
// ============================================================================
function loadMynavi() {
  // 2-1. 掲載中のcorpID（再列挙版＝今の掲載。旧版は過去に掲載していた社の補完）
  const listed = new Map(); // corpID -> Set(卒年)
  const corp = [['allmedia/mynavi-28-corpus.csv', '28', true], ['allmedia/mynavi-27-corpus.csv', '27', true],
    ['mynavi-2028-corpus.csv', '28', false], ['mynavi-2027-corpus.csv', '27', false]];
  const fresh = { 28: 0, 27: 0 };
  for (const [rel, gy, isNew] of corp) {
    const f = D(rel); if (!fs.existsSync(f)) continue;
    for (const r of readCsv(fs.readFileSync(f, 'utf8')).records) {
      const id = g(r, 'corpID'); if (!id) continue;
      if (!listed.has(id)) listed.set(id, { years: new Set(), current: new Set(), name: g(r, '企業名') });
      listed.get(id).years.add(gy);
      if (isNew) { listed.get(id).current.add(gy); fresh[gy]++; }
    }
  }
  log(`  マイナビ corpus: ${listed.size}社（今回の再列挙 28卒${fresh[28]}・27卒${fresh[27]}）`);

  // 2-2. 会社概要（新しい検証を優先）
  const outline = new Map();
  for (const r of Object.values(readJson(D('fresh-verify.json')))) if (r && r.ok && r.corpID) outline.set(String(r.corpID), { ...r, _src: 'fresh-verify(2026-09)' });
  for (const r of Object.values(readJson(D('allmedia/mynavi-verify.json')))) if (r && r.ok && r.corpID) outline.set(String(r.corpID), { ...r, _src: 'mynavi-verify(2026-10)' });

  // 2-3. インテント観測（最新観測日を優先）
  const intent = new Map();
  for (const rel of INTENT_FILES) {
    const f = path.resolve(ROOT, rel); if (!fs.existsSync(f)) { log(`  (インテント台帳なし: ${rel})`); continue; }
    const { records } = readCsv(fs.readFileSync(f, 'utf8'));
    let n = 0;
    for (const r of records) {
      const id = g(r, 'corpID') || ((g(r, '採用ページURL') + ' ' + g(r, '根拠URL一覧')).match(/corp(\d+)\//) || [])[1] || '';
      const key = id ? 'c' + id : 'n' + mkey(g(r, '企業名'));
      const old = intent.get(key);
      if (old && g(old, '観測日') > g(r, '観測日')) continue;
      intent.set(key, {
        企業名: g(r, '企業名'), corpID: id, 電話番号: g(r, '電話番号'), 業種: g(r, '業種'), 従業員数: g(r, '従業員数'), 本社: g(r, '本社'),
        卒年: g(r, '卒年'), 採用担当者名: g(r, '採用担当者名'), メール: g(r, 'メール'),
        採用実績: g(r, '採用実績(直近3年)'), 募集最新: g(r, '募集人数(最新卒年)'), 募集前年: g(r, '募集人数(前卒年)'),
        採用ページURL: g(r, '採用ページURL'), 公式URL: g(r, '公式URL'), ATS判定: g(r, 'ATS判定'), ATS確度: g(r, 'ATS確度'),
        エントリー動線: g(r, 'エントリー動線'), 観測日: g(r, '観測日'), 内訳: g(r, 'シグナル内訳JSON'), 元スコア: g(r, 'インテントスコア'),
      });
      n++;
    }
    log(`  インテント台帳 ${path.relative(ROOT, f)}: ${n}社`);
  }

  // 2-4. corpID 単位でまとめてエンティティへ
  const ids = new Set([...listed.keys(), ...outline.keys(), ...[...intent.values()].map((x) => x.corpID).filter(Boolean)]);
  let n = 0;
  for (const id of ids) {
    const o = outline.get(id) || {};
    const it = intent.get('c' + id) || {};
    const ls = listed.get(id) || { years: new Set(), current: new Set(), name: '' };
    const name = cleanDisplay(o.企業名 || it.企業名 || ls.name);
    if (!name) continue;
    const e = entityFor(name, o.本社 || it.本社);
    if (!e) continue;
    e.src.mynavi = {
      corpID: id, 企業名: name, 業種: o.業種 || it.業種 || '', 従業員数: o.従業員数 || it.従業員数 || '',
      本社: o.本社 || it.本社 || '', 電話: normalizeJpPhone(o.電話番号 || it.電話番号 || '') || '',
      実績: o.実績3年 || it.採用実績 || '', 募集最新: it.募集最新, 募集前年: it.募集前年,
      卒年面: [...ls.years].sort().join('/'), 現掲載: [...ls.current].sort().join('/'),
      url: o.url || ('https://job.mynavi.jp/' + ([...ls.years].sort().pop() || '28') + '/pc/search/corp' + id + '/outline.html'),
      公式URL: it.公式URL || '', 採用担当者名: it.採用担当者名 || '', メール: it.メール || '',
      ATS判定: it.ATS判定 || '', ATS確度: it.ATS確度 || '', 内訳: it.内訳 || '', 観測日: it.観測日 || '', 検証: o._src || (it.観測日 ? 'intent台帳' : 'corpusのみ'),
    };
    n++;
  }
  // corpID を持たないインテント行（公式URLのみの社）も拾う
  for (const [key, it] of intent) {
    if (!key.startsWith('n')) continue;
    const e = entityFor(it.企業名, it.本社); if (!e || e.src.mynavi) continue;
    e.src.site = { 企業名: it.企業名, 業種: it.業種, 従業員数: it.従業員数, 本社: it.本社, 電話: normalizeJpPhone(it.電話番号) || '', 実績: it.採用実績, 公式URL: it.公式URL, 内訳: it.内訳, 観測日: it.観測日, 採用担当者名: it.採用担当者名, メール: it.メール, ATS判定: it.ATS判定 };
  }
  log(`  マイナビ: ${n}社をエンティティ化`);
}

function loadCareertasu() {
  const list = readJson(D('allmedia/careertasu-list.json'));
  const corp = readJson(D('allmedia/careertasu-corp.json'));
  const det = readJson(D('allmedia/careertasu-detail.json'));
  const cards = new Map();
  for (const arr of Object.values(list)) for (const c of arr) if (!cards.has(c.id)) cards.set(c.id, c);
  let n = 0;
  for (const [id, c] of cards) {
    const r = corp[id] && !corp[id].失敗 ? corp[id] : {};
    const name = r.企業名 || c.企業名;
    const e = entityFor(name, r.本社所在地 || r.本社県 || c.本社県);
    if (!e) continue;
    const d = det[id] && !det[id].失敗 ? det[id] : {};
    e.src.careertasu = {
      id, 企業名: name, 業種: r.業種 || c.業種 || '', 従業員数: r.従業員数 || '', 本社: cleanAddr(r.本社所在地) || r.本社県 || c.本社県 || '',
      上場: r.上場区分 || '', フォロワー: r.フォロワー != null ? r.フォロワー : c.フォロワー,
      実績: (r.採用実績 || []).map((x) => x.年 + '年' + x.人数 + '名').join('/'),
      予定: d.採用予定数 != null ? d.採用予定数 : null, 昨年度実績: d.昨年度実績 != null ? d.昨年度実績 : null,
      電話: d.電話 || '', メール: d.メール || '', 最終更新日: r.最終更新日 || '',
      インターン件数: r.インターン件数 || 0, 説明会件数: r.説明会件数 || 0, 本選考件数: r.本選考件数 || 0, 合説: !!r.合説出展,
      本文: d.本文 || '', 企業ページ取得: !!r.企業名, ページ種別: r.ページ種別 || '',
      url: 'https://job.career-tasu.jp/corp/' + id + (r.ページ種別 === '簡易掲載' ? '/default/' : '/'),
    };
    // 簡易掲載（企業DBに基本情報だけ）で募集も説明会もインターンも無い社は「いま新卒を掲載している」証拠にしない
    e.src.careertasu.掲載中 = !(r.ページ種別 === '簡易掲載' && !(r.インターン件数 || r.説明会件数 || r.本選考件数));
    n++;
  }
  log(`  キャリタス: 一覧 ${cards.size}社（企業ページ ${Object.keys(corp).length}・本選考詳細 ${Object.keys(det).length}）→ ${n}社`);
}

function loadRikunabi() {
  const j = readJson(D('allmedia/rikunabi.json'));
  let n = 0;
  for (const r of Object.values(j)) {
    if (!r || r.失敗) continue;
    const e = entityFor(r.企業名, r.本社所在地); if (!e) continue;
    e.src.rikunabi = { ...r, 電話: r.電話番号 || '', 本社: r.本社所在地 || '' };
    n++;
  }
  log(`  リクナビ: ${n}社`);
}

function loadGakujo() {
  const j = readJson(D('allmedia/gakujo.json'));
  let n = 0;
  for (const r of Object.values(j)) {
    if (!r || r.失敗) continue;
    const name = cleanDisplay(r.企業名);
    const e = entityFor(name, r.本社所在地); if (!e) continue;
    e.src.gakujo = { ...r, 企業名: name, 本社: cleanAddr(r.本社所在地) };
    n++;
  }
  log(`  あさがくナビ: ${n}社`);
}

// ============================================================================
// 3. CRM・除外索引（名寄せキーで当てる）
// ============================================================================
const PENDING_BLOCK = new Map([
  ['接触人数が30人以下', '接触人数<50(BALES記録:接触人数30人以下)'],
  ['採用人数が1~2名', '採用人数<6(BALES記録:1~2名)'],
  ['新卒やってない', '新卒採用なし(BALES記録)'],
  ['セキュリティor会社の方針でLINE NG', 'LINE利用NG(BALES記録)=MOCHICA提案不可'],
  ['従業員数49名以下', '従業員49名以下(BALES記録)'],
]);
const BAND_LOW = { '1～2名': 1, '3～5名': 3, '6～10名': 6, '11～15名': 11, '16～20名': 16, '21～25名': 21, '26～30名': 26, '31～35名': 31, '36～40名': 36, '41～45名': 41, '46～50名': 46, '51～100名': 51, '101～200名': 101, '201～300名': 201, '301名～': 301 };
function loadCrm() {
  const crm = { bales: new Map(), sf: new Map(), mochica: new Set(), master: new Map() };
  const bf = D('BALESCLOUDの既存リスト - 202607062007_leadList_utf-8.csv');
  const bales = readCsv(fs.readFileSync(bf, 'utf8'));
  crm.balesHeaders = bales.headers;
  for (const r of bales.records) {
    const k = mkey(g(r, '会社情報：会社名')); if (!k) continue;
    const prev = crm.bales.get(k);
    if (prev && prev.length) { prev.push(r); continue; }
    crm.bales.set(k, [r]);
  }
  const sfRows = parseCsv(fs.readFileSync(D('セールスフォースMOCHICA参照 - 全てのリードSitoke突合用.csv'), 'utf8'));
  let hi = -1; for (let i = 0; i < 30; i++) if (sfRows[i].some((c) => /会社名\s*\/\s*取引先/.test(c))) { hi = i; break; }
  const H = sfRows[hi];
  const ci = (re) => H.findIndex((c) => re.test(String(c)));
  const C = { name: ci(/会社名\s*\/\s*取引先/), tel: ci(/^電話$/), hire: ci(/採用人数/), stat: ci(/リード\s*状況/), emp: ci(/従業員数レンジ/), mail: ci(/^メール$/), ind: ci(/^業種$/) };
  for (let i = hi + 1; i < sfRows.length; i++) {
    const row = sfRows[i]; const k = mkey(row[C.name]); if (!k) continue;
    if (!crm.sf.has(k)) crm.sf.set(k, []);
    crm.sf.get(k).push({ 電話: row[C.tel] || '', 採用人数: row[C.hire] || '', 状況: row[C.stat] || '', 従業員: row[C.emp] || '' });
  }
  for (const r of readCsv(fs.readFileSync(D('MOCHICAの既存顧客リスト - mochica-companies-list.csv'), 'utf8')).records) {
    for (const n of [g(r, '法人名'), g(r, 'LINEアカウント登録企業名')]) { const k = mkey(n); if (k) crm.mochica.add(k); }
  }
  for (const r of readCsv(fs.readFileSync(D('leads-consolidated-all.csv'), 'utf8')).records) {
    const k = mkey(g(r, '企業名')); if (!k) continue;
    if (!crm.master.has(k)) crm.master.set(k, []);
    crm.master.get(k).push({ 法人番号: g(r, '法人番号'), 電話: normalizeJpPhone(g(r, '電話番号')) || '', 公式URL: g(r, '公式URL'), 採用担当者名: g(r, '採用担当者名'), 氏名検証: g(r, '氏名検証'), 部署: g(r, '部署'), 役職: g(r, '役職'), 代表者名: g(r, '代表者名'), 確度: parseFloat(g(r, '担当者確度')) || 0, 県: prefsIn(g(r, '都道府県')) });
  }
  log(`  CRM索引: BALES ${crm.bales.size}社 ／ SF ${crm.sf.size}社 ／ MOCHICA顧客 ${crm.mochica.size} ／ 統合マスタ ${crm.master.size}`);
  return crm;
}

// ============================================================================
// 4. 1社の属性を確定する
// ============================================================================
const MEDIA_ORDER = [['mynavi', 'マイナビ'], ['careertasu', 'キャリタス就活'], ['rikunabi', 'リクナビ'], ['gakujo', 'あさがくナビ']];
const BAND_LABELS = [[301, '301名～'], [201, '201～300名'], [101, '101～200名'], [51, '51～100名'], [46, '46～50名'], [41, '41～45名'], [36, '36～40名'], [31, '31～35名'], [26, '26～30名'], [21, '21～25名'], [16, '16～20名'], [11, '11～15名'], [6, '6～10名'], [3, '3～5名'], [1, '1～2名']];
const bandOf = (n) => { if (n == null) return ''; for (const [lo, lab] of BAND_LABELS) if (n >= lo) return lab; return ''; };
const BASIS_RANK = { 実績: 3, 予定: 2, ヒアリング: 1 };
const NAME_JUNK_RE = /^(が|を|は|に|へ|と|の|も|で)?(聞く|聞き|問い合わせ|問合せ|について|に関する|宛|より|御中|窓口|係|様|さん|氏|殿|担当|採用|人事|総務)$/;
const MEDIA_HOST_RE = /(mynavi.jp|career-tasu.jp|rikunabi.com|gakujo.ne.jp|onecareer.jp|wantedly.com)/i;

function resolve(e, crm) {
  const s = e.src;
  const M = s.mynavi || s.site || null; const C = s.careertasu || null; const R = s.rikunabi || null; const G = s.gakujo || null;
  const live = (k) => s[k] && !(k === 'careertasu' && s[k].掲載中 === false);
  const media = MEDIA_ORDER.filter(([k]) => live(k)).map(([, lab]) => lab);
  const mediaDetail = [];
  if (s.mynavi) mediaDetail.push('マイナビ' + (s.mynavi.現掲載 || s.mynavi.卒年面 ? '(' + (s.mynavi.現掲載 || s.mynavi.卒年面) + '卒)' : ''));
  if (C) mediaDetail.push(live('careertasu') ? 'キャリタス就活' : 'キャリタス(企業DBのみ)');
  if (R) mediaDetail.push('リクナビ'); if (G) mediaDetail.push('あさがくナビ');

  const name = cleanDisplay((M && M.企業名) || (C && C.企業名) || (R && R.企業名) || (G && G.企業名) || [...e.names][0]);
  // CRM（BALES/SF/統合マスタ）は社名キーで当てるが、同じキーの別社（県違いの同名企業）が母集団に複数いる時は
  // 「都道府県が一致」か「電話番号が一致」するレコードだけを当てる。キーだけで当てると、トーカイ〈岐阜〉と
  // トーカイ〈香川〉が同じBALESリード（同じID）を共有し、既存更新ファイルが別会社のリードを書き換えてしまう。
  const ambiguous = (byKey.get(e.key) || []).length > 1;
  const mediaTels = new Set([M && M.電話, C && C.電話, R && R.電話].map((t) => normalizeJpPhone(t || '')).filter(Boolean));
  // 同じ番号帯（末尾2桁だけ違う＝代表と人事直通など）も同一社とみなす。実測: トーカイ 058-263-5111／5112、
  // エイベックス 052-811-1175／1171 は BALES 側の県が誤っていた同一社だった。
  const digits = (t) => String(normalizeJpPhone(t || '') || '').replace(/\D/g, '');
  const mediaDigits = [...mediaTels].map(digits);
  const telHit = (t) => { const d = digits(t); return !!d && mediaDigits.some((m) => m === d || (m.length === d.length && m.length >= 10 && m.slice(0, -2) === d.slice(0, -2))); };
  const prefHit = (txt) => prefsIn(txt).some((p) => e.prefs.has(p));
  const crmB = (crm.bales.get(e.key) || []).filter((r) => !ambiguous || prefHit(g(r, '会社情報：住所：都道府県')) || telHit(g(r, '会社情報：電話')));
  const balesOther = (crm.bales.get(e.key) || []).filter((r) => !crmB.includes(r)).map((r) => g(r, '会社情報：会社名') + '(' + (g(r, '会社情報：住所：都道府県') || '県なし') + '/' + g(r, '会社情報：電話') + ')');
  const crmS = (crm.sf.get(e.key) || []).filter((x) => !ambiguous || telHit(x.電話));
  const mstList = crm.master.get(e.key) || [];
  const mst = (ambiguous ? mstList.find((m) => m.県.some((p) => e.prefs.has(p)) || telHit(m.電話)) : mstList[0]) || {};

  // 業種（主たる業種で判定。キャリタス/あさがくは複数業種を「｜/／」で並べるので先頭）
  const industry = (M && M.業種) || (C && firstSeg(C.業種)) || (R && R.業種) || (G && firstSeg(G.業種)) || '';
  // 従業員数
  const empSrc = [[M && M.従業員数, 'マイナビ'], [C && C.従業員数, 'キャリタス'], [G && G.従業員数, 'あさがくナビ']].find(([v]) => parseEmployees(v) != null);
  let emp = empSrc ? parseEmployees(empSrc[0]) : null; let empFrom = empSrc ? empSrc[1] : '';
  if (emp == null) {
    const sfEmp = crmS.map((x) => x.従業員).find((v) => /(\d+)/.test(v));
    if (sfEmp) { const m = sfEmp.replace(/千/g, '000').replace(/万/g, '0000').match(/(\d+)/); emp = m ? +m[1] : null; empFrom = emp != null ? 'SF従業員数レンジ(下限)' : ''; }
  }
  // 住所（BALESの住所分解のため、県だけでなく番地まである方を選ぶ）
  const addr = [C && C.本社, R && R.本社, G && G.本社, M && M.本社].map(cleanAddr).filter(Boolean).sort((a, b) => b.length - a.length)[0] || [...e.prefs][0] || '';
  // 電話（マイナビ会社概要＝多くは人事課 → キャリタス採用連絡先 → リクナビ代表 → BALES → 統合マスタ → SF）
  // キャリタスの採用連絡先は採用代行（RPO）の窓口番号のことがある（例: ◯◯採用センター＠j-saiyo.com）ので2番手。
  const phones = [
    [M && M.電話, 'マイナビ会社概要'], [C && C.電話, 'キャリタス採用連絡先'], [R && R.電話, 'リクナビ代表電話'],
    ...crmB.map((r) => [normalizeJpPhone(g(r, '会社情報：電話')) || '', 'BALES']), [mst.電話, '統合マスタ'], ...crmS.map((x) => [normalizeJpPhone(x.電話) || '', 'SF']),
  ].filter(([v]) => v && normalizeJpPhone(v));
  const phone = phones.length ? normalizeJpPhone(phones[0][0]) : '';
  const phoneFrom = phones.length ? phones[0][1] : '';

  // 採用人数: 実績（最新年。同年はマイナビ優先）→ 予定 → CRMヒアリング
  const pts = [];
  for (const [src, lab] of [[M, 'マイナビ'], [C, 'キャリタス'], [G, 'あさがくナビ']]) {
    if (!src) continue;
    if (src.実績) for (const p of parseHireSeries(src.実績)) pts.push({ ...p, src: lab });
  }
  if (G && G.前年度実績 != null) pts.push({ 年: (G.予定卒年 || 2027) - 1, 人数: G.前年度実績, src: 'あさがくナビ' });
  const srcRank = { マイナビ: 3, キャリタス: 2, あさがくナビ: 1 };
  const byYear = new Map();
  for (const p of pts) { const o = byYear.get(p.年); if (!o || srcRank[p.src] > srcRank[o.src]) byYear.set(p.年, p); }
  const series = [...byYear.values()].sort((a, b) => b.年 - a.年);
  let hire = null; let hireBasis = ''; let hireFrom = ''; let hireYear = null;
  if (series.length) { hire = series[0].人数; hireYear = series[0].年; hireBasis = '実績'; hireFrom = series[0].src + ' ' + series[0].年 + '年実績'; }
  // --hire-rule avg3: 最新年が6名未満でも直近3年の平均が6名以上なら「年6名以上の採用企業」と見なす
  // （単年の谷で落とさない。例: 2026年5名/2025年8名/2024年7名 → 平均6.7名）。既定は最新年のみ。
  if (HIRE_RULE === 'avg3' && series.length >= 2 && hire != null && hire < ICP.HIRE_MIN) {
    const last3 = series.slice(0, 3);
    const avg = last3.reduce((a, p) => a + p.人数, 0) / last3.length;
    if (avg >= ICP.HIRE_MIN) { hire = Math.round(avg * 10) / 10; hireBasis = '実績'; hireFrom = `${last3[0].src} 直近${last3.length}年平均(${last3.map((p) => p.年 + '年' + p.人数 + '名').join('/')})`; }
  }
  const mynaviPlan = M ? num((String(M.募集最新 || '').match(/\d+/) || [])[0]) : null;
  const plans = [[C && C.予定, 'キャリタス今年度採用予定数'], [G && G.予定人数, 'あさがくナビ採用予定'], [mynaviPlan, 'マイナビ募集人数']].filter(([v]) => v != null && v > 0);
  const plan = plans.length ? plans[0] : null;
  if (hire == null && plan) { hire = plan[0]; hireBasis = '予定'; hireFrom = plan[1]; }
  const hearing = [...crmB.map((r) => g(r, 'カスタム情報：採用人数(選択リスト)')), ...crmS.map((x) => x.採用人数)].map((b) => [BAND_LOW[b], b]).filter(([v]) => v != null).sort((a, b) => b[0] - a[0])[0];
  if (hire == null && hearing) { hire = hearing[0]; hireBasis = 'ヒアリング'; hireFrom = 'CRM採用人数(' + hearing[1] + ')'; }

  // 接触人数（実測 → 推定）
  const entryMeasured = crmB.map((r) => num(g(r, 'カスタム情報：エントリー数'))).filter((v) => v != null && v < 100000).sort((a, b) => b - a)[0];
  const followers = C && C.フォロワー != null ? C.フォロワー : null;
  const est = hire != null ? Math.round(hire * CONTACT_RATIO_MED) : null;
  const estLow = hire != null ? Math.round(hire * CONTACT_RATIO_P25) : null;
  const contactBlocks = crmB.filter((r) => /接触人数/.test(g(r, 'カスタム情報：ペンディング理由')) || /接触人数不足/.test(g(r, 'カスタム情報：失注商談失注理由大')));
  let contact = null; let contactBasis = '';
  if (entryMeasured != null) { contact = entryMeasured; contactBasis = '実測(BALESエントリー数)'; }
  else if (followers != null && followers >= CONTACT_MIN && (est == null || followers >= est)) { contact = followers; contactBasis = '実測(キャリタスのフォロワー学生数)'; }
  else if (est != null) { contact = est; contactBasis = `推定(採用${hire}名×${CONTACT_RATIO_MED})` + (followers && C && C.掲載中 !== false ? `／キャリタスフォロワー${followers}名` : ''); }

  // 担当者名（無くてよいが、統合マスタに検証済みの名前があれば載せる）
  // 統合マスタの名前は質がまちまち（実測:「石原 が聞く」に氏名検証OK）。担当者名は必須ではないので、
  // 確度0.8以上・要確認でない・抽出の断片語（が聞く/窓口/様 等）を含まない名前だけ載せる。
  const nameOk = (n) => n && isPlausiblePersonName(n) && !n.split(/[s　]+/).some((t) => NAME_JUNK_RE.test(t));
  const recName = (nameOk(String(mst.採用担当者名 || '').trim()) && (mst.確度 || 0) >= 0.8 && !/NG|不一致|要確認/.test(mst.氏名検証 || '')) ? String(mst.採用担当者名).trim() : '';

  // ── ゲート（理由は落ちた順に1つ目を採る） ──
  const reasons = [];
  if (!media.length) reasons.push('新卒媒体の掲載なし');
  const nameVariants = [name, ...e.names];
  if (nameVariants.some((n) => ng.isNg(n))) reasons.push('架電禁止リスト');
  if (crm.mochica.has(e.key)) reasons.push('MOCHICA既存顧客');
  const ban = crmB.map((r) => g(r, 'カスタム情報：アプローチ禁止の種類')).find(Boolean);
  if (ban) reasons.push('BALESアプローチ禁止(' + ban + ')');
  const pend = crmB.map((r) => g(r, 'カスタム情報：ペンディング理由')).find((p) => PENDING_BLOCK.has(p));
  if (pend) reasons.push(PENDING_BLOCK.get(pend));
  if (contactBlocks.length) reasons.push('接触人数<50(BALES記録:接触人数不足)');
  if (isGovernmentOrg(name, industry)) reasons.push('官公庁');
  if (isExcludedIndustry(industry)) reasons.push('IT・ソフトウェア');
  if (emp != null && emp < ICP.EMP_MIN) reasons.push(`従業員${emp}名<${ICP.EMP_MIN}`);
  if (hire == null) reasons.push('採用人数不明');
  else if (hire < ICP.HIRE_MIN) reasons.push(`採用${hire}名<${ICP.HIRE_MIN}(${hireBasis})`);
  else if (BASIS_RANK[hireBasis] < BASIS_RANK[HIRE_BASIS]) reasons.push(`採用人数の根拠が${hireBasis}のみ`);
  if (entryMeasured != null && entryMeasured < CONTACT_MIN) reasons.push(`接触${entryMeasured}名<${CONTACT_MIN}(BALES実測)`);
  else if (contact != null && contact < CONTACT_MIN) reasons.push(`接触推定${contact}名<${CONTACT_MIN}`);
  if (!phone) reasons.push('電話番号なし');

  return {
    e, name, media, mediaDetail, industry, emp, empFrom, addr, phone, phoneFrom, hire, hireBasis, hireFrom, hireYear, series, plan,
    contact, contactBasis, est, estLow, followers, entryMeasured, recName, mst, crmB, crmS, reasons, balesOther,
  };
}

// ============================================================================
// 5. インテント（観測台帳のシグナル ＋ 他媒体の構造値から立つシグナル）
// ============================================================================
function ledgerHits(json) {
  if (!json) return [];
  let arr; try { arr = JSON.parse(json); } catch (_) { return []; }
  return (Array.isArray(arr) ? arr : []).filter((d) => d && SIGNALS[d.signal]).map((d) => ({
    signal: d.signal, 名称: d.名称 || SIGNALS[d.signal].名称, 列: d.列 || SIGNALS[d.signal].列, weight: SIGNALS[d.signal].weight,
    半減期日: SIGNALS[d.signal].半減期日, strength: Number(d.strength) || 0, level: d.level || '', 根拠: d.根拠 || '', 詳細: d.詳細 || {}, 検知日: d.検知日,
  }));
}
function mediaHits(x) {
  const s = x.e.src; const C = s.careertasu; const R = s.rikunabi; const G = s.gakujo;
  const hits = [];
  const push = (h, media) => { if (h) { h.根拠 = '[' + media + '] ' + h.根拠; hits.push(h); } };
  // 採用実績の前年比（全媒体の実績を年でまとめた系列。マイナビ系列は台帳側でも立つが scoreIntent が強い方を採る）
  if (x.series.length >= 2) push(detectHirePlanIncrease({ series: x.series.map((p) => p.年 + '年' + p.人数 + '名').join('/'), 検知日: TODAY }), x.series[0].src);
  else if (C && C.予定 != null && C.昨年度実績 != null) push(detectHirePlanIncrease({ plan: C.予定, prevPlan: C.昨年度実績, 種別ラベル: '採用予定数(昨年度実績→今年度予定)', 検知日: TODAY }), 'キャリタス');
  const intern = Math.max(C ? C.インターン件数 : 0, R ? R.インターン件数 : 0);
  if (intern > 0) push(detectInternship({ text: '', 件数: intern, 検知日: TODAY }), C && C.インターン件数 >= (R ? R.インターン件数 : 0) ? 'キャリタス' : 'リクナビ');
  if (C && C.合説) push(detectExpo({ text: '合同企業説明会に出展（キャリタス出展情報）', 検知日: TODAY }), 'キャリタス');
  const txt = [R && R.掲載本文, C && C.本文, G && G.掲載本文].filter(Boolean).join('\n');
  if (txt) push(detectSecondaryRecruit({ text: txt, 卒年: '27', now: NOW, 検知日: TODAY }), R && R.掲載本文 ? 'リクナビ等' : 'キャリタス等');
  if (C && C.メール) push(detectRecruitEmail({ emails: [{ email: C.メール }], 検知日: TODAY }), 'キャリタス');
  return hits;
}
function intentOf(x) {
  const M = x.e.src.mynavi || x.e.src.site;
  const hits = [...ledgerHits(M && M.内訳), ...mediaHits(x)];
  return scoreIntent(hits, { now: NOW });
}

// ============================================================================
// 6. メイン
// ============================================================================
function main() {
  log('媒体ソースを読み込み中…');
  loadMynavi(); loadCareertasu(); loadRikunabi(); loadGakujo();
  log(`名寄せ後のユニーク企業: ${entities.length}社`);
  const crm = loadCrm();
  const ledger = loadLedger();

  const funnel = {}; const bump = (k) => { funnel[k] = (funnel[k] || 0) + 1; };
  const pool = [];
  const fillPool = [];
  const near = []; // 採用人数だけが未確定の社（他媒体の実績が後から入れば有資格になる）＝インテント再観測の対象に含める
  const mediaReach = { マイナビ: 0, キャリタス就活: 0, リクナビ: 0, あさがくナビ: 0 };
  const DUMP_ALL = getArg('dump-all', '');
  const all = [];
  for (const e of entities) {
    const x = resolve(e, crm);
    if (DUMP_ALL) all.push({ 企業名: x.name, 掲載媒体: x.media.join('・'), 従業員数: x.emp == null ? '' : String(x.emp), 採用人数: x.hire == null ? '' : String(x.hire), 採用人数の根拠: x.hireBasis, 業種: x.industry, 電話番号: x.phone, 除外理由: x.reasons.join('｜') });
    for (const m of x.media) mediaReach[m]++;
    if (x.reasons.length === 1 && x.reasons[0] === '採用人数不明') near.push(x);
    // 準適合の候補: 落ちた理由が「従業員100名未満」だけで、従業員が FILL_EMP_MIN 名以上の社
    // （採用6名以上・接触50名以上・非IT等ユーザー指定の条件は満たす。ICPの規模フロアだけ下回る）
    const fillable = x.reasons.length === 1 && /^従業員\d+名</.test(x.reasons[0]) && x.emp != null && x.emp >= FILL_EMP_MIN;
    if (x.reasons.length && !fillable) { bump(x.reasons[0].replace(/\(.*$/, '').replace(/\d+名?<\d+/, 'N<閾値')); continue; }
    const icp = scoreMochica({
      企業名: x.name, 業種: x.industry, 従業員数: x.emp != null ? String(x.emp) : '', 電話番号: x.phone, 採用担当者名: x.recName,
      採用人数: String(x.hire), 新卒フラグ: '新', 掲載媒体: x.media.join('・'), エントリー人数: x.entryMeasured != null ? String(x.entryMeasured) : '',
    }, { now: NOW });
    if (icp.total <= 0 || icp.flags.blocked) { bump('ICPゲート'); continue; }
    const it = intentOf(x);
    x.icp = icp; x.intent = it;
    x.priority = combineWithFit(it.スコア, icp.total);
    if (fillable) { x.tier = '準適合（従業員' + FILL_EMP_MIN + '～' + (ICP.EMP_MIN - 1) + '名・ICP規模下限未満）'; fillPool.push(x); bump(x.reasons[0].replace(/\(.*$/, '').replace(/\d+名?<\d+/, 'N<閾値') + '（うち準適合へ）'); continue; }
    x.tier = /平均/.test(x.hireFrom) ? '完全適合（採用は直近3年平均）' : '完全適合';
    pool.push(x);
  }
  log(`有資格プール: ${pool.length}社 ／ 準適合候補（従業員${FILL_EMP_MIN}～${ICP.EMP_MIN - 1}名）: ${fillPool.length}社`);
  if (DUMP_ALL) { fs.writeFileSync(path.resolve(ROOT, DUMP_ALL), '﻿' + toCsv(['企業名', '掲載媒体', '従業員数', '採用人数', '採用人数の根拠', '業種', '電話番号', '除外理由'], all), 'utf8'); log(`全社の判定 → ${DUMP_ALL}`); }

  const byPriority = (a, b) => (b.priority - a.priority) || (b.intent.スコア - a.intent.スコア) || (b.icp.total - a.icp.total)
    || (b.media.length - a.media.length) || ((b.hire || 0) - (a.hire || 0));
  pool.sort(byPriority); fillPool.sort(byPriority);

  // 段階的に埋める（条件を崩さない順）:
  //   ① 完全適合（代表電話が一意）… 同一代表電話はJA県本部が同番号で並ぶ等があるので上位1社だけ
  //   ② 完全適合だが代表電話が①の社と共通（別法人。条件はすべて満たすが同じ番号へ2度かけることになる）
  //   ③ 準適合（従業員50～99名）… ①②で目標に届かない時だけ
  const usedTel = new Map(); const picked = []; const shared = []; let telDup = 0; let sameCo = 0;
  const tel = (x) => x.phone.replace(/\D/g, '');
  // 同名（名寄せキー一致）で本社県が食い違う別エンティティは、原則として別社（実測: 医療法人社団平成会〈福島〉と
  // 社会福祉法人平成会〈広島〉、朝日工業〈東京〉と朝日工業〈広島〉など、法人格を落とした社名が同じだけの別法人が大半）。
  // 同一社として寄せるのは公式サイトのドメインが一致したときだけ（同じ番号の重複は下の電話共通の扱いで別途見る）。
  const keptByKey = new Map();
  // 公式URLは媒体のものだけ使う（統合マスタの値は社名キー経由なので同名別社で共有され得る）
  const hostOf = (x) => { const s = x.e.src; const u = [s.rikunabi && s.rikunabi.公式URL, s.mynavi && s.mynavi.公式URL].find((v) => v && !MEDIA_HOST_RE.test(v)) || ''; try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return ''; } };
  const dupOfKept = (x) => { const h = hostOf(x); return !!h && (keptByKey.get(x.e.key) || []).some((y) => hostOf(y) === h); };
  const keep = (x) => {
    picked.push(x);
    if (!keptByKey.has(x.e.key)) keptByKey.set(x.e.key, []); keptByKey.get(x.e.key).push(x);
    if (!usedTel.has(tel(x))) usedTel.set(tel(x), []); usedTel.get(tel(x)).push(x);
  };
  for (const x of pool) {
    if (dupOfKept(x)) { sameCo++; if (process.env.DEBUG_DUP) { const y = keptByKey.get(x.e.key)[0]; console.log('  寄せ: ' + x.name + '[' + x.addr.slice(0, 12) + '/' + x.emp + '/' + x.media.join('+') + '] → ' + y.name + '[' + y.addr.slice(0, 12) + '/' + y.emp + '/' + y.media.join('+') + ']'); } continue; }
    if (usedTel.has(tel(x))) { shared.push(x); telDup++; continue; }
    keep(x);
  }
  const strict = picked.length;
  // 同じ番号の上位社と「社名の頭（最初の空白・※・〈 の手前）」が同じなら同一社の別コース掲載（〈薬剤師職コース〉等）＝出さない
  const core = (n) => mkey(String(n).split(/[\s　※〈<]/)[0]) || mkey(n);
  const sameCore = (a, b) => { const p = core(a); const q = core(b); return p && q && (p.startsWith(q) || q.startsWith(p)); };
  let sharedOut = 0;
  for (const x of shared) {
    if (picked.length >= TARGET) break;
    const mates = usedTel.get(tel(x)) || [];
    if (mates.some((y) => sameCore(x.name, y.name)) || dupOfKept(x)) { sameCo++; if (process.env.DEBUG_DUP) console.log('  別コース: ' + x.name + ' → ' + mates.map((y) => y.name).join('・')); continue; }
    x.tier = '完全適合（代表電話が他社と共通）';
    x.telMate = mates.map((y) => y.name).join('・');
    keep(x); sharedOut++;
  }
  let filled = 0;
  for (const x of fillPool) {
    if (picked.length >= TARGET) break;
    if (usedTel.has(tel(x)) || dupOfKept(x)) continue;
    keep(x); filled++;
  }
  picked.length = Math.min(picked.length, TARGET);
  // 同名（法人格を除いた社名が同じ）の別社がリスト内にいる行には相手の県を書く（架電時の取り違え防止）
  const grp = new Map(); for (const x of picked) { if (!grp.has(x.e.key)) grp.set(x.e.key, []); grp.get(x.e.key).push(x); }
  for (const arr of grp.values()) if (arr.length > 1) for (const x of arr) x.sameName = arr.filter((y) => y !== x).map((y) => y.name + '(' + (prefsIn(y.addr)[0] || [...y.e.prefs][0] || '県不明') + ')').join('・');
  log(`同名の同一社 ${sameCo}社を寄せた ／ ① 完全適合(電話一意) ${strict}社 ／ ② 電話共通 ${sharedOut}社 ／ ③ 準適合 ${filled}社 → 採用 ${picked.length}社（目標 ${TARGET}）`);

  // ---- 詳細CSV ----
  const COLS = ['順位', '適合区分', '企業名', '電話番号', '電話番号の出所', '業種', '従業員数', '従業員数の出所', '都道府県', '本社所在地',
    '採用人数', '採用人数の根拠', '採用人数の出所', '採用実績(年系列)', '接触人数(見込み)', '接触人数の根拠', '接触人数(推定下限p25)', 'キャリタスフォロワー数',
    '掲載媒体', '掲載媒体数', 'ICPスコア(v5)', 'ICP優先度', '組織型', '提案セグメント', 'インテントスコア', 'インテント階層', '最有力シグナル', '検知シグナル', 'なぜ今', '推奨トーク',
    '総合優先度', '電話共通の相手', '同名の別社', 'BALESに同名の別社', 'ATS判定', '採用担当者名', '既存BALES', 'BALES_ID', 'BALESリードステージ', '既存SF', 'SFリード状況', '過去納品', '完全新規',
    '法人番号', '公式URL', 'マイナビURL', 'キャリタスURL', 'リクナビURL', 'あさがくナビURL', '取得日'];
  const rows = picked.map((x, i) => {
    const s = x.e.src; const b = x.crmB[0];
    const delivered = isDelivered(ledger, { 企業名: x.name, 法人番号: x.mst.法人番号 || '' });
    return {
      順位: String(i + 1), 適合区分: x.tier, 企業名: x.name, 電話番号: x.phone, 電話番号の出所: x.phoneFrom, 業種: x.industry,
      従業員数: x.emp != null ? String(x.emp) : '', 従業員数の出所: x.empFrom, 都道府県: prefsIn(x.addr)[0] || [...x.e.prefs][0] || '', 本社所在地: x.addr,
      採用人数: String(x.hire), 採用人数の根拠: x.hireBasis, 採用人数の出所: x.hireFrom, '採用実績(年系列)': x.series.map((p) => p.年 + '年' + p.人数 + '名(' + p.src + ')').join(' / '),
      '接触人数(見込み)': x.contact != null ? String(x.contact) : '', 接触人数の根拠: x.contactBasis, '接触人数(推定下限p25)': x.estLow != null ? String(x.estLow) : '',
      キャリタスフォロワー数: x.followers != null ? String(x.followers) : '',
      掲載媒体: x.mediaDetail.join('・'), 掲載媒体数: String(x.media.length),
      'ICPスコア(v5)': String(x.icp.total), ICP優先度: x.icp.priority, 組織型: x.icp.orgLabel || '', 提案セグメント: x.icp.segment || '',
      インテントスコア: String(x.intent.スコア), インテント階層: x.intent.階層, 最有力シグナル: x.intent.最有力 || '—', 検知シグナル: x.intent.検知シグナル || '',
      なぜ今: whyNow(x.intent), 推奨トーク: talkGuide(x.intent), 総合優先度: String(x.priority), 電話共通の相手: x.telMate || '', 同名の別社: x.sameName || '', BALESに同名の別社: x.balesOther.slice(0, 3).join('・'),
      ATS判定: (s.mynavi && s.mynavi.ATS判定) || (s.site && s.site.ATS判定) || '', 採用担当者名: x.recName,
      既存BALES: x.crmB.length ? '有' : '', BALES_ID: b ? g(b, 'システム管理情報：ID') : '', BALESリードステージ: b ? g(b, 'リード関連情報：最終リードステージ') : '',
      既存SF: x.crmS.length ? '有' : '', SFリード状況: x.crmS.length ? x.crmS[0].状況 : '', 過去納品: delivered ? '有' : '',
      完全新規: (!x.crmB.length && !x.crmS.length && !delivered) ? '◎' : '',
      法人番号: x.mst.法人番号 || '', 公式URL: [s.rikunabi && s.rikunabi.公式URL, s.mynavi && s.mynavi.公式URL, x.mst.公式URL].find((u) => u && /^https?:/.test(u) && !MEDIA_HOST_RE.test(u)) || '',
      マイナビURL: s.mynavi ? s.mynavi.url : '', キャリタスURL: s.careertasu ? s.careertasu.url : '', リクナビURL: s.rikunabi ? s.rikunabi.url : '', あさがくナビURL: s.gakujo ? s.gakujo.url : '',
      取得日: TODAY,
    };
  });
  fs.writeFileSync(OUT, '﻿' + toCsv(COLS, rows, { where: path.basename(OUT) }), 'utf8');
  log(`詳細 → ${path.relative(ROOT, OUT)}（${rows.length}行）`);

  if (DUMP_POOL) {
    // 再観測は「採用した社」ではなく有資格プール全体（マイナビ面あり）に掛ける。
    // 観測の無い社は順位が沈むので、採用社だけに絞ると観測の無い社が永遠に上がってこない。
    const pc = ['企業名', 'corpID', '電話番号', '業種', '従業員数', '本社', '採用実績(直近3年)', '採用担当者名', 'アポ期待度', '採用ページURL', '公式URL'];
    const prow = [...pool, ...near].filter((x) => x.e.src.mynavi).map((x) => ({
      企業名: x.name, corpID: x.e.src.mynavi.corpID, 電話番号: x.phone, 業種: x.industry, 従業員数: x.emp != null ? String(x.emp) : '', 本社: x.addr,
      '採用実績(直近3年)': x.series.map((p) => p.年 + '年' + p.人数 + '名').join('/'), 採用担当者名: x.recName, アポ期待度: x.icp ? String(x.icp.total) : '',
      採用ページURL: x.e.src.mynavi.url, 公式URL: '',
    }));
    fs.writeFileSync(path.resolve(ROOT, DUMP_POOL), '﻿' + toCsv(pc, prow), 'utf8');
    log(`インテント再観測用プール → ${DUMP_POOL}（マイナビ面あり ${prow.length}社）`);
  }

  // ---- BALES取込形式（新規 / 既存ID付き）----
  const balesIn = OUT.replace(/\.csv$/, '.bales-in.csv');
  const BIN = ['企業名', '電話番号', '公式URL', '業種', '従業員数', '都道府県', '部署', '役職', '採用担当者名', 'メール', '代表者名', '既存被り'];
  const urlOf = new Map(picked.map((x, i) => [x, rows[i].公式URL]));
  const binRows = (subset) => subset.map((x) => ({
    企業名: x.name, 電話番号: x.phone, 公式URL: urlOf.get(x) || '', 業種: x.industry, 従業員数: x.emp != null ? String(x.emp) : '',
    都道府県: x.addr, 部署: x.recName ? (x.mst.部署 || '') : '', 役職: x.recName ? (x.mst.役職 || '') : '', 採用担当者名: x.recName, メール: '', 代表者名: '', 既存被り: '',
  }));
  const fresh = picked.filter((x) => !x.crmB.length);
  const exist = picked.filter((x) => x.crmB.length);
  const outNew = D('leads-bales-allmedia-new.csv');
  const outExist = D('leads-bales-allmedia-existing.csv');
  for (const [subset, out] of [[fresh, outNew], [exist, outExist]]) {
    fs.writeFileSync(balesIn, '﻿' + toCsv(BIN, binRows(subset)), 'utf8');
    execFileSync(process.execPath, [path.join(__dirname, 'format-bales.js'), '--in', balesIn, '--scope', 'all', '--out', out, '--no-record', '--no-dedupe-history'], { stdio: 'inherit' });
    annotateBales(out, subset, out === outExist, crm);
  }
  try { fs.unlinkSync(balesIn); } catch (_) {}
  writeReport({ picked, pool, fillPool, funnel, telDup, entities: entities.length, mediaReach, fresh: fresh.length, exist: exist.length, outNew, outExist, rows });
}

// BALESのカスタム欄へ「なぜこの社か・なぜ今か」を載せる。既存リードは営業が書いたメモを潰さない（空欄にだけ書く）。
function annotateBales(file, subset, isExisting, crm) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const { headers, records } = readCsv(text);
  const stamp = TODAY + ' ' + NOW.toTimeString().slice(0, 5);
  // format-bales / 架電禁止ガードで行が落ちても対応がずれないよう、社名（＋電話）で引き当てる
  const queue = new Map();
  for (const x of subset) { const k = x.name + '\t' + x.phone; if (!queue.has(k)) queue.set(k, []); queue.get(k).push(x); }
  let miss = 0;
  for (const rec of records) {
    const q = queue.get(rec['会社情報：会社名'] + '\t' + rec['会社情報：電話']);
    const x = q && q.shift();
    if (!x) { miss++; continue; } // 引き当てられない行は注記しない（安全側）
    const b = x.crmB[0];
    const put = (k, v) => {
      if (!(k in rec) || !v) return;
      if (isExisting && b && g(b, k)) return; // 既存リードの入力済み欄は触らない
      rec[k] = String(v).slice(0, 250);
    };
    if (isExisting && b) {
      // 既存リードは「BALES側が空欄の項目だけ埋める」。入力済みの項目は空欄で渡す
      // （更新取込で空欄を無視する設定なら、営業が入れた担当者名・電話・住所を一切変えない）。
      // 社名はBALESの表記のまま返す（表記揺れで既存の社名を書き換えない）。
      for (const h of headers) if (h !== 'システム管理情報：No' && g(b, h) && rec[h]) rec[h] = '';
      rec['システム管理情報：ID'] = g(b, 'システム管理情報：ID');
      rec['会社情報：会社名'] = g(b, '会社情報：会社名');
    }
    if (x.hireBasis !== 'ヒアリング') put('カスタム情報：採用人数(選択リスト)', bandOf(x.hire));
    if (x.entryMeasured != null) put('カスタム情報：エントリー数', String(x.entryMeasured));
    put('カスタム情報：顧客の現状', (x.tier && x.tier !== '完全適合' ? '【' + x.tier + '】' : '') + `インテント${x.intent.階層}(${x.intent.スコア})・ICP${x.icp.total}・総合${x.priority}／新卒${x.hire}名(${x.hireBasis}:${x.hireFrom})・従業員${x.emp != null ? x.emp + '名' : '不明'}／接触${x.contact}名(${x.contactBasis})／掲載:${x.mediaDetail.join('・')}`);
    put('カスタム情報：顧客の課題感', whyNow(x.intent));
    put('カスタム情報：活動予定コメント', talkGuide(x.intent));
    if (!isExisting) { rec['リードソース：アウトバウンド'] = '1'; rec['リード流入日時：アウトバウンド'] = stamp; }
  }
  if (miss) log(`  注記: ${path.basename(file)} で引き当てられない行 ${miss}件（注記なしで出力）`);
  fs.writeFileSync(file, '﻿' + toCsv(headers, records, { where: path.basename(file) }), 'utf8');
}

function writeReport(o) {
  const band = (arr, f) => { const m = {}; for (const r of arr) { const k = f(r); m[k] = (m[k] || 0) + 1; } return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  const P = o.picked;
  const table = (title, entries) => [`| ${title} | 件数 |`, '|---|---:|', ...entries.map(([k, v]) => `| ${k} | ${v} |`), ''];
  const md = [];
  md.push(`# 全新卒媒体 × ICP適合 × 採用6名以上 × 接触50名以上 × インテント重視 ${P.length}社`, '');
  md.push(`- 生成: ${TODAY} ${NOW.toTimeString().slice(0, 5)}（JST）`);
  md.push(`- 詳細: \`${path.relative(ROOT, OUT)}\``);
  md.push(`- BALES取込（新規・BALES未登録）: \`${path.relative(ROOT, o.outNew)}\` … ${o.fresh}社`);
  md.push(`- BALES取込（既存・ID付き）: \`${path.relative(ROOT, o.outExist)}\` … ${o.exist}社`);
  md.push(`- 母集団（名寄せ後のユニーク企業）: ${o.entities}社 → 完全適合 ${o.pool.length}社（うち代表電話が他社と共通 ${o.telDup}社）＋ 準適合候補 ${o.fillPool.length}社 → 採用 ${P.length}社`, '');
  md.push(...table('適合区分', band(P, (x) => x.tier)));
  md.push('## 媒体別の母集団（名寄せ前の掲載社数）', '', ...table('媒体', Object.entries(o.mediaReach)));
  md.push('## 落ちた理由（1社1理由・先に当たった条件）', '', ...table('理由', Object.entries(o.funnel).sort((a, b) => b[1] - a[1])));
  md.push('## 採用企業の内訳', '');
  md.push(...table('インテント階層', band(P, (x) => x.intent.階層)));
  md.push(...table('最有力シグナル', band(P, (x) => x.intent.最有力 || '—').slice(0, 15)));
  md.push(...table('掲載媒体数', band(P, (x) => x.media.length + '媒体')));
  md.push(...table('掲載媒体の組み合わせ', band(P, (x) => x.media.join('＋')).slice(0, 12)));
  md.push(...table('採用人数の根拠', band(P, (x) => x.hireBasis)));
  md.push(...table('採用人数', band(P, (x) => (x.hire >= 51 ? '51名以上' : x.hire >= 21 ? '21-50名' : x.hire >= 11 ? '11-20名' : '6-10名'))));
  md.push(...table('接触人数の根拠', band(P, (x) => x.contactBasis.replace(/\(.*$/, '').replace(/／.*$/, ''))));
  md.push(...table('ICPスコア', band(P, (x) => (x.icp.total >= 80 ? '80以上' : x.icp.total >= 70 ? '70-79' : x.icp.total >= 60 ? '60-69' : x.icp.total >= 50 ? '50-59' : '50未満'))));
  md.push(...table('従業員数', band(P, (x) => (x.emp == null ? '不明' : x.emp >= 2000 ? '2000名以上' : x.emp >= 1000 ? '1000-1999名' : x.emp >= 500 ? '500-999名' : x.emp >= 300 ? '300-499名' : '100-299名'))));
  md.push(...table('既存との重なり', band(o.rows, (r) => (r.完全新規 ? '完全新規（BALES/SF/過去納品に無し）' : r.既存BALES ? 'BALES登録済' : r.既存SF ? 'SFのみ既存' : '過去納品のみ'))));
  md.push(...table('都道府県（上位15）', band(o.rows, (r) => r.都道府県 || '不明').slice(0, 15)));
  md.push('## 判定ルール', '');
  md.push(`- 採用人数: 媒体の採用実績（過去3年の新卒採用者数）の最新年を正とし、年が同じならマイナビ＞キャリタス＞あさがくナビ。実績が無い社は予定人数→CRMヒアリング値（許容: ${HIRE_BASIS}まで）。${ICP.HIRE_MIN}名未満は除外。`
    + (HIRE_RULE === 'avg3' ? `最新年が${ICP.HIRE_MIN}名未満でも直近3年の平均が${ICP.HIRE_MIN}名以上の社は「年${ICP.HIRE_MIN}名以上を継続採用」と見なして採用（適合区分に「採用は直近3年平均」と明記）。` : ''));
  md.push(`- 接触人数: BALESのエントリー数（実測）＞キャリタスのフォロワー学生数（実測・推定値以上のとき）＞推定（採用人数×${CONTACT_RATIO_MED}）。倍率はBALESのエントリー数×採用人数帯51件の中央値（下位25%点は×${CONTACT_RATIO_P25}）。BALESで「接触人数不足」「接触人数が30人以下」と記録済みの社と、実測が${CONTACT_MIN}名未満の社は除外。`);
  md.push(`- ICP: 非IT・官公庁でない・従業員${ICP.EMP_MIN}名以上（不明は通す）。ICPスコアは v5（期待アポ率の2段モデル）。`);
  md.push('- 除外: 架電禁止リスト／MOCHICA既存顧客／BALESアプローチ禁止／BALESで「採用人数1~2名」「新卒やってない」「LINE NG」「従業員49名以下」記録済み／電話番号なし。');
  md.push('- 並び: 総合優先度（0.55×インテント＋0.45×ICP）→インテント→ICP→掲載媒体数→採用人数。適合区分の順（①完全適合 → ②代表電話が他社と共通の完全適合 → ③準適合）に並べ、各区分の中を総合優先度順にしている。');
  md.push('- 準適合: 採用6名以上・接触50名以上・非IT・官公庁以外・架電禁止等の除外はすべて満たし、従業員数だけがICPの規模下限（' + ICP.EMP_MIN + '名）を下回る' + FILL_EMP_MIN + '名以上の社。①②で目標件数に届かない分だけ補充。');
  md.push('- 既存BALESリードは `leads-bales-allmedia-existing.csv` に分け、システム管理情報：ID を入れた。カスタム欄は**BALES側が空欄の項目だけ**埋めている（営業メモを潰さない）。');
  const outMd = OUT.replace(/\.csv$/, '-report.md');
  fs.writeFileSync(outMd, md.join('\n'), 'utf8');
  log(`レポート → ${path.relative(ROOT, outMd)}`);
}

if (require.main === module) main();
