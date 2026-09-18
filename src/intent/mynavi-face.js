'use strict';
/**
 * マイナビ「卒年面」の構造化パーサ（層2の幅を広げる土台）
 * ============================================================================
 * これまで層2は「掲載本文を1本のテキストに潰して語を探す」だけだった。そのため
 *   - 採用予定数の増減は“履歴が貯まるまで”言えない
 *   - 選考が何段あるか／応募をどう受けているかという、MOCHICAの提案に直結する事実
 * が取れていなかった。
 *
 * マイナビは corpID が卒年をまたいで安定しているため、同じ会社の「27卒面」と「28卒面」を
 * 並べて取れる。＝初回観測でも“前年比”を言える。ここはその2面から構造値を取り出す層。
 *
 * 取り出す事実（すべて公開掲載面の記載。推測はしない）:
 *   募集人数 / 募集コース / 選考フロー（段数・種類）/ エントリー方法 / 初任給 / 最終更新日
 *
 * 方針: セクション見出しでテキストを切ってからその区間だけを読む。ページ全体への
 * 正規表現は、別セクションの語（例: 中途採用欄の「メール」）を拾って誤判定するため使わない。
 */

const HALF = (s) => String(s || '').normalize('NFKC');
const clean = (s) => HALF(s).replace(/\r/g, '').replace(/[ \t　]+/g, ' ').replace(/\n{2,}/g, '\n').trim();

// ---- セクション切り出し ------------------------------------------------
// 見出し語から次の見出し語までを1区間として返す。見出しが無ければ null。
const SECTION_STOPS = ['募集人数', '募集学部', '募集内訳', '募集の特徴', '採用後の待遇', '初任給', '昇給', '賞与',
  '年間休日', '休日休暇', '福利厚生', '募集コース', 'エントリー方法', '採用フロー', '募集要項', '選考方法',
  '選考の特徴', '問い合わせ先', '連絡先', '採用ホームページ', '先輩情報', '会社概要', '前年度採用データ',
  '求める人物像', '活かせるスキル', '勤務地', '勤務時間', '給与', '諸手当', '待遇'];

/**
 * 見出し語から次の見出し語までを1区間で返す。
 * @param {string} heading 見出し
 * @param {object} o.stops  この区間を終わらせる語（既定は全見出し）
 * @param {RegExp} o.needs  「その見出しの本体」を見分ける語。マイナビは同じ語が
 *   タブのナビ列（募集コース／募集対象／採用フロー…）にも出るため、これが無いと
 *   ナビの並びを本文と誤認して全社が同じ値になる（実測: コース数が全社1になる）。
 */
function section(text, heading, { stops = SECTION_STOPS, max = 4000, needs = null } = {}) {
  const t = clean(text);
  const stopList = stops.filter((x) => x !== heading);
  for (let i = t.indexOf(heading); i >= 0; i = t.indexOf(heading, i + heading.length)) {
    const from = i + heading.length;
    let end = t.length;
    for (const st of stopList) {
      const j = t.indexOf(st, from);
      if (j >= 0 && j < end) end = j;
    }
    const body = t.slice(from, Math.min(end, from + max)).trim();
    if (!needs) return body;
    // needs 指定時は、本体の目印を含む区間に当たるまで次の出現を見る。
    // 判定は必ず body（stop で閉じた区間）に対して行う。先読み窓で判定すると、
    // ナビ列の直後から覗いた窓に本文が入ってしまい、ナビ側を本体と誤認する。
    if (needs.test(body)) return body;
  }
  return '';
}

// ---- ① 募集人数（卒年面どうしの比較に使う）----------------------------
// 「26～30名」「10名程度」「若干名」「未定」を区別する。範囲は下限・上限の両方を残す
// （memory: 範囲を連結して「2630名」にする事故を起こさない）。
function parseHeadcount(text) {
  const sec = section(text, '募集人数', { max: 200 });
  if (!sec) return null;
  const s = HALF(sec).replace(/,/g, '');
  if (/若干名/.test(s)) return { 下限: 1, 上限: 1, 表記: '若干名', 確度: '弱' };
  if (/未定/.test(s.slice(0, 12))) return null;
  const range = s.match(/(\d{1,4})\s*[~〜～-]\s*(\d{1,4})\s*名/);
  if (range) return { 下限: +range[1], 上限: +range[2], 表記: `${range[1]}～${range[2]}名`, 確度: '強' };
  const one = s.match(/(\d{1,4})\s*名/);
  if (one) return { 下限: +one[1], 上限: +one[1], 表記: `${one[1]}名`, 確度: /程度|前後|以上/.test(s.slice(0, 20)) ? '中' : '強' };
  return null;
}
// 比較に使う代表値。範囲は下限を採る（上振れ表記で増加を作らないため）。
const headcountValue = (h) => (h && Number.isFinite(h.下限) ? h.下限 : null);

