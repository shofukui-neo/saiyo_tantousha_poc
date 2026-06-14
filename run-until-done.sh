#!/usr/bin/env bash
# undiciクラッシュで落ちても、完走するまで自動再起動（レジューム）
cd "$(dirname "$0")"
for i in $(seq 1 20); do
  node src/run-probe-recruit-page.js --limit 0 --concurrency 3 --out data/recruiter-recruitpage-full.csv --done data/recruitpage-done.json >> data/run-full.log 2>&1
  code=$?
  echo "[loop] attempt $i exited code=$code" >> data/run-full.log
  if [ $code -eq 0 ]; then echo "[loop] completed" >> data/run-full.log; break; fi
  sleep 2
done
