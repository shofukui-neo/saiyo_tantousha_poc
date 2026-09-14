'use strict';
/**
 * hot-signal — 「採用シグナル」検出とホットリード採点の規則エンジン（単一の真実の源）
 * =====================================================================
 * 企業リストを上から架電する（＝誰に架けるかが固定）のではなく、
 * **採用ニーズが発生した瞬間**を捉えて架電先を毎日組み替えるための判定ロジック。
 * 依存なし・ネットワーク/APIキー不要（＝完全ローカル規則ベース、テスト可能）。
 *
 * ドライバ:
 *   harvest-signals.js     … PR TIMES 等からシグナル素材（リリース本文）を収集
 *   signal-store.js        … 日次スナップショットを蓄積し「求人急増／長期掲載」を差分で作る
 *   build-hotlead-list.js  … 収集＋差分＋採点＋除外突合 → 架電リストCSV
 *
 * ■ シグナルは2系統ある（ここが設計の核）
 *   (a) テキストシグナル … 1本のリリース/ニュース本文から読める出来事
 *                          （新拠点開設・M&A・資金調達・採用強化・外国人採用 …）
 *                          → detectSignals()
 *   (b) 差分シグナル     … 単発では読めず、**前回スナップショットとの比較**でしか出ない
 *                          （求人数 3→12 の急増・120日超の長期掲載・新規掲載開始）
 *                          → detectDeltaSignals()
 *   「求人急増」「採用できていない（長期掲載）」は (b) でしか作れない。だから
 *   スナップショットを毎日貯める signal-store が必須の構成要素になる。
 *
 * ■ 熱度(heat)の意味
 *   5 … 採用枠が今まさに増えた（大量求人・新店舗/新工場OPEN）＝架電理由が最も明確
 *   4 … 採用ニーズが発生する構造変化（M&A・資金調達・採用担当者募集・長期掲載・外国人採用）
 *   3 … 採用に投資する意思の表明（採用サイト刷新・ATS導入）
 *   2 … 採用活動の存在は分かるが緊急性が弱い（採用広報・SNS・インターン）
 *   1 … 通常の採用活動（内定式/入社式など）
 *
 * ■ 誤爆させないための3層（koso-signal と同じ流儀）
 *   1) シグナル規則 … 出来事を表す語と文脈語の同時成立を要求する
 *   2) 否定ガード   … 解説記事/ランキング/他社事例の紹介は落とす（GUIDE / NEG）
 *   3) 主体ガード   … 自治体・学校など企業リードにならない発信主体を落とす（NOT_COMPANY）
 */

// ── 正規化（全角→半角・空白畳み込み。boshudan-needs / talk-analysis と同一の流儀）──
const z2h = (s) => String(s || '').replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
const norm = (s) => z2h(s).replace(/[ \t　]+/g, ' ');

