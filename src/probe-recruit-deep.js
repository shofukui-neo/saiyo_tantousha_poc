'use strict';
/**
 * 採用担当者名プローブ（深掘り版）
 * =====================================================================
 * probe-recruit-page の弱点（静的1〜3ページ・本文先頭の最初の人名を採る）を是正：
 *   1. JSレンダリング:  politeGet render:'auto'（静的→薄ければPlaywright）でSPA採用サイトに対応
 *   2. 複数ページ探索:  トップ→採用ページ→その配下（募集要項/エントリー/問い合わせ/メッセージ/
 *                      スタッフ/先輩）まで2ホップで辿り、定番の氏名格納パスも推測探査（最大maxPages）
 *   3. 氏名の在処を面で探す:
 *        (a) 構造抽出: table(th/td)・dl(dt/dd) の「採用担当/担当者名/問い合わせ先」行の値を読む
 *        (b) 下部の連絡先ブロック: 「応募先/お問い合わせ先/採用担当 … 氏名」をページ末尾優先で照合
 *        (c) 既存の本文正規表現（名乗り/ラベル/署名）
 *   各ページで (a)→(b)→(c) の順に高精度から試し、jp-names辞書で検証した氏名のみ確定。
 *
 * 戻り値: probe-recruit-page と同形 { name, role, department, confidence, evidence, sourceUrl, source, engine }
 */
const cheerio = require('cheerio');
const { politeGet } = require('./polite');
const { findRecruitLinks } = require('./recruit-page');
const { looksLikePersonName } = require('./extract');
const { isFullName, isKnownSurname, splitName, stripNonName, completeSurname } = require('./jp-names');

// 氏名の字種（漢字/かな、姓1-4＋名1-5）。romaji も別途許容。
const NAME = '([\\u4e00-\\u9fa5々]{1,4}[ \\u3000]?[\\u4e00-\\u9fa5々\\u3040-\\u309f\\u30a0-\\u30ffー]{0,5})';
const ROMAJI_RE = /\b([A-Z][a-z]+)\s+([A-Z][a-z]+)\b/g;

const { looksJsRendered } = require('./fetch');
// 採用担当の在処を示すラベル（構造抽出・連絡先ブロックのアンカー）
const LABEL_RE = /(採用担当者?|人事担当者?|担当者名?|採用責任者|人事責任者|ご担当者?|問[い合]*[わせ]*先|応募先|連絡先)/;

// 氏名直後に貼り付く語尾（名乗り/敬称/助詞）。これらを名前と誤認しないよう剥がす。
//  「坪井です」→坪井 / 「山田と申します」→山田 / 「佐藤さん」→佐藤 / 「田中より」→田中
const NAME_TAIL_RE = /(でございます|と申し上げます|と申します|でした|です|ます|である|だ|より|から|まで|宛|が担当|が対応|担当|さん|様|氏|くん|君|ちゃん)+$/;

// トークンを氏名候補へ正規化：語尾(です/さん…)と先頭の助詞ひらがなを剥がす。
function normTok(t) { return String(t || '').replace(/[ 　]/g, '').replace(NAME_TAIL_RE, '').replace(/^[ぁ-ん]+/, ''); }

// 住所由来の地名を氏名と誤認しないためのゲート（「宮城県」「青葉区」等。連絡先ブロック抽出で混入する）。
const GEO_NAME_RE = /[都道府県市区町村郡]$/;
const PREF_NAME_RE = /^(北海道|青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|東京|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|京都|大阪|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄)/;
function isGeoName(name) { const j = String(name).replace(/[ 　]/g, ''); return GEO_NAME_RE.test(j) || (PREF_NAME_RE.test(j) && j.length <= 4); }