// ---- ② 選考フロー（段数と種類）----------------------------------------
// MOCHICAの提案に直結する事実。段が多いほど応募者の状態管理が重い。
const FLOW_STEPS = [
  ['会社説明会', /会社説明会|企業説明会|説明会/],
  ['エントリーシート', /エントリーシート|ES提出|履歴書提出|書類選考/],
  ['適性検査', /適性検査|適性試験|SPI|玉手箱|Web ?テスト/i],
  ['筆記試験', /筆記試験|一般常識|作文|小論文/],
  ['グループディスカッション', /グループディスカッション|GD|集団討論/],
  ['面接', /面接/],
  ['最終面接', /最終面接|役員面接/],
  ['内々定', /内々定|内定/],
];
function parseFlow(text) {
  const sec = section(text, 'エントリー方法・採用フロー', { max: 2500 })
    || section(text, '採用フロー', { max: 2500 });
  if (!sec) return null;
  const steps = FLOW_STEPS.filter(([, re]) => re.test(sec)).map(([n]) => n);
  // 面接の実施回数（「1回実施予定」「2回」）。複数ブロックの合計を取る。
  // 「面接(個別) / 開催回数 / 1回実施予定」のブロックを全部足す。ブロックは
  // 「面接(種別)」と回数の間に見出し行が2本まで入る（開催回数・実施場所）。
  let 面接回数 = 0;
  for (const m of sec.matchAll(/面接[^0-9\n]{0,30}(?:\n[^0-9\n]{0,30}){0,2}\s(\d{1,2})\s*回/g)) 面接回数 += +m[1];
  // 「複数回実施予定」は回数を書いていない。最低2回として数える（過大に見積もらない）。
  面接回数 += (sec.match(/複数回実施予定/g) || []).length * 2;
  if (!面接回数 && /面接/.test(sec)) 面接回数 = 1;
  const 選考段数 = steps.filter((s) => s !== '内々定').length;
  return { 段: steps, 選考段数, 面接回数, オンライン: /WEB|ウェブ|オンライン|Web/i.test(sec), 引用: sec.slice(0, 180) };
}

// ---- ③ エントリー方法（手作業運用の痕跡）------------------------------
// 「マイナビよりエントリー」だけ＝媒体任せ。メール/電話/郵送/FAXが出口に混じると
// 応募者データが担当者の受信箱に散る＝MOCHICAが刺さる状態。
// 「ご応募」「お申し込み」のように敬語の接頭辞が挟まるのが普通なので必ず許す。
// これが無いと「メールにてご応募ください」を取りこぼす（実測で踏んだ）。
const P = '(?:お|ご)?';
const ENTRY_MANUAL = [
  ['メール', new RegExp(`(?:メール|E-?mail)(?:に?て|で|より|から)?${P}(?:エントリー|応募|受付|送付|連絡|申し?込み?)|(?:エントリー|応募).{0,8}(?:メール|E-?mail)`, 'i')],
  ['電話', new RegExp(`電話(?:に?て|で|より|から)?${P}(?:エントリー|応募|受付|申し?込み?|連絡)|(?:応募|エントリー).{0,6}電話`)],
  ['郵送', new RegExp(`郵送(?:に?て|で|により)?${P}(?:提出|応募|送付|受付)|履歴書.{0,10}郵送`)],
  ['FAX', new RegExp(`FAX(?:に?て|で)?${P}(?:応募|送付|受付)`, 'i')],
  ['自社フォーム', /当社(?:採用)?(?:ホームページ|サイト|HP).{0,12}(?:より|から)?(?:エントリー|応募)|自社(?:採用)?(?:サイト|ページ).{0,10}(?:より|から)?(?:エントリー|応募)/],
];
function parseEntryRoutes(text) {
  const sec = section(text, 'エントリー方法・採用フロー', { max: 1200 })
    || section(text, 'エントリー方法', { max: 1200 });
  if (!sec) return null;
  const 手作業 = ENTRY_MANUAL.filter(([, re]) => re.test(sec)).map(([n]) => n);
  const 媒体経由 = /マイナビ(?:より|から)?エントリー/.test(sec);
  return { 手作業, 媒体経由, 引用: sec.slice(0, 160) };
}

