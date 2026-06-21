# 本番運用ラッパー: 監視を1サイクル実行し、ログ追記・履歴アーカイブ・ローテーションを行う。
# タスクスケジューラから powershell.exe -File でこのスクリプトを叩く（register-task.ps1 が -PocRoot 付きで設定）。
# 状態(熱量/スナップショット/クエリ)は data/monitor/ にディスク永続。1サイクル独立なので中断再開に強い。
[CmdletBinding()]
param([int]$Pages = 1, [int]$Top = 30, [string]$PocRoot = '')
$ErrorActionPreference = 'Stop'

# poc ルート解決: -PocRoot 明示 > 自スクリプトの親 > カレント（タスクのWorkingDir）。$PSScriptRoot に依存しない。
if (-not $PocRoot) {
  $self = $PSCommandPath
  if (-not $self) { $self = $MyInvocation.MyCommand.Path }
  if ($self) { $PocRoot = Split-Path -Parent (Split-Path -Parent $self) }
}
if (-not $PocRoot) { $PocRoot = (Get-Location).Path }
$poc = $PocRoot
if (-not (Test-Path (Join-Path $poc 'src\monitor\run.js'))) { throw "poc ルート解決失敗: $poc (src\monitor\run.js が無い)" }

$logDir = Join-Path $poc 'data\monitor\logs'
$hist   = Join-Path $poc 'data\monitor\history'
New-Item -ItemType Directory -Force -Path $logDir, $hist | Out-Null
$log = Join-Path $logDir 'monitor.log'

# UTF-8(BOMなし)で追記（PS5.1のOut-File -Append UTF8がBOMを撒くのを回避）
$enc = New-Object System.Text.UTF8Encoding($false)
function AppendLog([string]$text) { [System.IO.File]::AppendAllText($log, $text + [Environment]::NewLine, $enc) }

# ログローテーション（5MB超で1世代退避）
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) { Move-Item $log "$log.1" -Force }

$ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
AppendLog "==================== $ts  monitor --once (pages=$Pages top=$Top) ===================="

$code = 1
try {
  # node 絶対パス解決（タスクスケジューラのPATHは対話セッションと異なることがあるため自前で探す）
  $node = $env:NODE_EXE
  if (-not $node) { $c = Get-Command node -ErrorAction SilentlyContinue; if ($c) { $node = $c.Source } }
  if (-not $node) {
    foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe", "$env:APPDATA\npm\node.exe", "$env:ProgramW6432\nodejs\node.exe")) {
      if ($p -and (Test-Path $p)) { $node = $p; break }
    }
  }
  if (-not $node) { throw "node が見つかりません（PATH未設定）。環境変数 NODE_EXE に node.exe の絶対パスを設定してください。" }
  AppendLog "node: $node"

  # native exeのstderrをPS5.1で直接パイプするとNativeCommandError化するため、ファイル経由で取り込む
  $out = Join-Path $logDir '_stdout.tmp'
  $err = Join-Path $logDir '_stderr.tmp'
  $proc = Start-Process -FilePath $node `
    -ArgumentList @('src/monitor/run.js', '--once', '--pages', "$Pages", '--top', "$Top") `
    -WorkingDirectory $poc -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput $out -RedirectStandardError $err
  $code = $proc.ExitCode

  if (Test-Path $out) { AppendLog ([System.IO.File]::ReadAllText($out)); Remove-Item $out -Force }
  if ((Test-Path $err) -and ((Get-Item $err).Length -gt 0)) { AppendLog '[stderr]'; AppendLog ([System.IO.File]::ReadAllText($err)) }
  if (Test-Path $err) { Remove-Item $err -Force }

  # 「今アツい」ランキングを時系列レビュー用にアーカイブ（hottest.csv は毎サイクル上書きのため）
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $csv = Join-Path $poc 'data\monitor\hottest.csv'
  if (Test-Path $csv) { Copy-Item $csv (Join-Path $hist "hottest-$stamp.csv") -Force }

  # 30日より古いアーカイブ/スナップショットを掃除（ディスク肥大防止）
  $cutoff = (Get-Date).AddDays(-30)
  Get-ChildItem $hist -Filter 'hottest-*.csv' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt $cutoff } | Remove-Item -Force -ErrorAction SilentlyContinue
  $snapDir = Join-Path $poc 'data\monitor\snapshots'
  if (Test-Path $snapDir) { Get-ChildItem $snapDir -Filter '*.json' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt $cutoff } | Remove-Item -Force -ErrorAction SilentlyContinue }
}
catch {
  AppendLog "[ERROR] $($_.Exception.Message)"
  if ($_.ScriptStackTrace) { AppendLog $_.ScriptStackTrace }
  $code = 1
}

AppendLog "---- exit code: $code ----"
exit $code