// ─────────────────────────────────────────────────────────────
// シグナル定義表
//   key      … 内部キー（CSV/JSONに出る）
//   heat     … 熱度1-5（上の凡例）
//   issue    … 推定課題（営業が最初に当てにいく仮説）
//   opener   … 架電の切り出し（{社名}{根拠} を差し込む）
//   re       … 判定正規表現（norm 済みテキストに当てる）
//   require  … 併存を要求する文脈語（無ければ不採用＝単語一致だけで撃たない）
// ─────────────────────────────────────────────────────────────
const SIGNALS = [
  {
    key: '大量求人開始', heat: 5, issue: '応募母数不足（枠が急に増えた）',
    opener: '{社名}様が採用を強化されているのを拝見しまして、枠が増えた分の母集団づくりで動かれているのではと思いお電話しました',
    re: /(大量採用|大量募集|採用(を)?(大幅に)?(強化|拡大|加速|増強)|採用人数[^。]{0,6}(拡大|増加|倍)|\d{2,4} ?名(規模)?(の)?(新規|中途|新卒)?採用|採用(計画|目標)[^。]{0,8}\d{2,4} ?名|積極採用|通年採用[^。]{0,4}開始|新卒採用[^。]{0,6}(開始|再開|拡大)|採用活動[^。]{0,4}(開始|再開))/,
  },
  {
    key: '新店舗OPEN', heat: 5, issue: '出店に伴う店舗人員の確保',
    opener: '{社名}様の新店舗オープンを拝見しまして、店舗立ち上げの人員確保のご状況を伺えればと思いお電話しました',
    re: /(新店舗|新規出店|新規オープン|グランドオープン|新装開店|\d+ ?号店|新規開業|初出店|旗艦店)/,
    require: /(オープン|開店|開業|出店|進出|展開)/,
  },
  {
    key: '新工場OPEN', heat: 5, issue: '生産拠点立ち上げに伴うまとまった採用',
    opener: '{社名}様の新拠点立ち上げを拝見しまして、立ち上げに伴う人員計画のところでお役に立てないかと思いお電話しました',
    re: /(新工場|第[二三四五2-5]工場|工場[^。]{0,6}(新設|新築|建設|増設|稼働開始|竣工)|生産拠点[^。]{0,8}(新設|増設|建設|開設)|新倉庫|物流(センター|拠点)[^。]{0,8}(新設|開設|稼働|竣工))/,
  },
  {
    key: '新拠点開設', heat: 5, issue: '新拠点の人員確保（採用予算が発生した直後）',
    opener: '{社名}様の新拠点開設を拝見しまして、立ち上げメンバーの採用でお困りではないかと思いお電話しました',
    // 同じ出来事を二重に数えない。工場/店舗の開設が既に立っていれば、その具体形に譲る。
    subsumedBy: ['新工場OPEN', '新店舗OPEN'],
    re: /(新拠点|新設拠点|拠点[^。]{0,6}(開設|新設|拡大|展開)|(営業所|支店|支社|事業所|センター)[^。]{0,6}(開設|新設|設立)|新オフィス|オフィス[^。]{0,6}(開設|拡張|増床))/,
  },
  {
    key: 'M&A・事業承継', heat: 4, issue: '統合後の組織再編に伴う人材再構築',
    opener: '{社名}様のグループ再編を拝見しまして、統合後の組織拡大フェーズの採用支援をしておりお電話しました',
    re: /(M&A|買収|譲受|子会社化|完全子会社|グループ[^。]{0,6}(参画|入り|加入)|経営統合|株式[^。]{0,8}(取得|譲渡)[^。]{0,10}(完了|実施|締結|について)|事業(承継|継承)|資本業務提携)/,
  },
  {
    key: '資金調達', heat: 4, issue: '調達後の増員計画（採用予算が確保された）',
    opener: '{社名}様の資金調達を拝見しまして、増員フェーズの採用でお役に立てないかと思いお電話しました',
    re: /(資金調達|シリーズ ?[A-Ea-e](ラウンド)?|プレシリーズ|第三者割当増資|\d+(\.\d+)? ?億円[^。]{0,8}(調達|出資|増資)|ラウンド[^。]{0,6}(実施|完了|クローズ)|出資を受け)/,
  },
  {
    key: '採用担当者募集', heat: 4, issue: '採用体制そのものが不足（採用に人を割けていない）',
    opener: '{社名}様が採用担当の増員をされているのを拝見しまして、体制づくりの部分でご支援できればと思いお電話しました',
    re: /((採用|人事|リクルーティング)(担当|責任者|マネージャー|リーダー|企画)[^。]{0,10}(募集|採用|増員|求人|新設|強化)|人事(部|課|チーム)[^。]{0,8}(新設|立ち上げ|発足)|採用チーム[^。]{0,6}(新設|立ち上げ|発足|増員))/,
  },
  {
    key: '外国人採用開始', heat: 4, issue: '人手不足の自覚あり（日本人採用にも余地）',
    opener: '{社名}様の人材確保のお取り組みを拝見しまして、新卒側の母集団づくりでもお役に立てないかと思いお電話しました',
    re: /(外国人(材|労働者|従業員|スタッフ)?[^。]{0,8}(採用|雇用|受入|受け入れ|活用)|特定技能|技能実習|育成就労|高度外国人材|海外人材[^。]{0,6}採用|グローバル人材[^。]{0,6}採用)/,
  },
  {
    key: '採用サイト刷新', heat: 3, issue: '採用に投資中（母集団が採れていない可能性）',
    opener: '{社名}様の採用サイトを拝見しまして、せっかくの発信を応募につなげる部分でお話できればと思いお電話しました',
    re: /(採用(サイト|ページ|特設サイト|ホームページ|HP|LP)[^。]{0,10}(公開|開設|新設|リニューアル|刷新|開始|リリース)|採用[^。]{0,4}オウンドメディア[^。]{0,8}(開設|公開))/,
  },
  {
    key: 'ATS導入・採用DX', heat: 3, issue: '採用改善に予算あり（歩留まり改善の関心が高い）',
    opener: '{社名}様が採用のDXを進めておられるのを拝見しまして、母集団側の打ち手も合わせてご紹介できればとお電話しました',
    re: /(採用管理システム|採用管理[^。]{0,4}ツール|ATS[^。]{0,8}(導入|活用|刷新)|採用DX|LINE[^。]{0,8}採用|採用[^。]{0,8}(自動化|効率化|デジタル化)[^。]{0,8}(導入|開始|推進)|(Indeed|求人検索エンジン)[^。]{0,8}(運用|活用|開始)|面接[^。]{0,6}(自動|AI)[^。]{0,6}(導入|開始))/,
  },
  {
    key: '採用広報開始', heat: 2, issue: '認知はあるが応募に転換できていない可能性',
    opener: '{社名}様の採用広報を拝見しまして、発信を応募数につなげる部分でお話できればと思いお電話しました',
    re: /(採用広報|採用ブランディング|社員(インタビュー|紹介)[^。]{0,10}(公開|開始|連載)|採用[^。]{0,6}(note|YouTube|Instagram|TikTok|SNS)[^。]{0,8}(開始|公開|運用))/,
  },
  {
    key: 'インターン募集', heat: 2, issue: '母集団形成の初期段階（早期接触に動いている）',
    opener: '{社名}様のインターンシップを拝見しまして、そこからの母集団づくりのお話ができればとお電話しました',
    re: /(インターンシップ|インターン)[^。]{0,10}(開催|募集|開始|受付|実施|エントリー)/,
  },
  {
    key: '事業拡大', heat: 2, issue: '拡大に人員が追いつかない可能性',
    opener: '{社名}様の事業拡大を拝見しまして、それに伴う人員計画のところでお話できればと思いお電話しました',
    re: /(事業拡大|業容拡大|新規事業[^。]{0,8}(開始|参入|立ち上げ)|過去最高[^。]{0,6}(売上|業績|受注|利益)|増収増益|大型(案件|受注|契約)|受注[^。]{0,6}(獲得|過去最高))/,
  },
  {
    key: '通常採用活動', heat: 1, issue: '採用活動は動いている（緊急性は弱い）',
    opener: '{社名}様の採用のお取り組みを拝見してお電話しました',
    re: /(内定式|入社式|新入社員[^。]{0,8}(研修|入社|配属)|会社説明会[^。]{0,8}(開催|実施)|合同説明会[^。]{0,8}(出展|参加))/,
  },
];
const SIGNAL_BY_KEY = new Map(SIGNALS.map((s) => [s.key, s]));

