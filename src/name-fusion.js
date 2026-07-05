'use strict';
/**
 * 採用担当者名 クロスソース融合ロジック（マイナビ以外の実績WEB源を横断して高確率化）
 * ============================================================================
 * 背景 / なぜ作るか:
 *   既存カスケード(harvest-named.js)は「自社ページ→インタビュー記事…」を順に試し、
 *   最初に取れた1件で打ち切る（first-hit-wins）。だが probe-recruit-page.js の設計コメントが
 *   最初から意図していたのは「各プローブを同じ形で足し “クロス検証” に載せる」ことだった。
 *   その未実装部分＝本モジュール。
 *
 * 高確率化の3レバー（first-hit-wins に対して）:
 *   ① プール最良（best-of-pool）: 早い弱い部分一致に引きずられず、後段の辞書検証済みフルネームを採る。
 *   ② クロスソース一致（agreement）: 独立した複数の実績WEB源が同じ氏名を指したら確度を加点。
 *      例「自社採用ページ」と「Webインタビュー記事」が両方 “早瀬 峻介” → ほぼ確定に昇格。
 *   ③ 実績源の信頼度重み: 構造アンカーの強い源（自社ページ / Wantedly / PR TIMES問合せ先）を、
 *      検索起点で誤爆しやすい discovery系（インタビュー記事）より重く扱う。
 *
 * 入力は各プローブ／既存CSVから集めた共通形の候補配列。純粋関数＝副作用なし・単体テスト可能。
 *   candidate = { name, role?, department?, confidence?, evidence?, sourceUrl?, source?, engine? }
 */
const { normPersonToken } = require('./mynavi-name-extract');
const { splitName, isFullName, isKnownSurname, isPlausiblePersonName } = require('./jp-names');

// ── 実績源の信頼度重み（マイナビ以外・構造アンカーの強さ順）─────────────────
// 「取得実績のあるWEBページ」を分類。ラベル/構造で人名が保証される源ほど高い。
const SOURCE_BUCKETS = [
  { bucket: '公式HP(自社サイト)',        weight: 0.95, re: /公式HP|公式サイト|自社サイト|コーポレートサイト/i },
  { bucket: '自社採用ページ',           weight: 1.00, re: /自社(採用)?ページ|採用ページ|recruit-?page|own[- ]?page/i },
  { bucket: 'Wantedly',                 weight: 1.00, re: /wantedly/i },
  { bucket: 'gBizINFO(公的)',           weight: 0.98, re: /gbiz|gbizinfo|法人番号/i },
  { bucket: 'PR TIMES問合せ先',         weight: 0.95, re: /pr\s?times|プレス|press|問合せ|問い?合わ?せ/i },
  { bucket: 'テック媒体(GitHub/connpass)', weight: 0.82, re: /github|connpass|テック|技術者/i },
  { bucket: 'Webインタビュー記事/採用ブログ', weight: 0.85, re: /インタビュー|採用ブログ|記事|interview|blog/i },
];
const DEFAULT_WEIGHT = 0.75;

// 採用/人事のロール兆候（部署・役職・根拠のいずれかに出れば加点）。
const ROLE_SIGNAL_RE = /採用|人事|人材|人財|リクルート|リクルーター|HR|タレントアクイジション|新卒|中途|広報/i;

/**
 * 候補の source 文字列（＋URL）を信頼度バケットに分類する。
 * @returns {{bucket:string, weight:number}}
 */
function classifySource(source, url) {
  const hay = `${source || ''} ${url || ''}`;
  for (const s of SOURCE_BUCKETS) if (s.re.test(hay)) return { bucket: s.bucket, weight: s.weight };
  return { bucket: source ? String(source).slice(0, 24) : '不明', weight: DEFAULT_WEIGHT };
}

