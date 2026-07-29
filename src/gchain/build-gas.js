'use strict';
/**
 * G-Chain OS v1.5 — GASバンドラ（詳細設計書 §12）。
 * src/gchain/*.js（単一正本）を GChain.* 名前空間に畳み、orchestration.gs を付けて
 * apps-script/gchain-os.gs を生成する。CommonJS の require を軽量モジュールシステムに書換。
 *
 * 実行: node src/gchain/build-gas.js
 */
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const VENDOR_CSV = path.join(DIR, '..', 'csv.js');
const ORCH = path.join(DIR, 'gas', 'orchestration.gs');
const OUT = path.join(DIR, '..', '..', 'apps-script', 'gchain-os.gs');

// 依存順（先に定義するものが先）。key = GChain.<key>、reqPath = 元の require 文字列。
const REGISTRY = [
  { key: 'schema', file: 'schema.js', reqPath: './schema' },
  { key: 'config', file: 'config.js', reqPath: './config' },
  { key: 'normalize', file: 'normalize.js', reqPath: './normalize' },
  { key: 'canonical', file: 'canonical.js', reqPath: './canonical' },
  { key: 'eventEngine', file: 'event-engine.js', reqPath: './event-engine' },
  { key: 'kpi', file: 'kpi.js', reqPath: './kpi' },
  { key: 'sampling', file: 'sampling.js', reqPath: './sampling' },
  { key: 'scoring', file: 'scoring.js', reqPath: './scoring' },
  { key: 'experiment', file: 'experiment.js', reqPath: './experiment' },
  { key: 'llmContract', file: 'llm-contract.js', reqPath: './llm-contract' },
  { key: 'meta', file: 'meta.js', reqPath: './meta' },
];

// require 文字列 → 置換先グローバル参照
const REPLACE = { '../csv': 'GChainVendor.csv' };
REGISTRY.forEach((m) => { REPLACE[m.reqPath] = 'GChain.' + m.key; });

function rewriteRequires(src) {
  return src.replace(/require\(\s*['"]([^'"]+)['"]\s*\)/g, (whole, p) => {
    if (REPLACE[p]) return REPLACE[p];
    throw new Error(`未マップの require: ${p}（build-gas.js の REPLACE に追加せよ）`);
  });
}

function wrapModule(globalRef, src) {
  const body = rewriteRequires(src);
  return `${globalRef} = (function () {\n  var module = { exports: {} };\n${indent(body)}\n  return module.exports;\n})();\n`;
}

function indent(s) {
  return s.split('\n').map((l) => (l ? '  ' + l : l)).join('\n');
}

function build() {
  let out = '';
  out += `/* ============================================================================\n`;
  out += ` * G-Chain OS v1.5 — 自動生成バンドル（EDITしないこと）\n`;
  out += ` * 生成元: src/gchain/*.js + gas/orchestration.gs（単一正本）\n`;
  out += ` * 再生成: node src/gchain/build-gas.js\n`;
  out += ` * ========================================================================== */\n`;
  out += `var GChain = {};\nvar GChainVendor = {};\n\n`;

  // vendor: csv.js（依存なし・純関数）
  out += `/* --- vendor: csv.js --- */\n`;
  out += wrapModule('GChainVendor.csv', fs.readFileSync(VENDOR_CSV, 'utf8'));
  out += '\n';

  // gchain modules
  for (const m of REGISTRY) {
    out += `/* --- module: ${m.file} --- */\n`;
    out += wrapModule('GChain.' + m.key, fs.readFileSync(path.join(DIR, m.file), 'utf8'));
    out += '\n';
  }

  // orchestration（生GAS・requireなし）
  out += `/* --- orchestration --- */\n`;
  out += fs.readFileSync(ORCH, 'utf8');
  out += '\n';

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out, 'utf8');
  return { out, bytes: Buffer.byteLength(out) };
}

if (require.main === module) {
  const r = build();
  console.log(`bundled → ${path.relative(process.cwd(), OUT)} (${r.bytes} bytes, ${REGISTRY.length + 1} modules)`);
}

module.exports = { build, rewriteRequires, REGISTRY };
