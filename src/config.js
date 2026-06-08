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

  // ===== 電話番号抽出（正規表現＋tel:リンク。API不要） =====
  // 電話番号らしさを高めるキーワード（近接で加点）
  PHONE_POSITIVE_HINTS: ['tel', 'TEL', 'ＴＥＬ', '電話', '℡', '代表', 'お問い合わせ', 'お問合せ', 'お問合わせ', '問い合わせ', 'phone', 'お電話'],
  // FAX番号は本命ではないので近接で減点
  PHONE_NEGATIVE_HINTS: ['fax', 'FAX', 'ＦＡＸ', 'ファクス', 'ファックス', 'ｆａｘ'],
};
