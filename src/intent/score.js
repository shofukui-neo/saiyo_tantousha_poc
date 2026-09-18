'use strict';
/**
 * インテントスコア層: 検知シグナル → 「いま刺すべき順」の数値・階層・トーク
 * ============================================================================
 * monitor/heat.js と同じ考え方（加点 → 時間で減衰）をシグナル単位に持ち込む。
 *   点数 = Σ weight(シグナル) × strength(その社での確からしさ) × decay(検知からの経過日)
 * 減衰は「そのシグナルの賞味期限」で決める（半減期日）。
 *   例: 二次募集(30日) は1か月で半減 = 秋採用は待ってくれない
 *       採用予定数の前年比増(120日) は年単位の事実なので長く効く
 *
 * 階層（架電オペレーションの入口）:
 *   A 即架電（今週）  … 40点以上。最強シグナル1本 or 中位2本が新鮮に立っている
 *   B 今週中に着手    … 22点以上
 *   C 監視           … 10点以上（次サイクルで昇格するか見る）
 *   D 待機           … 10点未満。層1の適合だけで動かす対象
 */
const { SIGNALS } = require('./signals');
const { OPPORTUNITY_TALK, GROUP_CAPS } = require('./opportunity-signals');
const { FACE_TALK, FACE_GROUP_CAP } = require('./face-signals');
const { FAILURE_TALK, FAILURE_GROUP_CAP } = require('./failure-signals');
const { BUDGET_TALK, BUDGET_GROUP_CAP } = require('./budget-signals');
const { MIX_TALK, MIX_GROUP_CAP } = require('./mix-signals');

// 課題群ごとの合計上限。軸を足した群に上限を付け忘れると、その群だけが青天井で積み上がる。
const CAPS = { ...GROUP_CAPS, ...FACE_GROUP_CAP, ...FAILURE_GROUP_CAP, ...BUDGET_GROUP_CAP, ...MIX_GROUP_CAP };

// 効く順①の重み（＝シグナル定義の最大重み）。単独昇格の判定に使う。
const TOP_WEIGHT = Math.max(...Object.values(SIGNALS).map((s) => s.weight));

// 「これ1本で即架電に値する」と決めた軸。合計点の閾値とは別に、明示的に置く。
//   MIDCAREER_HR_JOB … 効く順①（2026-09-03 確定）
//   LAST_YEAR_SHORTFALL … 昨年度の採用失敗（2026-09-18 確定）。二次募集・採用数増は
//     この“結果”であって原因ではないので、原因が数字で取れた社は合計点に関わらず先に架ける。
// 重みを閾値に合わせて水増しするのではなく、昇格条件として書く（後から読めるようにするため）。
const PROMOTE_SIGNALS = ['MIDCAREER_HR_JOB', 'LAST_YEAR_SHORTFALL'];

// 階層の閾値は「絶対値」。母集団が変わっても同じ社は同じ階層に留まる（時系列で比較できる）。
// ただし分析軸を足すと合計点の目盛りそのものが伸びるので、軸を増やした時は閾値を引き直す。
//
// 2026-09-15: 16軸→21軸で A(40点以上) が母集団の11%→25%に膨らんだ。
// 「即架電（今週中）」は1週間で架電しきれる件数を指す運用ラベルなので、
// 20,928社の25%＝5,200社では意味を失う。実測2,266社の分位から上位10%に戻す閾値に引き直した。
// 45.4 は「face群の上限を適用した後」かつ「母集団全数（20,928社）」の分布から取った値。
// 二度外している:
//   1) 上限適用“前”の分位で決める → 上限のぶん点が下がって8%になる
//   2) 母集団の先頭2,266社だけで決める → シグナル0の社(D階層)の比率が全数と違い7%になる
//      （プールは採点優先度の降順なので、頭を切るとシグナルの濃い社に偏る。
//        実測: 標本のD階層12% に対し全数は25%）
// 分位は必ず「全数・上限適用後」で取ること。
// 閾値を変えた後は npm run intent:rescore（取得し直さずに採点だけやり直す）。
//
// 2026-09-18: 21軸→29軸（昨年度の失敗4軸＋資金4軸）。45.4 はまだ21軸時点の分位のまま。
// 新しい8軸は「定着率の開示欄・会社データ・事業所・特徴タグ」を一次情報にしており、
// これらは過去の取得回では集めていない。＝既存CSVを採点し直しても新軸は立たず、
// 分位を取り直せない（intent:rescore では較正できない、ということ）。
// 較正の手順は必ずこの順で:
//   1) npm run intent:wide         … 29軸ぶんの一次情報を取り直す（--resume で継続可）
//   2) 全数・群上限適用後のスコア分布から A が上位約10%になる値を取る
//   3) ここの 45.4 を差し替えて npm run intent:rescore
// それまでは A の件数が従来より膨らむ（軸を足したぶん目盛りが伸びているだけで、
// 「急に有望企業が増えた」わけではない）。群上限（failure 44 / budget 24）で
// 青天井にはならないが、上位10%という運用ラベルの意味は較正するまで戻らない。
const TIERS = [
  { tier: 'A', min: 45.4, 行動: '即架電（今週中）' },
  { tier: 'B', min: 22, 行動: '今週中に着手' },
  { tier: 'C', min: 10, 行動: '監視（次サイクルで再判定）' },
  { tier: 'D', min: 0, 行動: '待機（層1の適合のみ）' },
];

