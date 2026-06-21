'use strict';
// 採用・人事担当者の「氏名」抽出。
// ※ 外部AI API（Anthropic等）は一切使用しない。ページ本文に対する正規表現＋人名らしさ判定のみで動作する。
const cfg = require('./config');
const { stripNonName, isFullName, completeSurname } = require('./jp-names');

// 氏名候補の語尾に貪欲一致で付く敬称・助詞（「山田太郎さん」「鈴木一郎より」「中村課長 まで」等）。
// これらを剥がさないと役職/敬称/助詞を含む氏名が下流(validateHit等)を素通りして誤検出になる。
const NAME_TAIL_RE = /[ 　]*(?:でした|ちゃん|くん|さん|サン|さま|どの|への|から|より|まで|です|各位|様|氏|君|殿|宛|行|へ)$/;

// 抽出した氏名候補から、役割語/役職/地名（stripNonName）と語尾の敬称/助詞を剥がす。
// 辞書照合はしない（heuristicは寛容に拾い、確定は呼出側のisFullName/validateHitに委ねる方針）。
function cleanName(raw) {
  let s = stripNonName(String(raw || '')).replace(/[ 　]{2,}/g, ' ').trim();
  let prev;
  do { prev = s; s = s.replace(NAME_TAIL_RE, '').trim(); } while (s !== prev);
  return s;
}

// 人名ではない典型語（誤検出を弾くためのブロックリスト）。
// 例:「舞台裏（人事）」のような見出し語、役割語、組織語など。
const NON_NAME_WORDS = [
  '採用', '人事', '人材', '人財', '担当', '責任', '窓口', '部門', '部署', '採用担当', '人事担当',
  '舞台裏', 'チーム', 'メンバー', '社員', 'スタッフ', '全般', '各位', '募集', '情報', '広報', '総務',
  '本社', '支社', '会社', '当社', '弊社', '新卒', '中途', '代表', '事業', '管理', '営業', '経営', '企画',
  'お問', '問合', '連絡', '電話', '受付', '対応', '詳細', '一覧', '以下', '上記', '皆様', '私たち',
  // 姓辞書の1字目を含む一般語の誤検出止め（例:「採用関連」→関連、「池田宛」→宛、「ご応募」→応募）
  '関連', '宛', '応募', '紹介', '注目', '今回', '本件', '関係', '案内', '掲載', '更新', '専用', '希望',
  // 組織語（社名・施設名の断片が「姓＋組織語」に化けるのを防ぐ。例:「大塚商会は」→商会、「南大学」→大学）
  '商会', '商店', '大学', '学校', '学院', '銀行', '信用', '研修', '工業', '製作', '製造', '物産', '興業', '産業',
];

// 日本語の姓＋名らしさ（漢字またはカナ）。1〜4字＋（任意の空白）＋1〜5字。
const JP_NAME = '([\\u4e00-\\u9fa5々]{1,4}[ \\u3000]?[\\u4e00-\\u9fa5々\\u3040-\\u309f\\u30a0-\\u30ffー]{1,5})';

// 抽出した語が「人名らしい」か（役割語・組織語・ブロックリストを排除）
function looksLikePersonName(name) {
  const n = String(name || '').trim();
  if (n.length < 2) return false;
  if (NON_NAME_WORDS.some((w) => n.includes(w))) return false;
  if (cfg.ROLE_KEYWORDS.some((k) => n.toLowerCase().includes(String(k).toLowerCase()))) return false;
  // 数字・記号・URLっぽいもの、中黒で連結された複数名（例:「佐々木・粟津」）を除外
  if (/[0-9０-９@.\/:：、。（）()\[\]・･／]/.test(n)) return false;
  return true;
}

/**
 * 本文から採用/人事担当者の氏名をヒューリスティック抽出する（API不要）。
 * @param {string} text ページ可視テキスト
 * @returns {{found:boolean,name:string|null,role:string|null,department:string|null,evidence:string|null,confidence:number,reason:string}}
 */