// ---- ④ 募集コース（複線化＝管理の複雑さ）------------------------------
// コース表の中には「福利厚生」「給与」など共通 stops の語が説明文として出る。
// 共通 stops で切ると1コース目の途中で終わり、全社が「コース1」に潰れる（実測）。
const COURSE_STOPS = ['求める人物像', '活かせるスキル', '募集要項', 'エントリー方法', '採用フロー',
  '採用後の待遇', '選考方法', '選考の特徴', '問い合わせ先', '先輩情報', '前年度採用データ'];
// マイナビが全社に出す属性バッジ。コース名ではない。
const COURSE_BADGE = /^(受託開発|技術派遣)(あり|なし)$/;

function parseCourses(text) {
  // 「募集コース」はタブのナビ列にも出る。本体は必ず「コース名」か「配属職種」を伴う。
  const sec = section(text, '募集コース', { max: 6000, stops: COURSE_STOPS, needs: /コース名|配属職種/ });
  if (!sec) return null;
  // 「配属職種」「配属職種2」…の数＝コース数。マイナビの募集コース表の実構造。
  const n = new Set((sec.match(/配属職種\s*\d?/g) || []).map((x) => x.trim())).size;
  if (n) return { コース数: n, 根拠: '配属職種の枠数', 引用: sec.slice(0, 140) };
  // 配属職種の枠が無い掲載は、コース名の行を「・」区切りで数える（バッジ行は除く）。
  const line = sec.split(/\r?\n/).map((x) => x.trim())
    .find((x) => x && !COURSE_BADGE.test(x) && !/^(コース名|雇用形態|全社共通)$/.test(x)) || '';
  const m = line.split(/[・、／/]/).filter((x) => x.trim().length >= 2).length;
  return m > 0 ? { コース数: m, 根拠: 'コース名の列挙', 引用: sec.slice(0, 140) } : null;
}

// ---- ⑤ 初任給（卒年面の差分＝採用投資の意思決定）----------------------
function parseStartingPay(text) {
  // 初任給の表は「諸手当」「支給額」を内側に含む。共通 stops で切ると金額の手前で終わる。
  const sec = section(text, '初任給', { max: 700, stops: ['昇給', '賞与', '年間休日', '休日休暇', '福利厚生', '勤務地', '勤務時間'] });
  if (!sec) return null;
  const s = HALF(sec).replace(/,/g, '');
  // 「大卒・院了 （月給） 228000円」形式。最大値ではなく“大卒”の額を代表にする。
  const daisotsu = s.match(/(?:大卒|大学卒|学部卒)[^0-9]{0,40}?(\d{5,7})\s*円/);
  const any = s.match(/(\d{5,7})\s*円/);
  const 額 = daisotsu ? +daisotsu[1] : (any ? +any[1] : null);
  if (!額 || 額 < 120000 || 額 > 900000) return null;
  const 実績年 = (s.match(/(20\d{2})年\s*0?(\d{1,2})月(?:実績|予定)/) || [])[1] || '';
  return { 大卒月額: 額, 実績年, 引用: sec.slice(0, 120) };
}

