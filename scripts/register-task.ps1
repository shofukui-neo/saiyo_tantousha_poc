#requires -Version 5
# 監視を Windows タスクスケジューラに登録（既定: 6時間ごとに run-monitor.ps1 を --once 実行）。
#  - 管理者で実行 → S4U（ログオン有無に関わらず実行＝24/7・推奨）。
#  - 非管理者で実行 → Interactive（ユーザーログオン時のみ実行）にフォールバック。
#    ※Interactive タスクは、ユーザーが対話ログオン中の予定時刻に発火する。自動化/非対話セッションからの
#      手動 Start は Windows に拒否される（0x800710E0）ことがあるが、通常運用の発火は問題ない。
#    ※24/7（ログオフ中も）動かすには本スクリプトを管理者権限で実行し直すこと。
[CmdletBinding()]
param(
  [string]$TaskName = 'SaiyoShinsotsuMonitor',
  [int]$IntervalHours = 6,
  [datetime]$StartAt = (Get-Date).Date.AddHours((Get-Date).Hour + 1) # 次の正時から開始
)
$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $PSCommandPath }
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$wrapper = Join-Path $scriptDir 'run-monitor.ps1'
if (-not (Test-Path $wrapper)) { throw "ラッパーが見つかりません: $wrapper" }
$poc = Split-Path -Parent $scriptDir   # 絶対パスをタスクに焼き込み、$PSScriptRoot 非依存にする

# -PocRoot に絶対パスを明示。WorkingDirectory も poc に固定（二重の保険）。
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$wrapper`" -PocRoot `"$poc`"" `
  -WorkingDirectory $poc

$trigger = New-ScheduledTaskTrigger -Once -At $StartAt `
  -RepetitionInterval (New-TimeSpan -Hours $IntervalHours) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

# 耐障害設定: 取りこぼし回は復帰後に実行 / 重複は新規破棄 / 1hで強制終了 / バッテリーでも実行
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
  -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 5) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

# 管理者なら S4U（ログオン不要・24/7）、不可なら Interactive にフォールバック
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$mode = ''
try {
  if (-not $isAdmin) { throw 'not-admin' }
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType S4U -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description "新卒採用サイト 鮮度モニタリング（${IntervalHours}時間ごと, --once, ファイル&ログ）" -Force -ErrorAction Stop | Out-Null
  $mode = 'S4U（ログオン有無に関わらず実行＝24/7）'
} catch {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description "新卒採用サイト 鮮度モニタリング（${IntervalHours}時間ごと, --once, ファイル&ログ）" -Force | Out-Null
  $mode = 'Interactive（ユーザーログオン時のみ）※24/7化は管理者で再実行'
}

Write-Host "登録完了: $TaskName / ${IntervalHours}時間ごと / 開始 $StartAt"
Write-Host "実行モード: $mode"
Write-Host "確認: Get-ScheduledTask -TaskName $TaskName ｜ 手動: Start-ScheduledTask -TaskName $TaskName ｜ 解除: scripts\unregister-task.ps1"
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State | Format-Table -AutoSize
