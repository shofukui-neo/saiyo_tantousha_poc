'use strict';
/**
 * 採用構成シグナル（S30）── 新卒採用があり、かつ中途の方が小さい会社
 * ============================================================================
 * ユーザー確定（2026-09-18）:
 *   「新卒採用を行っていて、なおかつ中途採用の規模が新卒より少ない
 *     ＝中途中心の採用計画ではない企業」をピックアップしたい。
 *
 * なぜ効くか:
 *   MOCHICAは新卒ATS。中途が採用計画の主で、その横に新卒枠が少しあるだけの会社は、
 *   担当者の感触が良くても新卒側に割り当てられた予算が小さく、決裁まで届かない。
 *   逆に新卒が主戦場の会社は、新卒の歩留まりがそのまま事業計画に響くので話が前に進む。
 *
 * 判定そのもの（classifyHiringMix）は icp-rules.js に置いてある。
 * ICPのゲート（中途中心を落とす）と、ここのシグナル（新卒中心を上げる）で同じ関数を使う
 * ＝「リストに載る条件」と「刺す順」が別々の定義でずれることがない。
 *
 * 単位が違うことを隠さない:
 *   新卒 = 募集“人数”、中途 = 公開中の求人“件数”。1件の中途求人が何人採るかは分からない。
 *   だから等倍では比べず（ICP.MIDCAREER_RATIO_MAX）、根拠文にも件数と人数を並べて書く。
 */
const { classifyHiringMix, MIX } = require('../icp-rules');
const { scopeOf } = require('../ats-scope');

const MIX_SIGNALS = {
  NEWGRAD_CENTRIC: {
    id: 'NEWGRAD_CENTRIC', 順位: 30, 名称: '新卒中心の採用計画（中途より新卒が大きい）', 列: 'S30_新卒中心',
    weight: 26, 半減期日: 210, 要履歴: false, group: 'mix',
    説明: '新卒の募集人数と、公開中の中途求人件数を比べる。中途中心の社はICP側で落とす',
  },
};

// mix群は1軸しかないので、上限は重みそのもの（他群と同じ書き方を残しておく）。
const MIX_GROUP_CAP = { mix: 26 };

const MIX_TALK = {
  NEWGRAD_CENTRIC: '御社は新卒の採用が中心かとお見受けしました。'
    + '新卒は母集団を作ってから内定まで工程が長いぶん、途中の連絡が滞ると一気に抜けます。'
    + 'そこを止めない仕組みの話をさせてください。',
};

function hit(sig, { strength, level, 根拠, 詳細 = {}, 検知日 }) {
  const s = Math.max(0, Math.min(1, strength));
  return {
    signal: sig.id, 名称: sig.名称, 列: sig.列, weight: sig.weight, 半減期日: sig.半減期日,
    strength: Math.round(s * 100) / 100, level, 根拠: String(根拠 || '').slice(0, 300),
    詳細, 検知日: 検知日 || new Date().toISOString().slice(0, 10),
  };
}

/**
 * 中途採用の規模を見積もる。強い順に:
 *   ① 求人検索エンジン（求人ボックス）の社名一致カード件数 … 実数に近い。jobs 系統でのみ取れる
 *   ② 採用ページ・掲載本文の新卒語/中途語の量            … 件数ではなく“寄り”しか言えない
 * 「取得できて0件」と「取得していない」を必ず区別する（後者を0件にすると全社が新卒中心になる）。
 * @param {object} ev collect.js のエビデンス
 * @returns {{件数:number|null, 取得:boolean, 出所:string, 確度:string, 引用:string}}
 */
function estimateMidcareer(ev = {}) {
  const j = ev.中途求人;
  if (j && j.取得) {
    return {
      件数: Number.isFinite(j.件数) ? j.件数 : null, 取得: true,
      出所: j.出所 || '求人ボックス', 確度: j.打切り ? '中' : '強',
      引用: (j.例 || []).slice(0, 3).join(' ／ ').slice(0, 160)
        + (j.打切り ? '（1ページ目で打ち切り＝実際はこれ以上）' : ''),
    };
  }
  // 語の量からの“寄り”。件数は出さない（出すと突き合わせが嘘になる）。
  // ★ 見るのは自社サイトの採用ページだけ。マイナビ掲載本文（ev.掲載本文）は構造上100%新卒なので、
  //   混ぜると全社が新卒寄りになる（実測8社中8社が「新卒寄り」になった）。
  const text = String(ev.自社サイト本文 || '');
  if (!text.trim()) return { 件数: null, 取得: false, 出所: '', 確度: '—', 引用: '' };
  const sc = scopeOf({ text: text.slice(0, 60000) });
  return {
    件数: null, 取得: false, 出所: '採用ページの語', 確度: '弱',
    引用: `新卒語${sc.shinsotsu}点(${sc.sHits.slice(0, 3).join('・')})／中途語${sc.chuto}点(${sc.cHits.slice(0, 3).join('・')})`,
    寄り: sc.scope,
  };
}

