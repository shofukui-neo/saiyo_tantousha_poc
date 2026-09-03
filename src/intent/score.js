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

const TIERS = [
  { tier: 'A', min: 40, 行動: '即架電（今週中）' },
  { tier: 'B', min: 22, 行動: '今週中に着手' },
  { tier: 'C', min: 10, 行動: '監視（次サイクルで再判定）' },
  { tier: 'D', min: 0, 行動: '待機（層1の適合のみ）' },
];

// 検知からの経過日で減衰。半減期はシグナルごと（signals.js の 半減期日）。
function decayFactor(hit, now = new Date()) {
  const half = hit.半減期日 || SIGNALS[hit.signal] && SIGNALS[hit.signal].半減期日 || 60;
  const d = new Date(hit.検知日);
  if (!Number.isFinite(d.getTime())) return 1;
  const days = Math.max(0, (now.getTime() - d.getTime()) / 86400000);
  return Math.pow(0.5, days / half);
}

/**
 * シグナル配列 → インテントスコア。
 * @param {Array} hits signals.js の検知結果
 * @param {{now?:Date}} opts
 * @returns {{スコア:number, 階層:string, 行動:string, 最有力:string, 根拠:string, 内訳:Array}}
 */
function scoreIntent(hits, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const 内訳 = (hits || []).map((h) => {
    const decay = decayFactor(h, now);
    return {
      signal: h.signal, 名称: h.名称, 列: h.列, level: h.level, 根拠: h.根拠,
      strength: h.strength, weight: h.weight, 検知日: h.検知日,
      減衰: Math.round(decay * 100) / 100,
      点数: Math.round(h.weight * h.strength * decay * 10) / 10,
    };
  }).sort((a, b) => b.点数 - a.点数);

  const raw = 内訳.reduce((a, x) => a + x.点数, 0);
  const スコア = Math.min(100, Math.round(raw * 10) / 10);
  const t = TIERS.find((x) => スコア >= x.min) || TIERS[TIERS.length - 1];
  const top = 内訳[0] || null;
  return {
    スコア, 階層: t.tier, 行動: t.行動,
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

module.exports = { scoreIntent, combineWithFit, decayFactor, talkGuide, whyNow, TIERS, TALK };
