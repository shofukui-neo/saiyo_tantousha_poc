'use strict';
/**
 * 資金シグナル（S26〜S29）と資金リスク（点にしない減点側）
 * ============================================================================
 * ユーザー確定（2026-09-18）:
 *   「担当者がいいと思っても、会社の方針で“無駄の削減”が効いて決まらない」。
 *   だから「採用にお金を出せる会社か」を先に見て、出せない会社は今の商談ではなく
 *   検討時期を押さえてナーチャリングに回す。
 *
 * 二方向に分けている。ここが設計の肝:
 *   ＜加点＞ 資金シグナル（S26〜S29）… 採用にお金を使う構造を持っている
 *     - 人が資本の業種（人材派遣・インフラ・小売多店舗・物流・介護・外食）
 *     - 全国展開・拠点／店舗が多い（採る母数が構造的に大きい）
 *     - 業績が伸びている・安定して黒字
 *     - 売上規模そのもの（＝採用に配れる原資）
 *   ＜減点＞ 資金リスク（点にしない）… 赤字・採用縮小・予算が確定済み
 *     これを加点シグナルと同じ土俵に置くと「リスクが多いほど点が伸びる」ことになる。
 *     点ではなく総合優先度の係数と、推奨アクション（ナーチャリング）に効かせる。
 *
 * 「お金がない」の解像度（ユーザー指定の4分類）:
 *   ① 赤字・業績不振      → 逼迫。今期の新規支出は通らない
 *   ② 採用縮小・募集停止   → 逼迫。そもそも採用を絞っている
 *   ③ 予算が決まってしまった → 予算確定。悪い相手ではない。次の予算取りの時期を押さえる
 *   ④ 何にいくら使っているか不明 → 中立。ヒアリングで埋める（予算トークを出す）
 *
 * 一次情報: マイナビ掲載面の会社データ（売上高・資本金・従業員・事業所）、
 *           マイナビの特徴・特色タグ（統制語彙なので自由記述より当てになる）、
 *           掲載本文・自社サイト・根拠資料の文面。
 * 重みは営業仮説であり受注確率ではない。
 */

const RULES = [
  ['GROWTH_TREND', '業績の伸長・安定黒字', '業績伸長', 20, 240],
  ['EXPANSION_SITES', '全国展開・多拠点／多店舗', '多拠点', 18, 365],
  ['PEOPLE_BUSINESS', '人が資本の業種（採用が事業の生命線）', '人が資本', 14, 365],
  ['FUND_CAPACITY', '採用に配れる原資（売上規模）', '原資規模', 14, 365],
];
const BUDGET_SIGNALS = Object.fromEntries(RULES.map(([id, 名称, col, weight, 半減期日], i) => [id, {
  id, 名称, 列: `S${i + 26}_${col}`, 順位: i + 26, weight, 半減期日, 要履歴: false, group: 'budget',
  説明: '掲載面の会社データ・特徴タグ・業種から、採用にお金を出せる構造かを判定',
}]));

/**
 * budget群の合計点の上限。
 * この4軸は「タイミング」ではなく「体力」で、放っておくと大企業が常に上位に来る。
 *
 * 実測（2026-09-18・無作為8社）で上限24にしたところ、8社中6社が S27＋S26 だけで
 * 上限に張り付いた。全社に同じ点が乗るのは「順位を作らずに目盛りだけ伸ばす」ことで、
 * 階層の閾値を壊すだけ何の役にも立たない。体力は同点を割る材料に留める位置まで下げる。
 */
const BUDGET_GROUP_CAP = { budget: 16 };

const BUDGET_TALK = {
  GROWTH_TREND: '事業を伸ばされている時期かと思いますが、今年の採用計画は前年から増やされていますか。',
  EXPANSION_SITES: '拠点ごとに採用と選考を回されていると思いますが、各拠点の選考状況はどのように共有されていますか。',
  PEOPLE_BUSINESS: '人の採用が事業に直結する業態かと思います。今年いちばん人を足したい部門はどちらでしょうか。',
  FUND_CAPACITY: '採用にかけられている費用は、いまどのあたりに配分されていますか。',
};

function hit(sig, { strength, level, 根拠, 詳細 = {}, 検知日 }) {
  const s = Math.max(0, Math.min(1, strength));
  return {
    signal: sig.id, 名称: sig.名称, 列: sig.列, weight: sig.weight, 半減期日: sig.半減期日,
    strength: Math.round(s * 100) / 100, level, 根拠: String(根拠 || '').slice(0, 300),
    詳細, 検知日: 検知日 || new Date().toISOString().slice(0, 10),
  };
}

