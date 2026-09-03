'use strict';
/**
 * 層2: タイミングシグナル（インテントデータ）の判定 — 純ロジック・ネットワーク不要
 * ============================================================================
 * 層1（ATS未導入 × ICP適合）だけでは母数が大きすぎて刺す順が決まらない。
 * 「いま採用業務が破綻しかけている／いま採用に投資すると決めた」痕跡＝タイミングシグナルで順序を作る。
 *
 * 効く順（ユーザー確定 2026-09-03）:
 *   ① 人事・採用担当の中途求人       … 採用業務が回っていない直接証拠。求人票に「母集団形成/採用管理」で確定級
 *   ② 二次募集・秋採用・通年採用     … 計画未充足の証拠（通年採用は定型文＝偽陽性が多いので弱く採る）
 *   ③ 採用専用メールアドレスの新設   … 既存顧客の58%が保有する質シグナル。"新設"なら投資判断の直後
 *   ④ 採用予定数の前年比増           … ICPの「年6名以上」ラインをまたいだ社が最高
 *   ⑤ 採用ページの新設・リニューアル … 採用に金を入れると決めた直後
 *   ⑥ 採用用LINE公式アカウントの取得 … 自前でLINE運用を始めようとしている＝MOCHICAのど真ん中
 *   ⑦ インターン新規開始・合説初出展 … プロセスが増える＝Excel運用が破綻する
 *
 * 設計の肝:
 *   - 「新設／切り替え」は "前回観測に無く今ある" ことでしか言えない。履歴が無い初回は baseline を
 *     記録するだけで新設として数えない（観測台帳は store.js）。SIGNALS[].要履歴 がその印。
 *   - 検知は必ず「根拠テキスト（一次情報の引用）」を返す。架電時にそのまま読める形にするため。
 *   - 否定文（「二次募集は行っておりません」）はキーワード近傍で必ず打ち消す。
 *   - 強度(strength 0..1)と重み(weight)を分離。重み＝シグナルの効き、強度＝その社での確からしさ。
 */
const { normCompanyName } = require('../csv');

// ---- シグナル定義（weight＝効く順そのもの。半減期＝そのシグナルの賞味期限）----
const SIGNALS = {
  MIDCAREER_HR_JOB: {
    id: 'MIDCAREER_HR_JOB', 順位: 1, 名称: '人事・採用担当の中途求人', 列: 'S1_人事中途求人',
    weight: 40, 半減期日: 45, 要履歴: false,
    説明: '採用業務が回っていない直接証拠。求人票に「母集団形成/採用管理」があれば確定に近い',
  },
  SECONDARY_RECRUIT: {
    id: 'SECONDARY_RECRUIT', 順位: 2, 名称: '二次募集・秋採用・通年採用への切替', 列: 'S2_二次募集',
    weight: 28, 半減期日: 30, 要履歴: false,
    説明: '「追加募集中」＝計画が充足しなかった証拠。通年採用は定型文が多いため弱く採る',
  },
  RECRUIT_EMAIL: {
    id: 'RECRUIT_EMAIL', 順位: 3, 名称: '採用専用メールアドレスの新設', 列: 'S3_採用メール',
    weight: 22, 半減期日: 90, 要履歴: true,
    説明: '既存顧客の58%が保有する質シグナル。新設なら投資判断の直後',
  },
  HIRE_PLAN_UP: {
    id: 'HIRE_PLAN_UP', 順位: 4, 名称: '採用予定数の前年比増', 列: 'S4_採用数増',
    weight: 20, 半減期日: 120, 要履歴: false,
    説明: '年差分がプラス。ICPの「年6名以上」ラインをまたいだ社が最高',
  },
  RECRUIT_PAGE: {
    id: 'RECRUIT_PAGE', 順位: 5, 名称: '採用ページの新設・リニューアル', 列: 'S5_採用ページ',
    weight: 16, 半減期日: 60, 要履歴: true,
    説明: '採用に金を入れると決めた直後。初回観測は baseline（新設として数えない）',
  },
  LINE_RECRUIT: {
    id: 'LINE_RECRUIT', 順位: 6, 名称: '採用用LINE公式アカウントの取得', 列: 'S6_採用LINE',
    weight: 14, 半減期日: 90, 要履歴: true,
    説明: '自前でLINE運用を始めようとしている＝MOCHICAのど真ん中',
  },
  INTERN_NEW: {
    id: 'INTERN_NEW', 順位: 7, 名称: 'インターン・仕事体験の新規開始', 列: 'S7_インターン',
    weight: 10, 半減期日: 60, 要履歴: true,
    説明: 'プロセスが増える＝Excel運用が破綻する',
  },
  EXPO_FIRST: {
    id: 'EXPO_FIRST', 順位: 8, 名称: '合同説明会の初出展', 列: 'S8_合説',
    weight: 10, 半減期日: 60, 要履歴: true,
    説明: '母集団形成に外部投資を始めた＝応募者管理の負荷が跳ねる',
  },
};
const SIGNAL_LIST = Object.values(SIGNALS).sort((a, b) => a.順位 - b.順位);