// ── 否定ガード ───────────────────────────────────────────────
// 解説記事・ランキング・調査レポートのタイトル（自社の出来事ではない）
const GUIDE = /とは|ランキング|おすすめ|徹底解説|完全ガイド|まとめ|比較|違い|なるには|\d+選|コツ|入門|基礎知識|注意点|メリット|デメリット|調査(結果|レポート)|白書|実態調査|アンケート(結果|調査)/;
// 他社事例の紹介（主語が自社ではない）
const NEG = /導入事例|お客様の声|支援事例|活用事例|事例紹介|セミナーレポート/;
// 企業リードにしない発信主体
const NOT_COMPANY = /(市役所|町役場|村役場|県庁|区役所|官公庁|自治体|独立行政法人|国立大学|大学$|大学院|高等学校|中学校|小学校|商工会議所|協議会$|実行委員会)/;
// 海外の拠点開設は国内の新卒採用需要を生まない（実測: 新工場8本中2本がタイ/グアテマラ工場だった）。
// 拠点系シグナルに限り、根拠文が海外を指していて国内地名を伴わない場合は採らない。
const OVERSEAS = /(タイ|ベトナム|インドネシア|フィリピン|マレーシア|シンガポール|ミャンマー|カンボジア|インド|中国|上海|深圳|台湾|韓国|米国|アメリカ|カナダ|メキシコ|ブラジル|グアテマラ|欧州|ドイツ|フランス|イタリア|英国|ポーランド|オランダ|豪州|オーストラリア|海外|現地法人|北米|東南アジア)/;
const DOMESTIC = /(北海道|青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|東京|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|京都|大阪|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄|国内)/;
// 海外ガードを効かせるシグナル（拠点系のみ。採用強化やM&Aは海外語が混じっても国内採用に効く）
const OVERSEAS_GUARDED = new Set(['新工場OPEN', '新店舗OPEN', '新拠点開設']);

