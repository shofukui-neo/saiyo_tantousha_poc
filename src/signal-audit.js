'use strict';
/**
 * signal-audit — 収集のたびに「何を見て・何を採り・何を落としたか」を残す
 * =====================================================================
 * これまで harvest 系は不採用の内訳を**画面に出すだけ**だった。画面はスクロールで消える。
 * そのため「規則をいじったら取りこぼしが増えた」を後から検証できず、
 * 収集ロジックの改善が勘になっていた。判定を1行ずつ残せば、
 *   ・ソース別／シグナル別の採択率が時系列で見える
 *   ・不採用理由の偏り（例: not-company ばかり＝ソース選びが悪い）が分かる
 *   ・サンプリングして人が○×を付ければ、そのまま Precision の測定台になる
 *
 * 置き場所: data/hot-signals/audit/YYYY-MM.jsonl（月別・追記のみ）
 *   {ts, source, url, company, decision:'accept'|'reject', reason, signals:[key...]}
 *
 * CLI:
 *   node src/signal-audit.js show            # 直近30日の採択率とソース別内訳
 *   node src/signal-audit.js show --days 7
 *   node src/signal-audit.js sample --n 30   # 人手検証用に採択分を無作為抽出して表示
 */
const fs = require('fs');
const path = require('path');
const { getIntArg } = require('./cli-util');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'data', 'hot-signals', 'audit');

const monthFile = (d = new Date()) => path.join(DIR, `${d.toISOString().slice(0, 7)}.jsonl`);

/**
 * 判定を追記する。1件ずつ同期追記（途中終了でも残す。harvest と同じ流儀）。
 * @param {Array<{source:string,url?:string,company?:string,decision:string,reason?:string,signals?:string[]}>} rows
 */
function appendAudit(rows) {
  if (!rows || !rows.length) return 0;
  fs.mkdirSync(DIR, { recursive: true });
  const ts = new Date().toISOString();
  const file = monthFile();
  let n = 0;
  for (const r of rows) {
    fs.appendFileSync(file, JSON.stringify({ ts, ...r }) + '\n', 'utf8');
    n++;
  }
  return n;
}

/** 指定日数ぶんの監査行を読む（月ファイルをまたいで集める）。 */
function loadAudit(days = 30) {
  const since = Date.now() - days * 86400000;
  const out = [];
  if (!fs.existsSync(DIR)) return out;
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (new Date(j.ts).getTime() >= since) out.push(j);
      } catch (_) { /* 壊れた行は捨てる（追記中の切断） */ }
    }
  }
  return out;
}

/** ソース別の採択率・不採用理由・シグナル内訳を集計する。 */
function summarize(rows) {
  const bySource = new Map();
  const reasons = {};
  const signals = {};
  for (const r of rows) {
    const s = bySource.get(r.source || '(不明)') || { seen: 0, accept: 0 };
    s.seen++;
    if (r.decision === 'accept') { s.accept++; for (const k of (r.signals || [])) signals[k] = (signals[k] || 0) + 1; }
    else reasons[r.reason || '(理由なし)'] = (reasons[r.reason || '(理由なし)'] || 0) + 1;
    bySource.set(r.source || '(不明)', s);
  }
  return { bySource, reasons, signals, total: rows.length };
}

if (require.main === module) {
  const cmd = process.argv[2] || 'show';
  const days = getIntArg('days', 30);
  const rows = loadAudit(days);
  if (!rows.length) { console.log(`[signal-audit] 直近${days}日の監査ログはありません（${path.relative(ROOT, DIR)}）`); process.exit(0); }

  if (cmd === 'show') {
    const { bySource, reasons, signals, total } = summarize(rows);
    const acc = rows.filter((r) => r.decision === 'accept').length;
    console.log(`[signal-audit] 直近${days}日: 判定 ${total}件 / 採択 ${acc}件（採択率 ${(acc / total * 100).toFixed(1)}%）`);
    console.log('\n  ソース別');
    for (const [k, v] of [...bySource].sort((a, b) => b[1].seen - a[1].seen)) {
      console.log(`    ${String(v.accept).padStart(5)}/${String(v.seen).padEnd(6)} ${(v.accept / v.seen * 100).toFixed(1).padStart(5)}%  ${k}`);
    }
    console.log('\n  不採用理由');
    for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`    ${String(v).padStart(5)}  ${k}`);
    console.log('\n  採択されたシグナル');
    for (const [k, v] of Object.entries(signals).sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(5)}  ${k}`);
  } else if (cmd === 'sample') {
    // 人手で○×を付けるための無作為抽出。ここに○×を付けた結果が Precision の実測になる。
    const n = getIntArg('n', 30);
    const acc = rows.filter((r) => r.decision === 'accept');
    for (let i = acc.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [acc[i], acc[j]] = [acc[j], acc[i]]; }
    console.log(`[signal-audit] 採択 ${acc.length}件から ${Math.min(n, acc.length)}件を無作為抽出（○×を付けて Precision を測る）\n`);
    for (const r of acc.slice(0, n)) {
      console.log(`  [ ] ${r.company || '(社名なし)'}  «${(r.signals || []).join('+')}»  ${r.source}`);
      if (r.url) console.log(`       ${r.url}`);
    }
  } else {
    console.error(`不明なコマンド: ${cmd}（show | sample）`);
    process.exit(1);
  }
}

module.exports = { appendAudit, loadAudit, summarize, DIR };