// 1つのテキスト断片から、辞書検証を通る最初の人名を取り出す（フル→姓+名ペア→姓のみ→ローマ字）。
// 役割語/組織語を剥がし、空白・記号でトークン分割してから照合する（貪欲正規表現の跨ぎ誤マッチを防ぐ）。
function pullName(raw) {
  if (!raw) return null;
  const cleaned = stripNonName(String(raw)).replace(/[\t\r\n]+/g, ' ').trim();
  if (!cleaned) return null;
  const toks = cleaned.split(/[\s　/／・|｜:：,，、。()（）\[\]【】<>＜＞]+/).map(normTok).filter(Boolean);
  // 1) 単一トークンが漢字フルネーム（「山田太郎」）
  for (const t of toks) if (isFullName(t) && looksLikePersonName(t) && !isGeoName(t)) { const sp = splitName(t); return { name: `${sp.sei} ${sp.mei}`, kind: 'kanji' }; }
  // 2) 隣接トークンが「姓 名」（「山田 太郎」）
  for (let i = 0; i < toks.length - 1; i++) { const c = toks[i] + toks[i + 1]; if (isFullName(c) && looksLikePersonName(c) && !isGeoName(c)) { const sp = splitName(c); return { name: `${sp.sei} ${sp.mei}`, kind: 'kanji' }; } }
  // 3) 単独姓（辞書完全一致のみ。地名片を弾く）
  for (const t of toks) { if (isGeoName(t)) continue; const sur = completeSurname(t); if (sur && looksLikePersonName(sur)) return { name: sur, kind: 'surname' }; }
  // ローマ字フルネーム
  ROMAJI_RE.lastIndex = 0; const rm = ROMAJI_RE.exec(cleaned);
  if (rm && !/^(The|And|Inc|Co|Ltd|Group|Japan|Tokyo|Osaka|Sales|Recruit|Career|Team|New)$/i.test(rm[1])) return { name: `${rm[1]} ${rm[2]}`, kind: 'romaji' };
  return null;
}

// (a) 構造抽出: table / dl の「採用担当/担当者名/問い合わせ先」行の値セルから氏名
function extractStructured(html) {
  const $ = cheerio.load(html);
  $('script,style,noscript,svg').remove();
  const candidates = [];
  // table 行: ラベルセルの隣（または同行の他セル）を値とみなす
  $('tr').each((_, tr) => {
    const cells = $(tr).find('th,td');
    if (cells.length < 2) return;
    let li = -1;
    cells.each((i, c) => { if (li < 0 && LABEL_RE.test($(c).text())) li = i; });
    if (li >= 0) for (let j = 0; j < cells.length; j++) if (j !== li) candidates.push({ label: $(cells[li]).text().trim(), val: $(cells[j]).text() });
  });
  // dl: dt がラベルなら直後の dd を値に
  $('dl').each((_, dl) => {
    const dt = $(dl).find('dt'); const dd = $(dl).find('dd');
    dt.each((i, t) => { if (LABEL_RE.test($(t).text())) candidates.push({ label: $(t).text().trim(), val: $(dd.get(i)).text() }); });
  });
  for (const c of candidates) {
    const got = pullName(c.val);
    if (got) {
      const role = (c.label.match(/採用責任者|採用担当者?|人事担当者?|採用担当|人事担当/) || [])[0] || '採用担当';
      return { name: got.name, role, department: (c.label.match(/[一-龥]{2,8}部/) || [])[0] || '', confidence: 0.84, evidence: `${c.label}: ${String(c.val).replace(/\s+/g, ' ').trim().slice(0, 40)}`, where: 'structured' };
    }
  }
  return null;
}

// (b) 下部の連絡先ブロック: 「応募先/問い合わせ先/採用担当 … 氏名」をページ末尾を優先して照合
function extractContactBlock(text) {
  if (!text) return null;
  const t = String(text).replace(/[ \t　]+/g, ' ');
  // ラベルの後ろ80字以内の人名（複数マッチ→末尾＝フッタ連絡先を優先）
  const re = new RegExp('(応募先|お?問[い合]*[わせ]*先|採用担当者?|採用に関する(?:お問[い合]*せ?|ご連絡)|人事部?採用|連絡先)[^。\\n]{0,80}?' + NAME, 'g');
  let m; const hits = [];
  while ((m = re.exec(t)) !== null) {
    const got = pullName(m[2]);
    if (got) hits.push({ name: got.name, label: m[1], idx: m.index, evidence: m[0].replace(/\s+/g, ' ').trim().slice(0, 80) });
  }
  if (!hits.length) return null;
  const h = hits[hits.length - 1]; // 末尾（=ページ下部の連絡先ブロック）を優先
  return { name: h.name, role: (h.label.match(/採用担当者?|人事/) || ['採用担当'])[0], department: '', confidence: 0.78, evidence: h.evidence, where: 'contact-block' };
}

// (c) 既存の本文正規表現（名乗り/ラベル/署名）— 取り込み（importの循環を避け同梱の薄版）
const { extractFromRecruitText, pageCorpus } = require('./probe-recruit-page');

// 1ページのHTML/コーパスから氏名を (a)→(b)→(c) で抽出
function extractFromPage(html) {
  const a = extractStructured(html);
  if (a) return a;
  const corpus = pageCorpus(html);
  const b = extractContactBlock(corpus);
  if (b) return b;
  const c = extractFromRecruitText(corpus);
  if (c && c.name) return { name: c.name, role: c.role || '', department: c.department || '', confidence: c.confidence, evidence: c.evidence, where: 'text' };
  return null;
}

