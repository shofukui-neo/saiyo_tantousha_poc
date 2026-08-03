'use strict';
/**
 * 展示会リード（名刺スキャン）の追加調査＋ICPスコアリング ── 2026-07 v1
 * =====================================================================
 * HR EXPO 等の来場者スキャンリストは「熱はあるが玉石混交」。ブースの熱量シグナルだけで架電順を決めると、
 * 出展社（同業）・個人事業主・IT/ソフト（成約率6%＝構造的不適合）に工数を溶かす。
 * ここでは以下の順で機械的に落とし、残ったものだけをICPスコアで並べる。
 *
 *   ① 社内マスタ突合   : MOCHICA既存顧客 / 納品済み台帳 / BALES既存リード（アプローチ禁止・他社ATS）
 *   ② ハード除外       : 出展社側・人材/ATS競合・個人/フリーランス・IT/ソフト（icp-rules）・保険営業支社
 *   ③ ICPフロア        : 従業員100-2000名（スイート300-500）・新卒6名以上（icp-rules）
 *   ④ ソフトスコア     : 部署/役職の決裁近接 × 展示会の熱量（評価・商談ニーズ・DOC/OM・スキャン回数）
 *
 * 入力: --in <JSON>  … 1社1オブジェクト（同一社の複数スキャンは事前に集約）
 *   { n:社名, c:担当者, d:部署, t:役職, m:メール, p:電話, pref, city, type:来場者タイプ,
 *     scans:スキャン回数, first:"HH:MM"(初回スキャン), rate:最高評価(0-5), need:商談ニーズ有無,
 *     tags:"DOC;OM;RPO;Bスポンサーズ", memo:備考 }
 * 出力: --out <CSV>  … 判定/スコア/根拠つきの架電順リスト
 *
 * 使い方:
 *   node src/score-expo-leads.js --in scratch/expo-leads.json --out out/expo-scored.csv
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, normCompanyName } = require('./csv');
const { indexPut, indexGet } = require('./company-match');
const { buildExclusionIndex } = require('./exclusion-index');
const { ICP, isExcludedIndustry, proposalTier } = require('./icp-rules');

const DATA = path.join(__dirname, '..', 'data');
const F = {
  customers: path.join(DATA, 'MOCHICAの既存顧客リスト - mochica-companies-list.csv'),
  ledger: path.join(DATA, '_delivered-ledger.csv'),
  bales: path.join(DATA, 'BALESCLOUDの既存リスト - 202607062007_leadList_utf-8.csv'),
  consolidated: path.join(DATA, 'leads-consolidated-all.csv'),
};

// --- 展示会リード固有の除外辞書 ---------------------------------------------
// 出展社側/同業（人材・RPO・ATS・研修媒体）は「顧客」ではなく「同業の情報収集」。名指しで落とす。
const COMPETITOR_RE = /(パーソル|リクルート|エン・?ジャパン|エン株式会社|DONUTS|ジョブカン|ステラス|JobSuite|ソフトブレーン|マイナビ|ディップ|レバレジーズ|ROSCA|MATCHMAKER|HINDWILL|ネオキャリア)/i;
// 個人・フリーランス・屋号レベル（法人実体が薄く、新卒採用の母数がない）
const SOLO_RE = /(フリーランス|個人事業|屋号)/;
const FREE_MAIL_RE = /@(gmail|yahoo|outlook|hotmail|icloud|posteo|t-com|nifty|ezweb|docomo)\./i;
// 保険・金融の営業支社（＝募集人/営業職の採用。新卒ATSの購買主体ではない）
const SALES_BRANCH_RE = /(FA支社|第\d+支社|支社|営業所|開発営業部|営業本部)/;
// icp-rules の絶対除外に載らない IT ラベルの補完（CRM/統合マスタの粒度ゆれ吸収）。
// 「情報通信」「ゲーム」「RPA」は実体がソフト/ゲーム開発でも icp-rules の細分ラベルに当たらないことがある。
const IT_EXTRA_RE = /(情報通信|ゲーム|RPA|ＲＰＡ|DX開発|ITサービス)/i;
// 逆営業リスク（自社サービスを売りに来た営業部門）。採用の当事者ではないので窓口として弱い。
const REVERSE_SALES_RE = /(法人営業|営業本部|営業部|営業企画|販売企画|セールス|マーケティング)/;
// 人材・研修・人事BPO（＝MOCHICAの買い手ではなく提携先/競合になりうる。除外はせず見極めへ回す）
const HR_VENDOR_RE = /(人材|研修|人事BPO|HRサービス)/;
// 採用決裁に遠い部署（同じ企業でも窓口として弱い＝スコアで落とす、除外はしない）
const FAR_DEPT_RE = /(営業|マーケティング|知的財産|法務|技術統括|開発|プロダクト|プロモ|事業企画|事業部|制作|プロダクション|センター推進)/;
const HR_DEPT_RE = /(人事|採用|人材開発|人財|人材活躍|労務|総務|管理部|研修|ものづくり塾|教育)/;
const SENIOR_TITLE_RE = /(代表|社長|役員|本部長|統括|部長|センター長|エキスパート)/;
const MID_TITLE_RE = /(課長|マネージャ|マネジャ|リーダー|主任|主査|主事|ユニット長|Chief)/i;

/**
 * 公知情報による業種・規模の補完（社内マスタに無い上場/著名企業向け）。
 * 出所は「公知」として出力に明示する（推測値をマスタ値と混ぜない）。
 * emp は連結ではなく単体規模の目安。ICPは“採用の意思決定単位”を見たいため単体を採る。
 */
