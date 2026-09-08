'use strict';
/**
 * ats-scope — 「そのATSは**新卒**で使われているのか」を判定する
 * =====================================================================
 * なぜ要るか（2026-08-28の目視監査の結論）:
 *   旧ロジックは「企業サイトのどこかに hrmos.co / career-cloud.asia が出てきたら
 *   その会社のATS」と決めていた。34社を目視した結果、正解15・誤り15・要注意4。
 *   誤りの内訳はほぼ3種類しかなかった。
 *
 *     (A) 中途採用のATSを掴んでいた   … 新卒はi-web/AOL/マイナビ、中途だけHRMOS。
 *                                        日本の中堅以上は新卒と中途で別ATSを使うのが普通。
 *     (B) 新卒採用をやっていない会社   … 中途しか募集していないのにATS導入済みと出す。
 *     (C) 証拠が弱い                   … HTML本文に製品名の**文字列**が出ただけ（確度0.6）。
 *                                        HR系企業が記事内で製品名を書いているだけの誤爆。
 *
 *   MOCHICAは新卒ATS。中途のHRMOSを掴んで「リプレイス提案」と出すと架電が空振りする。
 *   よって判定単位を「企業 → ATS」から「**企業 × 用途（新卒/中途） → ATS**」に変える。
 *
 * このモジュールは純ロジック（ネットワーク無し）。
 *   scopeOf()         : テキスト/URLに新卒・中途どちらの言葉が出ているかを採点
 *   scopeOfUrl()      : URLのパスだけから（卒年 `/27/` `/2027/`、`shinsotsu`、`chuto` 等）
 *   isArticleContext(): 「導入事例」「比較」等＝製品を**紹介しているだけ**の文脈を弾く
 *   gradeEvidence()   : 集めた証拠を突き合わせて 確定/中途用/要確認 を決める（採否ゲート）
 *
 * 採否の原則（要件「確度100%じゃないと採用しない」）:
 *   確定にするのは「ATSホストの**実URL**が取れている」かつ「そのURLに**新卒の証拠**が
 *   紐づいている」時だけ。文字列マーカーだけ・新卒証拠なしは全部 要確認 に落とし、
 *   リストには載せない（＝取りこぼしてもいいが、誤って載せない）。
 */

const { isVendorOwnPage } = require('./ats');

// ── 語彙 ─────────────────────────────────────────────────────────
// 重み: 3=単独で決め手 / 2=強い / 1=弱い（他の証拠の補強にしかならない）
const SHINSOTSU_WORDS = [
  [3, '新卒採用'], [3, '新卒エントリー'], [3, '新卒者採用'], [3, '新卒向け'], [3, '新卒募集'],
  [3, '新卒求人'], [3, '新卒選考'], [3, '新卒応募'], [3, '新卒サイト'], [3, '新卒情報'],
  [3, '新卒マイページ'], [3, '卒業見込'], [3, 'プレエントリー'], [3, '新卒採用情報'],
  [2, '新卒'], [2, 'インターンシップ'], [2, '会社説明会'], [2, '就職活動'], [2, '内定式'],
  [2, 'リクルーター'], [2, '学校推薦'], [2, '学部卒'], [2, '大学院卒'],
  [1, '学生'], [1, '大学生'], [1, '大学院生'], [1, '専門学校生'], [1, '高専'],
  [1, '既卒'], [1, '第二新卒'], [1, 'エントリーシート'], [1, '就活'],
];
const CHUTO_WORDS = [
  [3, '中途採用'], [3, 'キャリア採用'], [3, '経験者採用'], [3, 'キャリア入社'],
  [3, '中途エントリー'], [3, '職務経歴書'], [3, '中途募集'], [3, '中途向け'], [3, '転職者'],
  [2, '中途'], [2, '転職'], [2, '経験者'], [2, '即戦力'], [2, '職務経歴'], [2, '第二新卒'],
  [1, '契約社員'], [1, '業務委託'], [1, 'アルバイト'], [1, 'パート'], [1, '派遣'], [1, '前職'],
];

// 「第二新卒歓迎」は**中途求人**の常套句なのに、部分一致だと「新卒」に化ける。
// 中途ページを新卒と誤判定する最大の罠なので、新卒語を数える前に潰す。
const DAINI_RE = /第二新卒/g;
const DAINI_MARK = '＠daini＠';

