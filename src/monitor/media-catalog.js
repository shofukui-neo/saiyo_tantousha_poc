'use strict';
// 新卒媒体カタログ（実地プローブ対象）。tier: major(大手総合)/regional(地方系)/specialized(専門職・理系・逆求人)/aggregator(横断・口コミ)。
// searchUrl(query) があれば検索結果を、無ければ url(トップ等)を叩いて到達性・取得方式・鮮度・企業密度を実証する。
// ※URL/検索仕様は変わりうる前提。プローブは「現状そうだったか」を正直に記録する（404/JS必須/robots不可も結果）。
const enc = encodeURIComponent;

const CATALOG = [
  // ── 大手総合 ──
  { name: 'リクナビ', tier: 'major', query: '新卒', searchUrl: (q) => `https://job.rikunabi.com/2027/search/?kw=${enc(q)}` },
  { name: 'マイナビ', tier: 'major', query: '新卒', url: 'https://job.mynavi.jp/2027/' }, // /27/ は404、/2027/ が正（実証）
  { name: 'キャリタス就活', tier: 'major', query: '新卒', url: 'https://job.career-tasu.jp/' },
  { name: 'ワンキャリア', tier: 'major', query: '新卒', url: 'https://www.onecareer.jp/companies' }, // /companies/search は404。一覧はlink71本（社名はJS寄り）
  { name: 'あさがくナビ(学情)', tier: 'major', query: '新卒', url: 'https://www.gakujo.ne.jp/' },
  { name: 'ブンナビ(文化放送)', tier: 'major', query: '新卒', url: 'https://bunnabi.jp/' },
  { name: 'Wantedly新卒', tier: 'major', query: '新卒', url: 'https://www.wantedly.com/projects' },
  { name: 'type就活', tier: 'major', query: '新卒', url: 'https://typeshukatsu.jp/' },

  // ── 専門職・理系・逆求人 ──
  { name: 'OfferBox(逆求人)', tier: 'specialized', query: '新卒', url: 'https://offerbox.jp/' },
  { name: 'アカリク(院生/研究)', tier: 'specialized', query: '新卒', url: 'https://acaric.jp/' },
  { name: 'レバテックルーキー(IT)', tier: 'specialized', query: 'エンジニア', url: 'https://rookie.levtech.jp/' },
  { name: 'TECH OFFER(理系逆求人)', tier: 'specialized', query: '理系', url: 'https://techoffer.jp/' },
  { name: 'LabBase(理系院生)', tier: 'specialized', query: '研究', url: 'https://compass.labbase.jp/' },
  { name: 'キミスカ(逆求人)', tier: 'specialized', query: '新卒', url: 'https://kimisuka.com/' },
  { name: 'dodaキャンパス', tier: 'specialized', query: '新卒', url: 'https://campus.doda.jp/' },
  { name: 'キャリアチケット', tier: 'specialized', query: '新卒', url: 'https://careerticket.jp/' },
  { name: 'マイナビ看護学生', tier: 'specialized', query: '看護', url: 'https://www.nurse-mynavi.com/' },
  { name: 'ナース専科就職(看護)', tier: 'specialized', query: '看護', url: 'https://kango-job.jp/' },
  { name: '薬キャリ(薬剤師)', tier: 'specialized', query: '薬剤師', url: 'https://pcareer.m3.com/' },

  // ── 横断・口コミ ──
  { name: 'みん就(みんなの就活)', tier: 'aggregator', query: '新卒', url: 'https://www.nikki.ne.jp/' },
  { name: '就活会議', tier: 'aggregator', query: '新卒', url: 'https://syukatsu-kaigi.jp/' },
  { name: 'OpenWork', tier: 'aggregator', query: '新卒', url: 'https://www.openwork.jp/' },
  { name: 'キャリコネ', tier: 'aggregator', query: '新卒', url: 'https://careerconnection.jp/' },
  { name: 'Indeed新卒', tier: 'aggregator', query: '新卒', searchUrl: (q) => `https://jp.indeed.com/jobs?q=${enc(q)}` },
  { name: 'スタンバイ', tier: 'aggregator', query: '新卒', searchUrl: (q) => `https://jp.stanby.com/search?q=${enc(q)}` },

  // ── 地方系 ──
  { name: 'しょくばらぼ(厚労省)', tier: 'regional', query: '新卒', url: 'https://shokuba.mhlw.go.jp/' },
  { name: 'ハローワーク求人検索', tier: 'regional', query: '新卒', url: 'https://www.hellowork.mhlw.go.jp/' },
  { name: 'ジョブカフェ', tier: 'regional', query: '新卒', url: 'https://www.jobcafe-network.jp/' },
  { name: 'Fネット(ふるさと就職)', tier: 'regional', query: '新卒', url: 'https://www.f-net.gr.jp/' },
  { name: 'ジモコロ就活(地方)', tier: 'regional', query: '新卒', url: 'https://www.glloow.com/' },
];

module.exports = { CATALOG };