// ---- ⑥ 掲載面の最終更新日 ---------------------------------------------
function parseUpdated(text) {
  const m = HALF(text).match(/最終更新日\s*[：:]\s*(20\d{2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{1,2})/);
  return m ? `${m[1]}/${m[2]}/${m[3]}` : '';
}

// ---- ⑦ 過去3年間の新卒採用者数・離職者数・定着率 ----------------------
// 若者雇用促進法の開示項目。実測（2026-09・無作為6社）では6社とも掲載面に出ていた。
// 「昨年度の採用がうまくいったか」を、掲載文言の解釈ではなく数字で言える唯一の欄。
//   採用者 / 離職者 / 定着率 の3年ぶん。新しい年が上に来る。
// 男女別テーブル（年＋3つの人数）が直前にあるので、必ず「離職者数」の位置から読む。
// 男女別は「名・名・名」で%を伴わないため、%を必須にしている限り誤って拾わない。
function parseRetention(text) {
  const t = clean(text);
  const i = t.indexOf('離職者数');
  if (i < 0) return null;
  const s = HALF(t.slice(i, i + 900)).replace(/\s+/g, ' ').replace(/,/g, '');
  const 系列 = [];
  for (const m of s.matchAll(/(20\d{2})\s*年\s*(\d{1,4})\s*名\s*(\d{1,4})\s*名\s*(\d{1,3}(?:\.\d)?)\s*%/g)) {
    const 採用者 = +m[2];
    if (系列.some((x) => x.年 === +m[1])) continue;
    系列.push({ 年: +m[1], 採用者, 離職者: +m[3], 定着率: +m[4] });
  }
  if (!系列.length) return null;
  系列.sort((a, b) => b.年 - a.年);
  return { 系列, 最新: 系列[0], 開示年: 系列[0].年 };
}

// ---- ⑧ 会社データ（資本金・売上高・従業員・設立）----------------------
// 「採用にお金を使えるか」を見るための素の数字。判断はここではしない（budget-signals.js）。
const DATA_STOPS = ['資本金', '売上高', '従業員', '募集人数', '事業所', '設立', '代表者', '本社', '株主構成',
  '主な取引先', '主な販売先', '主な仕入先', '平均年齢', '平均勤続年数', '沿革', 'エントリー', '事業内容'];

// 「210億4,830万円」「88.8億円」「3.11兆円」「3,300万円」を円に直す。
// 桁を足し合わせる形にしないと「210億4830万円」が210億で止まる（実測で踏む形）。
const MONEY_RE = /(?:(\d+(?:\.\d+)?)兆)?(?:(\d+(?:\.\d+)?)億)?(?:(\d+(?:\.\d+)?)万)?(?:(\d+(?:\.\d+)?))?円/;
function parseMoneyJP(str) {
  const s = HALF(str || '').replace(/[,\s]/g, '');
  const m = s.match(MONEY_RE);
  if (!m || !(m[1] || m[2] || m[3] || m[4])) return null;
  const v = (+m[1] || 0) * 1e12 + (+m[2] || 0) * 1e8 + (+m[3] || 0) * 1e4 + (+m[4] || 0);
  return v > 0 ? Math.round(v) : null;
}
// 単独/連結の両方が書かれる欄がある。大きい方（＝グループ全体の規模）を採る。
function maxMoney(seg) {
  let best = null;
  for (const m of HALF(seg || '').replace(/[,\s]/g, '').matchAll(/(?:\d+(?:\.\d+)?[兆億万])+\d*円|\d+(?:\.\d+)?[兆億万]円/g)) {
    const v = parseMoneyJP(m[0]);
    if (v && (!best || v > best)) best = v;
  }
  return best;
}
function parseCompanyData(text) {
  const t = clean(text);
  const seg = (h) => section(t, h, { stops: DATA_STOPS, max: 400 });
  const salesSeg = seg('売上高');
  // 「非上場のため開示していません。※◯◯グループの売上は3.11兆円」のような欄がある。
  // ここで最大額を採ると、別法人（グループ）の規模をその社の数字として持ち込む。
  const 非開示 = /開示していません|非公開|非開示/.test(salesSeg);
  const 売上高 = 非開示 ? null : maxMoney(salesSeg);
  const 資本金 = maxMoney(seg('資本金'));
  const empSeg = HALF(seg('従業員')).replace(/,/g, '');
  const em = empSeg.match(/(\d{1,6})\s*名/);
  const 従業員数 = em ? +em[1] : null;
  const sm = HALF(seg('設立')).match(/(19|20)\d{2}\s*年/);
  const 設立年 = sm ? parseInt(sm[0], 10) : null;
  if (!売上高 && !資本金 && !従業員数) return null;
  return {
    売上高, 資本金, 従業員数, 設立年, 非開示,
    売上表記: (seg('売上高') || '').split('\n')[0].slice(0, 60),
    一人当たり売上: (売上高 && 従業員数) ? Math.round(売上高 / 従業員数) : null,
  };
}

// ---- ⑨ 事業所（全国展開・店舗数）--------------------------------------
// 「全国展開している」「店舗が多い」は事業所欄の実体で数える。
// 拠点の呼び方は社によって違う（支社/営業所/店/センター）ので、語の出現数を拠点数の近似にする。
const PREFS = ['北海道', '青森', '岩手', '宮城', '秋田', '山形', '福島', '茨城', '栃木', '群馬', '埼玉', '千葉',
  '東京', '神奈川', '新潟', '富山', '石川', '福井', '山梨', '長野', '岐阜', '静岡', '愛知', '三重', '滋賀',
  '京都', '大阪', '兵庫', '奈良', '和歌山', '鳥取', '島根', '岡山', '広島', '山口', '徳島', '香川', '愛媛',
  '高知', '福岡', '佐賀', '長崎', '熊本', '大分', '宮崎', '鹿児島', '沖縄'];
const SITE_WORD_RE = /支社|支店|営業所|出張所|事業所|工場|センター|ステーション|店(?![舗長員])/g;
function parseOffices(text) {
  const sec = section(clean(text), '事業所', {
    stops: ['主な取引先', '主な販売先', '主な仕入先', '株主構成', '平均年齢', '平均勤続年数', '沿革',
      '働き方データ', '売上高', '資本金', '募集人数', '運営サイト', '多様な働き方'], max: 3000 });
  if (!sec) return null;
  const 拠点語数 = (sec.match(SITE_WORD_RE) || []).length;
  const 都道府県 = PREFS.filter((p) => sec.includes(p));
  const 店舗数 = (sec.match(/店(?![舗長員])/g) || []).length;
  // 拠点の書き方は「支店・営業所」を並べる社と、地名だけを読点で並べる社に分かれる。
  // 語数だけで数えると後者が1拠点になる（実測: 28都市を並べる社が拠点1になった）。
  const 列挙数 = sec.split(/[、,／]/).map((x) => x.trim()).filter((x) => x.length >= 2 && x.length <= 14).length;
  return {
    拠点語数, 列挙数, 店舗数, 拠点規模: Math.max(拠点語数, 列挙数), 都道府県数: 都道府県.length, 都道府県,
    海外: /海外|＜海外＞|【海外】/.test(sec),
    引用: sec.replace(/\n/g, ' ').slice(0, 160),
  };
}

// ---- ⑩ 特徴・特色タグ（マイナビの統制語彙）-----------------------------
// 「過去10年赤字決算なしなど安定した業績」「3年連続売上高前年比が130％以上と急成長中」
// 「年商1,000億円以上…」はマイナビ側が付ける定型タグで、自由記述より当てになる。
function parseFeatureTags(text) {
  const t = clean(text);
  const i = t.indexOf('と特徴・特色が同じ企業を探す');
  if (i < 0) return null;
  const sec = t.slice(i + 14, i + 1400).split('よろしいですか')[0];
  const tags = sec.split('\n').map((x) => x.trim())
    .filter((x) => x.length >= 4 && x.length <= 40 && !/^[。、]/.test(x));
  return tags.length ? tags : null;
}

// 上場区分は社名の後ろの【東証プライム上場】等に出る。非上場は空文字（不明と区別しない）。
function parseListing(text) {
  const m = HALF(text || '').match(/【[^】]{0,20}(?:東証|名証|札証|福証)[^】]{0,20}】/);
  return m ? m[0].replace(/[【】]/g, '') : '';
}

/**
 * 掲載面の「会社そのものの情報」をまとめて取る。卒年に依らないので卒年面とは別に持つ。
 * 失敗シグナル（failure-signals.js）と資金シグナル（budget-signals.js）の一次情報。
 */
function parseProfile(text) {
  return {
    定着: parseRetention(text),
    会社データ: parseCompanyData(text),
    拠点: parseOffices(text),
    特徴: parseFeatureTags(text),
    上場: parseListing(text),
  };
}

/**
 * 1つの卒年面（outline + employment のテキスト）から構造値をまとめて取る。
 * @param {string} text stripMynaviChrome 済みのテキスト
 */
function parseFace(text, meta = {}) {
  const t = clean(text);
  if (!t || t.length < 300) return null;
  return {
    卒年: meta.卒年 || '', url: meta.url || '',
    更新日: parseUpdated(t),
    募集人数: parseHeadcount(t),
    選考フロー: parseFlow(t),
    エントリー: parseEntryRoutes(t),
    募集コース: parseCourses(t),
    初任給: parseStartingPay(t),
    ...parseProfile(t),
    本文長: t.length,
  };
}

module.exports = { parseFace, parseProfile, parseRetention, parseCompanyData, parseOffices, parseFeatureTags, parseListing, parseMoneyJP, parseHeadcount, headcountValue, parseFlow, parseEntryRoutes, parseCourses, parseStartingPay, parseUpdated, section };
