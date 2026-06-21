'use strict';
// 出力層: 熱い順 top-N を Markdown（人が読む）と CSV（架電キュー・既存パイプライン合流）で書き出す。
// CSV は build-list.js の系統C（インテント/トリガー）として manifest に足せる列構成にしておく。
const fs = require('fs');
const path = require('path');
const { toCsv } = require('../csv');
const { DIR } = require('./store');

const EVENT_JA = {
  NEW: '🆕初出', REAPPEARED: '🔁復活', JOB_UP: '📈求人増', JOB_DOWN: '📉求人減',
  NEW_GRAD_YEAR: '🎓新卒年', NEW_QUERY: '🧭新領域', GONE: '— 消滅',
};

function heatBar(heat, max) {
  const n = max > 0 ? Math.round((heat / max) * 10) : 0;
  return '█'.repeat(n) + '░'.repeat(10 - n);
}

// 熱いランキングを Markdown + CSV で出力。
//   ranked: heat.rank() の出力 / cycle: ISO / stats: snapshot.stats
function writeReports(ranked, { cycle, stats, outDir = DIR, top = 30 } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const list = ranked.slice(0, top);
  const maxHeat = list.length ? list[0].heat : 0;

  // ---- Markdown ----
  const lines = [];
  lines.push(`# 🔥 今アツい新卒採用企業 ランキング`);
  lines.push('');
  lines.push(`- 集計時刻: ${cycle}`);
  if (stats && stats.perSource) {
    const src = Object.entries(stats.perSource).map(([s, v]) => `${s}(${v.companies}社/${v.cards}件)`).join(' ');
    lines.push(`- 観測ソース: ${src}`);
  }
  if (stats && stats.staleSources && stats.staleSources.length) {
    lines.push(`- ⚠️ セレクタ劣化の疑い: ${stats.staleSources.join(', ')}`);
  }
  lines.push('');
  lines.push('| # | 企業名 | 熱量 | 鮮度 | 直近の動き | 求人 | 卒年 |');
  lines.push('|---|--------|------|------|-----------|------|------|');
  list.forEach((s, i) => {
    const fresh = s.freshnessH < 1 ? '今' : `${Math.round(s.freshnessH)}h前`;
    const ev = (s.lastEvents || []).map((e) => EVENT_JA[e] || e).join(' ');
    lines.push(`| ${i + 1} | ${s.企業名} | ${s.heat.toFixed(1)} ${heatBar(s.heat, maxHeat)} | ${fresh} | ${ev} | ${s.totalJobs || ''} | ${(s.gradYears || []).join('/')} |`);
  });
  lines.push('');
  const md = lines.join('\n');
  fs.writeFileSync(path.join(outDir, 'hottest.md'), md);

  // ---- CSV（系統C: インテント/トリガー起点として合流可能） ----
  const headers = ['企業名', '法人番号', '熱量', '鮮度h', '直近イベント', '求人件数', '卒年',
    '出稿増', '採用ページ更新', 'インテント', '初検知', '最終更新', '取得日'];
  const records = list.map((s) => ({
    '企業名': s.企業名, '法人番号': '',
    '熱量': s.heat.toFixed(1), '鮮度h': Math.round(s.freshnessH),
    '直近イベント': (s.lastEvents || []).join('|'),
    '求人件数': s.totalJobs || '', '卒年': (s.gradYears || []).join('/'),
    '出稿増': (s.lastEvents || []).includes('JOB_UP') ? '○' : '',
    '採用ページ更新': (s.lastEvents || []).some((e) => ['NEW', 'REAPPEARED', 'NEW_GRAD_YEAR'].includes(e)) ? '○' : '',
    'インテント': '○',
    '初検知': s.firstSeen || '', '最終更新': s.lastEventTs || '',
    '取得日': (cycle || '').slice(0, 10),
  }));
  fs.writeFileSync(path.join(outDir, 'hottest.csv'), toCsv(headers, records));

  return { md, count: list.length, mdPath: path.join(outDir, 'hottest.md'), csvPath: path.join(outDir, 'hottest.csv') };
}

module.exports = { writeReports, EVENT_JA };
