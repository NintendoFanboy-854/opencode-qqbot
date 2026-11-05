# QQBot 安全重启（2026-11-05 事故立规：禁止在回合进行中 kill bot）
# 根因：审批请求生命周期绑在 bot 进程 promptAndWait 连接上，kill 进程即杀死
# 进行中的审批（用户裁决 404 → "审批等待超时"）。部署只换文件，重启必须等空闲。
#
# 用法：
#   powershell -File scripts/safe-restart.ps1           # 等到空闲再重启（默认最长等 60 分钟）
#   powershell -File scripts/safe-restart.ps1 -Force    # 跳过等待立即重启（仅维护窗口授权后）
#   powershell -File scripts/safe-restart.ps1 -CheckOnly # 只报告空闲状态，不重启
param(
  [switch]$Force,
  [switch]$CheckOnly,
  [int]$TimeoutMinutes = 60,
  [int]$PollSeconds = 10
)
$ErrorActionPreference = "Stop"
$home_ = $env:USERPROFILE
$journal = Join-Path $home_ ".openqq\inflight.json"
$heartbeat = Join-path $home_ ".openqq\heartbeat"
$bun = "C:\Users\linjz\AppData\Roaming\npm\node_modules\bun\bin\bun.exe"
$entry = Join-Path $home_ ".config\opencode\plugins\opencode-qqbot\dist\openqq-bot.js"
$logFile = Join-Path $home_ ".openqq\bot.out.log"

function Test-BotIdle {
  # 空闲判定：台账无"已进会话"的在途账（running/background/dispatched 都算活跃回合）；
  # 纯 claimed/queued（排队中未派发）不算——杀进程它们可由启动对账无损恢复。
  try {
    if (-not (Test-Path $journal)) { return $true }
    $j = Get-Content $journal -Raw | ConvertFrom-Json
    $active = @($j | Where-Object { $_.state -eq "inflight" -and $_.sessionId })
    return ($active.Count -eq 0)
  } catch {
    Write-Output "[safe-restart] 台账读取失败（$($_.Exception.Message)），按不空闲处理"
    return $false
  }
}

function Get-ActiveSummary {
  try {
    $j = Get-Content $journal -Raw | ConvertFrom-Json
    $active = @($j | Where-Object { $_.state -eq "inflight" -and $_.sessionId })
    if ($active.Count -eq 0) { return "无活跃回合" }
    return (($active | ForEach-Object { "$($_.stage):$($_.text.Substring(0, [Math]::Min(20, $_.text.Length)))…" }) -join " | ")
  } catch { return "台账不可读" }
}

if ($CheckOnly) {
  $idle = Test-BotIdle
  Write-Output "[safe-restart] 空闲=$idle；$(Get-ActiveSummary)"
  exit $(if ($idle) { 0 } else { 1 })
}

$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
if (-not $Force) {
  Write-Output "[safe-restart] 等待 bot 空闲（最长 $TimeoutMinutes 分钟，每 ${PollSeconds}s 轮询）…"
  while (-not (Test-BotIdle)) {
    if ((Get-Date) -ge $deadline) {
      Write-Output "[safe-restart] 超时仍未空闲：$(Get-ActiveSummary)。本次不重启——请稍后重试或显式 -Force（需授权）。"
      exit 2
    }
    Write-Output "[safe-restart] 活跃中：$(Get-ActiveSummary)；${PollSeconds}s 后再查"
    Start-Sleep -Seconds $PollSeconds
  }
  Write-Output "[safe-restart] 已空闲，执行重启"
} else {
  Write-Output "[safe-restart] -Force：跳过空闲等待（确认已授权维护窗口）"
}

# —— 单实例重启（先杀全部匹配进程，再拉新）——
$procs = Get-CimInstance Win32_Process -Filter "Name='bun.exe'" |
  Where-Object { $_.CommandLine -match 'opencode-qq-?bot' }
Write-Output ("[safe-restart] 停止实例：" + (($procs | ForEach-Object { $_.ProcessId }) -join ","))
$procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
$env:QQ_LOG_FILE = $logFile
$p = Start-Process -FilePath $bun -ArgumentList "run", $entry -WindowStyle Hidden -PassThru
Write-Output "[safe-restart] 已启动 pid=$($p.Id)（日志 $logFile）"
