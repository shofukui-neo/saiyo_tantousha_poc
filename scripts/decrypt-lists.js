'use strict';
/**
 * ボールト(secure/vault/)の暗号文を復号する。
 * 既定では secure/plain/ 配下に元の相対パス構造で書き出す(git-ignore・ローカル限定)。
 * --restore 指定時のみ元の場所(リポジトリ内の相対パス)へ復元する。
 *
 * 使い方:
 *   set LISTS_PASSPHRASE=...   (または LISTS_PASSPHRASE_FILE=<リポ外の鍵ファイル>)
 *   npm run decrypt:lists                 -> secure/plain/ へ
 *   npm run decrypt:lists -- --restore    -> 元の場所へ復元
 */
const fs = require('fs');
const path = require('path');
const { decryptPayload } = require('./lib-crypto');

const ROOT = path.resolve(__dirname, '..');
const VAULT = path.join(ROOT, 'secure', 'vault');
const PLAIN = path.join(ROOT, 'secure', 'plain');
const RESTORE = process.argv.includes('--restore');

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
    else if (e.isFile() && e.name.endsWith('.enc.json')) acc.push(full);
  }
  return acc;
}

function main() {
  const pass = getPassphrase();
  if (!pass) {
    console.error('LISTS_PASSPHRASE(または LISTS_PASSPHRASE_FILE)が必要です。');
    process.exit(2);
  }
  if (!fs.existsSync(VAULT)) {
    console.error('ボールトが見つかりません:', VAULT);
    process.exit(3);
  }
  const files = walk(VAULT, []);
  if (files.length === 0) {
    console.log('secure/vault/ に暗号化ファイルがありません。');
    return;
  }
  let n = 0;
  let failed = 0;
  for (const encPath of files) {
    const payload = JSON.parse(fs.readFileSync(encPath, 'utf8'));
    let out;
    try {
      out = decryptPayload(payload, pass);
    } catch (e) {
      failed++;
      console.error('✗ 復号失敗(パスフレーズ不一致/改ざんの可能性):', path.relative(VAULT, encPath));
      continue;
    }
    const rel = payload.relpath || path.relative(VAULT, encPath).replace(/\.enc\.json$/, '');
    const dest = RESTORE ? path.join(ROOT, rel) : path.join(PLAIN, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, out);
    n++;
  }
  console.log(`✅ ${n} 件を復号しました -> ${RESTORE ? '元の場所' : 'secure/plain/'}` + (failed ? `（失敗 ${failed} 件）` : ''));
  if (failed) process.exit(1);
}

main();