// ---- テキスト共通ヘルパ ----
const norm = (s) => String(s || '').replace(/[　\t]+/g, ' ').replace(/ {2,}/g, ' ');

// キーワード近傍の引用（架電でそのまま読める根拠にする）
function snippet(text, idx, before = 16, after = 44) {
  const s = norm(text);
  const from = Math.max(0, idx - before);
  return (from > 0 ? '…' : '') + s.slice(from, idx + after).replace(/\n+/g, ' ').trim() + '…';
}

// 否定の打ち消し。キーワード直後に否定・停止表現があればヒットにしない。
// 「既卒可 …現在、応募受付を停止しています」のような掲載中断は、募集の証拠にならない。
const NEGATION_RE = /(あり?ません|ございません|行っており?ません|行っていません|実施(?:して)?おり?ません|予定は(?:あり|ござい)ません|受付(?:を)?終了|受付(?:を)?停止|募集(?:を|は)?停止|募集(?:は)?終了|選考(?:を)?終了|締め切り|中止|見送り|未定です)/;
// 留保表現。「追加募集は状況により検討します」＝まだ動いていない。落としはしないが強度を半分にする。
const HEDGE_RE = /(状況により|場合(?:が)?(?:あり|ござい)ます|検討(?:し(?:ます|ています|中)|する場合)|予定です|可能性(?:が)?(?:あり|ござい)|次第で)/;
function negatedAround(text, idx, kw) {
  const s = norm(text);
  return NEGATION_RE.test(s.slice(idx + kw.length, idx + kw.length + 26));
}
function hedgedAround(text, idx, kw) {
  const s = norm(text);
  return HEDGE_RE.test(s.slice(idx + kw.length, idx + kw.length + 26));
}

// キーワード群のうち「否定されずに」最初に出たものを返す（留保表現は hedged で通知）
function findKeyword(text, list) {
  const s = norm(text);
  for (const kw of list) {
    let from = 0;
    for (;;) {
      const i = s.indexOf(kw, from);
      if (i < 0) break;
      if (!negatedAround(s, i, kw)) return { kw, idx: i, 引用: snippet(s, i), hedged: hedgedAround(s, i, kw) };
      from = i + kw.length;
    }
  }
  return null;
}

function countOccurrences(text, list) {
  const s = norm(text);
  let n = 0;
  for (const kw of list) { let i = -1; while ((i = s.indexOf(kw, i + 1)) >= 0) n++; }
  return n;
}

// 「いま充足できていない卒年」＝主戦場の卒年。4月以降は翌年3月卒が現行（2026-09 → 2027年卒）。
function currentGradYear(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const y = d.getFullYear();
  return d.getMonth() + 1 >= 4 ? y + 1 : y;
}

// 検知結果の共通形。score.js はこの形だけを見る。
function hit(sig, { strength, level, 根拠, 詳細 = {}, 検知日 }) {
  const s = Math.max(0, Math.min(1, strength));
  return {
    signal: sig.id, 名称: sig.名称, 列: sig.列, weight: sig.weight, 半減期日: sig.半減期日,
    strength: Math.round(s * 100) / 100, level, 根拠: String(根拠 || '').slice(0, 300),
    詳細, 検知日: 検知日 || new Date().toISOString().slice(0, 10),
  };
}

