'use strict';
/**
 * ICP完全適合 × 採用担当者名判明 × 完全新規 を “ゼロから発掘” する 1000件ハーベスタ
 * ============================================================================
 * ユーザー指定（2026-07）:「今あるものではなく、完全新規でICP完全適合・採用担当者名の
 * 判明しているリストを1000件」。= 統合マスタ(30,290社)からの抽出ではなく、マイナビ
 * **28卒（新シーズン＝既存の27卒harvestに無い新surface）** をディスカバリ探索し、下記を
 * すべて満たす“発掘したての新規企業”だけを積み上げる。
 *
 * ── 採用資格（全て満たした社だけ出力） ─────────────────────────
 *   ① 完全新規     : 統合マスタ(leads-consolidated-all) にも CRM(BALES/MOCHICA顧客/SF) にも不在
 *   ② 担当者名判明 : マイナビ問合せ先/伝言板/インタビューから実氏名 ＋ 品質ゲート(cleanCrossRefName)
 *   ③ 新卒インテント: マイナビ掲載（＝新卒採用を実施中・verifiedIntent）
 *   ④ 規模フィット : 従業員数 100〜2000名（実成約率の有効域）
 *   ⑤ 非IT         : IT/ソフトは絶対除外
 *   ⑥ 到達性       : 電話番号が妥当（架電できる）
 *
 * 効率化: discoverCorpIds が返す社名を先に正規化し、①で既存(マスタ/CRM)に当たる社は
 *   スクレイプせずスキップ（新規候補だけ実取得）。再開可能(seen台帳=corpID)。
 *
 * 使い方: `npm run icp:fresh`（バックグラウンド長時間・ループで進捗確認）
 *   MYNAVI_GRAD_YEAR=28 既定。ICP_FRESH_TARGET/ICP_FRESH_MAX/ICP_FRESH_KEYWORDS で調整。
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, normCompanyName, normCorpNumber } = require('./csv');
const { MynaviScraper } = require('./scrape-mynavi');
const { scoreMochica, parseEmployees } = require('./mochica-fit');
const { isExcludedIndustry } = require('./icp-rules');
const { cleanCrossRefName } = require('./enrich-crossref');
const { buildExclusionIndex } = require('./exclusion-index');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.ICP_FRESH_OUT || path.join(ROOT, 'data', 'leads-icp-fresh-named-1000.csv');
const RAW = process.env.ICP_FRESH_RAW || path.join(ROOT, 'data', 'icp-fresh-harvest-raw.csv'); // 新規×担当者名の全捕捉(バッファ/監査)
const TARGET = parseInt(process.env.ICP_FRESH_TARGET || '1000', 10);
const MAX_COMPANIES = parseInt(process.env.ICP_FRESH_MAX || '60000', 10);
const GRAD_YEAR = process.env.MYNAVI_GRAD_YEAR || '28';
const DELAY = parseInt(process.env.MYNAVI_POLITE_MS || '1200', 10);
const PER_COMPANY_MS = 75000;
const EMP_MIN = 100, EMP_MAX = 2000;

const has = (v) => v && String(v).trim() && String(v).trim() !== '-';
// マイナビ表示名のノイズ（末尾NEWバッジ・【親会社/グループ】等の注記）を落とす。
// これを剥がさずに正規化すると、注記付き社名が除外索引に当たらず「偽の完全新規」になる（実測46%混入）。
function stripAnn(name) {
  return String(name || '').replace(/\s*(NEW|new)\s*$/, '').replace(/[【（(［\[].*?[】）)］\]]/g, '').trim();
}
// 突合キー（注記除去 → 法人格除去の正規化）。除外索引・候補・出力の全てで統一して使う。
const mkey = (name) => normCompanyName(stripAnn(name));
// 表示用クリーニング（末尾NEWと【…】グループ注記だけ落とし、（…）通称は残す）
const cleanDisplay = (name) => String(name || '').replace(/\s*(NEW|new)\s*$/, '').replace(/[【\[].*?[】\]]/g, '').trim();
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function withTimeout(p, ms, onT) {
  return new Promise((res) => { const t = setTimeout(() => res(onT()), ms); p.then((v) => { clearTimeout(t); res(v); }, () => { clearTimeout(t); res(onT()); }); });
}
function safeWrite(abs, content) {
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, content);
  for (let i = 0; i < 5; i++) { try { fs.renameSync(tmp, abs); return; } catch (e) { if (e.code === 'EPERM' || e.code === 'EBUSY') { try { fs.writeFileSync(abs, content); fs.unlinkSync(tmp); return; } catch (_) {} } } }
  try { fs.writeFileSync(abs, content); fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch (_) {}
}

// ── 既存(マスタ＋CRM＋納品台帳＋既存母集団)の索引。ここに当たる社は「新規でない」→スキップ ──
// 索引の構築は exclusion-index.js に集約（2026-07-30）。以前はこのファイル独自の
// Set(正規化社名のみ)で、農協別称・表記ゆれ・納品台帳を突合していなかった。
function buildExclusion() {
  const ex = buildExclusionIndex({ masters: true, ledger: true, pool: true });
  log(`  除外索引 合計: ${ex.idx.size}社（${ex.layers.join('+')}）`);
  return { has: (name) => ex.idx.has(name), detail: (name) => ex.idx.matchDetail(name), size: ex.idx.size };
}

// 発掘した1社の資格判定
// ICP完全適合（担当者名は必須でない＝優先度）: 新卒媒体掲載 + 規模100-2000 + 非IT + 電話妥当
// 連絡先ティア: 1=採用担当者名アリ / 2=代表者名 / 3=名前なし（ユーザー指定の優先順位）
// マイナビの面見出し/業務語がcleanCrossRefNameをすり抜けて氏名化する既知ノイズ（実測: 人材/業界研究/専門/人材開発 等）
const BAD_NAME = new Set(['人材', '人事', '採用', '総務', '業界研究', '会社研究', '企業研究', '専門', '人材開発', '説明会', '募集', '担当', '部門', '管理', '事務', '窓口', '総合職', '技術職', '営業職', '会社説明', '仕事']);
function evaluate(rec) {
  let clean = cleanCrossRefName(rec['採用担当者名']);
  if (clean && BAD_NAME.has(String(clean).replace(/\s/g, ''))) clean = null; // 業務語は氏名として不採用
  const nameOk = clean && String(clean).replace(/\s/g, '').length >= 2;
  const rep = cleanCrossRefName(rec['代表者名']);
  const repOk = rep && String(rep).replace(/\s/g, '').length >= 2;
  const m = scoreMochica(rec);
  const emp = parseEmployees(rec['従業員数']);
  const inBand = emp != null && emp >= EMP_MIN && emp <= EMP_MAX;
  const notIT = !isExcludedIndustry(String(rec['業種'] || rec['募集職種'] || ''));
  const qualifies = m.flags.verifiedIntent && inBand && m.flags.callable && notIT;
  const tier = nameOk ? 1 : repOk ? 2 : 3;
  const contact = nameOk ? clean : repOk ? rep : '';
  return { clean, nameOk, rep, repOk, m, emp, inBand, notIT, qualifies, tier, contact };
}

const TIER_LABEL = { 1: '採用担当者名', 2: '代表者名', 3: '名前なし' };
const OUT_COLS = ['連絡先区分', '企業名', '法人番号', '採用担当者名', '代表者名', '役職', '部署', '架電宛名', '電話番号', 'メール',
  '業種', '従業員数', '新卒フラグ', '採用予定人数', '募集職種', '掲載媒体', '卒年', '採用ページURL',
  'アポ期待度', '優先度', '確信度', 'MOCHICA適合', 'フィットティア', '完全適合根拠', 'corpID', '担当者確度', 'パターン', '取得日'];

// ディスカバリ用キーワード（非IT高成約×職種×地域を厚めに。IT/ソフトは資格で落ちるので入れない）
const DEFAULT_KEYWORDS = [
  '食品', '飲料', 'メーカー', '自動車', '機械', '電機', '電子部品', '半導体', '化学', '医薬品', '化粧品',
  '金属', '鉄鋼', '繊維', '印刷', '包装', 'ガラス', 'ゴム', '住宅', '建設', '建材', '設備', 'プラント',
  '不動産', '商社', '専門商社', '卸売', '小売', 'スーパー', '百貨店', '専門店', 'アパレル', '家具',
  '外食', '飲食', 'ホテル', '旅行', 'ブライダル', 'レジャー', '物流', '運輸', '倉庫', '陸運', '海運', '航空',
  '鉄道', 'バス', 'タクシー', '金融', '銀行', '信用金庫', '信用組合', '証券', '保険', 'リース', 'クレジット',
  '人材', '教育', '学習塾', '福祉', '介護', '保育', '医療', '病院', '調剤', 'ドラッグストア', '農業', '水産',
  '林業', '環境', 'エネルギー', '電力', 'ガス', '石油', '警備', 'ビルメンテナンス', '清掃', '自動車整備',
  '製造', '生産', '加工', 'メンテナンス', '設計', '施工管理', '生産技術', '品質管理', '研究開発', '購買',
  '営業', '販売', '企画', '総合職', '技術職',
  // 地域×新卒（地方SMEを掘る）
  '北海道 新卒', '青森 新卒', '岩手 新卒', '宮城 新卒', '仙台 新卒', '秋田 新卒', '山形 新卒', '福島 新卒',
  '茨城 新卒', '栃木 新卒', '群馬 新卒', '埼玉 新卒', '千葉 新卒', '東京 新卒', '神奈川 新卒', '横浜 新卒',
  '新潟 新卒', '富山 新卒', '石川 新卒', '福井 新卒', '山梨 新卒', '長野 新卒', '岐阜 新卒', '静岡 新卒',
  '愛知 新卒', '名古屋 新卒', '三重 新卒', '滋賀 新卒', '京都 新卒', '大阪 新卒', '兵庫 新卒', '神戸 新卒',
  '奈良 新卒', '和歌山 新卒', '鳥取 新卒', '島根 新卒', '岡山 新卒', '広島 新卒', '山口 新卒', '徳島 新卒',
  '香川 新卒', '愛媛 新卒', '高知 新卒', '福岡 新卒', '北九州 新卒', '佐賀 新卒', '長崎 新卒', '熊本 新卒',
  '大分 新卒', '宮崎 新卒', '鹿児島 新卒', '沖縄 新卒',
];

async function run() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const SEEN = OUT.replace(/\.csv$/, '') + '.seen.txt';

  log('除外索引（統合マスタ＋CRM）を構築中…');
  const excl = buildExclusion();

  // 再開
  const outRows = [];
  const rawRows = [];
  const seen = new Set();
  const tierOf = (label) => (label === '採用担当者名' ? 1 : label === '代表者名' ? 2 : 3);
  const collected = new Set(); // 出力済み社名（複数卒年/媒体をまたいだ社の二重計上を防ぐ）
  if (fs.existsSync(OUT)) { try { for (const r of readCsv(fs.readFileSync(OUT, 'utf8')).records) { r._tier = tierOf(r['連絡先区分']); outRows.push(r); if (r.corpID) seen.add(String(r.corpID)); const k = mkey(r['企業名']); if (k) collected.add(k); } } catch (_) {} }
  if (fs.existsSync(RAW)) { try { for (const r of readCsv(fs.readFileSync(RAW, 'utf8')).records) { rawRows.push(r); if (r.corpID) seen.add(String(r.corpID)); } } catch (_) {} }
  if (fs.existsSync(SEEN)) { try { for (const l of fs.readFileSync(SEEN, 'utf8').split(/\r?\n/)) { const s = l.trim(); if (s) seen.add(s); } } catch (_) {} }
  log(`再開: 資格クリア ${outRows.length}社 ｜ 新規×担当者名(生) ${rawRows.length}社 ｜ seen ${seen.size}社`);

  const keywords = (process.env.ICP_FRESH_KEYWORDS && fs.existsSync(process.env.ICP_FRESH_KEYWORDS))
    ? fs.readFileSync(process.env.ICP_FRESH_KEYWORDS, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    : DEFAULT_KEYWORDS;

  const flush = () => {
    // ユーザー指定の優先順位: 採用担当者名(1) → 代表者名(2) → 名前なし(3)、各ティア内はアポ期待度降順
    outRows.sort((a, b) => {
      const ta = a._tier || 3, tb = b._tier || 3;
      if (ta !== tb) return ta - tb;
      return (parseInt(b['アポ期待度']) || 0) - (parseInt(a['アポ期待度']) || 0);
    });
    safeWrite(OUT, toCsv(OUT_COLS, outRows));
    safeWrite(RAW, toCsv(RAW_COLS, rawRows));
    safeWrite(SEEN, [...seen].join('\n'));
  };

  const sc = new MynaviScraper({ gradYear: GRAD_YEAR });
  await sc.launch();
  let processed = 0, skippedExisting = 0, scraped = 0;
  const stats = { named: 0, netNewNamed: rawRows.length };
  try {
    for (const kw of keywords) {
      if (outRows.length >= TARGET) break;
      if (seen.size >= MAX_COMPANIES) { log(`上限 ${MAX_COMPANIES}社`); break; }
      let found = [];
      try { found = await sc.discoverCorpIds(kw); } catch (e) { log(`discover ERR "${kw}": ${String(e).slice(0, 60)}`); continue; }
      const cand = found.filter((f) => !seen.has(String(f.id)));
      // 先に社名で既存(マスタ/CRM)を除外＝スクレイプ節約
      const fresh = [], skipped = [];
      for (const f of cand) { const k = mkey(f.name); if (excl.has(f.name) || (k && collected.has(k))) skipped.push(f); else fresh.push(f); }
      skippedExisting += skipped.length;
      for (const f of skipped) seen.add(String(f.id)); // 既存は二度と見ない
      log(`🔍 "${kw}": 掲載${found.length} 新規候補${cand.length} → 既存除外${skipped.length} 探索対象${fresh.length} ｜ 資格${outRows.length}/${TARGET}`);
      for (const f of fresh) {
        if (outRows.length >= TARGET) break;
        seen.add(String(f.id));
        const r = await withTimeout(sc.scrapeByCorp(f.id, f.name), PER_COMPANY_MS, () => ({ 根拠: 'timeout', corpID: f.id, 企業名: f.name }));
        scraped++;
        const rec = {
          企業名: r.企業名 || f.name, corpID: f.id, 法人番号: r.法人番号 || '',
          採用担当者名: r.採用担当者名 || '', 担当者確度: r.担当者確度 || '', パターン: r.パターン || '',
          役職: r.役職 || '', 部署: r.部署 || '', メール: r.メール || '', 電話番号: r.電話番号 || '',
          従業員数: r.従業員数 || '', 募集職種: r.募集職種 || '', 採用予定人数: r.採用予定人数 || '',
          卒年: r.卒年 || GRAD_YEAR, 採用ページURL: r.採用ページURL || '',
          掲載媒体: 'マイナビ', 新卒フラグ: '新', 取得日: new Date().toISOString().slice(0, 10),
        };
        // 二重チェック: 実社名の正規化でも既存に当たれば新規でない
        rec.企業名 = cleanDisplay(rec.企業名);
        const k2 = mkey(rec.企業名);
        if (excl.has(rec.企業名) || (k2 && collected.has(k2))) { if (++processed % 20 === 0) flush(); continue; }
        if (has(rec.採用担当者名)) { rawRows.push({ ...rec }); stats.netNewNamed++; }
        const ev = evaluate(rec);
        if (ev.qualifies) {
          rec.採用担当者名 = ev.nameOk ? ev.clean : '';
          rec.代表者名 = ev.repOk ? ev.rep : (rec.代表者名 || '');
          rec.連絡先区分 = TIER_LABEL[ev.tier];
          rec.架電宛名 = ev.contact ? ((rec.部署 ? rec.部署 + ' ' : '') + ev.contact + ' 様') : (rec.部署 ? rec.部署 + ' ご採用ご担当者様' : 'ご採用ご担当者様');
          rec.業種 = rec.業種 || '';
          rec.アポ期待度 = ev.m.total; rec.優先度 = ev.m.priority; rec.確信度 = ev.m.confidence;
          rec.MOCHICA適合 = ev.m.total >= 80 ? '◎' : ev.m.total >= 65 ? '○' : '△';
          rec._tier = ev.tier; // 並べ替え用
          rec.フィットティア = 'S:完全適合(新規発掘)';
          rec.完全適合根拠 = `完全新規｜${TIER_LABEL[ev.tier]}${ev.contact ? '(' + ev.contact + ')' : ''}｜新卒媒体掲載｜従業員${ev.emp}名(100-2000)｜非IT｜電話妥当`;
          const o = {}; for (const c of OUT_COLS) o[c] = rec[c] != null ? rec[c] : '';
          o._tier = ev.tier;
          outRows.push(o);
          if (k2) collected.add(k2);
          if (ev.tier <= 2) log(`  ✅[${TIER_LABEL[ev.tier]}] ${rec.企業名} / ${ev.contact} / 従${ev.emp} / apo${ev.m.total} → ${outRows.length}/${TARGET}`);
        }
        if (++processed % 10 === 0) { flush(); log(`  …処理${processed} 探索${scraped} 既存除外${skippedExisting} 新規名(生)${stats.netNewNamed} 資格${outRows.length}（担当者名${outRows.filter(r=>r._tier===1).length}/代表${outRows.filter(r=>r._tier===2).length}/名なし${outRows.filter(r=>r._tier===3).length}）`); }
        await sleep(DELAY);
      }
      flush();
    }
  } finally { flush(); await sc.close().catch(() => {}); }
  const t1 = outRows.filter((r) => r._tier === 1).length, t2 = outRows.filter((r) => r._tier === 2).length, t3 = outRows.filter((r) => r._tier === 3).length;
  log(`完了: 探索${scraped}社 既存除外${skippedExisting} 資格クリア${outRows.length}/${TARGET}（採用担当者名${t1}/代表者名${t2}/名前なし${t3}）`);
  log(`出力: ${OUT}`);
}

const RAW_COLS = ['企業名', 'corpID', '法人番号', '採用担当者名', '担当者確度', 'パターン', '役職', '部署',
  'メール', '電話番号', '従業員数', '募集職種', '採用予定人数', '卒年', '採用ページURL', '掲載媒体', '新卒フラグ', '取得日'];

if (require.main === module) run().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
module.exports = { buildExclusion, evaluate, EMP_MIN, EMP_MAX, stripAnn, mkey, cleanDisplay };
