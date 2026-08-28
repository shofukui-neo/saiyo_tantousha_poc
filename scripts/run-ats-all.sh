#!/usr/bin/env bash
# 全社ATSスイープを最後まで走らせる。
# undici(Node標準fetch)の既知アサーションは本体で握りつぶすが、それ以外の異常終了でも
# ジャーナル（data/ats-scan/journal.jsonl）から再開できるので、完了するまで再起動する。
cd "$(dirname "$0")/.."
LOG=${1:-data/ats-scan/run.log}
mkdir -p "$(dirname "$LOG")"
for i in $(seq 1 40); do
  node --max-old-space-size=4096 src/enrich-ats-all.js --conc 14 >> "$LOG" 2>&1
  code=$?
  n=$(wc -l < data/ats-scan/journal.jsonl 2>/dev/null || echo 0)
  echo "[loop] attempt $i exit=$code done=$n" >> "$LOG"
  if [ $code -eq 0 ]; then echo "[loop] completed done=$n" >> "$LOG"; break; fi
  sleep 3
done