// =====================================================================
// ① 人事・採用担当の中途求人（最強）
// =====================================================================
// 職種名が人事/採用“ロール”であること。人材ビジネスの“商品としての”ロールは除く。
// 実測（2026-09-03・上位60社）: 「採用」だけを条件にすると、求人ボックスが拾っている
// その社自身の新卒求人（"2027 新卒採用 農業協同組合"）が37社中30社ほど混ざる。
// そのため裸の「採用」は不可とし、人事ロール語か「採用＋役割語」だけを通す。
const HR_TITLE_RE = /(人事|リクルーター|リクルーティング|人材開発|組織開発|タレントアクイジション|HR(?![a-z])|採用(?:担当|企画|広報|責任者|マネージャ|リーダー|アシスタント|課|部|チーム|戦略|業務|事務|オペレーション))/i;
// その社の“新卒求人”そのもの（＝中途で人事を採っている証拠ではない）
const NEWGRAD_LISTING_RE = /((?:20\d{2}|\d{2}卒)\s*年?\s*新卒採用|新卒採用の(?:募集|求人)|新卒者?を?対象)/;
const AGENCY_ROLE_RE = /(キャリアアドバイザー|リクルーティングアドバイザー|人材コーディネーター|派遣コーディネーター|RA\s*[／/]\s*CA|CA\s*[／/]\s*RA)/;
const OWN_HIRING_RE = /(自社採用|社内|当社の人事|当社の採用|自社の採用)/;
// 確定級の文言＝採用オペレーションそのものを回す人を採っている
const CONFIRM_RE = /(母集団形成|採用管理|応募者管理|ATS|採用計画|採用戦略|採用フロー|選考管理|面接調整|日程調整|説明会(?:の)?運営|採用広報|採用業務全般|スカウト|採用イベント)/g;
// 新卒採用を回す人を中途で採る＝MOCHICA（新卒ATS）のど真ん中
const SHINSOTSU_OPS_RE = /(新卒採用|新卒(?:の)?母集団|新卒担当|新卒・中途|新卒／中途|インターン(?:シップ)?(?:の)?企画|学生対応)/;
const NEWGRAD_ONLY_RE = /(新卒(?:採用)?のみ|新卒限定)/;

// 掲載鮮度テキスト（求人ボックスの「新着」「6日前」「13日前」）→ 経過日数
function parsePostedDays(s) {
  const t = String(s || '');
  if (/新着|本日|たった今/.test(t)) return 0;
  if (/(\d+)\s*時間前/.test(t)) return 0;
  let m = t.match(/(\d+)\s*日(?:以上)?前/); if (m) return parseInt(m[1], 10); // 「14日以上前」も14日として扱う
  m = t.match(/(\d+)\s*週間前/); if (m) return parseInt(m[1], 10) * 7;
  m = t.match(/(\d+)\s*[ヶかカ]?月前/); if (m) return parseInt(m[1], 10) * 30;
  return null;
}
function recencyFactor(days) {
  if (days == null) return 0.85;   // 鮮度不明は中立よりやや下げる
  if (days <= 14) return 1;
  if (days <= 45) return 0.9;
  if (days <= 90) return 0.75;
  return 0.55;
}

/**
 * 中途求人カードから「人事・採用担当を中途で採っている」を判定する。
 * @param {Array<{企業名?:string,職種:string,本文?:string,url?:string,媒体?:string,掲載?:string}>} cards
 * @param {{companyName?:string, 検知日?:string}} opts companyName を渡すと社名一致のカードだけを見る
 */