// ── 差分シグナル定義（signal-store から呼ばれる）──────────────
const DELTA_SIGNALS = {
  求人急増: {
    heat: 5, issue: '応募母数不足（枠が急に増えた）',
    opener: '{社名}様の求人が直近で大きく増えているのを拝見しまして、母集団づくりのご状況を伺えればとお電話しました',
  },
  求人増加: {
    heat: 3, issue: '採用枠の拡大局面',
    opener: '{社名}様が募集を増やされているのを拝見してお電話しました',
  },
  新規掲載開始: {
    heat: 4, issue: '採用活動の立ち上がり（媒体選定の直前後）',
    opener: '{社名}様が新しく募集を開始されたのを拝見しまして、媒体のご検討状況を伺えればとお電話しました',
  },
  求人長期掲載: {
    heat: 4, issue: '母集団形成より後の歩留まりに課題の可能性（採れていない）',
    opener: '{社名}様、{根拠}長期間ご募集されているようでしたので、母集団形成よりもその後の歩留まりの方に課題があるのではと思いお電話しました',
  },
  採用人数増: {
    heat: 4, issue: '採用目標の引き上げに母集団が追いつかない',
    opener: '{社名}様が採用予定人数を増やされているのを拝見してお電話しました',
  },
  // ── ベースライン偏差（Bombora の Company Surge と同じ考え方）──────────
  // 「前回より増えた」は1点ノイズで簡単に立つ。平常時の水準そのものを超えたかを見る。
  求人ベースライン超過: {
    heat: 5, issue: '平常時を超える採用量（明確な増員フェーズ）',
    opener: '{社名}様の募集が平年より大きく増えているのを拝見しまして、母集団づくりのご状況を伺えればとお電話しました',
  },
  // ── 自社巡回で取れる第一者相当のシグナル（harvest-site-signals）──────
  採用ページ更新: {
    heat: 3, issue: '採用要項を今まさに動かしている（媒体検討の直前後）',
    opener: '{社名}様の採用ページが更新されているのを拝見しまして、今期の母集団づくりのご状況を伺えればとお電話しました',
  },
  新着情報更新: {
    heat: 2, issue: '企業活動は動いている（採用への波及を確認したい）',
    opener: '{社名}様の最近のお知らせを拝見してお電話しました',
  },
};

/**
 * シグナルの「連鎖」に対する加点（Sequence）。
 * 単発の出来事より、原因→結果の順に並んだ出来事の方が採用ニーズの確度が高い。
 * 例: 資金調達 → 大量求人開始 は「予算が付いて枠が増えた」ことを2本で裏づける。
 * keys が全て揃っている場合のみ bonus を加える（順序は問わない＝観測順は媒体都合で前後する）。
 */
const COMBOS = [
  { keys: ['資金調達', '大量求人開始'], bonus: 10, label: '調達→採用強化の連鎖' },
  { keys: ['新拠点開設', '大量求人開始'], bonus: 10, label: '拠点開設→採用強化の連鎖' },
  { keys: ['新工場OPEN', '大量求人開始'], bonus: 10, label: '工場開設→採用強化の連鎖' },
  { keys: ['新店舗OPEN', '大量求人開始'], bonus: 10, label: '出店→採用強化の連鎖' },
  { keys: ['M&A・事業承継', '大量求人開始'], bonus: 8, label: '再編→採用強化の連鎖' },
  { keys: ['採用担当者募集', '求人長期掲載'], bonus: 8, label: '採れていない＋体制不足の同時成立' },
  { keys: ['求人長期掲載', '採用サイト刷新'], bonus: 6, label: '採れずに採用広報へ投資している' },
  { keys: ['求人急増', '採用ページ更新'], bonus: 6, label: '枠の増加が採用要項にも出ている' },
  { keys: ['事業拡大', '大量求人開始'], bonus: 6, label: '拡大→採用強化の連鎖' },
];

/**
 * ソース別の信頼度係数（Identity / 抽出確度）。
 * 同じ「大量求人開始」でも、企業の公式採用ページで読んだものと、
 * プレスリリース本文の一文から正規表現で拾ったものでは確度が違う。
 * ここを乗じないと、収集ソースを増やした瞬間に弱いソースが上位を占める。
 */
const SOURCE_CONFIDENCE = {
  '公式サイト': 1.0,          // 自社巡回（企業の一次情報・社名/URL が確定している）
  '採用ページ': 1.0,
  '求人媒体スナップショット': 1.0,  // 差分は観測値そのもの
  'PR TIMES': 0.85,           // 本文からの正規表現抽出（誤爆余地あり）
  '': 1.0,                    // ソース不明は減点しない（既存の採点分布を勝手に動かさないため）
};
const confidenceOf = (src) => {
  const k = String(src || '');
  for (const [name, v] of Object.entries(SOURCE_CONFIDENCE)) if (name && k.includes(name)) return v;
  return SOURCE_CONFIDENCE[''];
};

// 従業員数が不明なときの規模の代理指標（法人格）。ICPの規模フロア100名に届かない形態。
const MICRO_FORM = /(合同会社|有限会社|合資会社|合名会社|個人事業)/;

