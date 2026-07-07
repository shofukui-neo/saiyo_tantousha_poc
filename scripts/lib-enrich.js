'use strict';
// 既存顧客エンリッチ共通部品: 業種マクロ分類・従業員/採用バンド・メール属性・地域・獲得チャネル。
const { prefectureForNumber } = require('../src/areacode');
const { normalizeJpPhone } = require('../src/phone');

// ---- 業種マクロカテゴリ（SFの細分ラベルを12大分類へ集約）----
function industryMacro(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const has = (re) => re.test(s);
  if (has(/小売|流通|物販|百貨店|スーパー|ドラッグ|専門店|コンビニ|生活協同|生協|通販|ネット販売/)) return '流通・小売';
  if (has(/銀行|信用金庫|信金|信用組合|労働金庫|保険|証券|金融|リース|レンタル|クレジット|共済|アセットマネジ/)) return '金融・保険';
  if (has(/介護|保育|医療法人|クリニック|病院|福祉|幼稚園|医療機関|調剤|薬局/)) return '医療・介護・福祉';
  if (has(/メーカー|製造|機械|電機|電気|電子|半導体|素材|化学|食品|医薬|金属|鉄鋼|自動車|部品|精密|繊維|ガラス|セラミック|紙・パルプ|化粧品|タイヤ|ゴム|プラント|重電|産業用/)) return '製造・メーカー';
  if (has(/商社|卸/)) return '商社・卸';
  if (has(/建設|建築|土木|設備工事|工務店|住宅|不動産|エクステリア|建材|インテリア|リフォーム/)) return '建設・不動産';
  if (has(/運輸|物流|倉庫|陸運|海運|運送|交通|鉄道|航空|タクシー|バス/)) return '運輸・物流';
  if (has(/インフラ|エネルギー|環境|ガス|電力|水道|通信|放送|リサイクル/)) return '公共インフラ・エネルギー';
  if (has(/ソフトウ|ＩＴ|IT|情報処理|システム|受託開発|インターネット|ゲーム|Web|アプリ|コンピュータ|通信機器|セキュリティ|SIer|SES/i)) return 'IT・ソフトウェア';
  if (has(/外食|フード|レストラン|給食|デリカ|ホテル|旅館|レジャー|アミューズメント|フィットネス|エステ|美容|理容|冠婚葬祭|イベント|旅行/)) return '外食・サービス・レジャー';
  if (has(/広告|マスコミ|デザイン|印刷|出版|新聞|放送|空間デザイン/)) return 'マスコミ・広告・印刷';
  if (has(/コンサル|人材|派遣|紹介|BPO|ビジネスサービス|シンクタンク|教育|官公庁|警察|学校法人|団体|協同組合|公益|独立行政/)) return '人材・専門・公共サービス';
  return 'その他';
}

// ---- 従業員数レンジ → バンドラベル ----
function empBandLabel(v) {
  if (!v || /不明|^-$/.test(String(v))) return '';
  const s = String(v).replace(/,/g, '');
  const map = [
    [/1～5人|1~5人/, '01:<5'], [/5～10|5~10/, '02:5-10'], [/10～20|10~20/, '03:10-20'],
    [/20～30|20~30/, '04:20-30'], [/30～50|30~50/, '05:30-50'], [/50～100|50~100|50人未満/, '06:50-100'],
    [/100～300|100~300|100～200|100～500|100～1千/, '07:100-300'], [/300～500|300～1千/, '08:300-500'],
    [/500～1千|500～1000/, '09:500-1000'], [/1千～2千|1000～2千|1千人～1万|1千人～5000|1千～1万/, '10:1000-2000'],
    [/2千～5千/, '11:2000-5000'], [/5千～1万/, '12:5000-10000'], [/1万/, '13:10000+'],
  ];
  for (const [re, lab] of map) if (re.test(s)) return lab;
  const n = parseInt((s.match(/\d+/) || [])[0] || '', 10);
  if (Number.isFinite(n)) {
    if (n < 5) return '01:<5'; if (n < 10) return '02:5-10'; if (n < 20) return '03:10-20';
    if (n < 30) return '04:20-30'; if (n < 50) return '05:30-50'; if (n < 100) return '06:50-100';
    if (n < 300) return '07:100-300'; if (n < 500) return '08:300-500'; if (n < 1000) return '09:500-1000';
    if (n < 2000) return '10:1000-2000'; if (n < 5000) return '11:2000-5000'; if (n < 10000) return '12:5000-10000';
    return '13:10000+';
  }
  return '';
}
function hireBandLabel(v) {
  if (!v || /不明/.test(String(v))) return '';
  const s = String(v);
  if (/1～2名|1~2/.test(s)) return '1:1-2';
  if (/3～5名|3~5/.test(s)) return '2:3-5';
  if (/6～10名|6~10/.test(s)) return '3:6-10';
  if (/11～15|11~15/.test(s)) return '4:11-15';
  if (/16～20|16~20/.test(s)) return '5:16-20';
  if (/21～25|26～30|21~25|26~30/.test(s)) return '6:21-30';
  if (/31～35|36～40|41～45|46～50/.test(s)) return '7:31-50';
  if (/51～100/.test(s)) return '8:51-100';
  if (/101～200|201～300|301名/.test(s)) return '9:101+';
  return '';
}