// 「新卒」が**職種名の一部**として出るケース。これは新卒採用をしている証拠にならない。
//   例: 「採用担当（新卒採用）」「新卒採用アシスタント」「新卒リクルーター募集」
//       ＝ 新卒採用の仕事をする人を**中途で**募集している求人。
//   実測: 株式会社コロプラ。HRMOSの求人一覧にこの職種名があり、新卒利用と誤判定した
//        （正解は新卒sonar・HRMOSは中途）。
// 「新卒、中途問わず」も応募資格の常套句で、新卒採用の証拠にならない。
const JOB_TITLE_NOISE = [
  /新卒(?:採用)?(?:担当者?|アシスタント|スタッフ|業務|チーム|responsible|責任者|マネージャー|マネジャー|リーダー|グループ|部門|支援|コンサル(?:タント)?|企画|広報)/g,
  /採用担当[（(][^）)]{0,12}新卒[^）)]{0,12}[）)]/g,
  /新卒[・、,／/]\s*中途(?:問わず|いずれ|どちら)?/g,
  /中途[・、,／/]\s*新卒(?:問わず|いずれ|どちら)?/g,
];
const NOISE_MARK = '＠jobtitle＠';

// 「新卒採用サイクルが今まさに動いている」ことを示す語。
// 中途求人が新卒採用に**言及する**ことはあっても（「新卒採用をご担当いただきます」）、
// 卒年や新卒専用の応募導線までは書かない。ATSページで確定を出すのはこの語がある時だけにする。
// 実測: 株式会社コロプラ。HRMOSに載っていたのは「新卒採用担当」の中途求人だった。
const CYCLE_WORDS = ['卒業見込', 'プレエントリー', '新卒エントリー', '新卒採用エントリー',
  '新卒マイページ', '新卒採用サイト', '新卒採用情報', '新卒採用ページ', '新卒募集要項',
  '会社説明会', '新卒採用選考', '新卒応募'];

/**
 * 新卒サイクルの証拠の強さ。卒年があれば最強（3点）、専用導線の語も3点。
 * 「新卒採用」という**言及だけ**では0点にする（中途求人の職務内容でよく出るため）。
 * @param {string} text
 * @returns {number}
 */
function cycleScore(text) {
  const masked = maskJobTitleNoise(String(text || '')).replace(DAINI_RE, DAINI_MARK);
  if (!masked) return 0;
  for (const w of CYCLE_WORDS) if (masked.includes(w)) return 3;
  for (const re of [/(?:20)?(\d{2})\s*年(?:\s*\d{1,2}\s*月)?\s*卒/g, /(?:20)?(\d{2})\s*卒/g]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(masked))) if (isPlausibleGradYear(Number(m[1]))) return 3;
  }
  return 0;
}

/** 職種名として出た「新卒」を潰す（新卒採用をしている証拠と混同しないため）。 */
function maskJobTitleNoise(text) {
  let out = String(text || '');
  for (const re of JOB_TITLE_NOISE) { re.lastIndex = 0; out = out.replace(re, NOISE_MARK); }
  return out;
}

// URLパスの手がかり。`/careers/` は日本では新卒にも中途にも使われるので**入れない**。
const SHINSOTSU_PATHS = [
  [3, /(^|[/_-])(shinsotsu|sinsotsu|shinsotu|shinsotsusaiyo)([/_-]|$)/i],
  [3, /(^|[/_-])(newgrad|new-grad|new_grad|newgraduate|new-graduate|new_graduate)/i],
  [3, /(^|[/_-])(freshers?|graduates?|gradrecruit)([/_-]|$)/i],
  [2, /(^|[/_-])(students?|campus)([/_-]|$)/i],
  [2, /\/(recruit|saiyo|career)s?\/(new|fresh)/i],
];
const CHUTO_PATHS = [
  [3, /(^|[/_-])(chuto|chutou|chuuto|midcareer|mid-career|mid_career|mid)([/_-]|$)/i],
  [3, /(^|[/_-])(experienced|career-recruit|careerentry)([/_-]|$)/i],
  [2, /\/(recruit|saiyo|career)s?\/(mid|chuto|experienced)/i],
];