function detectHrMidCareerJob(cards, opts = {}) {
  const list = Array.isArray(cards) ? cards : [];
  if (!list.length) return null;
  const target = opts.companyName ? normCompanyName(opts.companyName) : '';
  const matched = [];
  for (const c of list) {
    const 職種 = String(c.職種 || '');
    const 本文 = String(c.本文 || '');
    if (target) {
      const n = normCompanyName(c.企業名 || '');
      if (!n) continue;
      if (!(n === target || n.includes(target) || target.includes(n))) continue;
    }
    if (!HR_TITLE_RE.test(職種)) continue;                                     // 職種が人事/採用ロールでない
    if (NEWGRAD_LISTING_RE.test(職種)) continue;                                // その社の新卒求人そのもの
    if (NEWGRAD_ONLY_RE.test(職種 + 本文)) continue;                            // 新卒側の募集は中途求人ではない
    if (AGENCY_ROLE_RE.test(職種) && !OWN_HIRING_RE.test(職種 + 本文)) continue; // 人材ビジネスの売り物ロール
    const hay = 職種 + ' ' + 本文;
    const confirms = [...new Set(hay.match(CONFIRM_RE) || [])];
    const shinsotsu = SHINSOTSU_OPS_RE.test(hay);
    matched.push({ ...c, confirms, shinsotsu, days: parsePostedDays(c.掲載) });
  }
  if (!matched.length) return null;

  // 代表カードは「確定語の数 → 新卒運用 → 掲載鮮度」で決める
  matched.sort((a, b) => (b.confirms.length - a.confirms.length)
    || (Number(b.shinsotsu) - Number(a.shinsotsu))
    || ((a.days == null ? 999 : a.days) - (b.days == null ? 999 : b.days)));
  const best = matched[0];

  let strength = 0.6;
  let level = '中(人事ロールの中途求人)';
  if (best.confirms.length >= 2 || (best.confirms.length >= 1 && best.shinsotsu)) { strength = 1; level = '確定(採用オペ文言あり)'; }
  else if (best.confirms.length === 1 || best.shinsotsu) { strength = 0.85; level = '強(採用実務の記載あり)'; }
  if (matched.length >= 2) strength = Math.min(1, strength + 0.05); // 複数枚の出稿＝本気度
  strength *= recencyFactor(best.days);

  const 根拠 = `${best.媒体 || '求人検索'}に人事・採用担当の中途求人「${String(best.職種).slice(0, 46)}」`
    + (best.confirms.length ? `／確定文言: ${best.confirms.slice(0, 4).join('・')}` : '')
    + (best.shinsotsu ? '／新卒採用の運用担当' : '')
    + (best.days != null ? `／掲載${best.days}日前` : '')
    + (matched.length > 1 ? `／計${matched.length}件` : '');
  return hit(SIGNALS.MIDCAREER_HR_JOB, {
    strength, level, 根拠, 検知日: opts.検知日,
    詳細: { 件数: matched.length, 職種: best.職種, url: best.url || '', 確定文言: best.confirms, 掲載日数: best.days },
  });
}

// =====================================================================
// ② 二次募集・秋採用・通年採用への切り替え
// =====================================================================
const SECONDARY_STRONG = ['二次募集', '2次募集', '第二次募集', '追加募集', '追加選考', '募集再開', '再募集',
  '秋採用', '秋期採用', '秋季採用', '冬採用', '選考再開', 'エントリー再開', '追加エントリー'];
const SECONDARY_MED = ['第二新卒', '卒業後3年以内', '留学生特別選考', '追加募集枠'];
// 「既卒可」はマイナビの掲載属性（バッジ）としても出る。実測: 2,000社中896社(45%)が該当し、
// 中強度で採ると B階層が埋まって順位が壊れるため、間口拡大の“弱い”証拠として別枠にする。
const SECONDARY_BADGE = ['既卒可', '既卒者も', '既卒歓迎'];
const SECONDARY_WEAK = ['通年採用', '通年で採用', '随時募集', '随時受付', '年間を通じて募集', 'いつでもエントリー'];

/**
 * 募集の“やり直し”を検知する。
 * @param {{text:string, 卒年?:string, now?:Date|string, 検知日?:string}} o
 */
function detectSecondaryRecruit({ text, 卒年 = '', now, 検知日 } = {}) {
  const s = norm(text);
  if (!s) return null;
  const cy = currentGradYear(now ? new Date(now) : new Date());
  // 現行卒年（＝いま充足できていない代）への言及があると意味が跳ね上がる
  const yearRe = new RegExp(`(${cy}年(?:3月)?卒|${String(cy).slice(2)}卒)`);
  const 卒年一致 = yearRe.test(s) || yearRe.test(String(卒年));

  const strong = findKeyword(s, SECONDARY_STRONG);
  if (strong) {
    const 秋冬 = /秋|冬/.test(strong.kw);
    let strength = 卒年一致 ? 1 : 0.9;
    if (秋冬 && !卒年一致) strength = 0.8;
    let level = 秋冬 ? '強(秋・冬採用への切替)' : '確定(二次・追加募集)';
    // 「追加募集は状況により検討します」＝まだ動いていない。半分に落として留保を明示する。
    if (strong.hedged) { strength *= 0.5; level = '中(追加募集は検討段階の記載)'; }
    return hit(SIGNALS.SECONDARY_RECRUIT, {
      strength, level, 検知日,
      根拠: `「${strong.kw}」を掲載: ${strong.引用}` + (卒年一致 ? `／現行の${cy}年卒に言及` : '') + (strong.hedged ? '／※実施は検討段階の表現' : ''),
      詳細: { キーワード: strong.kw, 卒年一致, 留保: !!strong.hedged },
    });
  }
  const med = findKeyword(s, SECONDARY_MED);
  if (med) {
    return hit(SIGNALS.SECONDARY_RECRUIT, {
      strength: (卒年一致 ? 0.45 : 0.35) * (med.hedged ? 0.5 : 1), level: '中(第二新卒・既卒へ間口拡大)', 検知日,
      根拠: `「${med.kw}」を掲載: ${med.引用}`, 詳細: { キーワード: med.kw, 卒年一致, 留保: !!med.hedged },
    });
  }
  const badge = findKeyword(s, SECONDARY_BADGE);
  if (badge) {
    return hit(SIGNALS.SECONDARY_RECRUIT, {
      strength: 卒年一致 ? 0.25 : 0.2, level: '弱(既卒可＝掲載属性の可能性)', 検知日,
      根拠: `「${badge.kw}」を掲載: ${badge.引用}`, 詳細: { キーワード: badge.kw, 卒年一致, バッジ: true },
    });
  }
  const weak = findKeyword(s, SECONDARY_WEAK);
  if (weak) {
    // 通年採用は偽陽性の主犯（定型文）。単独では弱く採り、根拠にその旨を明記する。
    return hit(SIGNALS.SECONDARY_RECRUIT, {
      strength: 0.35, level: '弱(通年・随時募集＝定型文の可能性)', 検知日,
      根拠: `「${weak.kw}」を掲載: ${weak.引用}`, 詳細: { キーワード: weak.kw, 卒年一致 },
    });
  }
  return null;
}