const KNOWN = {
  'トヨタ自動車': { ind: '自動車', emp: 70000 },
  'ソニー': { ind: '電機', emp: 3000 },
  'キリンホールディングス': { ind: '食品', emp: 1000 },
  'キリンビバレッジ': { ind: '食品', emp: 3000 },
  'キリンシティ': { ind: '外食', emp: 400 },
  'ニトリ': { ind: '小売', emp: 5000 },
  'ダイキン工業': { ind: '機械', emp: 8000 },
  'セイコーエプソン': { ind: '電機', emp: 12000 },
  'コカ・コーラボトラーズジャパン': { ind: '食品', emp: 9000 },
  'オムロンソーシアルソリューションズ': { ind: '機械', emp: 2000 },
  'パナソニックエレクトリックワークス': { ind: '電機', emp: 10000 },
  'パナソニックマーケティングジャパン': { ind: '電機', emp: 4000 },
  'ネスレネスプレッソ': { ind: '食品', emp: 500 },
  'ダイフク': { ind: '機械', emp: 4000 },
  'キオクシア': { ind: '電機', emp: 12000 },
  'サミー': { ind: '機械', emp: 1500 },
  'サントリーロジスティクス': { ind: '運輸・物流', emp: 500 },
  'Daigasエナジー': { ind: 'エネルギー', emp: 1000 },
  'TPR': { ind: '自動車部品', emp: 1000 },
  'ショウワノート': { ind: '印刷・紙', emp: 300 },
  'パルシステム生活協同組合連合会': { ind: '生協', emp: 1000 },
  '図書館流通センター': { ind: 'その他サービス', emp: 5000 },
  'オリジン東秀': { ind: '外食', emp: 1000 },
  'アルティウスリンク': { ind: 'コールセンター', emp: 20000 },
  'SMBCコンシューマーファイナンス': { ind: '金融', emp: 2000 },
  'トヨタモビリティパーツ': { ind: '自動車部品', emp: 2000 },
  'トヨタバッテリー': { ind: '自動車部品', emp: 500 },
  'エアロトヨタ': { ind: '自動車', emp: 200 },
  'いすゞユニテック': { ind: '自動車部品', emp: 500 },
  'JSRビジネスサービス': { ind: 'その他ビジネスサービス', emp: 300 },
  'ダイヤモンドオフィスサービス': { ind: 'その他ビジネスサービス', emp: 300 },
  'ケミカルグラウト': { ind: '建設', emp: 400 },
  'ダイトーケミックス': { ind: '化学', emp: 400 },
  'EAファーマ': { ind: '医薬品', emp: 700 },
  'シンバイオ製薬': { ind: '医薬品', emp: 100 },
  'ピンゴルフジャパン': { ind: 'スポーツ用品', emp: 100 },
  'ウェルネスコミュニケーションズ': { ind: '医療・ヘルスケア', emp: 200 },
  'エムシーファッション': { ind: 'アパレル', emp: 200 },
  'アイナックス稲本': { ind: '商社', emp: 200 },
  'エバタ': { ind: '建材', emp: 300 },
  'キーパー': { ind: '住宅設備', emp: 200 },
  'シーラックパル': { ind: '外食', emp: 300 },
  'アカルタスホールディングス': { ind: '福祉サービス', emp: 300 },
  'デイナイト': { ind: '広告・販促', emp: 100 },
  'エクネス': { ind: '製造', emp: 100 },
  'スクエアライン': { ind: '建設・設備', emp: 100 },
  'デコラート': { ind: '内装・装飾', emp: 50 },
  '展示会ブース装飾': { ind: '内装・装飾', emp: 30 },
  'ビルディングデザイン': { ind: '不動産・建築', emp: 50 },
  'オリエント商事': { ind: '商社', emp: 100 },
  'アイアール債権回収': { ind: '金融', emp: 200 },
  'アーク東短オルタナティブ': { ind: '金融', emp: 50 },
  '光通信': { ind: '商社・通信販売', emp: 5000 },
  '大塚商会': { ind: '商社', emp: 8000 },
  'NTT健康保険組合': { ind: '健康保険組合', emp: 100 },
  'ANAビジネスソリューション': { ind: '人材・研修', emp: 500 },
  'エイチアールワン': { ind: '人事BPO', emp: 700 },
  'パーソルビジネスプロセスデザイン': { ind: '人事BPO', emp: 3000 },
  'ソフトバンクロボティクス': { ind: 'ロボティクス', emp: 500 },
  'MSR': { ind: 'その他ビジネスサービス', emp: 300 },
  'Treead': { ind: 'その他サービス', emp: 100 },
  'オープン': { ind: '不動産', emp: 300 },
  'EH': { ind: 'その他ビジネスサービス', emp: 100 },
  'アクサ生命保険': { ind: '保険', emp: 8000 },
  'ソニー生命保険': { ind: '保険', emp: 10000 },
  'SOMPOひまわり生命保険': { ind: '保険', emp: 3000 },
  'QUICK': { ind: '情報提供（金融）', emp: 800 },
  'デザインネットワーク': { ind: '広告・デザイン', emp: 300 },
  'ANEOS': { ind: 'その他サービス', emp: 100 },
  // --- IT/ソフト（icp-rules の絶対除外に載せるため業種名を明示） ---
  '日立社会情報サービス': { ind: '情報処理', emp: 1500 },
  'CTCテクノロジー': { ind: '情報処理', emp: 2000 },
  'AGS': { ind: '情報処理', emp: 900 },
  'DAIKOXTECH': { ind: 'システム開発', emp: 1000 },
  'FPTジャパンホールディングス': { ind: 'システム開発', emp: 3000 },
  'NECネクサソリューションズ': { ind: '情報処理', emp: 2500 },
  'NECビジネスインテリジェンス': { ind: '情報処理', emp: 2000 },
  'NRIデータiテック': { ind: '情報処理', emp: 1000 },
  'NTTデータウィズ': { ind: 'システム開発', emp: 1000 },
  'NTTテクノクロス': { ind: 'ソフトウエア', emp: 1000 },
  'PFU ITサービス': { ind: '情報処理', emp: 500 },
  'PHONEAPPLI': { ind: 'ソフトウエア', emp: 200 },
  'Sansan': { ind: 'ソフトウエア', emp: 1500 },
  'キヤノンITソリューションズ': { ind: 'ソフトウエア', emp: 4000 },
  'コムチュア': { ind: 'ソフトウエア', emp: 2000 },
  'コムチュアネットワーク': { ind: 'ソフトウエア', emp: 500 },
  'エクスウェア': { ind: 'ソフトウエア', emp: 200 },
  'アイエックスナレッジ': { ind: '情報処理', emp: 1200 },
  'ULSコンサルティング': { ind: 'ITコンサル', emp: 300 },
  'ソシオークヒューテック': { ind: 'システム開発', emp: 100 },
  'エバーネットデータ': { ind: '情報処理', emp: 100 },
  'ACALL': { ind: 'ソフトウエア', emp: 100 },
  'GeNiE': { ind: 'ソフトウエア', emp: 50 },
  'QunaSys': { ind: 'ソフトウエア', emp: 100 },
  'KRAFTON JAPAN': { ind: 'ゲーム・エンタメ', emp: 100 },
  'DONUTS': { ind: 'ソフトウエア', emp: 800 },
  'ステラス': { ind: 'ソフトウエア', emp: 100 },
  'コニカミノルタジャパン': { ind: 'ソフトウエア', emp: 3000 },
};
// 表記ゆれでも引けるよう全キー系統で登録（company-match.indexPut）
const KNOWN_INDEX = Object.entries(KNOWN).reduce((m, [k, v]) => indexPut(m, k, v), new Map());