// 氏名が眠りやすいページへのリンクか（採用配下の募集要項/エントリー/問い合わせ/メッセージ/スタッフ等）
const NAME_PAGE_HINTS = /(entry|応募|問[い合]|contact|inquiry|message|メッセージ|挨拶|要項|guideline|requirement|information|info|staff|スタッフ|member|people|voice|先輩|interview|インタビュー|採用担当|jinji|saiyo|recruit)/i;
function deepLinks(baseUrl, html) {
  let base; try { base = new URL(baseUrl); } catch { return []; }
  const $ = cheerio.load(html); const out = []; const seen = new Set();
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href'); if (!href) return;
    let u; try { u = new URL(href, base); } catch { return; }
    if (!/^https?:$/.test(u.protocol) || u.host !== base.host) return;
    u.hash = ''; const key = u.toString(); if (seen.has(key)) return; seen.add(key);
    const hay = (u.pathname + ' ' + ($(a).text() || '')).toLowerCase();
    if (NAME_PAGE_HINTS.test(hay)) out.push(key);
  });
  return out;
}

// 定番の氏名格納パス（ナビにリンクが無くても叩く。速度のため高利回りに厳選）
const GUESS_PATHS = ['/recruit/', '/recruit/message/', '/recruit/entry/', '/recruit/information/',
  '/recruit/requirements/', '/saiyo/', '/contact/'];

/**
 * 公式URLから複数ページを辿って採用担当者名を深掘り抽出。
 * 速度方針: クロールは静的取得（高速）。本文がJS描画で空のページのみ、対象を絞ってPlaywright描画にエスカレーション。
 *   opts.maxPages 取得上限（既定7）。
 */
async function probeRecruitDeep(officialUrl, opts = {}) {
  const maxPages = opts.maxPages || 7;
  if (!officialUrl) return null;
  let url = String(officialUrl).trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  // 静的取得→抽出。空(JS描画)なら1回だけ描画にエスカレーション。renderedHtmlも返す。
  const jsPages = []; // 静的では空だったURL（最後に1つだけ描画フォールバック）
  async function getAndExtract(u, allowRenderFallback) {
    const r = await politeGet(u, { render: 'static' });
    if (!r || r.blocked || r.error || !r.html) return { hit: null, html: '', url: u };
    if (looksJsRendered(r.html)) { if (allowRenderFallback) jsPages.push(u); }
    const hit = extractFromPage(r.html);
    return { hit, html: r.html, url: r.finalUrl || u };
  }

  const top = await getAndExtract(url, false);
  if (!top.html) return null;
  const baseUrl = top.url; let origin = ''; try { origin = new URL(baseUrl).origin; } catch {}
  if (top.hit && top.hit.name) return finalize(top.hit, baseUrl);

  // 1ホップ目: トップから採用リンク → そのページで抽出＋配下リンク収集
  const recruitLinks = findRecruitLinks(baseUrl, top.html).filter((l) => !l.external).map((l) => l.url).slice(0, 3);
  const queue = [];
  const pushUnique = (arr) => { for (const u of arr) if (u && !queue.includes(u)) queue.push(u); };
  let fetched = 1;
  for (const rl of recruitLinks) {
    if (fetched >= maxPages) break; fetched++;
    const r = await getAndExtract(rl, true);
    if (r.hit && r.hit.name) return finalize(r.hit, r.url);
    if (r.html) pushUnique(deepLinks(rl, r.html));
  }
  // 2ホップ目: 採用配下の氏名ページ＋定番パス（静的・高速）
  if (origin) pushUnique(GUESS_PATHS.map((p) => origin + p));
  for (const pageUrl of queue) {
    if (fetched >= maxPages) break; fetched++;
    const r = await getAndExtract(pageUrl, true);
    if (r.hit && r.hit.name) return finalize(r.hit, r.url);
  }
  // 描画フォールバック: 静的で空だったページを1つだけPlaywrightで描画して再抽出（SPA採用サイト対策）
  if (jsPages.length) {
    const r = await politeGet(jsPages[0], { render: 'auto' });
    if (r && r.html && !r.blocked && !r.error) { const hit = extractFromPage(r.html); if (hit && hit.name) return finalize(hit, r.finalUrl || jsPages[0]); }
  }
  return null;

  function finalize(hit, sourceUrl) {
    return { name: hit.name, role: hit.role || '', department: hit.department || '', confidence: hit.confidence || 0.7, evidence: hit.evidence || '', sourceUrl, source: '自社採用ページ', engine: 'deep:' + (hit.where || 'text') };
  }
}

module.exports = { probeRecruitDeep, extractStructured, extractContactBlock, extractFromPage, pullName, deepLinks, GUESS_PATHS, NAME_PAGE_HINTS };