// 卒年。`27卒` `2027年卒` は本文で、`/27/` `/2027/` `_2027` はURLで拾う。
// 「今年から見て妥当な卒年か」を効かせるため、範囲は実行時の年から -1〜+8 年で切る。
const GRAD_YEAR_TEXT = /(?:20)?(\d{2})\s*年(?:\s*\d{1,2}\s*月)?\s*卒|(?:20)?(\d{2})\s*卒/g;
const GRAD_YEAR_PATH = /(?:^|[/_-])(?:20)?([23]\d)(?:[/_-]|$)/g;

/** 卒年として妥当か（今年-1 〜 今年+8）。2桁でも4桁でも受ける。 */
function isPlausibleGradYear(n, now = new Date()) {
  const y = n >= 100 ? n : 2000 + n;
  const cur = now.getFullYear();
  return y >= cur - 1 && y <= cur + 8;
}

/** 2桁表記に寄せる（2027→27）。 */
const twoDigit = (n) => String((Number(n) >= 100 ? Number(n) - 2000 : Number(n))).padStart(2, '0');

/**
 * テキスト／URLから**採用活動中の卒年を全部**取り出す（`27卒` `2027年3月卒業見込` `/27/` `_2028`）。
 * 「27卒向けのATS」「28卒はまだ」を切り分けるための列を作るのに使う。
 * 採点（scoreWords）は最初の1件で足りるが、一覧化には全件が要るので別関数にしている。
 *
 * @param {{text?:string, url?:string, atsHost?:boolean}} input
 * @returns {string[]} 2桁の卒年を昇順で（例 ['27','28']）
 */