// =====================================================================
// ③ 採用専用メールアドレスの新設
// =====================================================================
// email-harvest の classifyRole は /hr/ 等が語中一致する（例: chris@）ため、ここでは
// 区切り文字で割ったトークンの完全一致だけを採用専用と見なす（厳しめ）。
const RECRUIT_LOCAL_TOKENS = new Set(['recruit', 'recruits', 'recruiting', 'recruitment', 'saiyo', 'saiyou',
  'jinji', 'jinzai', 'hr', 'hrd', 'career', 'careers', 'job', 'jobs', 'entry', 'newgrad', 'shinsotsu',
  'sinsotu', 'employment', 'personnel', 'saiyoinfo', 'shukatsu']);
function isRecruitAddress(email) {
  const local = String(email || '').toLowerCase().split('@')[0];
  if (!local) return false;
  return local.split(/[._\-+0-9]+/).filter(Boolean).some((t) => RECRUIT_LOCAL_TOKENS.has(t));
}

/**
 * @param {{emails:Array<{email:string,ownDomain?:boolean}|string>, prevEmails?:string[]|null, 検知日?:string}} o
 * prevEmails が null（＝履歴なし）なら「保有」までしか言わない。
 */
function detectRecruitEmail({ emails = [], prevEmails = null, 検知日 } = {}) {
  const recs = emails.map((e) => (typeof e === 'string' ? { email: e } : e)).filter((e) => e && e.email);
  const recruit = recs.filter((e) => isRecruitAddress(e.email));
  if (!recruit.length) return null;
  const own = recruit.find((e) => e.ownDomain) || recruit[0];
  const 自社ドメイン = !!own.ownDomain;

  if (Array.isArray(prevEmails)) {
    const prev = new Set(prevEmails.map((x) => String(x).toLowerCase()));
    const fresh = recruit.filter((e) => !prev.has(String(e.email).toLowerCase()));
    if (fresh.length) {
      const 前に採用アドレス有 = prevEmails.some((x) => isRecruitAddress(x));
      return hit(SIGNALS.RECRUIT_EMAIL, {
        strength: 自社ドメイン ? (前に採用アドレス有 ? 0.7 : 1) : 0.6,
        level: 前に採用アドレス有 ? '強(採用アドレスを追加)' : '確定(採用専用アドレスを新設)', 検知日,
        根拠: `採用専用アドレス ${fresh[0].email} を新規検知（前回観測には無し${前に採用アドレス有 ? '＝別口を追加' : ''}）`,
        詳細: { メール: fresh[0].email, 新設: true, 自社ドメイン },
      });
    }
  }
  return hit(SIGNALS.RECRUIT_EMAIL, {
    strength: 自社ドメイン ? 0.35 : 0.25, level: '弱(採用専用アドレスを保有＝新設かは履歴待ち)', 検知日,
    根拠: `採用専用アドレス ${own.email} を保有（既存顧客の58%が保有する質シグナル）`,
    詳細: { メール: own.email, 新設: false, 自社ドメイン },
  });
}