// 人名でない頻出フォールスポジ語（ラベル/UI/一般語の断片）。全ソース共通で弾く。
const NON_NAME = new Set(['区分', '一覧', '詳細', '応募', '募集', '採用', '担当', '内容', '情報',
  '関連', '以上', '当社', '弊社', '御社', '貴社', '新卒', '中途', '正社', '社員', '職種', '条件',
  '待遇', '概要', '事業', '会社', '本社', '所在', '地図', '沿革', '理念', '方針', '特徴', '強み',
  '記事', '一部', '全部', '担当者', '責任', '各位', '皆様', '様方', '氏名', '名前', '登録', '検索',
  '実績', '事例', '導入', '料金', '価格', '無料', '有料', '注意', '確認', '選択', '入力', '送信',
  // 役職語が単独で氏名化する誤検出（実験1で「社長」「会長」を人名として抽出したため追加）
  '社長', '会長', '専務', '常務', '部長', '課長', '係長', '室長', '主任', '主査', '店長', '所長',
  '取締役', '代表', '役員', '執行', '監査', '理事', '理事長', '会頭', '頭取', '社員一同', '一同',
  '副社長', '副会長', '本部長', '次長', '支社長', '支店長', '工場長', '園長', '院長', '校長',
  // 動詞・状態語が肩書きチェーン直後で氏名化する誤検出（実験4で「就任」を抽出したため）
  '就任', '退任', '着任', '現在', '新任', '前任', '歴任', '昇任', '選任', '重任', '再任', '退職',
  '挨拶', 'ごあいさつ', 'メッセージ', '沿革', '概要', '一同', '以下', '同左', '同上', '未定']);
// 役職語で始まる複合の誤検出（「会長 梅」「社長 田中」等、先頭が肩書きの壊れトークン）を弾く。
const TITLE_HEAD_RE = /^(社長|会長|副社長|副会長|専務|常務|代表|取締役|部長|課長|本部長|次長|室長|主任|支店長|工場長|会頭|頭取|理事長?)[ 　]/;
// 役職・役割語を内包する壊れトークン（「日代表者」「採用担当者」等）を弾く。氏名にこれらは含まれない。
const CONTAINS_ROLE_RE = /(代表者|担当者|責任者|採用担当|人事部|取締役|代表取締|執行役)/;
const TITLE_TAIL_RE = /(社長|会長|専務|常務|部長|課長|係長|室長|本部長|次長|支店長|工場長|取締役|代表|役員|理事)$/;
// 業種・組織語で終わる壊れトークン（「章剛医療」「○○工業」等）を弾く。氏名は業種語で終わらない。
const INDUSTRY_TAIL_RE = /(医療|工業|産業|商事|製作|販売|興業|運輸|物産|印刷|食品|運送|建設|電気|化学|製薬|銀行|保険|証券|不動産|物流|通信|放送|出版|広告|株式|会社|法人|機構|協会|組合|財団|大学|病院|銀)$/;

/**
 * 氏名の正規化キー（グルーピング用）と表示形を返す。
 *   「早瀬 峻介」「早瀬峻介」を同一グループに束ね、表示は姓辞書で整形した形を優先。
 * @returns {{key:string, display:string}|null}
 */
function canonName(raw) {
  let spaced = String(raw || '').replace(/[　\s]+/g, ' ').trim(); // 入力の姓名境界（空白）を保持
  // 役員表のフラット化で次行の肩書き頭が氏名末尾にbleedする（「加藤 文隆取」←取締役の頭）。
  // 末尾の取締役断片を剥がす。取/締/役は氏名末尾にまず来ないので安全。
  spaced = spaced.replace(/(取締役|取締|締役|取)$/, '').trim();
  const norm = (normPersonToken(spaced) || spaced.replace(/ /g, '')).replace(/(取締役|取締|締役|取)$/, '');
  const compact = norm.replace(/[ 　]/g, '');
  if (!compact || compact.length < 2) return null;
  if (NON_NAME.has(compact)) return null;   // 「区分」「社長」等のUI/ラベル/役職断片を人名扱いしない
  if (TITLE_HEAD_RE.test(norm)) return null; // 「会長 梅」等の先頭肩書き複合を弾く
  if (CONTAINS_ROLE_RE.test(compact)) return null; // 「日代表者」「採用担当者」等の役割語内包を弾く
  if (TITLE_TAIL_RE.test(compact)) return null;    // 「〇〇社長」等の末尾肩書きを弾く
  if (INDUSTRY_TAIL_RE.test(compact)) return null; // 「章剛医療」「〇〇工業」等の末尾業種語を弾く
  const sp = splitName(compact);
  // 表示形: 入力に姓名境界の空白があり、詰め形が一致するならページ境界を優先（辞書の2字姓誤分割を回避）。
  //         無ければ姓辞書で整形、それも無ければ生の空白/詰め形。
  let display;
  if (spaced.includes(' ') && spaced.replace(/ /g, '') === compact) display = spaced;
  else display = sp && sp.mei ? `${sp.sei} ${sp.mei}` : (norm.includes(' ') ? norm : compact);
  return { key: compact, display };
}

