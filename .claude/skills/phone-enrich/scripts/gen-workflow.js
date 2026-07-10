'use strict';
// gen-workflow.js <input.csv> <out-workflow.js> [--batch 8] [--model sonnet] [--only-todo worklist.csv]
// Emits a self-contained multi-agent Workflow script with the companies embedded
// (the workflow sandbox has NO filesystem, so data must ride inside the script).
// Each agent resolves 代表電話 for a batch via first-party web lookup, with strict
// no-fabrication / verify-right-company / flag-公開電話なし rules.
const fs = require('fs');
const { parseCSV, readFile, findCol, normCompanyName } = require('./lib');

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : def; }
const input = process.argv[2], outJs = process.argv[3];
if (!input || !outJs || input.startsWith('--')) { console.error('usage: node gen-workflow.js <input.csv> <out-workflow.js> [--batch 8] [--model sonnet] [--only-todo worklist.csv]'); process.exit(1); }
const BATCH = parseInt(arg('batch', '8'), 10);
const MODEL = arg('model', 'sonnet');
const onlyTodo = arg('only-todo', '');

const rows = parseCSV(readFile(input));
const H = rows[0];
const ci = {
  name: findCol(H, ['会社情報：会社名', '会社名', '企業名', '取引先名'], ['会社名', '企業名', '取引先']),
  sei: findCol(H, ['担当者情報：姓', '姓'], []),
  mei: findCol(H, ['担当者情報：名', '名'], []),
  contact: findCol(H, ['担当者', '担当者名'], ['担当者']),
  phone: findCol(H, ['会社情報：電話', '電話', '電話番号'], ['電話', 'TEL']),
};
if (ci.name < 0) { console.error('could not detect company-name column'); process.exit(1); }

// optional: restrict to unresolved companies from an internal-join worklist (status=todo)
let todoSet = null;
if (onlyTodo && fs.existsSync(onlyTodo)) {
  const wr = parseCSV(readFile(onlyTodo)); const wh = wr[0];
  const wn = findCol(wh, ['会社名', '企業名'], ['会社名', '企業名']); const ws = wh.indexOf('status');
  todoSet = new Set(wr.slice(1).filter(r => ws < 0 || r[ws] === 'todo').map(r => normCompanyName((r[wn] || '').trim())));
  console.error('only-todo: restricting to', todoSet.size, 'unresolved companies');
}

const COMPANIES = rows.slice(1)
  .filter(r => (r[ci.name] || '').trim())
  .filter(r => ci.phone < 0 || !(r[ci.phone] || '').trim())         // skip ones that already have a phone
  .filter(r => !todoSet || todoSet.has(normCompanyName((r[ci.name] || '').trim())))
  .map(r => ({
    name: (r[ci.name] || '').trim(),
    contact: (((ci.sei >= 0 ? r[ci.sei] : '') || '') + ' ' + ((ci.mei >= 0 ? r[ci.mei] : '') || '')).trim() || (ci.contact >= 0 ? (r[ci.contact] || '').trim() : ''),
  }));
if (!COMPANIES.length) { console.error('no companies to look up (all already have phones?)'); process.exit(1); }

