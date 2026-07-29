'use strict';
// Shared helpers for the phone-enrich skill.
// Self-locates the repo (needs src/csv.js + src/phone.js) so normalization stays
// in lockstep with the pipeline. Prefix-aware phone formatting (0120/0800 fix).
const fs = require('fs');
const path = require('path');

function findRepoRoot() {
  const starts = [process.cwd(), __dirname];
  for (const s of starts) {
    let d = s;
    for (let i = 0; i < 10; i++) {
      if (fs.existsSync(path.join(d, 'src', 'phone.js')) && fs.existsSync(path.join(d, 'src', 'csv.js'))) return d;
      const p = path.dirname(d); if (p === d) break; d = p;
    }
  }
  throw new Error('repo root not found (need src/csv.js + src/phone.js). Run from inside the pipeline repo.');
}
const REPO = findRepoRoot();
const { normCompanyName } = require(path.join(REPO, 'src', 'csv'));
const { normalizeJpPhone } = require(path.join(REPO, 'src', 'phone'));

// --- RFC4180-ish parser (handles quotes, embedded commas/newlines) ---
function parseCSV(txt) {
  const rows = []; let f = '', row = [], q = false; txt = String(txt).replace(/^﻿/, '');
  for (let i = 0; i < txt.length; i++) { const c = txt[i];
    if (q) { if (c === '"') { if (txt[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else { if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; } else if (c === '\r') {} else f += c; } }
  if (f.length || row.length) { row.push(f); rows.push(row); } return rows;
}
const esc = (v) => { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function writeCSV(file, headerArr, rows) { // rows = array of arrays
  const lines = [headerArr.map(esc).join(',')].concat(rows.map(r => r.map(esc).join(',')));
  fs.writeFileSync(file, '﻿' + lines.join('\r\n'), 'utf8');
}
const readFile = (p) => fs.readFileSync(p, 'utf8');

// --- header detection ---
function findCol(header, exact, contains) {
  let i = header.findIndex(h => (exact || []).some(k => h === k));
  if (i < 0 && contains) i = header.findIndex(h => contains.some(k => h.includes(k)));
  return i;
}

// --- prefix-aware JP phone formatter (0120/0800 must not be split as mobile) ---
function fmtPhone(p) {
  const raw = String(p || '').trim(); if (!raw) return '';
  const d = raw.replace(/\D/g, '');
  if (d.length < 10 || d.length > 11 || !/^0/.test(d)) return '';
  if (/^0120/.test(d) && d.length === 10) return d.replace(/^(0120)(\d{3})(\d{3})$/, '$1-$2-$3');
  if (/^0800/.test(d) && d.length === 11) return d.replace(/^(0800)(\d{3})(\d{4})$/, '$1-$2-$3');
  if (/^0(70|80|90)/.test(d) && d.length === 11) return d.replace(/^(0\d0)(\d{4})(\d{4})$/, '$1-$2-$3');
  if (/^050/.test(d) && d.length === 11) return d.replace(/^(050)(\d{4})(\d{4})$/, '$1-$2-$3');
  const n = normalizeJpPhone(raw);
  if (n && n.replace(/\D/g, '') === d) return n;
  return raw;
}
function phoneType(fp) {
  const d = String(fp || '').replace(/\D/g, ''); if (!d) return '';
  if (/^0120|^0800/.test(d)) return 'フリーダイヤル';
  if (/^0(70|80|90)/.test(d)) return '携帯';
  if (/^050/.test(d)) return 'IP電話';
  return '固定電話';
}
function goodPhone(p) { return fmtPhone(p); } // alias: valid+formatted or ''

// --- pull {name,phone,confidence,source,note}[] out of a workflow journal.jsonl ---
function extractResultsFromJournal(journalPath) {
  const out = [];
  for (const line of readFile(journalPath).split('\n')) {
    if (!line.trim()) continue; let o; try { o = JSON.parse(line); } catch (_) { continue; }
    if (o.type === 'result' && o.result && Array.isArray(o.result.results)) out.push(...o.result.results);
  }
  return out;
}

module.exports = { REPO, normCompanyName, normalizeJpPhone, parseCSV, esc, writeCSV, readFile, findCol, fmtPhone, phoneType, goodPhone, extractResultsFromJournal };