// ── 熱度 → 基礎点（1本あたりの価値）────────────────────────────
// 配点はシグナル側が支配的になるように置く（属性補正の合計は最大+26）。
// 「熱度5が1本＝45点」＝ 属性が何も分からなくても B（50点）に手が届く水準。
// PR TIMES 経由の企業は従業員数/採用人数が不明なことが多く、ここを渋くすると
// 出来事で狙うという設計そのものが効かなくなる。
const HEAT_POINTS = { 5: 45, 4: 32, 3: 20, 2: 11, 1: 4 };
// 複数シグナルの逓減係数（2本目以降は効きを落とす＝語を並べただけの企業を満点にしない）
const STACK = [1, 0.6, 0.4, 0.25, 0.15];
// 鮮度係数（シグナル発生からの経過日数）。「今」でなければホットではない。
const RECENCY = [[14, 1], [30, 0.9], [60, 0.7], [90, 0.5], [180, 0.3]];

function recencyFactor(days) {
  if (days == null || !Number.isFinite(days)) return 0.8;   // 日付不明は中庸に置く
  if (days < 0) return 1;
  for (const [d, f] of RECENCY) if (days <= d) return f;
  return 0.15;
}
const stackFactor = (i) => (i < STACK.length ? STACK[i] : 0.1);

/**
 * テキスト（リリース見出し＋本文、ニュース、採用ページ等）から採用シグナルを検出する。
 * @param {{title?:string, text?:string, company?:string, industry?:string, date?:string, url?:string, asOf?:string}} o
 * @returns {{signals:Array<{key:string,heat:number,issue:string,evidence:string,days:number|null,url:string}>, rejected:string}}
 *   rejected … 空文字なら通過。値が入っていれば不採用理由（デバッグ・監査用）。
 */
function detectSignals({ title = '', text = '', company = '', industry = '', date = '', url = '', asOf } = {}) {
  const t = norm(title);
  const body = norm(text);
  const hay = t + '\n' + body;
  const out = { signals: [], rejected: '' };

  // 発信主体の判定は社名だけでは足りない（実例: 「横須賀市」は社名パターンに掛からず、
  // 業種欄の「官公庁・地方自治体」でしか見分けられなかった）。社名と業種を別々に見る
  // ─ 連結すると `大学$` のような末尾アンカーが効かなくなるため。
  const subjects = [norm(company), norm(industry)].filter(Boolean);
  const bad = subjects.length ? subjects.some((s) => NOT_COMPANY.test(s)) : NOT_COMPANY.test(t);
  if (bad) { out.rejected = 'not-company(自治体/学校等)'; return out; }
  if (GUIDE.test(t)) { out.rejected = 'guide-article(解説/ランキング/調査)'; return out; }
  if (NEG.test(t)) { out.rejected = 'third-party-case(他社事例の紹介)'; return out; }

  const days = daysAgo(date, asOf);
  for (const s of SIGNALS) {
    const m = hay.match(s.re);
    if (!m) continue;
    if (s.require && !s.require.test(hay)) continue;         // 文脈語の併存を要求
    const evidence = evidenceAround(hay, m);
    // 海外拠点の開設は国内採用needsにならない（根拠文が海外を指し、国内地名を伴わない場合）
    if (OVERSEAS_GUARDED.has(s.key) && OVERSEAS.test(evidence) && !DOMESTIC.test(evidence)) continue;
    out.signals.push({ key: s.key, heat: s.heat, issue: s.issue, evidence, days, url });
  }
  // 上位概念の吸収（「新工場OPEN」が立ったら「新拠点開設」は数えない＝同一事象の重複加点を防ぐ）
  const hit = new Set(out.signals.map((s) => s.key));
  out.signals = out.signals.filter((s) => {
    const def = SIGNAL_BY_KEY.get(s.key);
    return !(def && def.subsumedBy && def.subsumedBy.some((k) => hit.has(k)));
  });
  if (!out.signals.length) out.rejected = out.rejected || 'no-signal';
  return out;
}

// 一致箇所の前後を根拠文として切り出す（営業が読んで納得できる長さ＝60字前後）。
function evidenceAround(hay, m) {
  const i = Math.max(0, m.index - 24);
  return hay.slice(i, m.index + m[0].length + 40).replace(/\s+/g, ' ').trim();
}

/**
 * 日付文字列から「何日前か」を返す。パースできなければ null。
 * @param {string} date '2026-09-01' / '2026/9/1' / '2026年9月1日'
 * @param {string|Date} asOf 基準日（既定＝今日。テストで固定するために外から渡せる）
 */