const 億 = 1e8;
const yen = (v) => (v >= 億 ? `${Math.round(v / 億 * 10) / 10}億円` : `${Math.round(v / 1e4).toLocaleString()}万円`);

// 判定に使うテキストを1本に束ねる（掲載本文＋根拠資料。長すぎる資料は頭だけ見る）。
function bodyText(ev = {}) {
  const parts = [String(ev.掲載本文 || '')];
  for (const d of ev.インテント資料 || []) parts.push(String(d.text || '').slice(0, 20000));
  return parts.join('\n').normalize('NFKC');
}

// ---- S26 業績の伸長・安定黒字 ------------------------------------------
// マイナビの特徴・特色タグは統制語彙（社が選ぶ選択肢）で、自由記述より当てになる。
const GROWTH_TAGS = [
  ['3年連続売上高前年比', 1, '確定(3年連続の増収タグ)'],
  ['急成長', 0.9, '強(急成長タグ)'],
  ['過去10年赤字決算なし', 0.8, '強(10年赤字なしタグ)'],
  ['安定した業績', 0.7, '中(安定業績タグ)'],
  ['年商1,000億円以上', 0.7, '中(年商1,000億円以上タグ)'],
  // 「シェアNo.1や特化した技術・サービスを持っている」は実測8社中3社が付けており、
  // かつ業績ではなく事業の立ち位置の話。資金の証拠にはならないので採らない。
];
// 文面側。IR・ニュースの定型句だけを採る（「成長したい」のような意気込みは採らない）。
const GROWTH_TEXT = [
  ['過去最高益', 0.9], ['過去最高の売上', 0.9], ['増収増益', 0.9], ['最高益を更新', 0.9],
  ['上場を果た', 0.8], ['株式上場', 0.7], ['新規上場', 0.8], ['IPO', 0.6],
  ['増資', 0.6], ['資金調達を実施', 0.7], ['新工場', 0.6], ['新社屋', 0.5], ['本社を移転', 0.4],
];
function detectGrowth(ev, 検知日) {
  const tags = ev.特徴 || [];
  for (const [kw, strength, level] of GROWTH_TAGS) {
    const tag = tags.find((t) => t.includes(kw));
    if (!tag) continue;
    return hit(BUDGET_SIGNALS.GROWTH_TREND, {
      strength, level, 検知日,
      根拠: `マイナビ掲載面の特徴・特色タグ「${tag}」`,
      詳細: { 出所: '特徴タグ', タグ: tag },
    });
  }
  const text = bodyText(ev);
  for (const [kw, strength] of GROWTH_TEXT) {
    const i = text.indexOf(kw);
    if (i < 0) continue;
    return hit(BUDGET_SIGNALS.GROWTH_TREND, {
      strength: strength * 0.7, level: '中(掲載文に業績・投資の記載)', 検知日,
      根拠: `「…${text.slice(Math.max(0, i - 30), i + 50).replace(/\n+/g, ' ')}…」`,
      詳細: { 出所: '掲載文', キーワード: kw },
    });
  }
  return null;
}

// ---- S27 全国展開・多拠点／多店舗 --------------------------------------
// 拠点が多い＝採る人数が構造的に多く、拠点ごとに選考が走る＝管理コストも高い。
// MOCHICAの提案（拠点横断の選考管理）とそのまま重なる。
function detectExpansion(ev, 検知日) {
  const o = ev.拠点;
  if (!o) return null;
  const { 拠点規模 = 0, 店舗数 = 0, 都道府県数 = 0 } = o;
  let strength; let level;
  if (都道府県数 >= 8 || 拠点規模 >= 30) { strength = 1; level = `確定(${都道府県数}都道府県・拠点${拠点規模}件規模の全国展開)`; }
  else if (店舗数 >= 10) { strength = 0.8; level = `強(店舗${店舗数}件の多店舗展開)`; }
  else if (都道府県数 >= 4 || 拠点規模 >= 12) { strength = 0.6; level = `中(${都道府県数}都道府県・拠点${拠点規模}件)`; }
  else if (都道府県数 >= 2 && 拠点規模 >= 5) { strength = 0.35; level = '弱(複数拠点)'; }
  else return null;
  return hit(BUDGET_SIGNALS.EXPANSION_SITES, {
    strength, level, 検知日,
    根拠: `事業所欄: ${都道府県数}都道府県・拠点${拠点規模}件`
      + (店舗数 ? `（うち店舗表記${店舗数}件）` : '') + (o.海外 ? '・海外拠点あり' : '')
      + `: ${String(o.引用 || '').slice(0, 90)}`,
    詳細: { 都道府県数: 都道府県数, 拠点規模, 店舗数, 海外: !!o.海外 },
  });
}

