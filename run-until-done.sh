#!/usr/bin/env bash
cd "$(dirname "$0")"
for i in $(seq 1 60); do
  node src/run-probe-recruit-page.js --limit 0 --concurrency 1 --out data/recruiter-recruitpage-full.csv --done data/recruitpage-done.json >> data/run-clean.log 2>&1
  code=$?
  n=$(node -e 'try{console.log((require("./data/recruitpage-done.json").done||[]).length)}catch(e){console.log(0)}')
  echo "[loop] attempt $i exit=$code done=$n" >> data/run-clean.log
  if [ $code -eq 0 ]; then echo "[loop] completed done=$n" >> data/run-clean.log; break; fi
done
