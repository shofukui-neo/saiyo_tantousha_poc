'use strict';
require('dotenv').config();

const int = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(parseInt(v, 10)) ? parseInt(v, 10) : d);
const flt = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(parseFloat(v)) ? parseFloat(v) : d);

module.exports = {
  // このPoCが対象にする「1媒体」
  TARGET_MEDIA: 'company_site',

  // ===== 入出力（スプレッドシート / CSV） =====
  // 'sheet' = Google Sheets API（サービスアカウント） / 'gas' = GASウェブアプリ橋渡し / 'csv' = ローカルCSV
  SOURCE: process.env.SOURCE || 'sheet',
  SHEET_ID: process.env.SHEET_ID || '',
  SHEET_TAB: process.env.SHEET_TAB || 'Sheet1',
  GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
  GAS_URL: process.env.GAS_URL || '',
  ONLY_PENDING: /^(1|true|yes)$/i.test(process.env.ONLY_PENDING || ''), // status空欄の行だけ処理（再開・差分更新）

  USER_AGENT: process.env.USER_AGENT || 'MochicaResearchBot/0.1 (+mailto:your-email@example.com)',
  CONCURRENCY: int(process.env.CONCURRENCY, 3),          // 企業をまたいだ並列数（媒体内は1社ずつ丁寧に）
  MAX_PAGES_PER_SITE: int(process.env.MAX_PAGES_PER_SITE, 8),
  PER_PAGE_TIMEOUT_MS: int(process.env.PER_PAGE_TIMEOUT_MS, 15000),
  POLITE_DELAY_MS: int(process.env.POLITE_DELAY_MS, 1500), // 同一サイト内ページ取得の間隔
  MAX_TEXT_CHARS: int(process.env.MAX_TEXT_CHARS, 8000),   // 抽出処理に渡す本文の上限
  CONFIDENCE_THRESHOLD: flt(process.env.CONFIDENCE_THRESHOLD, 0.6),

  // ===== URL発見（企業名 → 公式HP） — APIキー不要 =====
  // 'bing' = Bing 検索結果HTML（キー不要・無料・既定） / 'duckduckgo' = DuckDuckGo HTML / 'none' = 入力URLが無い行はNO_URL
  SEARCH_ENGINE: process.env.SEARCH_ENGINE || 'bing',
  BING_HTML_URL: process.env.BING_HTML_URL || 'https://www.bing.com/search',
  DDG_HTML_URL: process.env.DDG_HTML_URL || 'https://html.duckduckgo.com/html/',
  // 検索リクエスト用のUA（検索エンジンはbot的UAを弾くため、ブラウザ相当を既定にする）
  SEARCH_USER_AGENT: process.env.SEARCH_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  SEARCH_MAX_CANDIDATES: int(process.env.SEARCH_MAX_CANDIDATES, 8),  // 検索結果から検討する候補数
  SEARCH_VERIFY_TOP: int(process.env.SEARCH_VERIFY_TOP, 3),          // 実際にページ取得して企業名一致を検証する上位件数
  SEARCH_DELAY_MS: int(process.env.SEARCH_DELAY_MS, 1200),           // 検索エンジンへの礼儀（連続クエリ間隔）

  // ===== 企業名の自動発見（発見層） — APIキー不要 =====
  DISCOVER_LIMIT: int(process.env.DISCOVER_LIMIT, 30),               // 1回で収集する企業名の上限
  DISCOVER_PAGES: int(process.env.DISCOVER_PAGES, 3),                // キーワード検索で辿る検索結果ページ数
  DISCOVER_FETCH_TOP: int(process.env.DISCOVER_FETCH_TOP, 4),        // 各検索ページで本文抽出する上位結果数（まとめ記事・一覧）

  // ※ gBizINFO は統合アプリの src/gbiz.js（GBIZ_TOKEN）を使用（旧 GBIZINFO_* キーは廃止）。

  // ===== 構造化データ抽出（JSON-LD / sitemap） — APIキー不要 =====
  USE_STRUCTURED: !/^(0|false|no)$/i.test(process.env.USE_STRUCTURED || ''),  // 既定ON
  USE_SITEMAP: !/^(0|false|no)$/i.test(process.env.USE_SITEMAP || ''),        // 既定ON

  // ===== ローカルLLM（Ollama） — 任意。外部API課金なし。未設定なら使用しない =====
  // 例: OLLAMA_URL=http://localhost:11434  OLLAMA_MODEL=qwen2.5:7b
  OLLAMA_URL: process.env.OLLAMA_URL || '',
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'qwen2.5:3b',
  OLLAMA_TIMEOUT_MS: int(process.env.OLLAMA_TIMEOUT_MS, 60000),
  OLLAMA_NUM_CTX: int(process.env.OLLAMA_NUM_CTX, 4096),        // 文脈長（VRAM4GBの3B級で安定する範囲）
  OLLAMA_PROMPT_CHARS: int(process.env.OLLAMA_PROMPT_CHARS, 4000), // LLMへ渡す本文の上限（文脈長に収める）

  // 公式サイトでは「ない」ドメイン（求人媒体 / SNS / 企業DB / ニュース等）。これらは候補から除外。
  EXCLUDE_DOMAINS: [
    // 求人媒体・転職サイト
    'rikunabi.com', 'mynavi.jp', 'next.rikunabi.com', 'doda.jp', 'en-japan.com', 'employment.en-japan.com',
    'indeed.com', 'jp.indeed.com', 'wantedly.com', 'green-japan.com', 'type.jp', 'baitoru.com', 'townwork.net',
    'job-medley.com', 'hellowork.mhlw.go.jp', 'engage.en-japan.com', 'kyujin-box.com', 'job-terminal.com',
    'tenshoku-station.jp', 'mid-tenshoku.com', 'levtech.jp', 'paiza.jp', 'gaishishukatsu.com', 'one-careers.com',
    // SNS・動画
    'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'linkedin.com', 'youtube.com', 'tiktok.com', 'note.com',
    // 企業DB・ポータル・百科
    'wikipedia.org', 'baseconnect.in', 'musubu.in', 'alarmbox.jp', 'houjin.jp', 'houjinbangou.nta.go.jp',
    'navinet.ne.jp', 'ipros.jp', 'g-search.or.jp', 'tdb.co.jp', 'tsr-net.co.jp', 'salesnow.jp', 'ullet.com',
    'mapfan.com', 'navitime.co.jp', 'goo.ne.jp', 'find-job.net', 'job-gear.jp', 'prtimes.jp', 'value-press.com',
    // 検索・ポータル本体
    'google.com', 'bing.com', 'yahoo.co.jp', 'search.yahoo.co.jp', 'duckduckgo.com',
  ],
  // ドメイン末尾によるスコア加点（公式コーポレートサイトらしさ）
  TLD_BONUS: { '.co.jp': 3, '.jp': 2, '.com': 1, '.net': 0, '.org': 0 },

  // ※ 外部AI API（Anthropic等）は使用しない。担当者名抽出も正規表現＋人名判定のみで動作する。

  // 採用担当者名が載っていそうなページを見つけるためのヒント（href / リンク文言に含まれるか）
  PAGE_HINTS: [
    'recruit', 'saiyo', '採用', 'careers', 'career', 'jobs', '採用情報', 'entry',
    'company', 'about', '会社概要', '会社案内', 'corporate', 'profile', 'overview',
    'contact', 'お問い合わせ', '問い合わせ', 'inquiry', 'members', 'member', 'team', 'people', 'staff',
  ],
  // ヒントの中でも特に当たりやすいもの（スコア加点）
  STRONG_HINTS: ['recruit', '採用', 'careers', 'contact', 'お問い合わせ', '問い合わせ', 'member', 'team', '会社概要'],

  // 採用/人事ロールと判定するキーワード（検証ゲート用）
  ROLE_KEYWORDS: ['採用', '人事', '人材', '人財', '新卒', '中途', '採用担当', '採用責任者',
    'recruit', 'recruiting', 'recruiter', 'hr', 'human resources', 'talent', 'hiring', 'people'],

  // ===================================================================================
  // ===== 統合パイプライン「究極の営業リスト」用の追加設定 =====
  // すべて環境変数で点火する。未設定なら自動でローカル・API不要の経路にフォールバックする。
  // （現状キーが無くても discoverUrl＋正規表現＋MX篩い だけで一気通貫が動く）
  // ===================================================================================

  // --- LLM（Gemini 無料枠）。GEMINI_KEY があれば ICP生成・採用担当者抽出をAIで行う ---
  GEMINI_KEY: process.env.GEMINI_KEY || '',
  LLM_ENDPOINT: process.env.LLM_ENDPOINT || 'https://generativelanguage.googleapis.com/v1beta/models/',
  LLM_MODEL: process.env.LLM_MODEL || 'gemini-flash-latest',

  // --- 国税庁 法人番号 Web-API v4（商号→法人番号の名寄せ。アプリID申請に数週間）---
  NTA_APP_ID: process.env.NTA_APP_ID || '',
  NTA_BASE: process.env.NTA_BASE || 'https://api.houjin-bangou.nta.go.jp/4',

  // --- gBizINFO REST API（業種×地域での構造化発掘・代表者名/HP取得。トークン申請が必要）---
  GBIZ_TOKEN: process.env.GBIZ_TOKEN || '',
  GBIZ_BASE: process.env.GBIZ_BASE || 'https://api.info.gbiz.go.jp/hojin/v1/hojin',
  GBIZ_CORPORATE_TYPE: process.env.GBIZ_CORPORATE_TYPE || '301,305', // 株式会社・合同会社に限定
  GBIZ_PAGES_PER_QUERY: int(process.env.GBIZ_PAGES_PER_QUERY, 5),
  GBIZ_LIMIT: int(process.env.GBIZ_LIMIT, 100),
  // 事業概要・営業品目への業種KW部分一致でさらに絞る（gBiz発掘の精度上げ）。空で無効＝API側 business_item のみ。
  GBIZ_INDUSTRY_KEYWORDS: (process.env.GBIZ_INDUSTRY_KEYWORDS || '')
    .split(',').map(s => s.trim()).filter(Boolean),
  // 事業概要・営業品目が空の企業を残すか（true=取りこぼし防止 / false=精度優先）
  GBIZ_KEEP_WHEN_NO_INDUSTRY_DATA: /^(1|true|yes)$/i.test(process.env.GBIZ_KEEP_WHEN_NO_INDUSTRY_DATA || ''),
  // 設立からの最低経過年数（新卒採用の継続性シグナル）。0で無効。
  GBIZ_MIN_YEARS: int(process.env.GBIZ_MIN_YEARS, 0),
  // 補助金採択フラグ付与（source=4で突合）。trueでgBiz呼び出しが約2倍に。
  GBIZ_ENRICH_SUBSIDY: /^(1|true|yes)$/i.test(process.env.GBIZ_ENRICH_SUBSIDY || ''),

  // --- メール実在検証（任意・Hunter.io）---
  HUNTER_KEY: process.env.HUNTER_KEY || '',
  DO_EMAIL_VERIFY: /^(1|true|yes)$/i.test(process.env.DO_EMAIL_VERIFY || ''),
  EMAIL_ROLES: (process.env.EMAIL_ROLES || 'info,recruit,saiyo,jinji,hr,contact,otoiawase,adm')
    .split(',').map(s => s.trim()).filter(Boolean),

  // --- ICP（理想顧客像）。GEMINI_KEY＋PRODUCT_DESC があれば自動生成し、無ければ手動設定を使う ---
  PRODUCT_DESC: process.env.PRODUCT_DESC || '',
  PRODUCT_EXISTING: process.env.PRODUCT_EXISTING || '',
  ICP_INDUSTRIES: (process.env.ICP_INDUSTRIES || '').split(',').map(s => s.trim()).filter(Boolean),
  ICP_PREFECTURES: (process.env.ICP_PREFECTURES || '').split(',').map(s => s.trim()).filter(Boolean),
  ICP_EMP_MIN: int(process.env.ICP_EMP_MIN, 50),
  ICP_EMP_MAX: int(process.env.ICP_EMP_MAX, 300),
  ICP_EMP_SWEET_MIN: int(process.env.ICP_EMP_SWEET_MIN, 100),
  ICP_EMP_SWEET_MAX: int(process.env.ICP_EMP_SWEET_MAX, 250),
  ICP_DEPARTMENT: process.env.ICP_DEPARTMENT || '人事部', // 架電呼称の既定部署

  // --- 発掘（企業選定）---
  DISCOVER_TARGET: int(process.env.DISCOVER_TARGET, 100), // 発掘の目標社数
  KEEP_UNKNOWN_EMP: !/^(0|false|no)$/i.test(process.env.KEEP_UNKNOWN_EMP || 'true'), // 従業員数不明を母集団に残すか

  // --- 採用担当者レースで決め打ちで叩く採用/会社系パス（既存 guessContactPaths と併用）---
  LOCATE_PATHS: ['/recruit', '/recruit/', '/saiyo', '/saiyo/', '/careers', '/career',
    '/company', '/corporate', '/about', '/news', '/contact', '/contact/'],

  // --- 出力（担当者マスタ）---
  MASTER_TAB: process.env.MASTER_TAB || '担当者マスタ',
  MASTER_HEADERS: ['企業名', '法人番号', '採用担当者名', '役職', '部署', '代表者名',
    'メール', 'メール確度', '担当者確度', '電話番号', '公式URL', 'Tier',
    '取得元媒体', '根拠URL', '架電呼称', '業種', '都道府県', '従業員数',
    '補助金', '設立年', '取得日'],
  SCORE_THRESHOLD: flt(process.env.SCORE_THRESHOLD, 0.6),

  // --- リスト品質スコアリング（src/quality.js・src/score-list.js）---
  // 4ディメンション加重（合計1.0）。テレアポ実績でチューニングする。
  QUALITY_WEIGHTS: {
    icp: flt(process.env.QUALITY_W_ICP, 0.30),
    intent: flt(process.env.QUALITY_W_INTENT, 0.35),
    data: flt(process.env.QUALITY_W_DATA, 0.20),
    timing: flt(process.env.QUALITY_W_TIMING, 0.15),
  },
  // 架電優先度の閾値（総合スコア）
  QUALITY_PRIORITY_HIGH: int(process.env.QUALITY_PRIORITY_HIGH, 70), // これ以上＝今週架電
  QUALITY_PRIORITY_MID: int(process.env.QUALITY_PRIORITY_MID, 45),   // これ以上＝ナーチャリング、未満＝後回し
  // 採用インテントの正規化上限（求人出稿データ連携時に使用）
  INTENT_MEDIA_MAX: int(process.env.INTENT_MEDIA_MAX, 5),            // 出稿媒体数の満点ライン
  INTENT_COST_MAX: int(process.env.INTENT_COST_MAX, 10000000),      // 予想出稿金額の対数正規化上限

  // ===================================================================================
  // ===== 多系統ソース統合（src/merge.js・src/build-list.js・src/source-kpi.js）=====
  // 設計「収集戦略の背骨」: ①採用メディア起点(新卒フラグ内蔵) を起点に ②企業属性で肉付け、
  // ③インテント/トリガーで優先度を上書き。突合キー=法人番号、役割固定でフィールドを採用する。
  // ===================================================================================

  // 系統ラベル（A=採用メディア起点 / B=企業属性 / C=インテント/トリガー / D=ネットワーク既存資産）
  SOURCE_SYSTEMS: {
    A: '採用メディア起点', B: '企業属性起点', C: 'インテント/トリガー起点', D: 'ネットワーク/既存資産',
  },
  // 系統ごとの既定 intent強度（★0-5）。manifest の source 個別 intent で上書き可。
  // C(今動いている)が最強、D(温かいリード)・A(新卒掲載中)が続く、B(属性のみ)は弱い。
  SYSTEM_INTENT: { A: 3, B: 1, C: 5, D: 4 },

  // 役割固定：各フィールドを「どの系統の値を最優先で採用するか」。設計の「役割固定」を実装。
  // 同キー（法人番号 or 正規化社名）の複数ソースをマージする際、ここに挙げた系統の非空値を優先採用。
  // 未掲載のフィールドは「最初に見つかった非空値」。連絡先は確度優先で別処理（merge.js）。
  FIELD_OWNERS: {
    // A=採用メディア起点が権威を持つ新卒シグナル
    '新卒フラグ': ['A'], '掲載媒体': ['A'], '掲載媒体数': ['A'], '採用予定人数': ['A'], '採用職種': ['A'],
    '新卒出稿': ['A'], '現在求人掲載中': ['A'], '出稿媒体数': ['A'], '予想出稿金額': ['A'], '出稿継続性': ['A'],
    // B=企業属性起点（公的DB・企業DB）が権威を持つ母集合属性
    '業種': ['B'], '都道府県': ['B'], '従業員数': ['B'], '設立年': ['B'], '補助金': ['B'],
    '代表者名': ['B'], '法人番号': ['B'], '公式URL': ['B'],
    // C=インテント/トリガー起点が権威を持つ"今動いている"シグナル
    'プレスリリース': ['C'], '出稿増': ['C'], '採用ページ更新': ['C'], 'インテント': ['C'],
    '辞退シグナル': ['C'], '来期検討': ['C'], '競合ATS導入': ['C'],
  },
  // 連絡先フィールド（確度の高いソースを優先してマージ）
  CONTACT_FIELDS: ['採用担当者名', '役職', '部署', 'メール', 'メール確度', '担当者確度', '電話番号'],

  // ②採用インテントを上書きするトリガー列（系統C）。truthy で各1★加点（intent.js/quality.js）。
  INTENT_TRIGGER_COLS: (process.env.INTENT_TRIGGER_COLS ||
    'プレスリリース,出稿増,採用ページ更新,インテント,辞退シグナル').split(',').map((s) => s.trim()).filter(Boolean),
  // 新卒採用フラグを示す列（いずれか truthy で「新卒採用フラグ確定」=採用インテントの背骨）
  SHINSOTSU_FLAG_COLS: (process.env.SHINSOTSU_FLAG_COLS ||
    '新卒フラグ,新卒出稿,現在求人掲載中').split(',').map((s) => s.trim()).filter(Boolean),

  // 属性ランク（A/B/C）の ICP適合スコア閾値
  GRADE_A_MIN: int(process.env.GRADE_A_MIN, 75),
  GRADE_B_MIN: int(process.env.GRADE_B_MIN, 50),
  // 系統Cトリガーで優先度を1段引き上げる最低★（"今動いている"を割り込みで最優先化）
  INTENT_OVERRIDE_STARS: int(process.env.INTENT_OVERRIDE_STARS, 3),

  // ===== ソース別KPI（src/source-kpi.js）— 設計#9「これを必ず回す」=====
  // 件数でなく下流（接続→アポ→商談→受注）でソースを評価し、低利回りを止め高利回りに寄せる。
  // 成果CSV（法人番号 or 企業名 をキーに 接続/アポ/商談/受注/コスト 列）を突合して算出。
  KPI_FIT_SCORE_MIN: int(process.env.KPI_FIT_SCORE_MIN, 60),   // 「ICP適合」とみなす品質スコア下限
  KPI_OUTCOME_COLS: { connect: '接続', appo: 'アポ', deal: '商談', won: '受注', cost: 'コスト' },
  // 利回り判定（受注率 or アポ率）で「寄せる/維持/止める」を振り分ける閾値（相対評価も併用）
  KPI_CYCLE_DAYS: int(process.env.KPI_CYCLE_DAYS, 14),         // 評価サイクル（設計: 2週間）

  // ===== 電話番号抽出（正規表現＋tel:リンク。API不要） =====
  // 電話番号らしさを高めるキーワード（近接で加点）
  PHONE_POSITIVE_HINTS: ['tel', 'TEL', 'ＴＥＬ', '電話', '℡', '代表', 'お問い合わせ', 'お問合せ', 'お問合わせ', '問い合わせ', 'phone', 'お電話'],
  // 代表電話を最優先するためのキーワード（近接でさらに加点）
  PHONE_REP_HINTS: ['代表', '本社', '代表電話', '代表番号', '本社代表'],
  // FAX番号は本命ではないので近接で減点
  PHONE_NEGATIVE_HINTS: ['fax', 'FAX', 'ＦＡＸ', 'ファクス', 'ファックス', 'ｆａｘ'],
};