/**
 * 新卒の募集規模。掲載面の募集人数 → 直近の入社実数 → CSVの採用予定人数 の順に見る。
 * @returns {{人数:number|null, 出所:string, 表記:string}}
 */
function newgradScale(ev = {}) {
  const faces = Object.entries(ev.卒年面 || {})
    .map(([gy, f]) => ({ gy: parseInt(gy, 10), f }))
    .filter((x) => Number.isFinite(x.gy) && x.f && x.f.募集人数 && Number.isFinite(x.f.募集人数.下限))
    .sort((a, b) => b.gy - a.gy);
  if (faces.length) return { 人数: faces[0].f.募集人数.下限, 出所: `${faces[0].gy}卒面の募集人数`, 表記: faces[0].f.募集人数.表記 };
  const ret = ev.定着 && ev.定着.系列 && ev.定着.系列[0];
  if (ret) return { 人数: ret.採用者, 出所: `${ret.年}年の入社実績`, 表記: `${ret.採用者}名` };
  const s = String(ev.採用予定人数 ?? '').normalize('NFKC').replace(/,/g, '').match(/^(\d{1,4})\s*(?:名|人)?$/);
  if (s) return { 人数: +s[1], 出所: '掲載の採用予定人数', 表記: `${s[1]}名` };
  return { 人数: null, 出所: '', 表記: '' };
}

/**
 * 採用構成を1社ぶん判定する。ICPゲートとシグナルの両方がこれを使う。
 * @returns classifyHiringMix() の戻り ＋ 出所・引用
 */
function hiringMix(ev = {}) {
  const ng = newgradScale(ev);
  const mc = estimateMidcareer(ev);
  const wrap = (base) => ({
    ...base, 新卒出所: ng.出所, 新卒表記: ng.表記, 中途出所: mc.出所, 中途引用: mc.引用, 中途寄り: mc.寄り || '',
  });
  const base = classifyHiringMix({
    newgrad: ng.人数, midcareer: mc.件数, midcareerFetched: mc.取得, 確度: mc.確度,
  });
  if (base.構成 !== MIX.UNKNOWN || ng.人数 == null) return wrap(base);

  // 件数が取れなかった時の弱い当て方: 採用ページ・掲載本文の新卒語と中途語の量。
  // 新卒に寄っているときだけ「新卒中心(弱)」と言い、中途に寄っていても中途中心とは言わない。
  // 語の量は“寄り”しか示さず、ICPのゲート（母集団から落とす判断）に足る証拠ではないため。
  if (mc.寄り === '新卒') {
    return wrap({
      ...base, 構成: MIX.NEWGRAD, 確度: '弱',
      理由: `新卒${ng.人数}名／中途の件数は未取得だが、採用ページの語は新卒寄り`,
    });
  }
  return wrap(base);
}

/**
 * S30 を検知する。立てるのは「新卒中心」のときだけ。
 * 中途中心・新卒なしは点を引かず、ICP側のゲート（passesNewgradCentric）が落とす
 * ＝減点シグナルを作らない（資金リスクと同じ方針）。
 */
function detectMixSignals(ev = {}, { now = new Date(), 検知日 } = {}) {
  const d = 検知日 || new Date(now).toISOString().slice(0, 10);
  const m = hiringMix(ev);
  if (m.構成 !== MIX.NEWGRAD) return [];

  let strength; let level;
  // 「中途0件」で確定は出さない。求人ボックスは全社横断の関連度順なので、
  // 0件は「募集していない」ではなく「1ページ目に出てこなかった」ことがある（collect.js の注記）。
  if (m.中途 != null && m.新卒 >= m.中途 * 2) { strength = 0.9; level = `確定(新卒${m.新卒表記}・中途${m.中途}件＝新卒が倍以上)`; }
  else if (m.中途 != null) { strength = 0.7; level = `強(新卒${m.新卒表記} ≥ 中途${m.中途}件)`; }
  else { strength = 0.35; level = '弱(採用ページの語から新卒寄り＝件数は未取得)'; }

  return [hit(MIX_SIGNALS.NEWGRAD_CENTRIC, {
    strength, level, 検知日: d,
    根拠: `${m.理由}／新卒の出所:${m.新卒出所}／中途の出所:${m.中途出所 || '未取得'}`
      + (m.中途引用 ? `: ${m.中途引用}` : '')
      + '（新卒は募集“人数”、中途は公開求人“件数”で単位が違う点に注意）',
    詳細: {
      構成: m.構成, 新卒: m.新卒, 中途: m.中途, 比: m.比,
      新卒出所: m.新卒出所, 中途出所: m.中途出所, 確度: m.確度,
    },
  })];
}

module.exports = {
  MIX_SIGNALS, MIX_TALK, MIX_GROUP_CAP, detectMixSignals,
  hiringMix, estimateMidcareer, newgradScale,
};