function daysAgo(date, asOf) {
  const s = String(date || '').trim();
  if (!s) return null;
  const iso = s.replace(/[年/]/g, '-').replace(/月/g, '-').replace(/日.*$/, '').replace(/-+$/, '');
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const base = asOf ? new Date(asOf) : new Date();
  if (isNaN(base.getTime())) return null;
  return Math.floor((base - d) / 86400000);
}

const numOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseInt(z2h(String(v)).replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};

/**
 * 前回スナップショットとの差分から「求人急増／長期掲載／新規掲載」等を作る。
 * 単発のテキストからは絶対に出ないシグナルなので、ここが差分専用の入口。
 * @param {{jobs?:number|null, hire?:number|null, seen?:boolean}|null} prev 前回観測（未観測なら null）
 * @param {{jobs?:number|null, hire?:number|null, firstSeen?:string}} curr 今回観測
 * @param {{asOf?:string, longDays?:number}} opt longDays… 長期掲載とみなす日数（既定90日）
 * @returns {Array<{key:string,heat:number,issue:string,evidence:string,days:number}>}
 */
function detectDeltaSignals(prev, curr = {}, opt = {}) {
  const longDays = opt.longDays == null ? 90 : opt.longDays;
  const sigs = [];
  const add = (key, evidence) => {
    const d = DELTA_SIGNALS[key];
    if (d) sigs.push({ key, heat: d.heat, issue: d.issue, evidence, days: 0 });
  };
  const pj = numOrNull(prev && prev.jobs);
  const cj = numOrNull(curr.jobs);
  const ph = numOrNull(prev && prev.hire);
  const ch = numOrNull(curr.hire);

  // 新規掲載開始（前回は観測されていなかった／求人0だった）
  if (cj != null && cj > 0 && (!prev || prev.seen === false || pj === 0)) {
    add('新規掲載開始', `新規に求人${cj}件を確認（前回は掲載なし）`);
  } else if (pj != null && cj != null && cj > pj) {
    // 求人急増: 2倍以上 かつ +3件以上（「3→12」のような跳ね方だけを拾う）
    if (cj >= pj * 2 && cj - pj >= 3) add('求人急増', `求人 ${pj}件 → ${cj}件（+${cj - pj}件・${(cj / Math.max(pj, 1)).toFixed(1)}倍）`);
    // 求人増加: +50% かつ +2件以上
    else if (cj >= pj * 1.5 && cj - pj >= 2) add('求人増加', `求人 ${pj}件 → ${cj}件（+${cj - pj}件）`);
  }
  // 採用人数の引き上げ
  if (ph != null && ch != null && ch > ph) add('採用人数増', `採用予定 ${ph}名 → ${ch}名`);

  // 長期掲載（初回観測日からの経過。掲載が続いている＝今回も観測できている場合のみ）
  const age = daysAgo(curr.firstSeen, opt.asOf);
  if (age != null && age >= longDays && (cj == null || cj > 0)) {
    add('求人長期掲載', `${age}日間（${curr.firstSeen}〜）掲載が続いており、`);
  }
  return sigs;
}

/**
 * 観測履歴の**平常時ベースライン**と直近を比べて「平年より明らかに多い」を検出する。
 * detectDeltaSignals が見ているのは「前回 vs 今回」の1点比較なので、
 * 媒体側の掲載揺れ（週末に1件消える等）でも 求人増加 が立ってしまう。
 * 平均同士の比較にすると、その揺れが均されて「本当に増えた社」だけが残る。
 *
 * @param {Array<{date:string,jobs:number|null,hire:number|null}>} history signal-store の履歴（古い順）
 * @param {{asOf?:string, recentDays?:number, baseDays?:number, minObs?:number}} opt
 *   recentDays … 直近ウィンドウ（既定21日＝3週）
 *   baseDays   … ベースラインウィンドウ（既定84日＝12週。直近ぶんは含めない）
 *   minObs     … 各ウィンドウに必要な最小観測点数（既定2。1点同士の比較は差分と変わらない）
 * @returns {Array} 差分シグナル配列（該当なしなら空）
 */