function extractGradYears(input = {}) {
  const years = new Set();
  const text = maskJobTitleNoise(String(input.text || '')).replace(DAINI_RE, DAINI_MARK);
  if (text) {
    // 27卒 / 2027年卒 / 2027年3月卒業（見込）
    for (const re of [/(?:20)?(\d{2})\s*年(?:\s*\d{1,2}\s*月)?\s*卒/g, /(?:20)?(\d{2})\s*卒/g]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) if (isPlausibleGradYear(Number(m[1]))) years.add(twoDigit(m[1]));
    }
  }
  if (input.url && input.atsHost) {
    let p = String(input.url);
    try { const u = new URL(/^https?:\/\//i.test(p) ? p : 'https://' + p); p = u.pathname + u.search; } catch (_) { /* 生文字列 */ }
    GRAD_YEAR_PATH.lastIndex = 0;
    let m;
    while ((m = GRAD_YEAR_PATH.exec(p))) if (isPlausibleGradYear(Number(m[1]))) years.add(twoDigit(m[1]));
    const y4 = p.match(/20[23]\d(?!\d)/g) || [];
    for (const y of y4) if (isPlausibleGradYear(Number(y))) years.add(twoDigit(y));
  }
  return [...years].sort();
}

// 「製品を紹介しているだけ」の文脈。HR系メディア・比較記事・導入事例で製品名が出るのを弾く。
// 例: 株式会社リクルートマネジメントソリューションズのサイトに「採用一括かんりくん」の文字列。
const ARTICLE_WORDS = ['導入事例', '比較', 'ランキング', 'おすすめ', 'とは？', 'とは何', '資料請求',
  'サービス紹介', 'ソリューション一覧', 'コラム', 'ブログ記事', '関連記事', 'お役立ち', 'セミナーレポート',
  '導入企業一覧', '提供サービス', '取扱製品', 'パートナー企業'];

// ── 採点 ─────────────────────────────────────────────────────────
/**
 * テキストから新卒/中途の言葉を数える。
 * @param {string} text 本文・アンカーテキスト・見出しなど
 * @returns {{shinsotsu:number, chuto:number, sHits:string[], cHits:string[]}}
 */
function scoreWords(text) {
  const raw = String(text || '');
  if (!raw) return { shinsotsu: 0, chuto: 0, strongS: 0, strongC: 0, sHits: [], cHits: [] };
  // 「第二新卒」と職種名の「新卒」を、新卒語として数える前に潰す
  const s = maskJobTitleNoise(raw).replace(DAINI_RE, DAINI_MARK);
  let shinsotsu = 0, chuto = 0, strongS = 0, strongC = 0;
  const sHits = [], cHits = [];
  for (const [w, word] of SHINSOTSU_WORDS) {
    if (!s.includes(word)) continue;
    shinsotsu += w; sHits.push(word);
    if (w >= 3) strongS += w;                    // 単独で決め手になる語（新卒採用・卒業見込…）
  }
  for (const [w, word] of CHUTO_WORDS) {
    const hit = word === '第二新卒' ? raw.includes(word) : s.includes(word);
    if (!hit) continue;
    chuto += w; cHits.push(word);
    if (w >= 3) strongC += w;
  }
  // 卒年（27卒 / 2027年卒 / 2027年3月卒業）は新卒の決定打
  GRAD_YEAR_TEXT.lastIndex = 0;
  let m;
  while ((m = GRAD_YEAR_TEXT.exec(s))) {
    const yy = Number(m[1] || m[2]);
    if (isPlausibleGradYear(yy)) { shinsotsu += 3; strongS += 3; sHits.push(m[0].trim()); break; }
  }
  return { shinsotsu, chuto, strongS, strongC, sHits, cHits };
}

/**
 * URLのパス（＋クエリ）から新卒/中途を読む。
 * 卒年の数字（`/27/` `rms2028`）は**ATSホストのURLでだけ**信用する。
 * 一般サイトの `/2027/` は年別アーカイブのことがあるため。
 * @param {string} url
 * @param {{atsHost?:boolean}} [opts] atsHost=true でパス中の卒年を採用する
 */
function scoreUrl(url, opts = {}) {
  const s = String(url || '');
  if (!s) return { shinsotsu: 0, chuto: 0, strongS: 0, strongC: 0, sHits: [], cHits: [] };
  let p = s;
  try { const u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); p = u.pathname + u.search; } catch (_) { /* 生文字列のまま見る */ }
  let shinsotsu = 0, chuto = 0, strongS = 0, strongC = 0;
  const sHits = [], cHits = [];
  for (const [w, re] of SHINSOTSU_PATHS) { const m = p.match(re); if (m) { shinsotsu += w; sHits.push('path:' + m[0]); if (w >= 3) strongS += w; } }
  for (const [w, re] of CHUTO_PATHS) { const m = p.match(re); if (m) { chuto += w; cHits.push('path:' + m[0]); if (w >= 3) strongC += w; } }
  if (opts.atsHost) {
    // ATSのマイページURLは卒年をパスに持つ（career-cloud.asia/27/form/…、…/rms2028/、…group2027/）
    let year = '';
    GRAD_YEAR_PATH.lastIndex = 0;
    let m;
    while ((m = GRAD_YEAR_PATH.exec(p))) { if (isPlausibleGradYear(Number(m[1]))) { year = m[1]; break; } }
    if (!year) {
      const y = p.match(/(20[23]\d)(?!\d)/);
      if (y && isPlausibleGradYear(Number(y[1]))) year = y[1];
    }
    if (year) { shinsotsu += 3; strongS += 3; sHits.push('卒年' + year); }
  }
  return { shinsotsu, chuto, strongS, strongC, sHits, cHits };
}

const SCOPE = { SHINSOTSU: '新卒', CHUTO: '中途', BOTH: '新卒/中途', UNKNOWN: '不明' };

/**
 * テキスト（任意）＋URL（任意）を合わせてスコープを決める。
 * @param {{text?:string, url?:string, atsHost?:boolean}} input
 * @returns {{scope:string, shinsotsu:number, chuto:number, sHits:string[], cHits:string[]}}
 */
function scopeOf(input = {}) {
  const a = scoreWords(input.text);
  const b = scoreUrl(input.url, { atsHost: !!input.atsHost });
  const shinsotsu = a.shinsotsu + b.shinsotsu;
  const chuto = a.chuto + b.chuto;
  const strongS = a.strongS + b.strongS;
  const strongC = a.strongC + b.strongC;
  const sHits = [...new Set([...a.sHits, ...b.sHits])];
  const cHits = [...new Set([...a.cHits, ...b.cHits])];
  let scope = SCOPE.UNKNOWN;
  if (shinsotsu >= 3 && chuto >= 3) scope = SCOPE.BOTH;
  else if (shinsotsu >= 3) scope = SCOPE.SHINSOTSU;
  else if (chuto >= 3) scope = SCOPE.CHUTO;
  else if (shinsotsu > chuto) scope = SCOPE.SHINSOTSU;
  else if (chuto > shinsotsu) scope = SCOPE.CHUTO;
  return { scope, shinsotsu, chuto, strongS, strongC, sHits, cHits };
}

