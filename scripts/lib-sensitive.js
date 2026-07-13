'use strict';
/**
 * 機密データ/秘密情報の判定を一元化する共有モジュール。
 * pre-commit ガード (check-staged-security.js) と暗号化ボールト (encrypt-lists.js)
 * の両方から利用し、「何が機密か」の定義を .gitignore と一致させる。
 * 取り扱い規約: SECURITY.md
 */
const path = require('path');

// 機密ツリー配下だが非PIIかつ実行時に必要なため追跡を維持する例外(.gitignore の allowlist と一致)
const ALLOWLIST = new Set([
  'sources/manifest.json',
  'sources/SF-leads.sample.csv',
  'data/media-catalog.json',
  'secure/README.md',
]);

// 配下すべてを機密データとして扱うディレクトリ接頭辞
const SENSITIVE_DIRS = ['data/', 'sources/', 'archive/', 'eval/', 'secure/'];

function toPosix(p) {
  return String(p).split(path.sep).join('/').replace(/^\.\//, '');
}

// 秘密/認証情報ファイル(.env 実体・サービスアカウント鍵・各種秘密鍵)
function isSecretFile(rel) {
  const base = path.basename(toPosix(rel));
  if (base === '.env') return true;
  if (/^\.env\./.test(base) && base !== '.env.example') return true;
  if (/^service-account.*\.json$/i.test(base)) return true;
  if (/\.(pem|key|p12|pfx|keystore)$/i.test(base)) return true;
  return false;
}

// ルート直下の生成物(リードCSV・各種ログ・スクラッチ)
function isRootSensitive(rel) {
  const r = toPosix(rel);
  if (r.includes('/')) return false;
  return /\.csv$/i.test(r) || /\.log$/i.test(r) || r === 'scratch-sme.json';
}

/**
 * リポジトリ相対パスが「コミット・共有してはならない機密」か判定する。
 * 暗号化対象の選定にも使う(ただし allowlist と *.enc.json は除外)。
 */
function isSensitivePath(rel) {
  const r = toPosix(rel);
  if (ALLOWLIST.has(r)) return false;
  if (/\.enc\.json$/i.test(r)) return false; // 暗号文自体は平文機密ではない
  if (isSecretFile(r)) return true;
  for (const d of SENSITIVE_DIRS) if (r.startsWith(d)) return true;
  if (isRootSensitive(r)) return true;
  return false;
}

// 埋め込み秘密情報の検出パターン(誤検知が少ない不変な形式のみ)
const SECRET_PATTERNS = [
  { name: 'Google API key', re: /AIza[0-9A-Za-z_\-]{35}/ },
  { name: 'OpenAI/API key (sk-)', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: 'service-account private_key', re: /"private_key"\s*:\s*"-----BEGIN/ },
  { name: 'Slack token', re: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'Google OAuth client secret', re: /\bGOCSPX-[A-Za-z0-9_\-]{20,}\b/ },
];

// PII列ヘッダ語彙。1行に2種以上あればPIIデータの見出し行とみなす
const PII_TOKENS = ['採用担当者名', '氏名', '担当者名', '電話番号', 'メール', 'メールアドレス', '代表者名', '法人番号', '携帯'];

// データファイルらしい拡張子(コードに対するPII内容スキャンの誤検知を避けるため対象を限定)
function looksLikeDataFile(rel) {
  return /\.(csv|tsv|json|txt|log|ndjson)$/i.test(toPosix(rel));
}

function findPiiHeader(content) {
  const lines = String(content).split(/\r?\n/).slice(0, 50); // 見出しは先頭付近
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    // CSV/TSVの見出し行のみを対象化(散文の誤検知回避)。
    // カンマ/タブ区切りフィールドがPII語に完全一致するものを数える。
    const fields = lines[i]
      .split(/[,\t]/)
      .map((s) => s.trim().replace(/^["'﻿]+|["']+$/g, ''));
    const uniq = [...new Set(fields.filter((f) => PII_TOKENS.includes(f)))];
    if (uniq.length >= 2) hits.push({ lineNo: i + 1, tokens: uniq });
  }
  return hits;
}

function scanSecrets(content) {
  const out = [];
  for (const p of SECRET_PATTERNS) if (p.re.test(String(content))) out.push(p.name);
  return out;
}

module.exports = {
  ALLOWLIST,
  SENSITIVE_DIRS,
  toPosix,
  isSecretFile,
  isRootSensitive,
  isSensitivePath,
  looksLikeDataFile,
  findPiiHeader,
  scanSecrets,
  SECRET_PATTERNS,
  PII_TOKENS,
};