// 検知からの経過日で減衰。半減期はシグナルごと（signals.js の 半減期日）。
function decayFactor(hit, now = new Date()) {
  const half = hit.半減期日 || SIGNALS[hit.signal] && SIGNALS[hit.signal].半減期日 || 60;
  const d = new Date(hit.詳細 && (hit.詳細.発生日 || hit.詳細.初回根拠確認日) || hit.検知日);
  if (!Number.isFinite(d.getTime())) return 1;
  const days = Math.max(0, (now.getTime() - d.getTime()) / 86400000);
  return Math.pow(0.5, days / half);
}

/**
 * シグナル配列 → インテントスコア。
 * @param {Array} hits signals.js の検知結果
 * @param {{now?:Date, 資金?:object}} opts 資金は budget-signals.assessFunding() の戻り。
 *   資金リスクは点にしない（加点側と同じ土俵に置くと「リスクが多いほど点が伸びる」ため）。
 *   点はそのままに、総合優先度の係数と推奨アクションにだけ効かせる。
 * @returns {{スコア:number, 階層:string, 行動:string, 最有力:string, 根拠:string, 内訳:Array,
 *   予算状態:string, 予算係数:number, 予算根拠:string, 検討時期:string, 予算トーク:string}}
 */
function scoreIntent(hits, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const unique = new Map();
  for (const h of hits || []) {
    if (!h || !SIGNALS[h.signal] || !Number.isFinite(h.weight) || !Number.isFinite(h.strength)) continue;
    const old = unique.get(h.signal);
    if (!old || h.strength * decayFactor(h, now) > old.strength * decayFactor(old, now)) unique.set(h.signal, h);
  }
  const 内訳 = [...unique.values()].map((h) => {
    const decay = decayFactor(h, now);
    return {
      signal: h.signal, 名称: h.名称, 列: h.列, level: h.level, 根拠: h.根拠,
      strength: h.strength, weight: h.weight, 検知日: h.検知日, 詳細: h.詳細 || {},
      減衰: Math.round(decay * 100) / 100,
      点数: Math.round(h.weight * Math.max(0, Math.min(1, h.strength)) * decay * 10) / 10,
    };
  }).sort((a, b) => b.点数 - a.点数);

  // 同じ課題群の言い換えで順位が膨らむのを防ぐ。既存8軸の重みは維持。
  const used = {};
  for (const d of 内訳) {
    const group = SIGNALS[d.signal].group;
    d.調整前点数 = d.点数;
    if (group && CAPS[group]) {
      d.点数 = Math.round(Math.min(d.点数, Math.max(0, CAPS[group] - (used[group] || 0))) * 10) / 10;
      used[group] = (used[group] || 0) + d.点数;
    }
  }
  内訳.sort((a, b) => b.点数 - a.点数);
  const raw = 内訳.reduce((a, x) => a + x.点数, 0);
  const スコア = Math.min(100, Math.round(raw * 10) / 10);
  let t = TIERS.find((x) => スコア >= x.min) || TIERS[TIERS.length - 1];
  // PROMOTE_SIGNALS が「確定」で立っていれば、合計点に関わらずA。
  // 設計の約束（人事・採用担当の中途求人／昨年度の採用計画が未充足は、それ1本で
  // 即架電に値する）を、閾値の引き上げで失わないため。
  if (t.tier !== 'A' && 内訳.some((d) => PROMOTE_SIGNALS.includes(d.signal) && /^確定/.test(d.level || '') && d.減衰 >= 0.5)) {
    t = TIERS[0];
  }
  const top = 内訳[0] || null;
  // 資金面。赤字・採用縮小・予算確定の社は、点が高くても「今すぐ売る相手」ではない。
  // 階層Aはタイミングの話なので落とさず、行動だけをナーチャリングに寄せる。
  const 資金 = opts.資金 || null;
  const 行動 = (資金 && 資金.ナーチャリング && t.tier !== 'A')
    ? `ナーチャリング（${資金.状態}／検討時期${資金.検討時期 || '未確認'}を確認）` : t.行動;
  return {
    スコア, 階層: t.tier, 行動,
    予算状態: 資金 ? 資金.状態 : '未判定',
    予算係数: 資金 ? 資金.係数 : 1,
    予算根拠: 資金 ? 資金.根拠 : '',
    検討時期: 資金 ? 資金.検討時期 : '',
    予算トーク: 資金 ? 資金.トーク : '',
    最有力: top ? top.名称 : '', 最有力シグナル: top ? top.signal : '',
    最有力レベル: top ? top.level : '',
    根拠: 内訳.slice(0, 3).map((x) => x.根拠).join(' ／ '),
    検知シグナル: 内訳.map((x) => x.名称).join('・'),
    内訳,
  };
}