/** URLだけ版の薄いラッパ。 */
function scopeOfUrl(url, atsHost) { return scopeOf({ url, atsHost: !!atsHost }); }

/** 「製品を紹介しているだけ」の文脈か（比較記事・導入事例など）。 */
function isArticleContext(text) {
  const s = String(text || '');
  return ARTICLE_WORDS.some((w) => s.includes(w));
}

// ── 採否ゲート ───────────────────────────────────────────────────
const GRADE = {
  CONFIRMED: '確定',            // 新卒でそのATSを使っている直接証拠あり → リストに載せてよい
  CHUTO: '中途用',              // ATSはあるが中途の導線 → 新卒リストには載せない
  REVIEW: '要確認',             // 証拠不十分（旧ロジックはここを全部「確定」扱いしていた）
  NO_SHINSOTSU: '新卒採用なし',  // 採用ページは読めたが新卒の募集が見当たらない
  NONE: '該当なし',
};

/**
 * 集めた証拠から採否を決める。**ここが唯一の採用基準**。
 *
 * @param {object} ev
 * @param {string}  ev.kind             検出したもの種別（ats/media/form/sns）
 * @param {string}  ev.source           url | redirect | embed | marker
 * @param {string}  ev.atsUrl           ATSホスト上の実URL（markerの時は空）
 * @param {string}  ev.linkContext      そのATS参照の周辺テキスト（アンカー文言・直前の見出し）
 * @param {string}  ev.atsPageText      ATSページ自体を取得できた時の本文
 * @param {object}  ev.pageScope        参照元ページ全体のスコープ（scopeOf の戻り）
 * @param {boolean} ev.pageHasShinsotsu 参照元ページに新卒の記載があるか（未取得なら undefined）
 * @returns {{grade:string, reason:string, scope:string, confidence:number}}
 *
 * 判定順（上から）:
 *   0) ATSでない／実URLが無い（marker止まり）        → 要確認（絶対に確定にしない）
 *   1) 紹介記事の文脈                                 → 要確認
 *   2) ATSページ本文が読めた: そこが新卒か中途かで決める（最も強い証拠）
 *   3) ATSのURL自体に新卒の印（卒年・shinsotsu）      → 確定
 *   4) リンク周辺が「中途採用」                        → 中途用
 *   5) 採用ページに新卒の記載が無い                    → 新卒採用なし
 *   6) それ以外                                       → 要確認
 *
 * 確定を出せるのは 2) と 3) だけ＝**ATSのURL/ページそのものに新卒の証拠がある時**に限る。
 * 参照元ページ側の文脈（「新卒採用」の見出しの近くにあった等）では確定にしない。
 * ナビに新卒/中途が並ぶだけで誤確定するため。
 */
