'use strict';
// 採用メールのローカル部から「担当者の姓」を推定する（中堅大手向けの数少ない個人名レバー）。
// ------------------------------------------------------------------
// 背景: 中堅大手は問合せ先テキストに個人名を出さない（[[recruiter-name-segment-finding]]）が、
//   マイナビ等で取れる採用メールが個人名ローカル部のことがある（例: Tsagara@→相良, ksato@→佐藤）。
//   ロール系(recruit@/saiyo@/info@)は除外し、人名ローカル部のみローマ字→姓に変換する。
//   ※あくまで「推定」。確度は中程度に留め、取得元を「メール推定」と明示する。

// 頻出姓のローマ字読み→漢字（上位～110姓。ヘボン式中心、長音 ou/oh/o 揺れも一部吸収）。
const ROMAJI_SURNAMES = {
  sato: '佐藤', suzuki: '鈴木', takahashi: '高橋', tanaka: '田中', ito: '伊藤', itoh: '伊藤',
  watanabe: '渡辺', yamamoto: '山本', nakamura: '中村', kobayashi: '小林', kato: '加藤', katoh: '加藤',
  yoshida: '吉田', yamada: '山田', sasaki: '佐々木', yamaguchi: '山口', matsumoto: '松本', inoue: '井上',
  kimura: '木村', hayashi: '林', shimizu: '清水', saito: '斎藤', saitoh: '斎藤', yamazaki: '山崎',
  abe: '阿部', mori: '森', ikeda: '池田', hashimoto: '橋本', yamashita: '山下', ishikawa: '石川',
  nakajima: '中島', maeda: '前田', fujita: '藤田', goto: '後藤', gotoh: '後藤', ogawa: '小川',
  okada: '岡田', murakami: '村上', hasegawa: '長谷川', kondo: '近藤', kondoh: '近藤', ishii: '石井',
  sakamoto: '坂本', endo: '遠藤', endoh: '遠藤', fujii: '藤井', aoki: '青木', fukuda: '福田',
  miura: '三浦', nishimura: '西村', fujiwara: '藤原', ota: '太田', ohta: '太田', matsuda: '松田',
  harada: '原田', okamoto: '岡本', nakano: '中野', nakagawa: '中川', ono: '小野', ohno: '大野',
  tamura: '田村', takeuchi: '竹内', kaneko: '金子', wada: '和田', nakayama: '中山', ishida: '石田',
  ueda: '上田', morita: '森田', kojima: '小島', shibata: '柴田', hara: '原', miyazaki: '宮崎',
  sakai: '酒井', kudo: '工藤', kudoh: '工藤', yokoyama: '横山', miyamoto: '宮本', uchida: '内田',
  takagi: '高木', ando: '安藤', andoh: '安藤', shimada: '島田', taniguchi: '谷口', takada: '高田',
  maruyama: '丸山', imai: '今井', kono: '河野', kohno: '河野', fujimoto: '藤本', murata: '村田',
  takeda: '武田', ueno: '上野', sugiyama: '杉山', masuda: '増田', koyama: '小山', otsuka: '大塚',
  ohtsuka: '大塚', hirano: '平野', sugawara: '菅原', kubo: '久保', matsui: '松井', chiba: '千葉',
  iwasaki: '岩崎', sakurai: '桜井', kinoshita: '木下', noguchi: '野口', matsuo: '松尾', kikuchi: '菊地',
  nomura: '野村', sagara: '相良', hattori: '服部', fukushima: '福島', sugimoto: '杉本', oshima: '大島',
  higuchi: '樋口', koike: '小池', takano: '高野', kawaguchi: '川口', honda: '本田', nakata: '中田',
  kojima2: '児島', morimoto: '森本', okazaki: '岡崎', uehara: '上原',
  // 追加バッチ（ランク～200の頻出姓。マイナビ採用メール実走で ogura@→小倉 等の取りこぼしを補う）。
  ogura: '小倉', sano: '佐野', hori: '堀', arai: '新井', koizumi: '小泉', mizuno: '水野', hamada: '浜田',
  sugiura: '杉浦', kuroda: '黒田', kuroki: '黒木', oki: '沖', nishida: '西田', kitamura: '北村',
  kawamura: '川村', hoshino: '星野', yokota: '横田', iida: '飯田', yasuda: '安田', taguchi: '田口',
  sekiguchi: '関口', naito: '内藤', naitoh: '内藤', matsumura: '松村', ozaki: '尾崎', otani: '大谷',
  ohtani: '大谷', imamura: '今村', katayama: '片山', eguchi: '江口', mochizuki: '望月', tsuchiya: '土屋',
  komatsu: '小松', sudo: '須藤', sudoh: '須藤', tomita: '富田', yagi: '八木', furukawa: '古川',
  aoyama: '青山', yano: '矢野', hirose: '広瀬', koga: '古賀', araki: '荒木', iizuka: '飯塚',
  shiraishi: '白石', tomioka: '富岡', miyata: '宮田', asano: '浅野', fukui: '福井', kawakami: '川上',
  nishikawa: '西川', kitagawa: '北川', sawada: '沢田', yoshimura: '吉村', miura2: '三浦',
};

// 人名でないロール系ローカル部（除外）。
const ROLE_LOCAL = new Set([
  'recruit', 'recruiting', 'recruits', 'saiyo', 'saiyou', 'saiyou', 'saiyo-hr', 'jinji', 'soumu',
  'info', 'hr', 'contact', 'career', 'careers', 'kanri', 'adm', 'admin', 'office', 'entry',
  'mail', 'mailto', 'support', 'sales', 'soumubu', 'jinjibu', 'jobs', 'job', 'apply', 'shinsotsu',
]);

/**
 * メールアドレスのローカル部から担当者の姓を推定する。
 * @param {string} email
 * @returns {{surname:string, romaji:string, local:string, confidence:number}|null}
 */
function nameFromEmail(email) {
  const local = String(email || '').split('@')[0].trim().toLowerCase();
  if (!local) return null;
  // 区切り（. _ -）でトークン分割。各トークンを姓候補として評価。
  const parts = local.split(/[._\-]+/).filter(Boolean);
  for (const p of parts) {
    if (ROLE_LOCAL.has(p)) continue;
    if (!/^[a-z]+$/.test(p)) continue;
    // そのまま / 先頭1字(イニシャル)除去 / 末尾1字除去 の順で姓辞書照合。
    const cands = [p];
    if (p.length >= 5) { cands.push(p.slice(1)); cands.push(p.slice(0, -1)); }
    for (const c of cands) {
      const kanji = ROMAJI_SURNAMES[c];
      if (kanji) {
        // 完全一致(=単独で姓)は確度やや高め、イニシャル除去等の推定は中程度。
        const exact = c === p;
        return { surname: kanji, romaji: c, local, confidence: exact ? 0.5 : 0.4 };
      }
    }
  }
  return null;
}

module.exports = { nameFromEmail, ROMAJI_SURNAMES };