function detectBaselineSignals(history = [], opt = {}) {
  const recentDays = opt.recentDays == null ? 21 : opt.recentDays;
  const baseDays = opt.baseDays == null ? 84 : opt.baseDays;
  const minObs = opt.minObs == null ? 2 : opt.minObs;
  const pts = history
    .map((h) => ({ age: daysAgo(h.date, opt.asOf), jobs: numOrNull(h.jobs) }))
    .filter((p) => p.age != null && p.jobs != null);
  const recent = pts.filter((p) => p.age <= recentDays);
  const base = pts.filter((p) => p.age > recentDays && p.age <= baseDays);
  if (recent.length < minObs || base.length < minObs) return [];
  const avg = (xs) => xs.reduce((s, p) => s + p.jobs, 0) / xs.length;
  const r = avg(recent);
  const b = avg(base);
  // 1.5倍以上 かつ 実数で+2件以上（小さい母数で倍率だけが跳ねるのを防ぐ）
  if (!(r >= b * 1.5 && r - b >= 2)) return [];
  const d = DELTA_SIGNALS.求人ベースライン超過;
  return [{
    key: '求人ベースライン超過', heat: d.heat, issue: d.issue, days: 0,
    evidence: `直近${recentDays}日の平均求人 ${r.toFixed(1)}件 / 平常時（〜${baseDays}日）${b.toFixed(1)}件（${(r / Math.max(b, 0.1)).toFixed(1)}倍）`,
  }];
}

/**
 * 巡回したページの**指紋の変化**からシグナルを作る（harvest-site-signals 用）。
 * 採用ページが書き換わった＝採用活動が今動いている、という第一者に近い観測。
 * 本文を保存せずハッシュだけ持つので、台帳が肥大しない。
 *
 * @param {{fp?:object}|null} prev 前回観測（{fp:{recruit,news}}）
 * @param {{fp?:object}} curr 今回観測
 * @returns {Array} 差分シグナル配列
 */
function detectSiteDiffSignals(prev, curr = {}) {
  if (!prev || !prev.fp) return [];                 // 初回は「変化」が定義できない
  const sigs = [];
  const pf = prev.fp || {};
  const cf = curr.fp || {};
  const add = (key, evidence) => {
    const d = DELTA_SIGNALS[key];
    if (d) sigs.push({ key, heat: d.heat, issue: d.issue, evidence, days: 0 });
  };
  if (cf.recruit && pf.recruit && cf.recruit !== pf.recruit) add('採用ページ更新', `採用ページの内容が前回巡回（${prev.lastSeen || '前回'}）から更新されています`);
  if (cf.news && pf.news && cf.news !== pf.news) add('新着情報更新', `お知らせ／ニュースが前回巡回（${prev.lastSeen || '前回'}）から更新されています`);
  return sigs;
}

/**
 * シグナル群＋企業属性から HOT SCORE（0-100）とランクを算出する。
 *
 * 設計:
 *   基礎点 = Σ(熱度点 × 鮮度係数 × 逓減係数)   … 「何が起きたか」×「いつ起きたか」
 *   補正   = ICP適合（規模/採用数/非IT）＋ 架電可能性（電話/担当者名）
 *   ICPは加点だけでなく減点もする（IT業種は実測成約率が最下位＝ホットでも売れない）。
 *
 * @param {{signals:Array, emp?:number|null, hire?:number|null, industry?:string, phone?:string, contactName?:string, repName?:string}} o
 * @returns {{score:number, rank:string, heat:number, top:object|null, reasons:string[], issue:string, why:string[]}}
 */