function gradeEvidence(ev = {}) {
  const mk = (grade, reason, scope, confidence) => ({
    grade, reason, scope: scope || SCOPE.UNKNOWN, confidence,
    // 確定した時だけ卒年を出す（中途・要確認の行に卒年が付くと一覧の意味が壊れる）
    years: grade === GRADE.CONFIRMED
      ? extractGradYears({ text: ev.atsPageText, url: ev.atsUrl, atsHost: true })
      : [],
  });

  if (ev.kind && ev.kind !== 'ats') return mk(GRADE.NONE, 'ATSではない', SCOPE.UNKNOWN, 0);
  if (!ev.atsUrl) return mk(GRADE.REVIEW, '実URLなし（本文の文字列のみ）＝証拠不十分', SCOPE.UNKNOWN, 0.3);
  if (ev.source === 'marker') return mk(GRADE.REVIEW, '本文マーカーのみ＝証拠不十分', SCOPE.UNKNOWN, 0.3);
  if (isArticleContext(ev.linkContext)) return mk(GRADE.REVIEW, '紹介記事・導入事例の文脈', SCOPE.UNKNOWN, 0.3);
  // ベンダーの製品紹介ページ（hrmos.co/ats/ 等）へのリンクは「導入している」証拠ではない
  if (isVendorOwnPage(ev.atsUrl)) return mk(GRADE.REVIEW, 'ベンダー自身のページ（テナントURLでない）＝証拠不十分', SCOPE.UNKNOWN, 0.3);

  const urlScope = scopeOfUrl(ev.atsUrl, true);

  // 2) ATSページ本文（取得できていれば最優先）
  if (ev.atsPageText) {
    const p = scopeOf({ text: ev.atsPageText, url: ev.atsUrl, atsHost: true });
    // 求人一覧ページは新卒と中途が混ざる。多数決にすると「中途求人が多い会社の新卒枠」を
    // 取りこぼすので**多数決にはしない**。ただし「新卒採用」という言及だけでは確定にしない。
    // 中途求人が新卒採用に言及する（「新卒採用をご担当いただきます」）誤爆があるため、
    // 卒年か新卒専用の応募導線（プレエントリー・卒業見込・会社説明会…）を必須にする。
    const cycle = cycleScore(ev.atsPageText);
    if (cycle >= 3) {
      return mk(GRADE.CONFIRMED, `ATSページに新卒の募集（${p.sHits.slice(0, 3).join('・')}）`, SCOPE.SHINSOTSU, 1);
    }
    if (p.chuto >= 3) {
      return mk(GRADE.CHUTO, `ATSページが中途のみ（${p.cHits.slice(0, 3).join('・')}）`, SCOPE.CHUTO, 1);
    }
    // 新卒の決め手も中途語も無い（求人0件・JS描画など）。URLに新卒の印があれば拾う
    if (urlScope.shinsotsu >= 3) {
      return mk(GRADE.CONFIRMED, `ATS URLに新卒の印（${urlScope.sHits.join('・')}）`, SCOPE.SHINSOTSU, 1);
    }
    return mk(GRADE.REVIEW, 'ATSページから新卒/中途を読み取れない（求人0件・JS描画の可能性）', SCOPE.UNKNOWN, 0.5);
  }

  // 3) ATSのURL自体（career-cloud.asia/27/… 等）
  if (urlScope.shinsotsu >= 3 && urlScope.chuto === 0) {
    return mk(GRADE.CONFIRMED, `ATS URLに新卒の印（${urlScope.sHits.join('・')}）`, SCOPE.SHINSOTSU, 1);
  }
  if (urlScope.chuto >= 3 && urlScope.shinsotsu === 0) {
    return mk(GRADE.CHUTO, `ATS URLが中途（${urlScope.cHits.join('・')}）`, SCOPE.CHUTO, 1);
  }

  // 4) リンク周辺が中途 → 中途用（**却下**の判断にだけ文脈を使う）
  //    確定に文脈は使わない。「新卒採用｜中途採用」が並ぶナビの中のリンクだと、
  //    周辺テキストに新卒の語が入るだけで中途ATSを新卒と誤認するため
  //    （実測: 株式会社ジェイ・スポーツ。新卒はsonar、リンク先は中途のHRMOS）。
  const ctx = scopeOf({ text: ev.linkContext });
  if (ctx.chuto >= 3 && ctx.chuto > ctx.shinsotsu) {
    return mk(GRADE.CHUTO, `導線の文脈が中途（${ctx.cHits.slice(0, 3).join('・')}）`, SCOPE.CHUTO, 0.9);
  }

  // 5) 新卒の記載がどこにも無い＝中途しか募集していない可能性
  const ps = ev.pageScope || {};
  if (ev.pageHasShinsotsu === false && (ps.chuto || 0) >= 3) {
    return mk(GRADE.NO_SHINSOTSU, '採用ページに新卒の記載なし（中途のみ）', SCOPE.CHUTO, 0.9);
  }
  return mk(GRADE.REVIEW, '新卒で使っている証拠が取れない（ATSページ未確認）', SCOPE.UNKNOWN, 0.5);
}

module.exports = {
  scopeOf, scopeOfUrl, scoreWords, scoreUrl, isArticleContext, gradeEvidence, maskJobTitleNoise, cycleScore,
  isPlausibleGradYear, extractGradYears, SCOPE, GRADE,
  SHINSOTSU_WORDS, CHUTO_WORDS, ARTICLE_WORDS,
};
