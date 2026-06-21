# 新卒鮮度モニタリング 運用Runbook（本番）

構成: Windows タスクスケジューラで **6時間ごと** に `--once` 実行。出力は**ファイル＆ログ**（通知連携なし）。
状態（熱量/スナップショット/クエリ）は `data/monitor/` にディスク永続 → 1サイクル独立で中断再開に強い。

## 1. 構成ファイル
| 役割 | パス |
|---|---|
| 実行ラッパー | `scripts/run-monitor.ps1`（1サイクル実行＋ログ追記＋履歴アーカイブ＋ローテーション＋掃除） |
| タスク登録 | `scripts/register-task.ps1`（既定6h。管理者ならS4U、非管理者はInteractiveに自動フォールバック） |
| タスク解除 | `scripts/unregister-task.ps1` |
| 監視本体 | `src/monitor/run.js`（観測→差分→熱量→出力＋自律クエリ） |

## 2. 出力
| 種別 | パス | 内容 |
|---|---|---|
| ランキング(人間用) | `data/monitor/hottest.md` | 今アツい企業 top-N（毎サイクル上書き） |
| ランキング(連携用) | `data/monitor/hottest.csv` | 系統C列構成（build-list合流可） |
| 時系列アーカイブ | `data/monitor/history/hottest-<ts>.csv` | 毎サイクルのtop-Nを保存（30日で自動掃除） |
| 実行ログ | `data/monitor/logs/monitor.log` | 各サイクルの観測/差分/TOP5/exit code（5MBでローテーション） |
| 生スナップショット | `data/monitor/snapshots/*.json` | 全観測の完全記録（30日で自動掃除） |

ログは UTF-8。PowerShellで読む際は `Get-Content ... -Encoding UTF8`（既定だと日本語が化ける）。

## 3. 運用コマンド
```powershell
# 状態確認
Get-ScheduledTask     -TaskName SaiyoShinsotsuMonitor | Select TaskName,State
Get-ScheduledTaskInfo -TaskName SaiyoShinsotsuMonitor | Select LastRunTime,LastTaskResult,NextRunTime
# 今すぐ1回（手動）
Start-ScheduledTask   -TaskName SaiyoShinsotsuMonitor
# 直近ログ / 今アツい企業
Get-Content .\data\monitor\logs\monitor.log -Encoding UTF8 -Tail 20
Get-Content .\data\monitor\hottest.md       -Encoding UTF8
# 頻度変更（例: 3時間ごとに再登録）
powershell -ExecutionPolicy Bypass -File .\scripts\register-task.ps1 -IntervalHours 3
# 解除
powershell -ExecutionPolicy Bypass -File .\scripts\unregister-task.ps1
```
ラッパー単体テスト: `powershell -ExecutionPolicy Bypass -File .\scripts\run-monitor.ps1 -PocRoot (Resolve-Path .).Path`

## 4. ⚠️ 実行モードと 24/7 化（重要）
タスクには2モードあり、登録時の権限で自動選択される:
- **Interactive（非管理者で登録）**: ユーザーが対話ログオン中の予定時刻にのみ発火。ログオフ中は動かない。
- **S4U（管理者で登録）**: ログオン有無に関わらず発火＝**24/7**。推奨。

**24/7運用にするには、`register-task.ps1` を「管理者として実行」した PowerShell で一度流し直す**:
```powershell
# 管理者PowerShellで
powershell -ExecutionPolicy Bypass -File .\scripts\register-task.ps1 -IntervalHours 6
# → 「実行モード: S4U」と表示されれば24/7化完了
```

## 5. トラブルシュート
| 症状 | 原因 | 対処 |
|---|---|---|
| LastTaskResult=0x800710E0「operator/administrator refused」 | ①バッテリー条件 ②Interactiveタスクを非対話セッションから手動起動 ③対話ログオンしていない | ①は対応済(AllowStartIfOnBatteries) ②自動化からの手動Startは拒否されるが予定発火は別 ③24/7化(§4)で解消 |
| LastTaskResult≠0 でログに `node が見つかりません` | タスクのPATHにnode無し | システム環境変数 `NODE_EXE` に `node.exe` の絶対パスを設定（例: `C:\Program Files\nodejs\node.exe`） |
| ログが文字化け | Get-Contentの既定エンコーディング | `-Encoding UTF8` を付ける（ファイル実体は正しいUTF-8） |
| 同一クエリで差分0が続く | キャッシュTTL>サイクル間隔 | 監視は既定30分TTL。`MONITOR_CACHE_TTL_MS` をサイクル間隔の半分以下に |
| 起動が `}` パースエラー | .ps1がBOM無しでPS5.1が日本語を誤読 | スクリプトはUTF-8 BOMで保存（本リポジトリは付与済） |