// =====================================================================
// ④ 採用予定数の前年比増
// =====================================================================
// "2026年26名/2025年33名/2024年33名" 形式・配列形式のどちらも受ける
function parseHireSeries(input) {
  if (Array.isArray(input)) {
    return input
      .map((x) => ({ 年: parseInt(x.年 != null ? x.年 : x.year, 10), 人数: parseInt(x.人数 != null ? x.人数 : x.count, 10) }))
      .filter((x) => Number.isFinite(x.年) && Number.isFinite(x.人数))
      .sort((a, b) => b.年 - a.年);
  }
  const s = String(input || '');
  const out = [];
  const seen = new Set();
  for (const m of s.matchAll(/(20\d{2})\s*年\D{0,4}?(\d{1,4})\s*名/g)) {
    const 年 = +m[1];
    if (seen.has(年)) continue;
    seen.add(年); out.push({ 年, 人数: +m[2] });
  }
  return out.sort((a, b) => b.年 - a.年);
}

/**
 * @param {{series?:string|Array, plan?:number|string, prevPlan?:number|string, floor?:number, 検知日?:string}} o
 *   series … 採用“実績”の年系列（マイナビ会社概要が一次情報。予定より確か）
 *   plan / prevPlan … 採用“予定”人数の今回/前回観測（媒体の採用予定人数フィールドの年差分）
 */
function detectHirePlanIncrease({ series, plan, prevPlan, floor = 6, 検知日 } = {}) {
  const s = parseHireSeries(series);
  let cur = null; let prev = null; let 種別 = '';
  if (s.length >= 2) { cur = s[0]; prev = s[1]; 種別 = '採用実績'; }
  const p = parseInt(plan, 10); const pp = parseInt(prevPlan, 10);
  if (!cur && Number.isFinite(p) && Number.isFinite(pp)) {
    cur = { 年: null, 人数: p }; prev = { 年: null, 人数: pp }; 種別 = '採用予定人数';
  }
  if (!cur || !prev || !(prev.人数 >= 0) || !(cur.人数 > 0)) return null;
  const delta = cur.人数 - prev.人数;
  if (delta <= 0) return null; // 横ばい・減少はシグナルにしない（減少は score 側の注記に回す）

  const 年表記 = cur.年 ? `${prev.年}年${prev.人数}名 → ${cur.年}年${cur.人数}名` : `前回${prev.人数}名 → 今回${cur.人数}名`;
  const ratio = prev.人数 > 0 ? cur.人数 / prev.人数 : Infinity;
  const ライン跨ぎ = prev.人数 < floor && cur.人数 >= floor;
  let strength; let level;
  if (ライン跨ぎ) { strength = 1; level = `確定(ICPの年${floor}名ラインをまたいだ)`; }
  else if (ratio >= 1.5 && delta >= 3) { strength = 0.85; level = '強(5割以上の増員)'; }
  else if (ratio >= 1.2 && delta >= 2) { strength = 0.65; level = '中(2割以上の増員)'; }
  else { strength = 0.4; level = '弱(微増)'; }
  return hit(SIGNALS.HIRE_PLAN_UP, {
    strength, level, 検知日,
    根拠: `${種別}が前年比+${delta}名（${年表記}）` + (ライン跨ぎ ? `／年${floor}名ラインをまたいだ` : ''),
    詳細: { 種別, 今回: cur.人数, 前年: prev.人数, 差分: delta, 年: cur.年 || '', ライン跨ぎ },
  });
}

// =====================================================================
// ⑤ 採用ページの新設・リニューアル
// =====================================================================
const RENEWAL_WORDS = ['リニューアル', '採用サイトをオープン', 'サイトを公開', '新しくなりました', '新設'];

