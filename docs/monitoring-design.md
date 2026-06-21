# 新卒採用サイト リアルタイム鮮度モニタリング設計

## 1. 何を解くか
既存PoCは「リストを作る」バッチ。本レイヤは **時間軸** を足す。
- 全新卒採用サイトを継続クロールし、**前回スナップショットとの差分（delta）** を取る。
- 差分を **熱量(heat)** に変換し、時間減衰させて「**今アツい＝鮮度の良い企業**」を常時ランキング。
- 「OpenClaw的な完全自律」= クロール対象（クエリ）を自分で広げ／枯れたら畳み、
  セレクタ劣化を自己検知して（任意でGeminiで）再導出する **autonomy ループ**。

設計思想は既存と同じ：**全取得は `polite.js` 経由**（robots遵守・ホスト別レート制限・ディスクキャッシュ）。
新規の外部依存は足さない。APIキー無しで動き、`GEMINI_KEY` があれば自己修復が点火する。

## 2. アーキテクチャ（5層 + 自律ブレイン）
```
                ┌─────────────────────────────────────────────┐
   autonomy.js  │ 自律ブレイン: クエリ自己増殖／枯渇撤退／セレクタ自己修復 │
                └───────────────┬─────────────────────────────┘
                                ▼ (今サイクルで叩くクエリ集合)
  ① capture   snapshot.js  ── 求人ボックス等を polite に巡回 → 社×ソース×求人数×職種×卒年
  ② store     store.js     ── スナップショットを追記保存 + 前回を読む（差分の土台）
  ③ diff      diff.js      ── 前回↔今回 を社単位で比較 → イベント列（NEW/求人増/新卒年追加…）
  ④ heat      heat.js      ── イベント×重み×ICP適合 を加点、半減期で減衰 → 熱量状態を永続
  ⑤ report    report.js    ── 熱い順 top-N を Markdown + CSV で出力（架電キューに直結）
                                run.js が ①→⑤ を1サイクルとして回す（--once / --watch）
```

## 3. データモデル
### スナップショット（1サイクル）`data/monitor/snapshots/<ts>.json`
```jsonc
{ "cycle": "2026-06-18T02:00:00.000Z",
  "companies": {
    "<正規化社名>": {
      "企業名": "…", "totalJobs": 4, "gradYears": ["2027"],
      "sources": { "求人ボックス": { "jobCount": 4, "jobs": ["新卒 営業"], "queries": ["新卒 営業 東京"] } }
    }
  } }
```
### イベント（差分）
`NEW`(初出) / `REAPPEARED`(復活) / `JOB_UP`(求人増) / `JOB_DOWN`(減) /
`NEW_GRAD_YEAR`(新しい卒年=次年度設計に着手) / `NEW_QUERY`(新しい職種・エリアに露出) / `GONE`(消滅)
### 熱量状態 `data/monitor/heat-state.json`
```jsonc
{ "<正規化社名>": { "企業名":"…", "heat": 12.4, "lastEventTs":"…",
    "firstSeen":"…", "history":[{ "ts":"…","event":"JOB_UP","delta":2,"points":3.1 }] } }
```

## 4. 熱量モデル（鮮度の数式）
1サイクル毎に：
1. **減衰**：`heat *= 0.5 ^ (経過時間h / HALF_LIFE_H)`（既定 半減期72h）。動きが止まれば自然に冷める。
2. **加点**：`heat += Σ eventWeight(event, delta) × icpFactor`
   - 重み: `NEW=10, NEW_GRAD_YEAR=8, REAPPEARED=5, JOB_UP=3·log2(1+Δ), NEW_QUERY=2, JOB_DOWN=-1`
   - `icpFactor`: 卒年が来期/再来期＝×1.3、ICP職種一致＝×1.2 等（emp数は発見段階で不明なので軽め）
3. **鮮度(freshness)**：直近イベントからの経過hが短いほど高い → ランキングの同点処理に使用。

「今アツい」= 現在heat降順。`GONE` は加点せず減衰に任せる（自然消滅）。

## 5. 自律ブレイン（autonomy.js）
- **クエリ自己増殖**：あるクエリが NEW/熱を多産 → 近接クエリ（同職種×別エリア、同エリア×別職種）を自動追加。
- **枯渇撤退**：K サイクル連続で新規ゼロのクエリは休止（`data/monitor/queries.json` に状態保持）。
- **セレクタ自己修復**：あるソースが全クエリで0件＝DOM変更の疑い → `selector-stale` を立ててログ警告。
  `GEMINI_KEY` があればキャッシュHTMLを渡してセレクタ再導出を試みる（`gemini.js` 利用、任意）。
- 予算（クエリ上限・ページ上限）と礼儀（`polite` のレート制限）を超えない範囲で自走。

## 6. 実行
```bash
node src/monitor/run.js --once                 # 1サイクルだけ（cron/タスクスケジューラ向き）
node src/monitor/run.js --watch --interval 60  # 60分毎に常時監視（フォアグラウンド常駐）
npm run monitor                                 # = --once
npm run monitor:watch                           # = --watch --interval 60
```
常時稼働は ①OSのタスクスケジューラ/cron で `--once` を定期起動（推奨・耐障害）か、
②`--watch` 常駐 か、③Claude Code の `/loop` / scheduled agent。状態はすべてディスク永続なので
どの方式でも中断・再開して継続できる。

## 7. 拡張ポイント
- ソース追加：`snapshot.js` の `CAPTURERS` に adapter を足すだけ（リクナビ/マイナビ/ワンキャリア/Wantedly）。
  媒体直叩きは Playwright 経路（`scrape-base.js`）に寄せる。求人ボックスは静的で実証済のため既定ON。
- 既存パイプラインへの接続：熱い社の `企業名/法人番号` を `sources/` のトリガー系統C CSVとして書き出し、
  `build-list.js` の名寄せに合流（採用ページ更新・出稿増を系統Cシグナルとして優先度上書き）。
- 通知：`report.js` の出力を Slack/メールに流すフック（既定はCSV+Markdownのみ）。
```
```