/**
 * 実地調査で裏取りした値（2026-07-29 / 公式採用サイト・マイナビ・gBizINFO等）。最優先で採用する。
 * BALESのCRM入力値は歯抜け・陳腐化があり（例: EAファーマ従業員12名/TPR新卒1名）、
 * これを鵜呑みにするとフロア判定で優良企業を落とす。裏取り済みの軸だけ上書きする。
 */
const VERIFIED = {
  'ＥＡファーマ': { emp: 917, hire: 11, ind: '医薬品', note: '公式:917名(2025/3)・27卒11～15名。BALESの従業員12名は誤り' },
  'アイナックス稲本': { emp: 329, hire: 6, ind: '産業機械', note: 'マイナビ2027:329名(2026/1)・新卒6～10名。業務用洗濯機メーカー' },
  'JSRビジネスサービス': { emp: 68, ind: 'その他ビジネスサービス', note: '従業員68名=規模フロア未満（JSR本体の管理受託会社）' },
  'キリンシティ': { emp: 149, ind: '外食', note: '公式:社員149名。中途採用中心(2025年度15名)・新卒数は要確認' },
  'TPR': { emp: 855, hire: 6, ind: '自動車部品', note: '公式:単体855名/連結6925名・高卒含む新卒採用実施。BALESの新卒1名は陳腐化' },
  'オープン': { emp: 175, ind: 'ソフトウエア(RPA/AI)', note: 'RPA/AI活用の情報処理・BPO。150～200名' },
  'アカルタスホールディングス': { emp: 11, ind: '産業廃棄物処理', note: 'HD単体11名(2022)。BALES300名はグループ値の疑い・現場所感も「採用以外」' },
  'ウェルネス・コミュニケーションズ': { emp: 121, ind: '健診・健康管理SaaS', note: '121名。来訪は法人営業本部2名＝逆営業の可能性' },
  'デイ・ナイト': { emp: 99, ind: 'ホール・貸会議室運営', note: 'NTTグループ。従業員99名前後（60～231名で諸説）' },
  'エクネス': { emp: 40, ind: 'マーケティング支援', note: '2018年設立ベンチャー(ロボットレター)。規模フロア未満の見込み・要確認' },
};
const VERIFIED_INDEX = Object.entries(VERIFIED).reduce((m, [k, v]) => indexPut(m, k, v), new Map());

