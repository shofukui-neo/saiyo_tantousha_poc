'use strict';

// 公開情報上の採用課題。重みは営業仮説であり、受注確率ではない。
const RULES = [
  ['MANUAL_APPLICANT', '応募者情報の手作業・分散管理', '手作業管理', 24, 60, 'operations',
    /(?:Excel|エクセル|スプレッドシート|紙|手作業).{0,35}(?:応募者|候補者|採用|選考).{0,20}(?:管理|集計)|(?:応募者|候補者|選考).{0,25}(?:Excel|エクセル|スプレッドシート|手作業|転記|二重入力)/i,
    '応募者情報の集約や転記に、どの程度お時間がかかっていますか。'],
  ['SCHEDULING_BURDEN', '面接日程調整・返信対応の負荷', '日程調整負荷', 24, 45, 'operations',
    /(?:日程調整|面接調整|応募者対応|学生対応|返信対応).{0,30}(?:負担|工数|煩雑|手作業|追いつか|時間がかか|課題)|(?:負担|工数|手作業).{0,25}(?:日程調整|面接調整|応募者対応)/,
    '面接日程の調整や学生への返信で、特に負荷が大きい工程はありますか。'],
  ['CANDIDATE_DROPOFF', '選考辞退・連絡不通の課題', '選考離脱', 26, 45, 'conversion',
    /(?:選考辞退|面接辞退|無断欠席|連絡不通|返信率).{0,30}(?:増加|増えて|多い|課題|対策|改善|低下|防止)|(?:課題|対策|改善).{0,25}(?:選考辞退|面接辞退|無断欠席|連絡不通|返信率)/,
    '選考中の辞退や連絡がつかなくなる場面について、現在の対策を伺えますか。'],
  ['OFFER_FOLLOWUP', '内定辞退・内定者フォローの強化', '内定フォロー', 22, 60, 'conversion',
    /(?:内定辞退|内定承諾率).{0,30}(?:増加|課題|低下|改善|対策|防止)|内定者フォロー.{0,25}(?:強化|見直し|課題|手作業|負担)/,
    '内定から入社までのフォローで、連絡や状況把握に課題はありますか。'],
  ['MULTICHANNEL_HIRING', '複数の応募経路の統合ニーズ', '応募経路統合', 18, 90, 'complexity',
    /(?:複数媒体|複数の求人媒体|複数の採用媒体|応募経路|採用チャネル).{0,35}(?:一元管理|分散|統合|集約|増や|追加)|(?:マイナビ.{0,25}リクナビ|リクナビ.{0,25}マイナビ).{0,35}(?:併用|管理|応募)/,
    '各媒体からの応募を、現在はどのようにまとめて管理されていますか。'],
  ['MULTISITE_HIRING', '拠点・部門をまたぐ採用管理', '拠点採用管理', 18, 90, 'complexity',
    /(?:各拠点|複数拠点|各店舗|各事業所|各部門|グループ各社).{0,30}(?:採用|応募者|選考).{0,25}(?:管理|連携|共有|担当)|(?:採用|選考).{0,25}(?:各拠点|複数拠点|各店舗|各部門).{0,25}(?:共有|連携|管理)/,
    '拠点や部門ごとの選考状況は、どのように共有されていますか。'],
  ['ATS_REVIEW', '採用管理システムの比較・見直し', 'ATS見直し', 32, 45, 'purchase',
    /(?:採用管理システム|応募者管理システム|ATS).{0,30}(?:比較検討|導入検討|導入を検討|乗り換え|リプレイス|見直し|更新時期)|(?:比較検討|導入検討|リプレイス).{0,25}(?:採用管理システム|応募者管理システム|ATS)/i,
    '採用管理の仕組みを見直す際に、外せない条件と導入時期を伺えますか。'],
  ['RECRUIT_DX_PROJECT', '採用業務のデジタル化投資・推進', '採用DX投資', 28, 60, 'purchase',
    /(?:採用DX|採用業務のデジタル化|採用管理の自動化).{0,35}(?:予算|プロジェクト|推進担当|責任者|着手|開始|投資)|(?:予算|プロジェクト|推進担当|責任者).{0,30}(?:採用DX|採用業務のデジタル化|採用管理の自動化)/,
    '採用業務のデジタル化で、最初に改善したい工程と実施時期を伺えますか。'],
];
const OPPORTUNITY_SIGNALS = Object.fromEntries(RULES.map(([id, 名称, column, weight, 半減期日, group], i) => [id, {
  id, 名称, 列: `S${i + 9}_${column}`, 順位: i + 9, weight, 半減期日, group, 要履歴: false,
  説明: '新卒採用の文脈と根拠URLを必須とし、発生日不明は弱い傍証として評価',
}]));
const OPPORTUNITY_TALK = Object.fromEntries(RULES.map(r => [r[0], r[7]]));
const GROUP_CAPS = { operations: 32, conversion: 32, complexity: 24, purchase: 40 };
const NEWGRAD = /新卒|学生|内定者|インターン|\d{2,4}年?卒/;
const NON_BUYER = /導入事例|お客様の声|お客さまの声|他社事例|支援事例|サービス紹介|サービスを提供|お客様に提供|他社では|一般的に|例えば|たとえば|解説します/;
const DENIED = /(?:課題|負担|必要|予定|検討)(?:は|が|も)?(?:あり|ござい)?ません|(?:行って|実施して|検討して)(?:い|おり)ません|(?:解消|解決|改善|導入|移行)(?:済み|済|しました)|(?:予定|計画)(?:は|が)?ない|(?:見送り|中止|終了|不要|予定なし|検討なし)/;
const HEDGED = /検討|可能性|予定|目指|検証/;