// 層1（ICP適合＝アポ期待度）と層2（タイミング）の合成。
// タイミングを主、適合を従に置く（適合だけで上位に来る母数が大きすぎるため）。
function combineWithFit(intentScore, アポ期待度) {
  const fit = Math.max(0, Math.min(100, parseFloat(アポ期待度) || 0));
  return Math.round((intentScore * 0.55 + fit * 0.45) * 10) / 10;
}

// ---- シグナル別の一言トーク（架電の入り口。line-official.js の lineTalkGuide と同じ役割）----
const TALK = {
  ...OPPORTUNITY_TALK,
  ...FACE_TALK,
  ...FAILURE_TALK,
  ...BUDGET_TALK,
  ...MIX_TALK,
  MIDCAREER_HR_JOB: '人事・採用ご担当の中途募集を拝見しました。採用のオペレーションが人手に寄っているタイミングかと思い、'
    + '採用担当を増やす前に応募者対応の自動化で持たせている事例をご紹介したくご連絡しました。',
  SECONDARY_RECRUIT: '追加募集（秋採用）のご案内を拝見しました。この時期の追加募集は歩留まりの取りこぼしが響くので、'
    + '応募〜面接設定の連絡速度を上げて充足させた事例をお話しできます。',
  RECRUIT_EMAIL: '採用専用の窓口アドレスを出されているのを拝見しました。応募者対応がそのアドレスに集中すると'
    + '見落としと二重対応が起きやすいので、そこを一本化した事例をご紹介できます。',
  HIRE_PLAN_UP: '新卒の採用人数を前年から増やされていますね。人数が増えると母集団も選考連絡も一段跳ねるので、'
    + '同じ規模で増員された企業がどう回しているかをお話しできます。',
  RECRUIT_PAGE: '採用ページを新しくされたのを拝見しました。露出を強めた直後は応募の波が読みにくいので、'
    + '応募が来た後の対応スピードを落とさない仕組みの話をさせてください。',
  LINE_RECRUIT: '採用でLINEを使われているのを拝見しました。学生との連絡はLINEが一番返ってきますが、'
    + '手運用だと誰にどこまで送ったかが消えるので、そこを台帳と繋げた事例をご紹介できます。',
  INTERN_NEW: 'インターン（仕事体験）を始められたのを拝見しました。回数が増えると予約・出欠・その後の連絡が'
    + 'Excelで持たなくなるタイミングなので、先に整えた企業の話をさせてください。',
  EXPO_FIRST: '合同説明会へのご出展を拝見しました。イベント後の名簿フォローは速度がそのまま歩留まりになるので、'
    + '当日集めた学生への連絡を落とさない運用の事例をお話しできます。',
};
function talkGuide(res) {
  if (!res || !res.最有力シグナル) return '';
  return TALK[res.最有力シグナル] || '';
}

// 「なぜ今か」を1行で（リスト上の説明欄・日報用）
function whyNow(res) {
  if (!res || !res.内訳 || !res.内訳.length) return 'タイミングシグナルなし（層1の適合のみ）';
  const top = res.内訳[0];
  return `${top.名称}［${top.level}］${top.減衰 < 0.7 ? `※検知${top.検知日}のため減衰${top.減衰}` : ''}`.trim();
}

module.exports = { scoreIntent, combineWithFit, decayFactor, talkGuide, whyNow, TIERS, TALK, CAPS, TOP_WEIGHT, PROMOTE_SIGNALS };