// 採用人数(選択リスト) "6～10名" → 6（レンジ下限＝保守的に採る）
function parseHireRange(s) {
  const t = String(s || '').replace(/[～~－-]/g, '~');
  const m = t.match(/(\d+)/);
  if (!m || /不明/.test(t)) return null;
  return parseInt(m[1], 10);
}
function parseIntOrNull(v) {
  const n = parseInt(String(v || '').replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}
function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

// --- マスタ読み込み ---------------------------------------------------------
function loadMasters() {
  // 除外索引は exclusion-index.js に集約（2026-07-30）。展示会リードは元々BALES/SFの
  // リードであることが前提なので、ハード除外に使うのは「既存顧客」と「納品済み台帳」のみ
  // （BALES/SF被りは除外理由にならない）。突合キーは他経路と同一＝表記ゆれも拾う。
  const excl = buildExclusionIndex({ layers: ['customers', 'ledger'], quiet: true }).idx;

  // BALES既存リード: 同一社に複数リードがあるので「最も情報量の多い1件」を残す
  const balesBest = new Map(); // 正規化社名 -> {name, cand}
  if (fs.existsSync(F.bales)) {
    for (const r of readCsv(fs.readFileSync(F.bales, 'utf8')).records) {
      const key = normCompanyName(r['会社情報：会社名']);
      if (!key) continue;
      const cand = {
        industry: (r['会社情報：業種'] || '').trim(),
        emp: parseIntOrNull(r['会社情報：従業員規模']),
        hire: parseHireRange(r['カスタム情報：採用人数(選択リスト)']),
        stage: (r['リード関連情報：最終リードステージ'] || '').trim(),
        ats: (r['カスタム情報：利用中ATS'] || '').trim(),
        ban: (r['カスタム情報：アプローチ禁止の種類'] || '').trim(),
        issue: (r['カスタム情報：顧客の課題感'] || '').trim(),
        kento: (r['カスタム情報：検討開始時期'] || '').trim(),
        lost: (r['カスタム情報：失注商談失注理由大'] || '').trim(),
      };
      const score = (o) => (o.emp ? 2 : 0) + (o.hire ? 2 : 0) + (o.industry ? 1 : 0) + (o.ats && o.ats !== '無し' ? 1 : 0) + (o.ban ? 3 : 0);
      const prev = balesBest.get(key);
      if (!prev || score(cand) > score(prev.cand)) balesBest.set(key, { name: r['会社情報：会社名'], cand });
    }
  }
  // 表記ゆれ（旧字体/カナ/長音/支店）でも引き当てられるよう別名キーを張る。
  // strict キーだけだと既存リードのATS/禁止/課題感を取りこぼし、被り判定が甘くなる。
  const bales = new Map();
  for (const { name, cand } of balesBest.values()) indexPut(bales, name, cand);

  // 統合マスタ（従業員数・採用予定人数の補完）
  const cons = new Map();
  if (fs.existsSync(F.consolidated)) {
    for (const r of readCsv(fs.readFileSync(F.consolidated, 'utf8')).records) {
      const key = normCompanyName(r['企業名']);
      if (!key || cons.has(key)) continue;
      indexPut(cons, r['企業名'], {
        emp: parseIntOrNull(r['従業員数']),
        hire: parseIntOrNull(r['採用予定人数']),
        industry: (r['業種'] || '').trim(),
        listed: (r['上場'] || '').trim(),
      });
    }
  }
  return { excl, bales, cons };
}

// --- 1社の判定 --------------------------------------------------------------
function judge(lead, M) {
  // 引き当ては全キー系統（正規化社名／農協／表記ゆれ／長音ゆれ）で行う
  const b = indexGet(M.bales, lead.n) || {};
  const c = indexGet(M.cons, lead.n) || {};
  const k = indexGet(KNOWN_INDEX, lead.n) || {};
  const v = indexGet(VERIFIED_INDEX, lead.n) || {};

  // 優先順: 実地調査(裏取り済) > BALES(CRM) > 統合マスタ > 公知の目安
  const industry = v.ind || b.industry || c.industry || k.ind || '';
  const indSrc = v.ind ? '実地調査' : (b.industry ? 'BALES' : (c.industry ? '統合マスタ' : (k.ind ? '公知' : '')));
  const emp = v.emp != null ? v.emp : (b.emp != null ? b.emp : (c.emp != null ? c.emp : (k.emp != null ? k.emp : null)));
  const empSrc = v.emp != null ? '実地調査' : (b.emp != null ? 'BALES' : (c.emp != null ? '統合マスタ' : (k.emp != null ? '公知' : '')));
  const hire = v.hire != null ? v.hire : (b.hire != null ? b.hire : (c.hire != null ? c.hire : null));
  const hireSrc = v.hire != null ? '実地調査' : (b.hire != null ? 'BALES' : (c.hire != null ? '統合マスタ' : ''));

  const dept = String(lead.d || '');
  const title = String(lead.t || '');
  const tags = String(lead.tags || '');
  const excludeLabel = M.excl.matchLabel(lead.n);
  const after13 = /^\d{2}:\d{2}$/.test(lead.first || '') && lead.first >= '13:00';
  const why0 = [];

  // ブースでの熱量が強い先（架電済アポ獲得／高評価＋商談ニーズ）は、CRM由来の古い採用人数で機械的に落とさない。
  // 「1名しか採らない」が数年前の入力である事故（例: TPR＝実際は高卒含め継続採用）を防ぐための救済。
  const hotSignal = /アポ獲得/.test(lead.memo || '') || (lead.rate >= 4 && lead.need);

  const hard = [];
  if (excludeLabel) hard.push(excludeLabel);
  if (lead.type === 'exhibitingDelegate') hard.push('出展社側（同業）');
  if (COMPETITOR_RE.test(lead.n)) hard.push('人材/RPO/ATS競合');
  if (b.ban) hard.push('アプローチ禁止:' + b.ban);
  if (SOLO_RE.test(dept + title) || (FREE_MAIL_RE.test(lead.m || '') && !/株式会社|有限会社|合同会社/.test(lead.n))) hard.push('個人/フリーランス（法人実体薄）');
  if (isExcludedIndustry(industry) || IT_EXTRA_RE.test(industry)) hard.push('IT・ソフト（ICP絶対除外）');
  if (/保険/.test(industry) && SALES_BRANCH_RE.test(dept) && !HR_DEPT_RE.test(dept)) hard.push('保険営業支社（募集人採用）');
  if (emp != null && emp < ICP.EMP_MIN) hard.push(`従業員${emp}名<${ICP.EMP_MIN}（規模フロア未満）`);
  if (hire != null && hire < ICP.HIRE_MIN) {
    if (hotSignal && hireSrc === 'BALES') why0.push(`新卒${hire}名(BALES旧値)だが現場シグナル強のため保留`);
    else hard.push(`新卒${hire}名<${ICP.HIRE_MIN}（採用フロア未満）`);
  }
  if (!String(lead.p || '').trim() && !String(lead.m || '').trim()) hard.push('連絡先なし');

  // ソフトスコア
  let s = 0; const why = why0.slice();
  if (v.note) why.push('調査:' + v.note);
  if (REVERSE_SALES_RE.test(dept) && !HR_DEPT_RE.test(dept)) { s -= 1; why.push('営業部門の来訪＝逆営業の可能性'); }
  // 人材・研修・人事BPO業は「自社の新卒採用」ではなく提携/競合の下見で来ることが多い。落とさず見極め扱い。
  if (HR_VENDOR_RE.test(industry)) { s -= 2; why.push('人材/研修/人事BPO業＝提携・競合の見極め要'); }
  if (emp == null) { why.push('規模不明(要確認)'); }
  else if (emp >= ICP.EMP_SWEET_MIN && emp <= ICP.EMP_SWEET_MAX) { s += 3; why.push(`従業員${emp}名=スイート`); }
  else if (emp >= ICP.EMP_MIN && emp <= 1000) { s += 2; why.push(`従業員${emp}名=有効`); }
  else if (emp <= ICP.EMP_MAX) { s += 1; why.push(`従業員${emp}名=有効(上限)`); }
  else { s -= 1; why.push(`従業員${emp}名=大企業(自前/競合ATS濃厚)`); }

  if (hire != null && hire >= ICP.HIRE_MIN) { s += 3; why.push(`新卒${hire}名+`); }
  else if (hire != null) { why.push(`新卒${hire}名`); }

  if (HR_DEPT_RE.test(dept)) { s += 3; why.push('人事/採用/総務の当事者'); }
  else if (FAR_DEPT_RE.test(dept)) { s -= 2; why.push('採用決裁から遠い部署'); }
  if (SENIOR_TITLE_RE.test(title)) { s += 2; why.push('決裁層(' + title + ')'); }
  else if (MID_TITLE_RE.test(title)) { s += 1; why.push('中間層(' + title + ')'); }

  if (lead.rate >= 5) { s += 3; why.push('ブース評価5'); }
  else if (lead.rate === 4) { s += 2; why.push('ブース評価4'); }
  else if (lead.rate === 3) { s += 1.5; why.push('ブース評価3'); }
  else if (lead.rate === 2) { s -= 1; why.push('ブース評価2(可能性低)'); }
  if (lead.need) { s += 2; why.push('商談ニーズあり'); }
  if (/DOC/.test(tags)) { s += 1; why.push('DOC(資料/商談化)'); }
  if (/OM/.test(tags)) { s += 0.5; why.push('OM'); }
  if ((lead.scans || 0) >= 3) { s += 1; why.push(`ブース接触${lead.scans}回`); }
  if (/アポ獲得/.test(lead.memo || '')) { s += 5; why.push('架電済:アポ獲得'); }
  if (/可能性：低|離脱|採用以外/.test(lead.memo || '')) { s -= 2; why.push('現場所感:低'); }
  if (b.ats && b.ats !== '無し') { s -= 2; why.push('他社ATS:' + b.ats); }
  if (b.kento) { s += 1.5; why.push('検討開始時期:' + b.kento); }
  if (after13) why.push('13時以降=全社共有（他ニーズ可）');

  // 規模が判明していない先は「ICP適合」と言い切れない＝A/Bには入れず、必ず要確認(C)へ落とす。
  let rank = hard.length ? '除外' : (s >= 9 ? 'A' : s >= 6 ? 'B' : s >= 3 ? 'C' : 'D');
  if (emp == null && (rank === 'A' || rank === 'B')) { rank = 'C'; why.push('規模未判明のため要確認どまり'); }
  const tier = proposalTier(emp);

  return {
    企業名: lead.n,
    判定: rank,
    スコア: Math.round(s * 10) / 10,
    除外理由: hard.join(' / '),
    担当者: lead.c,
    部署: dept,
    役職: title,
    電話番号: lead.p,
    メール: lead.m,
    都道府県: lead.pref,
    業種: industry,
    業種出所: indSrc,
    従業員数: emp == null ? '' : emp,
    規模出所: empSrc,
    新卒採用人数: hire == null ? '' : hire,
    採用数出所: hireSrc,
    セグメント: tier.segment,
    提案プラン: tier.plan,
    ブース評価: lead.rate || '',
    商談ニーズ: lead.need ? 'あり' : '',
    タグ: tags,
    スキャン回数: lead.scans || '',
    初回スキャン: lead.first || '',
    全社共有枠: after13 ? '○(13時以降)' : '',
    調査メモ: v.note || '',
    BALES最終ステージ: b.stage || '',
    利用中ATS: b.ats || '',
    既存接点: b.stage ? 'BALES既存リードあり' : '',
    根拠: why.join(' / '),
    現場メモ: lead.memo || '',
  };
}

function main() {
  const inFile = arg('in', '');
  const outFile = arg('out', 'expo-scored.csv');
  if (!inFile || !fs.existsSync(inFile)) { console.error('--in <leads.json> が必要です'); process.exit(1); }
  const leads = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  const M = loadMasters();
  console.log(`マスタ: 除外索引${M.excl.size}社 / BALES${M.bales.size}社 / 統合${M.cons.size}社`);

  const rows = leads.map((l) => judge(l, M));
  const order = { A: 0, B: 1, C: 2, D: 3, 除外: 4 };
  rows.sort((a, b) => (order[a.判定] - order[b.判定]) || (b.スコア - a.スコア));

  const headers = Object.keys(rows[0]);
  fs.writeFileSync(outFile, '﻿' + toCsv(headers, rows), 'utf8');

  const tally = rows.reduce((m, r) => { m[r.判定] = (m[r.判定] || 0) + 1; return m; }, {});
  console.log('判定内訳: ' + Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(' / '));
  console.log('出力: ' + outFile);
  for (const r of rows.filter((x) => x.判定 === 'A' || x.判定 === 'B')) {
    console.log(`  [${r.判定}] ${r.スコア}\t${r.企業名}\t${r.業種}\t${r.従業員数}名\t${r.根拠}`);
  }
}
if (require.main === module) main();
module.exports = { judge, loadMasters, parseHireRange, KNOWN };