function scoreHotLead({ signals = [], emp = null, hire = null, industry = '', phone = '', contactName = '', repName = '', company = '' } = {}) {
  const { isExcludedIndustry, ICP } = require('./icp-rules');
  // 熱度の高い順・同熱度なら新しい順に並べ、逓減をかけて足す
  const sorted = [...signals].sort((a, b) => (b.heat - a.heat) || ((a.days == null ? 999 : a.days) - (b.days == null ? 999 : b.days)));
  let base = 0;
  // 熱度点 × 鮮度 × 逓減 × ソース信頼度。信頼度は「その観測をどれだけ信じてよいか」で、
  // 出来事の強さ（熱度）とは別の軸として掛ける（強い出来事の弱い観測を満点にしない）。
  sorted.forEach((s, i) => {
    base += (HEAT_POINTS[s.heat] || 0) * recencyFactor(s.days) * stackFactor(i) * (s.conf != null ? s.conf : confidenceOf(s.source));
  });

  const reasons = [];
  let adj = 0;

  // ── 連鎖（Sequence）── 原因と結果が揃っている社を押し上げる
  const hitKeys = new Set(sorted.map((s) => s.key));
  for (const c of COMBOS) {
    if (c.keys.every((k) => hitKeys.has(k))) { adj += c.bonus; reasons.push(`${c.label}(+${c.bonus})`); }
  }
  // ── 継続（Frequency）── 別々の日に複数回シグナルが出ている＝一過性の広報ではない
  const days = sorted.map((s) => s.days).filter((d) => d != null);
  const distinctDays = new Set(days).size;
  if (sorted.length >= 3 && distinctDays >= 2) { adj += 5; reasons.push(`${sorted.length}本/${distinctDays}時点で継続観測(+5)`); }
  // ── 多源（Identity confidence）── 別ソースが同じ社を指している
  const srcs = new Set(sorted.map((s) => s.source).filter(Boolean));
  if (srcs.size >= 2) { adj += 5; reasons.push(`${srcs.size}ソースで裏づけ(+5)`); }
  const e = numOrNull(emp);
  const h = numOrNull(hire);
  if (isExcludedIndustry(industry)) { adj -= 15; reasons.push('IT/ソフト=ICP絶対除外(-15)'); }
  if (e != null) {
    if (e >= ICP.EMP_SWEET_MIN && e <= ICP.EMP_SWEET_MAX) { adj += 8; reasons.push(`従業員${e}名=主戦場(+8)`); }
    else if (e >= ICP.EMP_MIN && e <= ICP.EMP_MAX) { adj += 4; reasons.push(`従業員${e}名=有効レンジ(+4)`); }
    else if (e < ICP.EMP_MIN) { adj -= 8; reasons.push(`従業員${e}名<${ICP.EMP_MIN}=規模フロア未満(-8)`); }
  } else if (MICRO_FORM.test(String(company || ''))) {
    // 従業員数が取れない経路（PR TIMES等）では規模フロアが一切効かず、零細企業が上位に来る
    // （実測: 首位が個室ピラティススタジオの合同会社だった）。法人格は無料で得られる規模の代理指標で、
    // 合同会社/有限会社が従業員100名以上・新卒6名以上に該当することはまず無い。
    adj -= 10; reasons.push('合同/有限会社=規模フロア未満の可能性(-10)');
  }
  if (h != null) {
    if (h >= ICP.HIRE_MIN) { adj += 8; reasons.push(`新卒${h}名>=${ICP.HIRE_MIN}(+8)`); }
    else if (h >= 3) { adj += 3; reasons.push(`新卒${h}名=中程度(+3)`); }
    else { adj -= 6; reasons.push(`新卒${h}名=採用フロア未満(-6)`); }
  }
  if (String(phone || '').trim()) { adj += 5; reasons.push('電話番号あり(+5)'); }
  // 名指しできる方が繋がる。採用担当者名がベストだが、代表者名でも架電宛名にはなる。
  if (String(contactName || '').trim()) { adj += 5; reasons.push('採用担当者名あり(+5)'); }
  else if (String(repName || '').trim()) { adj += 3; reasons.push('代表者名あり=宛名可(+3)'); }

  const score = Math.max(0, Math.min(100, Math.round(base + adj)));
  const top = sorted[0] || null;
  return {
    score,
    rank: rankOf(score),
    heat: top ? top.heat : 0,
    top,
    reasons: [`シグナル基礎点${Math.round(base)}（${sorted.map((s) => s.key).join('+') || 'なし'}）`, ...reasons],
    issue: top ? top.issue : '',
    why: whyNow(sorted),
  };
}

// S: 今日必ず架ける / A: 今週中 / B: 母集団として保持 / C: 待機
function rankOf(score) {
  if (score >= 80) return 'S';
  if (score >= 65) return 'A';
  if (score >= 50) return 'B';
  return 'C';
}

/** 「なぜ今なのか」を営業がそのまま読める箇条書きにする。 */
function whyNow(signals) {
  return signals.slice(0, 5).map((s) => {
    const when = s.days == null ? '' : (s.days <= 0 ? '本日' : `${s.days}日前`);
    return `${'🔥'.repeat(Math.max(1, s.heat))} ${s.key}${when ? `（${when}）` : ''}：${String(s.evidence || '').slice(0, 80)}`;
  });
}

/**
 * 最上位シグナルから架電の切り出しトークを生成する。
 * 「求人を出してますよね？」ではなく「採用課題営業」の入り方に固定する。
 * @param {{key:string, evidence?:string}} sig
 * @param {string} company 社名（敬称なしの生名）
 */
function talkOpener(sig, company) {
  if (!sig) return '';
  const def = SIGNAL_BY_KEY.get(sig.key) || DELTA_SIGNALS[sig.key];
  if (!def || !def.opener) return '';
  const name = String(company || '').replace(/\s+/g, '') || '御社';
  return def.opener.replace('{社名}', name).replace('{根拠}', String(sig.evidence || '').slice(0, 40));
}

module.exports = {
  SIGNALS, SIGNAL_BY_KEY, DELTA_SIGNALS, HEAT_POINTS, COMBOS, SOURCE_CONFIDENCE,
  detectSignals, detectDeltaSignals, detectBaselineSignals, detectSiteDiffSignals,
  scoreHotLead, talkOpener, confidenceOf,
  whyNow, rankOf, daysAgo, recencyFactor, norm,
};