function daysSince(dateStr, now) {
  const s = String(dateStr || '').trim();
  if (!s) return null;
  const m = s.match(/(20\d{2})[/\-年](\d{1,2})[/\-月](\d{1,2})/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (!Number.isFinite(d.getTime())) return null;
  return Math.max(0, Math.round((now.getTime() - d.getTime()) / 86400000));
}

/**
 * @param {{cur:{url?:string,hash?:string,長さ?:number,更新日?:string,text?:string},
 *          prev?:{url?:string,hash?:string,長さ?:number}|null, now?:Date|string, 検知日?:string}} o
 * prev が無い初回は baseline（新設として数えない）。ページ自身が「リニューアル」と書いている時だけ弱く採る。
 */
function detectRecruitPageChange({ cur, prev = null, now, 検知日 } = {}) {
  if (!cur || (!cur.url && !cur.hash)) return null;
  const nowD = now ? new Date(now) : new Date();

  if (prev && !prev.url && cur.url) {
    return hit(SIGNALS.RECRUIT_PAGE, {
      strength: 1, level: '確定(採用ページを新設)', 検知日,
      根拠: `前回観測時に無かった採用ページを検知: ${String(cur.url).slice(0, 120)}`,
      詳細: { url: cur.url, 新設: true },
    });
  }
  if (prev && prev.hash && cur.hash && prev.hash !== cur.hash) {
    const a = prev.長さ || 0; const b = cur.長さ || 0;
    const 変化率 = a > 0 ? Math.abs(b - a) / a : 1;
    if (変化率 >= 0.15) {
      return hit(SIGNALS.RECRUIT_PAGE, {
        strength: 0.75, level: '強(採用ページを大幅刷新)', 検知日,
        根拠: `採用ページの本文量が${Math.round(変化率 * 100)}%変化（${a}→${b}字）＝作り替えの痕跡`,
        詳細: { url: cur.url, 変化率: Math.round(変化率 * 100) / 100 },
      });
    }
    return hit(SIGNALS.RECRUIT_PAGE, {
      strength: 0.3, level: '弱(採用ページを更新)', 検知日,
      根拠: `採用ページの内容が前回観測から変化（${a}→${b}字）`,
      詳細: { url: cur.url, 変化率: Math.round(変化率 * 100) / 100 },
    });
  }
  // 媒体面の「最終更新日」が直近なら、履歴が無くても“いま採用面を触っている”ことは言える
  const 更新日数 = daysSince(cur.更新日, nowD);
  if (更新日数 != null && 更新日数 <= 14) {
    // 更新日は媒体（マイナビ）掲載面のもの。自社ページの指紋とは出所が違うので URL も媒体側を出す。
    // 実測: 2,000社中914社(46%)が直近14日以内の更新＝ありふれている。弱い傍証として扱う。
    return hit(SIGNALS.RECRUIT_PAGE, {
      strength: 更新日数 <= 7 ? 0.4 : 0.28, level: '弱(掲載面を直近更新)', 検知日,
      根拠: `掲載面の最終更新日が${cur.更新日}（${更新日数}日前）＝いま採用面を触っている`,
      詳細: { url: cur.媒体URL || cur.url, 更新日: cur.更新日, 更新日数 },
    });
  }
  if (!prev && cur.text) {
    const f = findKeyword(cur.text, RENEWAL_WORDS);
    if (f) {
      return hit(SIGNALS.RECRUIT_PAGE, {
        strength: 0.4, level: '弱(ページ内にリニューアルの記述)', 検知日,
        根拠: `採用ページに「${f.kw}」の記述: ${f.引用}`, 詳細: { url: cur.url, キーワード: f.kw },
      });
    }
  }
  return null;
}

// =====================================================================
// ⑥ 採用用LINE公式アカウントの取得
// =====================================================================
/**
 * @param {{line:{判定?:string,用途?:string,ID?:string,確度?:number}, prev?:{判定?:string,ID?:string}|null, 検知日?:string}} o
 */
function detectLineRecruit({ line, prev = null, 検知日 } = {}) {
  if (!line || !line.判定) return null;
  const 有 = line.判定 === '有';
  const 要確認 = line.判定 === '要確認';
  if (!有 && !要確認) return null;
  const 採用用途 = line.用途 === '採用';
  const 新規 = !!(prev && prev.判定 && prev.判定 !== '有' && 有);

  let strength; let level;
  if (新規 && 採用用途) { strength = 1; level = '確定(採用用LINEを新規取得)'; }
  else if (新規) { strength = 0.7; level = '強(LINE公式を新規取得・用途不明)'; }
  else if (有 && 採用用途) { strength = 0.55; level = '中(採用用LINEを保有)'; }
  else if (有) { strength = 0.3; level = '弱(LINE公式を保有・用途不明)'; }
  else { strength = 0.2; level = '弱(LINEの痕跡あり・要確認)'; }
  return hit(SIGNALS.LINE_RECRUIT, {
    strength, level, 検知日,
    根拠: `LINE公式${line.ID ? '（' + line.ID + '）' : ''}を${新規 ? '新規に検知' : '検知'}／用途:${line.用途 || '不明'}`
      + (採用用途 ? '＝自前でLINE運用を始めている' : ''),
    詳細: { ID: line.ID || '', 用途: line.用途 || '', 新規 },
  });
}

// =====================================================================
// ⑦ インターン新規開始・合説初出展
// =====================================================================
const INTERN_WORDS = ['インターンシップ', 'インターン', '仕事体験', 'オープン・カンパニー', 'オープンカンパニー', '就業体験'];
const EXPO_WORDS = ['合同企業説明会', '合同説明会', '合同会社説明会', '合説', '就職EXPO', 'マイナビEXPO', '就職博', '合同企業セミナー'];

function detectInternship({ text, 件数, prev = null, 検知日 } = {}) {
  const n = Number.isFinite(件数) ? 件数 : countOccurrences(text, INTERN_WORDS);
  if (!n) return null;
  const f = findKeyword(text || '', INTERN_WORDS);
  if (!f && !Number.isFinite(件数)) return null;
  const prevN = prev && Number.isFinite(prev.件数) ? prev.件数 : null;
  let strength; let level;
  if (prevN === 0) { strength = 1; level = '確定(インターン・仕事体験を新規開始)'; }
  else if (prevN != null && n > prevN) { strength = 0.6; level = '中(インターンのコースを増やした)'; }
  else { strength = 0.3; level = '弱(インターンを実施＝新規かは履歴待ち)'; }
  return hit(SIGNALS.INTERN_NEW, {
    strength, level, 検知日,
    根拠: `インターン/仕事体験の掲載${n}件` + (f ? `: ${f.引用}` : '') + (prevN != null ? `（前回${prevN}件）` : ''),
    詳細: { 件数: n, 前回件数: prevN },
  });
}

function detectExpo({ text, prev = null, 検知日 } = {}) {
  const f = findKeyword(text || '', EXPO_WORDS);
  if (!f) return null;
  const 初出 = !!(prev && prev.出展 === false);
  return hit(SIGNALS.EXPO_FIRST, {
    strength: 初出 ? 1 : 0.35, level: 初出 ? '確定(合説に初出展)' : '弱(合説に出展＝初出かは履歴待ち)', 検知日,
    根拠: `合同説明会への出展を検知（${f.kw}）: ${f.引用}`, 詳細: { キーワード: f.kw, 初出 },
  });
}

// =====================================================================
// 束ねる: 収集済みエビデンス → 検知シグナル配列
// =====================================================================
/**
 * @param {object} ev collect.js が作るエビデンス
 * @param {object|null} prev store.js が返す前回観測（無ければ履歴依存シグナルは baseline 扱い）
 */
function detectAll(ev = {}, prev = null, opts = {}) {
  const 検知日 = opts.検知日 || new Date().toISOString().slice(0, 10);
  const now = opts.now || new Date();
  const p = prev || {};
  const hits = [];
  const push = (h) => { if (h) hits.push(h); };

  push(detectHrMidCareerJob(ev.求人カード || [], { companyName: ev.企業名, 検知日 }));
  push(detectSecondaryRecruit({ text: ev.掲載本文 || '', 卒年: ev.卒年, now, 検知日 }));
  push(detectRecruitEmail({ emails: ev.メール || [], prevEmails: p.メール || null, 検知日 }));
  push(detectHirePlanIncrease({ series: ev.採用実績系列, plan: ev.採用予定人数, prevPlan: p.採用予定人数, 検知日 }));
  push(detectRecruitPageChange({ cur: ev.採用ページ || null, prev: p.採用ページ || null, now, 検知日 }));
  push(detectLineRecruit({ line: ev.LINE || null, prev: p.LINE || null, 検知日 }));
  push(detectInternship({ text: ev.インターン本文 || '', 件数: ev.インターン件数, prev: p.インターン || null, 検知日 }));
  push(detectExpo({ text: (ev.インターン本文 || '') + '\n' + (ev.掲載本文 || ''), prev: p.合説 || null, 検知日 }));
  return hits;
}

module.exports = {
  SIGNALS, SIGNAL_LIST,
  detectAll, detectHrMidCareerJob, detectSecondaryRecruit, detectRecruitEmail,
  detectHirePlanIncrease, detectRecruitPageChange, detectLineRecruit, detectInternship, detectExpo,
  // 下位関数（テスト・再利用のために公開）
  parseHireSeries, isRecruitAddress, parsePostedDays, currentGradYear, findKeyword, negatedAround, hedgedAround,
  daysSince, countOccurrences, INTERN_WORDS, EXPO_WORDS,
};
