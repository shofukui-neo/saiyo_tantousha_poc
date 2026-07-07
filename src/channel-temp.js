'use strict';
/**
 * 経路の温度（獲得チャネル）── 成約を左右する最大レバー（2026-07 v3・仮説H1/H2/H5）
 * =====================================================================
 * SF全リード86,674件の実測で、リード獲得経路“だけ”で成約率は 7.2%〜30.1%（4.2倍）動く。
 * これは業種(〜3x)・規模(〜1.5x)を上回る第1レバーでありながら、従来の類似スコアは
 * firmographic 3軸(業種×規模×採用)のみで、コールド由来の企業を過大評価していた。
 * 本モジュールは「リスト名（セミナーアンケート項目）」から経路クラスを判定し、
 * 実測 lift を返す＝類似スコアの第4軸として掛け合わせる。
 *
 * 実測（全体17.0%, n=86,674）:
 *   アウトバウンド架電  30.1%  1.77x   ← 名指しで人が架ける（本リポジトリの弾込め＝主動線化すべき）
 *   未タグ(温/手入力)  21.4%  1.26x   ← リスト名なし＝温かい/手入力/古参
 *   その他タグ         20.7%  1.22x
 *   お断り再利用        8.6%  0.50x
 *   コールド媒体一括     7.2%  0.42x   ← マイナビ/リクナビ年度リストの一括インポート（低品位・大量）
 */

// 判定順が実測と一致していること（順序を変えると lift の割当がズレる）。
const CLASS = {
  OUTBOUND: 'アウトバウンド架電',
  WARM: '未タグ(温/手入力)',
  OTHER: 'その他タグ',
  REJECT: 'お断り再利用',
  COLD: 'コールド媒体一括',
};

// 実測 lift（empirical-icp-rates.json に channel が無い場合のフォールバック既定値）。
const DEFAULT_CHANNEL_LIFT = {
  [CLASS.OUTBOUND]: 1.77,
  [CLASS.WARM]: 1.26,
  [CLASS.OTHER]: 1.22,
  [CLASS.REJECT]: 0.50,
  [CLASS.COLD]: 0.42,
};

/**
 * リスト名（セミナーアンケート項目10 + 7 の連結）から経路クラスを判定。
 * 空＝未タグ＝温かい（リスト名を残す運用ではコールド媒体はリスト名/年度が必ず入る）。
 * @param {string} listText
 * @returns {string} CLASS のいずれか
 */
function classifyChannel(listText) {
  const s = String(listText || '').trim();
  if (!s) return CLASS.WARM;
  if (/(マイナビ|リクナビ)/.test(s) && /20\d\d/.test(s)) return CLASS.COLD;
  if (/お断り|リサイクル/.test(s)) return CLASS.REJECT;
  if (/架電|アウトバウンド|テレア|アルバイト/.test(s)) return CLASS.OUTBOUND;
  return CLASS.OTHER;
}

/**
 * empirical-icp-rates.json の channel 配列（[{bucket,rate,total},...]）から lift マップを作る。
 * 無ければ DEFAULT_CHANNEL_LIFT を返す。
 * @param {object} rates empirical-icp-rates.json をパースしたオブジェクト
 */
function channelLiftMap(rates) {
  if (!rates || !Array.isArray(rates.channel) || !rates.channel.length) return { ...DEFAULT_CHANNEL_LIFT };
  const overall = rates.overall || (rates.channel.reduce((s, r) => s + r.conv, 0) / rates.channel.reduce((s, r) => s + r.total, 0));
  const m = {};
  for (const r of rates.channel) m[r.bucket] = r.rate / overall;
  return m;
}

module.exports = { CLASS, classifyChannel, channelLiftMap, DEFAULT_CHANNEL_LIFT };
