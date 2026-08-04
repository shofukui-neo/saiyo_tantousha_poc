'use strict';
/**
 * 完全新規 × ICP完全適合 プール構築 v2（ページ送り discovery ＋ outline プレフィルタ）
 * ============================================================================
 * v1（build-icp-fresh-1000.js）は 757社で頭打ちになり「マイナビ母集団の上限」と結論づけていたが、
 * 実測するとそれは母集団ではなく **discovery の1ページ目しか見ていなかった** ことが原因だった。
 *   例: フリーワード「食品」= 6,150社ヒット → v1が見ていたのは先頭100社だけ（1.6%）。
 * v2は次の2点で母集団と速度を作り直す:
 *   ① discoverCorpIdsPaged … 「次の100社」を辿って1キーワードあたり最大 PAGES×100社を列挙
 *   ② outline プレフィルタ  … 会社概要1枚(約1.2秒)で 業種/従業員数 を確定させ、規模帯外・IT を
 *                             問合せ先巡回(約12秒)の前に落とす
 *
 * ── ICP完全適合の判定（全て実データで充足した社だけプールに入る）──────────────
 *   ① 完全新規   : 統合マスタ(30,290社)・BALES・MOCHICA顧客・SF全リードのいずれにも不在
 *   ② 新卒インテント: マイナビ2028掲載を実取得（verifiedIntent）
 *   ③ 規模フィット : 従業員 100〜2000名（outline.html の構造値。複数記載は最大値＝保守側）
 *   ④ 非IT        : outline.html の業種ラベルで判定（icp-rules の絶対除外）
 *   ⑤ 到達性      : 電話番号が妥当（架電できる）
 * 連絡先ティア（ユーザー指定の優先順位）: 1=採用担当者名 / 2=代表者名 / 3=名前なし
 *
 * 使い方: `npm run icp:v2`（長時間バックグラウンド・中断再開可）
 *   ICP_V2_TARGET(既定1400) ICP_V2_PAGES(既定25) ICP_V2_PER_KEYWORD(既定400) ICP_V2_CONCURRENCY(既定2)
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, normCorpNumber } = require('./csv');
const { MynaviScraper } = require('./scrape-mynavi');
const { scoreMochica, parseEmployees } = require('./mochica-fit');
const { isExcludedIndustry } = require('./icp-rules');
const { buildExclusion, evaluate, mkey, cleanDisplay, EMP_MIN, EMP_MAX } = require('./build-icp-fresh-1000');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.ICP_V2_OUT || path.join(ROOT, 'data', 'icp-fresh-pool.csv');
const SEEN = OUT.replace(/\.csv$/, '') + '.seen.txt';
const LEGACY_SEEN = path.join(ROOT, 'data', 'leads-icp-fresh-10000.seen.txt');
const TARGET = parseInt(process.env.ICP_V2_TARGET || '1400', 10);
const PAGES = parseInt(process.env.ICP_V2_PAGES || '25', 10);
const PER_KEYWORD = parseInt(process.env.ICP_V2_PER_KEYWORD || '400', 10);
const CONCURRENCY = Math.max(1, parseInt(process.env.ICP_V2_CONCURRENCY || '2', 10));
const GRAD_YEAR = process.env.MYNAVI_GRAD_YEAR || '28';
const DELAY = parseInt(process.env.ICP_V2_DELAY_MS || '400', 10);
const PER_COMPANY_MS = 90000;

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (v) => v && String(v).trim() && String(v).trim() !== '-';
function withTimeout(p, ms, onT) {
  return new Promise((res) => { const t = setTimeout(() => res(onT()), ms); p.then((v) => { clearTimeout(t); res(v); }, () => { clearTimeout(t); res(onT()); }); });
}
function safeWrite(abs, content) {
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, content);
  for (let i = 0; i < 5; i++) { try { fs.renameSync(tmp, abs); return; } catch (e) { if (e.code === 'EPERM' || e.code === 'EBUSY') { try { fs.writeFileSync(abs, content); fs.unlinkSync(tmp); return; } catch (_) {} } } }
  try { fs.writeFileSync(abs, content); fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch (_) {}
}

const POOL_COLS = ['連絡先区分', '企業名', '法人番号', '採用担当者名', '代表者名', '役職', '部署', '架電宛名', '電話番号', 'メール',
  '業種', '従業員数', '本社', '上場', '新卒フラグ', '採用予定人数', '募集職種', '掲載媒体', '卒年', '採用ページURL',
  'アポ期待度', '優先度', '確信度', 'MOCHICA適合', 'フィットティア', '完全適合根拠', 'corpID', '担当者確度', 'パターン', '検証', '取得日'];
const TIER_LABEL = { 1: '採用担当者名', 2: '代表者名', 3: '名前なし' };

// 検索キーワード（非IT高成約の業種×職種×地域。ITは④で落ちるので入れない）
const KEYWORDS = [
  '食品', 'メーカー', '製造', '機械', '自動車', '電機', '電子部品', '化学', '医薬品', '化粧品', '飲料',
  '金属', '鉄鋼', '繊維', '印刷', '包装', 'ガラス', 'ゴム', '住宅', '建設', '建材', '設備', 'プラント',
  '不動産', '商社', '専門商社', '卸売', '小売', 'スーパー', '百貨店', '専門店', 'アパレル', '家具',
  '外食', '飲食', 'ホテル', '旅行', 'ブライダル', 'レジャー', '物流', '運輸', '倉庫', '陸運', '海運',
  '鉄道', 'バス', '金融', '銀行', '信用金庫', '証券', '保険', 'リース', 'クレジット',
  '人材', '教育', '学習塾', '福祉', '介護', '保育', '医療', '病院', '調剤', 'ドラッグストア', '農業', '水産',
  '環境', 'エネルギー', '電力', 'ガス', '石油', '警備', 'ビルメンテナンス', '清掃', '自動車整備',
  '生産技術', '品質管理', '施工管理', '研究開発', '設計', '購買', '営業', '販売', '企画', '総合職', '技術職',
  '東京', '大阪', '愛知', '神奈川', '埼玉', '千葉', '兵庫', '福岡', '北海道', '静岡', '広島', '京都',
  '宮城', '新潟', '長野', '岐阜', '群馬', '栃木', '茨城', '三重', '岡山', '熊本', '鹿児島', '福島',
];

async function run() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  log('除外索引（統合マスタ＋BALES＋MOCHICA顧客＋SF全リード）を構築中…');
  const excl = buildExclusion();

  const rows = [];
  const seen = new Set();
  const collected = new Set();
  // 再開: プール
  if (fs.existsSync(OUT)) {
    try {
      for (const r of readCsv(fs.readFileSync(OUT, 'utf8')).records) {
        rows.push(r); if (r.corpID) seen.add(String(r.corpID));
        const k = mkey(r['企業名']); if (k) collected.add(k);
      }
    } catch (_) {}
  }
  // 再開: seen 台帳（v2 ＋ v1の24,255社。既に見た社は二度と触らない）
  for (const f of [SEEN, LEGACY_SEEN]) {
    if (!fs.existsSync(f)) continue;
    try { for (const l of fs.readFileSync(f, 'utf8').split(/\r?\n/)) { const s = l.trim(); if (s) seen.add(s); } } catch (_) {}
  }
  // v1の成果(757社)も「既に確保済みの社名」として扱い、二重計上を防ぐ
  const v1 = path.join(ROOT, 'data', 'leads-icp-fresh-10000.csv');
  if (fs.existsSync(v1)) {
    try { for (const r of readCsv(fs.readFileSync(v1, 'utf8')).records) { const k = mkey(r['企業名']); if (k) collected.add(k); } } catch (_) {}
  }
  log(`再開: プール ${rows.length}社 ｜ 探索済 ${seen.size}社 ｜ 確保済社名 ${collected.size}`);

  const tierCount = () => [1, 2, 3].map((t) => rows.filter((r) => r['連絡先区分'] === TIER_LABEL[t]).length);
  const flush = () => {
    rows.sort((a, b) => {
      const tv = (r) => (r['連絡先区分'] === '採用担当者名' ? 1 : r['連絡先区分'] === '代表者名' ? 2 : 3);
      return (tv(a) - tv(b)) || ((parseInt(b['アポ期待度']) || 0) - (parseInt(a['アポ期待度']) || 0));
    });
    safeWrite(OUT, toCsv(POOL_COLS, rows));
    safeWrite(SEEN, [...seen].join('\n'));
  };

  const sc = new MynaviScraper({ gradYear: GRAD_YEAR });
  await sc.launch();
  const stat = { outline: 0, deep: 0, dropEmp: 0, dropIT: 0, dropPhone: 0, dropDup: 0, ok: 0 };

  // 1社の処理: outline(安い) → 資格見込みがある社だけ 全面巡回(高い)
  async function processOne(f) {
    const o = await withTimeout(sc.scrapeOutline(f.id), 30000, () => ({ ok: false }));
    stat.outline++;
    if (!o.ok) return;
    const disp = cleanDisplay(o.企業名 || f.name);
    const k = mkey(disp);
    if (k && (excl.names.has(k) || collected.has(k))) { stat.dropDup++; return; } // outlineの実社名で新規性を再判定
    const emp = parseEmployees(o.従業員数);
    if (emp == null || emp < EMP_MIN || emp > EMP_MAX) { stat.dropEmp++; return; }
    if (isExcludedIndustry(o.業種)) { stat.dropIT++; return; }

    const r = await withTimeout(sc.scrapeByCorp(f.id, disp), PER_COMPANY_MS, () => null);
    stat.deep++;
    if (!r) return;
    const rec = {
      企業名: disp, corpID: f.id, 法人番号: '',
      採用担当者名: r.採用担当者名 || '', 担当者確度: r.担当者確度 || '', パターン: r.パターン || '',
      役職: r.役職 || '', 部署: r.部署 || '', メール: r.メール || '', 電話番号: r.電話番号 || '',
      // 規模・業種は outline の構造値を正とする（巡回中の自由文マッチで上書きされないよう明示）
      従業員数: o.従業員数, 業種: o.業種, 本社: o.本社 || '', 上場: o.上場 || '',
      募集職種: r.募集職種 || '', 採用予定人数: r.採用予定人数 || '', 卒年: r.卒年 || GRAD_YEAR,
      採用ページURL: r.採用ページURL || '', 掲載媒体: 'マイナビ', 新卒フラグ: '新',
      検証: 'outline実取得', 取得日: new Date().toISOString().slice(0, 10),
    };
    const ev = evaluate(rec);
    if (!ev.qualifies) { if (!ev.m.flags.callable) stat.dropPhone++; return; }
    if (collected.has(k)) { stat.dropDup++; return; }

    rec.採用担当者名 = ev.nameOk ? ev.clean : '';
    rec.代表者名 = ev.repOk ? ev.rep : '';
    rec.連絡先区分 = TIER_LABEL[ev.tier];
    rec.架電宛名 = ev.contact ? ((rec.部署 ? rec.部署 + ' ' : '') + ev.contact + ' 様') : (rec.部署 ? rec.部署 + ' ご採用ご担当者様' : 'ご採用ご担当者様');
    rec.アポ期待度 = ev.m.total; rec.優先度 = ev.m.priority; rec.確信度 = ev.m.confidence;
    rec.MOCHICA適合 = ev.m.total >= 80 ? '◎' : ev.m.total >= 65 ? '○' : '△';
    rec.フィットティア = 'S:完全適合(新規発掘)';
    rec.完全適合根拠 = `完全新規｜${TIER_LABEL[ev.tier]}${ev.contact ? '(' + ev.contact + ')' : ''}｜マイナビ${GRAD_YEAR}卒掲載｜従業員${ev.emp}名(${EMP_MIN}-${EMP_MAX})｜非IT(${o.業種})｜電話妥当`;
    const out = {}; for (const c of POOL_COLS) out[c] = rec[c] != null ? String(rec[c]) : '';
    rows.push(out);
    collected.add(k);
    stat.ok++;
    if (ev.tier <= 2) log(`  ✅[${TIER_LABEL[ev.tier]}] ${disp} / ${ev.contact} / 従${ev.emp} / ${o.業種} / apo${ev.m.total} → ${rows.length}`);
  }

  // 候補配列を並列ワーカーで処理する共通ループ（キーワード経路／全社コーパス経路の両方から使う）
  async function runBatch(batch, label) {
    let idx = 0, done = 0;
    const worker = async () => {
      while (true) {
        if (rows.length >= TARGET) return;
        const i = idx++;
        if (i >= batch.length) return;
        const f = batch[i];
        seen.add(String(f.id));
        try { await processOne(f); } catch (e) { /* 1社の失敗は無視 */ }
        if (++done % 25 === 0) {
          const [t1, t2, t3] = tierCount();
          flush();
          log(`  …${label} ${done}/${batch.length} outline${stat.outline} deep${stat.deep} ｜ 規模外${stat.dropEmp} IT${stat.dropIT} 電話無${stat.dropPhone} 既存${stat.dropDup} ｜ プール${rows.length}（担当${t1}/代表${t2}/無${t3}）`);
        }
        await sleep(DELAY);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    flush();
  }

  // ── 経路①: マイナビ掲載企業の「全社コーパス」から完全新規だけを総当たり（推奨・取りこぼし無し）──
  const CORPUS = process.env.ICP_V2_CORPUS ? path.resolve(ROOT, process.env.ICP_V2_CORPUS) : '';
  if (CORPUS && fs.existsSync(CORPUS)) {
    try {
      const corpus = readCsv(fs.readFileSync(CORPUS, 'utf8')).records;
      const cand = corpus.filter((c) => c.corpID && !seen.has(String(c.corpID)));
      const fresh = [];
      for (const c of cand) {
        const k = mkey(c['企業名']);
        if (k && (excl.names.has(k) || collected.has(k))) { seen.add(String(c.corpID)); continue; }
        fresh.push({ id: String(c.corpID), name: c['企業名'] });
      }
      log(`📚 全社コーパス ${corpus.length}社 → 未探索${cand.length} → 社名で既存除外 ${cand.length - fresh.length} ／ 探索対象 ${fresh.length}社（目標プール${TARGET}）`);
      await runBatch(fresh, 'corpus');
      const [t1, t2, t3] = tierCount();
      log(`完了(コーパス経路): プール${rows.length}社（採用担当者名${t1}/代表者名${t2}/名前なし${t3}） outline${stat.outline} deep${stat.deep}`);
      log(`出力: ${OUT}`);
      await sc.close().catch(() => {});
      return;
    } catch (e) { log(`コーパス経路 失敗→キーワード経路へ: ${String(e).slice(0, 100)}`); }
  }

  try {
    for (const kw of KEYWORDS) {
      if (rows.length >= TARGET) break;
      let found;
      try { found = await sc.discoverCorpIdsPaged(kw, PAGES); } catch (e) { log(`discover ERR "${kw}": ${String(e).slice(0, 60)}`); continue; }
      const cand = found.items.filter((f) => !seen.has(String(f.id)));
      const fresh = [];
      for (const f of cand) { const k = mkey(f.name); if (k && (excl.names.has(k) || collected.has(k))) { seen.add(String(f.id)); } else fresh.push(f); }
      const batch = fresh.slice(0, PER_KEYWORD);
      log(`🔍 "${kw}": 掲載${found.total}社 列挙${found.items.length}(${found.pages}面) 未探索${cand.length} → 社名で既存除外 ${cand.length - fresh.length} ／ 探索対象${batch.length} ｜ プール${rows.length}/${TARGET}`);

      // 軽い並列（各ワーカーは独自ページを開く。礼儀のため待機を挟む）
      await runBatch(batch, `"${kw}"`);
    }
  } finally {
    flush();
    await sc.close().catch(() => {});
  }
  const [t1, t2, t3] = tierCount();
  log(`完了: プール${rows.length}社（採用担当者名${t1}/代表者名${t2}/名前なし${t3}） outline${stat.outline} deep${stat.deep}`);
  log(`出力: ${OUT}`);
}

if (require.main === module) run().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
module.exports = { POOL_COLS, TIER_LABEL };