// ---- S28 人が資本の業種 ------------------------------------------------
// ユーザー指定: 人材派遣系／人が資本／全国展開系／インフラ系／店舗数の多い小売。
// 全国展開は S27 が拠点の実数で見るので、ここは業種そのものだけを見る。
const PEOPLE_INDUSTRY = [
  ['人材派遣・人材サービス', 1, /人材派遣|人材サービス|人材紹介|業務請負|アウトソーシング|BPO|派遣/],
  ['インフラ', 0.85, /電力|ガス・エネルギー|ガス|鉄道|空港|道路|水道|通信|エネルギー|プラント|インフラ/],
  ['小売・専門店', 0.8, /小売|専門店|百貨店|スーパー|コンビニ|ドラッグ|ホームセンター|量販/],
  ['物流・運輸', 0.8, /物流|倉庫|陸運|海運|運送|配送|運輸/],
  ['介護・医療・福祉', 0.8, /介護|福祉|医療機関|調剤|保育|看護/],
  ['外食・サービス', 0.75, /外食|レストラン|フードサービス|給食|ホテル|旅館|ブライダル|冠婚葬祭|警備|清掃|ビル管理|メンテナンス/],
  ['建設・設備', 0.6, /建設|工事|設備|土木|住宅/],
];
function detectPeopleBusiness(ev, 検知日) {
  const industry = String(ev.業種 || '');
  const text = industry + '\n' + String(ev.事業内容 || '');
  for (const [名称, strength, re] of PEOPLE_INDUSTRY) {
    if (!re.test(text)) continue;
    return hit(BUDGET_SIGNALS.PEOPLE_BUSINESS, {
      strength, level: `中(${名称}＝人の頭数が売上に直結する業態)`, 検知日,
      根拠: `業種「${industry || 名称}」＝${名称}。人員の充足がそのまま事業計画に効くため、採用は削りにくい費目`,
      詳細: { 区分: 名称, 業種: industry },
    });
  }
  return null;
}

// ---- S29 採用に配れる原資（売上規模）------------------------------------
// 規模そのものは“いま動く理由”ではないので重みは低い。刺す順の同点を割る材料。
function detectCapacity(ev, 検知日) {
  const d = ev.会社データ;
  if (!d) return null;
  const { 売上高, 資本金, 従業員数, 一人当たり売上 } = d;
  let strength; let level;
  // 売上30億円で採ると、ICP（従業員300〜500名）ではほぼ全社が該当して順位が作れない。
  // 実測8社は全社が該当した。100億円を境にして、同点を割る材料としてだけ使う。
  if (売上高 >= 300 * 億) { strength = 0.9; level = `強(売上高${yen(売上高)})`; }
  else if (売上高 >= 100 * 億) { strength = 0.6; level = `中(売上高${yen(売上高)})`; }
  else return null;
  return hit(BUDGET_SIGNALS.FUND_CAPACITY, {
    strength, level, 検知日,
    根拠: `掲載面の会社データ: ${売上高 ? '売上高' + yen(売上高) : ''}`
      + (資本金 ? `／資本金${yen(資本金)}` : '') + (従業員数 ? `／従業員${従業員数}名` : '')
      + (一人当たり売上 ? `／一人当たり売上${yen(一人当たり売上)}` : '')
      + (d.非開示 ? '／※売上は非開示欄のため採用せず' : ''),
    詳細: { 売上高: 売上高 || null, 資本金: 資本金 || null, 従業員数: 従業員数 || null, 一人当たり売上: 一人当たり売上 || null },
  });
}

/**
 * 資金シグナル（S26〜S29）を検知する。加点側のみ。
 */
function detectBudgetSignals(ev = {}, { now = new Date(), 検知日 } = {}) {
  const d = 検知日 || new Date(now).toISOString().slice(0, 10);
  return [
    detectGrowth(ev, d),
    detectExpansion(ev, d),
    detectPeopleBusiness(ev, d),
    detectCapacity(ev, d),
  ].filter(Boolean);
}