const script = `export const meta = {
  name: 'phone-enrich-lookup',
  description: 'Resolve 代表電話 for ${COMPANIES.length} companies via first-party web lookup',
  phases: [{ title: 'Lookup', detail: 'batched WebSearch + 会社概要/特商法 extract per company' }],
};

const COMPANIES = ${JSON.stringify(COMPANIES)};

const SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { results: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    properties: {
      name: { type: 'string', description: '会社名 EXACTLY as given' },
      phone: { type: 'string', description: '代表電話 0X-XXXX-XXXX, or "" if none public' },
      source: { type: 'string', description: 'URL where found/checked' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
      note: { type: 'string', description: 'short JP note e.g. 公開電話なし・フォームのみ / 本社代表' },
    }, required: ['name', 'phone', 'confidence'],
  } } }, required: ['results'],
};

function buildPrompt(batch) {
  const list = batch.map((c, i) => (i + 1) + '. 会社名: "' + c.name + '" ／ 担当者: ' + (c.contact || '(不明)')).join('\\n');
  return [
    'あなたは日本のB2B企業データ調査の専門家です。各企業の【代表電話（本社・お問い合わせ窓口）】を、企業自身の公式サイトまたは信頼できる情報源から特定してください。',
    'まず WebSearch と WebFetch を使えるように。使えない場合は ToolSearch("select:WebSearch,WebFetch") で読み込む。',
    '',
    '【手順】1. WebSearch: \`"<会社名>" 会社概要 電話\`、\`<会社名> 本社 電話番号\`、\`<会社名> 特定商取引法\`、\`<会社名> お問い合わせ\`。社名が一般的な時は担当者名/事業内容で正しい企業か確認。',
    '2. その企業【自身のドメイン】の 会社概要/会社情報/アクセス/特定商取引法に基づく表記/お問い合わせ を優先。スニペットで確定しなければ WebFetch で該当ページを読み TEL を抽出。',
    '3. アグリゲータ(baseconnect,salesnow,telnavi,電話帳ナビ,alarmbox,HRog,キャリタス,マイナビ,リクナビ,ハローワーク,Wantedly)は裏取りに使ってよいが一次情報を最優先。',
    '',
    '【厳守】- 日本形式 0X-XXXX-XXXX に正規化。固定電話・代表番号を優先(携帯/FAXは避ける、FAXならnote明記)。',
    '- 絶対に推測・捏造しない。確信なければ phone="" ・ confidence="none"。',
    '- 近年のスタートアップは電話を公開せずフォーム/メールのみが多い→その場合 phone="" ・ note に "公開電話なし・フォーム/メールのみ"(正しい結果)。',
    '- 別会社の番号を拾うのは "none" より有害。ドメイン・所在地・事業内容・代表者名の一致を検証。',
    '- confidence: high=自社の会社概要/特商法ページ / medium=信頼できるアグリゲータor採用ページ / low=不確実 / none=未発見。',
    '',
    '入力企業（全' + batch.length + '社）:', list, '',
    '出力: 全' + batch.length + '社を results 配列で。name は入力の会社名を一字一句そのまま。',
  ].join('\\n');
}

phase('Lookup');
const BATCH = ${BATCH};
const batches = [];
for (let i = 0; i < COMPANIES.length; i += BATCH) batches.push(COMPANIES.slice(i, i + BATCH));
log('企業 ' + COMPANIES.length + '社 を ' + batches.length + 'バッチ（各' + BATCH + '社）で並列探索');

const waves = await parallel(batches.map((b, bi) => () => {
  const from = bi * BATCH + 1, to = bi * BATCH + b.length;
  return agent(buildPrompt(b), { label: 'lookup:' + from + '-' + to, phase: 'Lookup', schema: SCHEMA, model: '${MODEL}', effort: 'medium', agentType: 'general-purpose' })
    .then((r) => (r && Array.isArray(r.results)) ? r.results : []).catch(() => []);
}));
const flat = waves.filter(Boolean).flat();
const withPhone = flat.filter((x) => x && x.phone && String(x.phone).trim()).length;
log('探索完了: ' + flat.length + '件 / 電話あり ' + withPhone + '件');
return { total: COMPANIES.length, returned: flat.length, withPhone, results: flat };
`;

fs.writeFileSync(outJs, script, 'utf8');
console.log('wrote workflow:', outJs);
console.log('companies:', COMPANIES.length, '| batches:', Math.ceil(COMPANIES.length / BATCH), '| model:', MODEL);
console.log('\nNext (needs user opt-in — billed run):');
console.log('  Workflow({ scriptPath: "' + outJs.replace(/\\/g, '/') + '" })');
console.log('When done, extract journal + finalize:');
console.log('  node finalize.js "' + input.replace(/\\/g, '/') + '" <transcriptDir>/journal.jsonl');