function validUrl(value) {
  try { const u = new URL(value); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch (_) { return ''; }
}
function evidenceDate(value) {
  if (!value) return null;
  const m = String(value).match(/^(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})(?:日|T.*)?$/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const d = new Date(iso);
  return Number.isFinite(+d) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

function detectOpportunitySignals(ev, { now = new Date(), 検知日 } = {}) {
  const nowD = new Date(now);
  const today = 検知日 || nowD.toISOString().slice(0, 10);
  const docs = Array.isArray(ev.インテント資料) ? ev.インテント資料 : [];
  const best = new Map();
  for (const doc of docs) {
    const url = validUrl(doc.url);
    const text = String(doc.text || '').normalize('NFKC').slice(0, 200000);
    if (!url || !text || NON_BUYER.test(String(doc.title || ''))) continue;
    const date = evidenceDate(doc.date);
    if (doc.date && !date) continue;
    const days = date ? (+nowD - +new Date(date)) / 86400000 : null;
    if (days != null && days < 0) continue;
    // 異なる段落のキーワードをつなげて企業の課題を創作しない。
    for (const sentence of text.split(/[。！？\n]+/).map(s => s.trim()).filter(Boolean)) {
      if (!NEWGRAD.test(sentence) || NON_BUYER.test(sentence) || DENIED.test(sentence)) continue;
      for (const [id, , , , , , re] of RULES) {
        const sig = OPPORTUNITY_SIGNALS[id];
        const match = re.exec(sentence);
        if (!match || (days != null && days > sig.半減期日 * 4)) continue;
        const strength = date ? (HEDGED.test(sentence) ? 0.7 : 0.9) : 0.4;
        const quote = sentence.slice(Math.max(0, match.index - 45), match.index + match[0].length + 60);
        const h = {
          signal: id, 名称: sig.名称, 列: sig.列, weight: sig.weight, 半減期日: sig.半減期日,
          strength, level: date ? '強(公開記載・要ヒアリング)' : '弱(発生日不明・要確認)',
          根拠: `「${quote}」／${date || '発生日不明'}／${url}`.slice(0, 500),
          検知日: today,
          詳細: { url, 引用: quote, 発生日: date || '', 発生日不明: !date, group: sig.group, source: doc.source || 'csv' },
        };
        const effective = strength * Math.pow(0.5, (days || 0) / sig.半減期日);
        if (!best.has(id) || best.get(id).effective < effective) best.set(id, { h, effective });
      }
    }
  }
  return [...best.values()].map(x => x.h);
}

module.exports = { OPPORTUNITY_SIGNALS, OPPORTUNITY_TALK, GROUP_CAPS, detectOpportunitySignals, validUrl, evidenceDate };