// =====================================================================
// 資金リスク（点にしない。総合優先度の係数と推奨アクションに効かせる）
// =====================================================================
// 「お金がない」の中身を4つに割る。どれに当たるかで次の一手が変わるため、
// ひとまとめの「見込み薄」にはしない。
const RISKS = [
  ['赤字・業績不振', '逼迫', 0.70, /赤字(?!決算なし)|営業損失|当期純損失|経常損失|債務超過|減収減益|業績不振|業績が悪化|下方修正/],
  ['人員削減', '逼迫', 0.70, /希望退職|early retirement|早期退職(?:者)?(?:の)?(?:募集|優遇)|人員削減|人員の適正化|リストラ|店舗の閉鎖|閉店|事業(?:から)?撤退|事業所の統廃合/i],
  // 「新卒採用は今年度見送り」のように助詞や副詞が挟まる。採用と縮小語のあいだに
  // 句点を含まない8字までの隙間を許す（許さないと実文のほとんどを取りこぼす）。
  ['採用縮小', '逼迫', 0.75, /採用[^。\n]{0,8}?(?:見送り|見合わせ|中止|停止|縮小|抑制)|募集[^。\n]{0,6}?(?:停止|中止|見送)|採用人数[^。\n]{0,6}?(?:減|絞|縮小)|新卒採用[^。\n]{0,6}?(?:行わ|実施し)(?:ない|ません)/],
  ['予算確定', '予算確定', 0.85, /今期(?:の)?予算(?:は)?(?:確定|決定|消化|使い切)|予算(?:は)?(?:もう)?(?:決ま|確定)|予算(?:が)?(?:取れ|確保でき)(?:ない|ません)|次年度(?:の)?予算|来期(?:の)?予算|来年度(?:の)?予算/],
];
const RISK_NEG = /(あり?ません|ござい?ません|такое)/;

// 検討時期。架電で「いつなら」を押さえるための当たり。
// N月／来期／下期／次年度を、検討・予算の文脈の近くにある時だけ拾う。
// 「開始」「更新」は新卒の掲載面に普通に出る語（エントリー開始・最終更新）なので入れない。
// 実測 2026-09-18: これを入れていたせいで「2027年3月卒業」の“3月”が検討時期として出た。
const TIMING_CONTEXT = /検討|導入|予算|稟議|決裁|入替|切替|リプレイス|見直し|商談|ご提案/;
// 月の直後がこれらなら採用スケジュールの話であって、検討時期ではない。
// 「(2026年3月時点)」「3月末現在」は基準日であって検討時期ではない。
const TIMING_NOT_AFTER = /^\s*(?:卒|卒業|入社|期|決算|時点|現在|実績|末|開講|開催|実施|選考|面接|説明会|エントリー)/;
const TIMING_WORDS = [
  [/(?:来期|次年度|来年度)/, '来期'],
  [/(?:下期|下半期)/, '下期'],
  [/(?:上期|上半期)/, '上期'],
  [/(?:期初|年度初め|年度初)/, '期初'],
];
function extractTiming(text, { now = new Date() } = {}) {
  const t = String(text || '').normalize('NFKC').replace(/[ \t]+/g, ' ');
  const 今年 = new Date(now).getFullYear();
  // 「2005年 8月 先進的IT技術導入…」のような沿革の日付を検討時期にしない。
  // 実測 2026-09-18: 掲載面の沿革から「8月」「4月」を拾っていた（窓に 導入/見直し が入るため）。
  // 過ぎた年が直前に付いている月は履歴の話。未来の年（2027年4月から導入を検討）は残す。
  const 今月 = new Date(now).getMonth() + 1;
  const 過去の日付 = (idx, mon) => {
    const m = t.slice(Math.max(0, idx - 10), idx).match(/(20\d{2})\s*年\s*$/);
    if (!m) return false;
    const y = Number(m[1]);
    return y < 今年 || (y === 今年 && mon < 今月);
  };
  for (const [re, label] of TIMING_WORDS) {
    const m = re.exec(t);
    if (!m) continue;
    const win = t.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30);
    if (TIMING_CONTEXT.test(win)) return { 時期: label, 引用: win.trim().slice(0, 120) };
  }
  for (const m of t.matchAll(/(\d{1,2})\s*月/g)) {
    const mon = parseInt(m[1], 10);
    if (mon < 1 || mon > 12) continue;
    if (TIMING_NOT_AFTER.test(t.slice(m.index + m[0].length, m.index + m[0].length + 6))) continue;
    if (過去の日付(m.index, mon)) continue;
    const win = t.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30);
    if (TIMING_CONTEXT.test(win)) return { 時期: `${mon}月`, 引用: win.trim().slice(0, 120) };
  }
  return null;
}

