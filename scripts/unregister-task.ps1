#requires -Version 5
# 監視タスクの登録解除（データ・ログは残す）。
[CmdletBinding()]
param([string]$TaskName = 'SaiyoShinsotsuMonitor')
$ErrorActionPreference = 'Stop'
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "削除しました: $TaskName"
} else {
  Write-Host "タスクが見つかりません: $TaskName"
}