/**
 * 複数ソースの候補を融合し、最有力の採用担当者名を1件（＋全グループ）返す。
 * @param {Array<object>} candidates 共通形候補の配列（空可）
 * @param {{threshold?:number}} [opts] threshold: best採用の下限融合確度（既定0.62）
 * @returns {{best: object|null, groups: Array<object>}}
 */
function fuseCandidates(candidates, opts = {}) {
  const threshold = opts.threshold != null ? opts.threshold : 0.62;
  const groups = new Map(); // key -> group

  for (const c of candidates || []) {
    if (!c || !c.name) continue;
    const cn = canonName(c.name);
    if (!cn) continue;
    const { bucket, weight } = classifySource(c.source, c.sourceUrl);
    const conf = Number(c.confidence) || 0.6;
    const roleText = `${c.role || ''} ${c.department || ''} ${c.evidence || ''} ${c.source || ''}`;
    const member = {
      name: cn.display, bucket, weight, confidence: conf,
      weighted: conf * weight,
      role: c.role || '', department: c.department || '',
      evidence: String(c.evidence || '').slice(0, 120),
      sourceUrl: c.sourceUrl || '', source: c.source || bucket,
      roleSignal: ROLE_SIGNAL_RE.test(roleText),
    };
    let g = groups.get(cn.key);
    if (!g) { g = { key: cn.key, display: cn.display, members: [] }; groups.set(cn.key, g); }
    g.members.push(member);
    // 表示形は「姓 名」フルネームを優先（辞書整形済みが来たら昇格）
    if (member.name.includes(' ') && !g.display.includes(' ')) g.display = member.name;
  }

  // 各グループの融合スコアを算定
  const scored = [];
  for (const g of groups.values()) {
    const buckets = [...new Set(g.members.map((m) => m.bucket))]; // 独立源の数
    const distinct = buckets.length;
    const base = Math.max(...g.members.map((m) => m.weighted));   // 信頼度重み付き最良
    const agreement = Math.min(0.20, 0.10 * (distinct - 1));      // クロスソース一致の加点
    const dict = isFullName(g.display) ? 0.06 : (isKnownSurname(g.display) ? 0.03 : 0);
    const role = g.members.some((m) => m.roleSignal) ? 0.04 : 0;
    // 高信頼源(公式HP/gBiz/自社ページ等 weight≥0.9)は構造アンカー抽出＝稀姓でも信頼できる。
    // 単一の弱い源(discovery等)だけ かつ 人名辞書も通らない場合のみ誤爆リスクで減点する。
    const bestWeight = Math.max(...g.members.map((m) => m.weight));
    const hasSpace = /[ 　]/.test(g.display);   // 姓名境界がある＝構造抽出の裏付け
    const weakSingle = (distinct < 2 && !isPlausiblePersonName(g.display) && bestWeight < 0.9 && !hasSpace) ? -0.15 : 0;
    const fused = Math.max(0, Math.min(0.99, base + agreement + dict + role + weakSingle));
    // 代表役職/部署/根拠は最良メンバー（weighted最大）から採る
    const lead = g.members.slice().sort((a, b) => b.weighted - a.weighted)[0];
    scored.push({
      name: g.display,
      confidence: Number(fused.toFixed(3)),
      sources: buckets,
      sourceCount: distinct,
      agreement: distinct >= 2,
      role: lead.role, department: lead.department,
      evidence: lead.evidence,
      sourceUrls: [...new Set(g.members.map((m) => m.sourceUrl).filter(Boolean))],
      memberCount: g.members.length,
      _base: Number(base.toFixed(3)),
    });
  }

  // 融合確度 → 独立源数 → base の順で最良を選ぶ
  scored.sort((a, b) =>
    b.confidence - a.confidence ||
    b.sourceCount - a.sourceCount ||
    b._base - a._base ||
    (b.name.includes(' ') ? 1 : 0) - (a.name.includes(' ') ? 1 : 0));

  const best = scored.length && scored[0].confidence >= threshold ? scored[0] : null;
  return { best, groups: scored };
}

module.exports = { fuseCandidates, classifySource, canonName, SOURCE_BUCKETS };
