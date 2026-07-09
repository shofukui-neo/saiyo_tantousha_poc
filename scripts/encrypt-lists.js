'use strict';
/**
 * 機密データの保存時暗号化(ボールト作成)。
 * リポジトリ内の全機密ファイル(企業リスト/個人情報)を lib-sensitive の判定で自動選定し、
 * AES-256-GCM + scrypt で secure/vault/ 配下に暗号化して書き出す。
 *   平文はローカルのみ・暗号文も既定でコミットしない(.gitignore 済み)。
 *
 * 使い方:
 *   set LISTS_PASSPHRASE=... (または LISTS_PASSPHRASE_FILE=<リポ外の鍵ファイル>)
 *   npm run encrypt:lists
 *   npm run encrypt:lists -- --dry   (対象一覧のみ表示)
 */
const fs = require('fs');
const path = require('path');
const lib = require('./lib-sensitive');
const { encryptBuffer } = require('./lib-crypto');

const ROOT = path.resolve(__dirname, '..');
const VAULT = path.join(ROOT, 'secure', 'vault');
const SCAN_DIRS = ['data', 'sources', 'archive', 'eval'];
const DRY = process.argv.includes('--dry') || process.argv.includes('--dry-run');

function getPassphrase() {
  const file = process.env.LISTS_PASSPHRASE_FILE;
  if (file && fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  return process.env.LISTS_PASSPHRASE || '';
}

function walk(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.isFile()) acc.push(full);
  }
  return acc;
}

function collectTargets() {
  const files = [];
  for (const d of SCAN_DIRS) walk(path.join(ROOT, d), files);
  // ルート直下の機密生成物(*.csv / *.log / scratch-sme.json)
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (e.isFile()) files.push(path.join(ROOT, e.name));
  }
  const seen = new Set();
  const targets = [];
  for (const full of files) {
    const rel = lib.toPosix(path.relative(ROOT, full));
    if (rel.startsWith('secure/') || rel.startsWith('.git/') || rel.startsWith('node_modules/')) continue;
    if (!lib.isSensitivePath(rel)) continue; // allowlist・*.enc.json は自動除外
    if (seen.has(rel)) continue;
    seen.add(rel);
    targets.push(rel);
  }
  return targets.sort();
}

function main() {
  const pass = getPassphrase();
  if (!pass) {
    console.error('LISTS_PASSPHRASE(または LISTS_PASSPHRASE_FILE)が必要です。');
    process.exit(2);
  }
  const targets = collectTargets();
  if (targets.length === 0) {
    console.log('暗号化対象の機密ファイルは見つかりませんでした。');
    return;
  }
  if (DRY) {
    console.log(`[dry-run] 暗号化対象 ${targets.length} 件:`);
    targets.forEach((r) => console.log('  -', r));
    return;
  }
  let n = 0;
  for (const rel of targets) {
    const buf = fs.readFileSync(path.join(ROOT, rel));
    const payload = encryptBuffer(buf, pass, rel);
    const outPath = path.join(VAULT, rel + '.enc.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(payload));
    n++;
  }
  console.log(`✅ ${n} 件を暗号化し secure/vault/ に保存しました(AES-256-GCM / scrypt)。`);
  console.log('   平文・暗号文とも .gitignore 済み。鍵(パスフレーズ)はリポジトリに保存しないでください。');
}

main();