function heuristicExtract(text) {
  const patterns = [
    // 「採用担当：山田 太郎」「人事ご担当 佐藤花子」など
    { re: new RegExp('(?:採用|人事|採用ご|人事ご)(?:担当|責任者)(?:者)?\\s*[:：]?\\s*' + JP_NAME), conf: 0.7 },
    // 「担当者：山田太郎」（前後に採用/人事の文脈がある場合に採用）
    { re: new RegExp('担当者\\s*[:：]\\s*' + JP_NAME), conf: 0.62 },
    // 「山田 太郎（採用担当）」
    { re: new RegExp(JP_NAME + '\\s*[（(]\\s*(?:採用|人事)'), conf: 0.7 },
  ];
  for (const { re, conf } of patterns) {
    const m = text.match(re);
    if (!m || !m[1]) continue;
    // 役職/敬称/助詞の貪欲取り込み（中村課長 まで 等）を剥がしてから人名らしさを判定する。
    const cleaned = cleanName(m[1]);
    if (!cleaned || !looksLikePersonName(cleaned)) continue;
    // 姓辞書で人名性を担保する。正規表現の貪欲一致＋(者)?の取りこぼしで生じる実データのノイズ
    //（「者とのコミュ」「業務部」「月曜日」等）を排除。validateHitはこれらを弾けないため抽出側で塞ぐ。
    const compact = cleaned.replace(/[ 　]/g, '');
    if (!isFullName(compact) && !completeSurname(compact)) continue;
    const idx = text.indexOf(m[0]);
    const around = text.slice(Math.max(0, idx - 24), idx + m[0].length + 24);
    const role = (around.match(/(採用責任者|採用担当|人事担当|採用部|人事部|人事|採用)/) || [])[0] || '';
    const dept = (around.match(/([一-龥]{2,6}部)/) || [])[0] || '';
    return { found: true, name: cleaned, role, department: dept, evidence: m[0].trim(), confidence: conf, reason: 'heuristic pattern match' };
  }
  return { found: false, name: null, role: null, department: null, evidence: null, confidence: 0, reason: 'no pattern matched (heuristic)' };
}

// ---- ローカルLLM（Ollama）抽出。外部API課金なし。OLLAMA_URL 未設定なら使用しない ----
const OLLAMA_SYSTEM =
  'あなたは日本語Webページ本文から「採用・人事の担当者」の実在の氏名を抽出するアシスタントです。' +
  '採用担当・人事担当・採用責任者など採用に関わる担当者の氏名のみを対象とし、経営者(代表取締役等)や' +
  '「採用担当」「人事部」などの役割語・組織語は氏名ではありません。確証が無ければ found=false。氏名を創作しないこと。' +
  '出力はJSONのみ: {"found":boolean,"name":string|null,"role":string|null,"department":string|null,"evidence":string|null,"confidence":number}';

async function callOllama(text, companyName) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), cfg.OLLAMA_TIMEOUT_MS);
  try {
    const res = await fetch(cfg.OLLAMA_URL.replace(/\/$/, '') + '/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: cfg.OLLAMA_MODEL,
        stream: false,
        format: 'json', // 有効なJSONのみを出力させる
        system: OLLAMA_SYSTEM,
        // 本文は文脈長に収まるよう抑制（VRAM4GBの3B級で安定させる）
        prompt: `対象企業: ${companyName || ''}\n以下の本文から採用/人事の担当者名を抽出してください。\n=== 本文 ===\n${String(text || '').slice(0, cfg.OLLAMA_PROMPT_CHARS)}\n=== 本文ここまで ===`,
        options: { num_ctx: cfg.OLLAMA_NUM_CTX, num_predict: 200, temperature: 0 },
      }),
    });
    if (!res.ok) throw new Error('Ollama HTTP ' + res.status);
    const data = await res.json();
    const obj = JSON.parse(data.response || '{}');
    return obj;
  } finally {
    clearTimeout(t);
  }
}

/**
 * 本文から採用担当者を抽出。既定はローカル処理（正規表現＋人名判定）。
 * OLLAMA_URL が設定されていればローカルLLMを使い、失敗時はヒューリスティックにフォールバック。
 * いずれも外部AI APIへの課金は発生しない。
 * @param {{text:string, companyName?:string}} opts
 * @returns {Promise<object>} 抽出結果（+ engine フィールド）
 */
async function extractContact({ text, companyName }) {
  if (cfg.OLLAMA_URL) {
    try {
      const r = await callOllama(text, companyName);
      // LLM結果も人名らしさで最終チェック（役割語・組織語の混入を防ぐ）
      if (r && r.found && looksLikePersonName(r.name)) {
        return Object.assign({ engine: 'ollama' }, r);
      }
      if (r && r.found === false) return Object.assign({ engine: 'ollama' }, r);
      // foundだが人名として不適 → ヒューリスティックで取り直す
    } catch (_) {
      return Object.assign({ engine: 'ollama-fallback' }, heuristicExtract(text));
    }
  }
  return Object.assign({ engine: cfg.OLLAMA_URL ? 'ollama-fallback' : 'heuristic' }, heuristicExtract(text));
}

module.exports = { extractContact, heuristicExtract, looksLikePersonName };