// 状態ごとの予算トーク。ユーザー指定の言い回しをそのまま使えるようにしておく。
//   「追加予算を取る」か「いま他にかけている費用から工面する」の二択を必ず置く。
const 予算トーク = {
  余力あり: '採用にかけられているご予算は、いまどちらに厚く配分されていますか。'
    + '媒体を増やすより先に、いまの応募をどれだけ面接まで運べているかで結果が変わる部分があります。',
  中立: '差し支えなければ、いま採用にはどのあたりに費用をかけられていますか。'
    + '新しく予算を足す形と、いまかけている費用の一部を振り替える形と、どちらが動かしやすいでしょうか。',
  逼迫: 'いまは費用を抑えられている時期かと思います。'
    + '新規のご予算ではなく、いま媒体や代行にかけている費用の一部を振り替える形で始められた事例がありますので、'
    + 'そのやり方だけ先にお伝えできればと思います。',
  予算確定: '今期のご予算がもう決まっているということでしたら、次に採用の予算を組まれるのはいつ頃でしょうか。'
    + 'その時期に合わせて資料をお送りします。',
};

/**
 * 資金の状態を1社ぶん判定する。点数は付けない（scoreIntent の外側で使う）。
 * @param {object} ev collect.js のエビデンス
 * @param {Array} hits detectAll の結果（加点側の資金シグナルが立っているかを見る）
 * @returns {{状態:string, 係数:number, リスク:Array, 根拠:string, 検討時期:string, トーク:string, ナーチャリング:boolean}}
 */
function assessFunding(ev = {}, hits = []) {
  const text = bodyText(ev);
  const リスク = [];
  for (const [種別, 状態, 係数, re] of RISKS) {
    const m = re.exec(text);
    if (!m) continue;
    const win = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 60).replace(/\n+/g, ' ');
    // 打ち消しはキーワードの“直後”だけを見る。窓の先頭から見ると、40字前の無関係な
    // 否定文（「残業はありません」等）でリスク判定が落ちる。
    if (RISK_NEG.test(text.slice(m.index + m[0].length, m.index + m[0].length + 24))) continue;
    リスク.push({ 種別, 状態, 係数, 引用: win.trim().slice(0, 140) });
  }
  // 構造側の採用縮小: 今年度の募集人数が前卒年面より減っている。
  // 文面が無くても「絞った」ことは数字で言えるので、ここで拾う。
  const faces = Object.entries(ev.卒年面 || {})
    .map(([gy, f]) => ({ gy: parseInt(gy, 10), f }))
    .filter((x) => Number.isFinite(x.gy) && x.f && x.f.募集人数 && Number.isFinite(x.f.募集人数.下限))
    .sort((a, b) => b.gy - a.gy);
  if (faces.length >= 2 && faces[0].f.募集人数.下限 < faces[1].f.募集人数.下限) {
    リスク.push({
      種別: '採用縮小', 状態: '逼迫', 係数: 0.8,
      引用: `募集人数 ${faces[1].gy}卒 ${faces[1].f.募集人数.表記} → ${faces[0].gy}卒 ${faces[0].f.募集人数.表記}（掲載面）`,
    });
  }

  const timing = extractTiming(text);
  const 加点あり = (hits || []).some((h) => h && BUDGET_SIGNALS[h.signal]);
  let 状態 = 加点あり ? '余力あり' : '中立';
  let 係数 = 1;
  if (リスク.length) {
    // いちばん厳しいものに合わせる（複数当たった時に甘い方へ丸めない）。
    const 最重 = リスク.reduce((a, b) => (b.係数 < a.係数 ? b : a));
    状態 = 最重.状態; 係数 = 最重.係数;
  }
  const ナーチャリング = 状態 === '予算確定' || 状態 === '逼迫';
  return {
    状態, 係数, リスク,
    根拠: リスク.length ? リスク.map((r) => `${r.種別}: ${r.引用}`).join(' ／ ')
      : (加点あり ? '資金シグナルあり（S26〜S29）' : '資金面の記載なし（要ヒアリング）'),
    検討時期: timing ? timing.時期 : '',
    検討時期根拠: timing ? timing.引用 : '',
    トーク: 予算トーク[状態] || 予算トーク.中立,
    ナーチャリング,
  };
}

module.exports = {
  BUDGET_SIGNALS, BUDGET_TALK, BUDGET_GROUP_CAP, detectBudgetSignals, assessFunding,
  extractTiming, RISKS, 予算トーク,
  detectGrowth, detectExpansion, detectPeopleBusiness, detectCapacity,
};
