'use strict';
const { USER_AGENT, PER_PAGE_TIMEOUT_MS } = require('./config');

// robots.txt を origin 単位でキャッシュ
const cache = new Map();

async function getRobots(origin) {
  if (cache.has(origin)) return cache.get(origin);
  let txt = '';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PER_PAGE_TIMEOUT_MS);
    const res = await fetch(origin + '/robots.txt', {
      headers: { 'User-Agent': USER_AGENT }, signal: ctrl.signal, redirect: 'follow',
    });
    clearTimeout(t);
    if (res.ok) txt = await res.text();
  } catch (_) { /* 取得失敗時は許可扱い（一般的な慣習） */ }
  const parsed = parseRobots(txt);
  cache.set(origin, parsed);
  return parsed;
}

// User-agent ごとに Disallow / Allow を収集（簡易実装）
function parseRobots(txt) {
  const groups = []; // { agents:[], rules:[{type, path}] }
  let cur = null, lastWasAgent = false;
  for (let raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === 'disallow' || field === 'allow') {
      if (!cur) { cur = { agents: ['*'], rules: [] }; groups.push(cur); }
      cur.rules.push({ type: field, path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

// 指定パスが許可されているか（最長一致＋Allow優先の簡易ルール）
function isAllowed(groups, userAgent, urlPath) {
  if (!groups || groups.length === 0) return true;
  const ua = (userAgent || '*').toLowerCase();
  // 自分のUAにマッチするグループ、なければ * を使用
  let g = groups.find(grp => grp.agents.some(a => a !== '*' && ua.includes(a)));
  if (!g) g = groups.find(grp => grp.agents.includes('*'));
  if (!g) return true;

  let decision = true, matchLen = -1;
  for (const r of g.rules) {
    if (r.path === '') continue; // 空Disallowは「全許可」
    if (urlPath.startsWith(r.path) && r.path.length > matchLen) {
      matchLen = r.path.length;
      decision = (r.type === 'allow');
    }
  }
  return decision;
}

module.exports = { getRobots, isAllowed, parseRobots };
