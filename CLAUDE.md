# このリポジトリで守ること

## 架電禁止リストは絶対（無条件削除）

`data/ng-companies.txt` に載っている企業は、**既存・新規を問わずあらゆる成果物に一切含めない**。
判定は `src/ng-guard.js` に集約してあり、出力の関所（`csv.js` の `toCsv`、`master-io.js` の
`writeMasterCsv`/`writeMasterSheet`、`monitor/report.js`、`dashboard.js`）が自動で落とす。
詳細 → [docs/ng-call-guard.md](docs/ng-call-guard.md)

新しくリストを出力するコードを書くときのルール:

1. **CSVは必ず `csv.js` の `toCsv()` を通す**。自前で `join(',')` して書かない
   （通さないとガードが効かず、禁止企業が成果物に混ざる）。
2. 社名の列名は `企業名` / `会社名` / `法人名` / `社名` / `company_name`、
   または `会社情報：会社名` のようにそれらで終わる名前にする（ガードの自動判定に乗せるため）。
3. Markdown等CSV以外で企業一覧を出す場合は、書き出し前に
   `require('./ng-guard').guardRecords(headers, records)` を通す。
4. `{ ngGuard: false }` と `NG_GUARD=off` は**禁止企業の一覧そのものを書く時だけ**。
   それ以外で使わない。
5. 納品前に `npm run ng:check` が **0本 / 0行** であることを確認する。

リストを更新したら: `npm run ng:sync -- "<新リスト.csv>"` → `npm run ng:sweep:apply` → `npm run deliver`