// ---- メール属性 ----
const FREE_MAIL = /@(gmail|yahoo|outlook|hotmail|icloud|docomo|ezweb|softbank|au\.com|ymobile)\./i;
function emailAttrs(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || !e.includes('@')) return { domain: '', domainType: '', mailboxType: '' };
  const [local, domain] = e.split('@');
  const domainType = FREE_MAIL.test(e) ? 'フリーメール' : (/\.n2i\.jp$/.test(e) ? 'ベンダー内部' : '独自ドメイン');
  let mailboxType = '個人名/その他';
  if (/saiyo|saiyou|recruit|採用/.test(local)) mailboxType = '採用専用';
  else if (/jinji|jinzai|hr|人事|soumu|somu|総務/.test(local)) mailboxType = '人事・総務';
  else if (/info|contact|mail|office/.test(local)) mailboxType = '代表窓口';
  return { domain, domainType, mailboxType };
}

// ---- 電話 → 都道府県・地域ブロック ----
const REGION = {
  '北海道': '北海道・東北', '青森県': '北海道・東北', '岩手県': '北海道・東北', '宮城県': '北海道・東北', '秋田県': '北海道・東北', '山形県': '北海道・東北', '福島県': '北海道・東北',
  '茨城県': '関東', '栃木県': '関東', '群馬県': '関東', '埼玉県': '関東', '千葉県': '関東', '東京都': '関東', '神奈川県': '関東',
  '新潟県': '中部・北陸', '富山県': '中部・北陸', '石川県': '中部・北陸', '福井県': '中部・北陸', '山梨県': '中部・北陸', '長野県': '中部・北陸', '岐阜県': '中部・北陸', '静岡県': '中部・北陸', '愛知県': '中部・北陸',
  '三重県': '近畿', '滋賀県': '近畿', '京都府': '近畿', '大阪府': '近畿', '兵庫県': '近畿', '奈良県': '近畿', '和歌山県': '近畿',
  '鳥取県': '中国・四国', '島根県': '中国・四国', '岡山県': '中国・四国', '広島県': '中国・四国', '山口県': '中国・四国', '徳島県': '中国・四国', '香川県': '中国・四国', '愛媛県': '中国・四国', '高知県': '中国・四国',
  '福岡県': '九州・沖縄', '佐賀県': '九州・沖縄', '長崎県': '九州・沖縄', '熊本県': '九州・沖縄', '大分県': '九州・沖縄', '宮崎県': '九州・沖縄', '鹿児島県': '九州・沖縄', '沖縄県': '九州・沖縄',
};
function phoneToGeo(phone) {
  const norm = normalizeJpPhone(String(phone || ''));
  if (!norm) return { pref: '', region: '' };
  const pref = prefectureForNumber(norm) || '';
  return { pref, region: REGION[pref] || '' };
}

// ---- 獲得チャネル分類（セミナーアンケート項目=リスト名から）----
function acquisitionChannel(s10, s7) {
  const s = (String(s10 || '') + ' ' + String(s7 || '')).trim();
  if (!s) return '';
  if (/マイナビ/.test(s)) return 'マイナビ掲載リスト';
  if (/リクナビ/.test(s)) return 'リクナビ掲載リスト';
  if (/セミナー|ウェビナー|イベント|展示会/.test(s)) return 'セミナー・イベント';
  if (/紹介|リファラル/.test(s)) return '紹介';
  if (/問い合わせ|問合せ|資料請求|フォーム|inbound|インバウンド/i.test(s)) return 'インバウンド';
  if (/お断り|リサイクル/.test(s)) return '再アプローチ';
  if (/架電|アウトバウンド|テレア/.test(s)) return 'アウトバウンド架電';
  return 'その他リスト';
}

module.exports = { industryMacro, empBandLabel, hireBandLabel, emailAttrs, phoneToGeo, acquisitionChannel };