## 6. チューニング（環境変数）
| 変数 | 既定 | 意味 |
|---|---|---|
| `MONITOR_CACHE_TTL_MS` | 1800000(30分) | 監視の再取得間隔（real-time成立の鍵） |
| `MONITOR_MAX_QUERIES` | 12 | 1サイクルのアクティブクエリ上限（負荷） |
| `MONITOR_SEED_QUERIES` | 営業/エンジニア等×主要都市 | 初期クエリ（autonomyが自動増殖） |
| `MONITOR_SOURCES` | 全観測器 | 観測媒体を限定（カンマ区切り: 求人ボックス,リクナビ,キャリタス就活） |
| `MONITOR_HALF_LIFE_H` | 72 | 熱量の半減期（鮮度減衰） |
| `MONITOR_GONE_CONFIRM` | 2 | 連続不在を確定不在とみなすサイクル数（偽差分抑制） |
| `NODE_EXE` | (PATH探索) | node.exe絶対パス（タスクPATH対策） |

恒久設定は OS のシステム環境変数に登録（タスク実行時に反映）。

## 7. スプレッドシート自動保存（任意）
毎サイクルの「今アツい」top-N を Google スプレッドシートに**時系列で追記**する（`src/monitor/sheets-sink.js`）。
未設定なら自動スキップ（監視は通常稼働）。設定すると `run.js` が出力後に自動追記する。
**2方式あり、設定された方を使う（Webhookが優先）。**

新規作成済みシート: `新卒鮮度モニタリング（今アツい企業 自動記録）`
ID `140hKiSrrZsZQ8mfBP2776ee9YHlVNTqhRlhqYDHqGzY` / owner sho.fukui@neo-career.co.jp

### 方式A: GASウェブアプリ Webhook（推奨・サービスアカウント不要）
1. 上記シートを開く →「拡張機能」→「Apps Script」→ `apps-script/sheets-webhook.gs` の内容を貼り付け、`SECRET` を変更して保存。
2. 「デプロイ」→「新しいデプロイ」→ ウェブアプリ（実行=自分 / アクセス=全員 または 組織内）→ URL（…/exec）をコピー。
3. システム環境変数に設定: `MONITOR_SHEET_WEBHOOK`=そのURL / `MONITOR_SHEET_TOKEN`=手順1のSECRET。
4. 確認: `npm run monitor:sheets-check` → `接続OK` でテスト行が入る。

### 方式B: Sheets API（サービスアカウント）
**セットアップ（一度だけ）:**
1. GCP でサービスアカウントを作成し、JSONキーをダウンロード（例 `C:\keys\sa.json`）。Google Sheets API を有効化。
2. 保存先スプレッドシートを作成し、その**サービスアカウントのメール**（`xxx@xxx.iam.gserviceaccount.com`）に「**編集者**」で共有。
3. システム環境変数を設定（タスク実行時に反映されるよう**システム環境変数**へ）:
   - `GOOGLE_APPLICATION_CREDENTIALS` = JSONキーの絶対パス
   - `MONITOR_SHEET_ID` = スプレッドシートID（URL `/d/＜ここ＞/edit`）
   - `MONITOR_SHEET_TAB` = タブ名（任意, 既定「鮮度モニタリング」）
4. 接続確認: `npm run monitor:sheets-check`（設定の有無を表示し、OKならテスト行を1行追記）

列: `集計時刻 / 順位 / 企業名 / 熱量 / 鮮度日数 / 直近イベント / 求人件数 / 卒年 / 観測媒体`。
タブ・ヘッダは初回に自動作成。6時間ごと×top30 ≒ 1日120行が時系列で積まれる。

## 8. ヘルスチェック観点
- `LastTaskResult` が 0 か（≠0 ならログ末尾を確認）
- `monitor.log` に毎サイクル「観測: N社」が出ているか
- `history/` に6時間ごとの CSV が増えているか
- 観測社数が突然0 → セレクタ劣化の疑い（ログに「要セレクタ較正」）。媒体DOM変更を確認
