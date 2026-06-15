#!/usr/bin/env bash
cd "$(dirname "$0")"
for i in $(seq 1 80); do
  node src/run-probe-recruit-page.js --limit 0 --concurrency 1 --out data/recruiter-gemini.csv --done data/recruitpage-gemini-done.json >> data/run-gemini.log 2>&1
  code=$?
  n=$(node -e 'try{console.log((require("./data/recruitpage-gemini-done.json").done||[]).length)}catch(e){console.log(0)}')
  echo "[loop] attempt $i exit=$code done=$n" >> data/run-gemini.log
  if [ $code -eq 0 ]; then echo "[loop] completed done=$n" >> data/run-gemini.log; break; fi
done
