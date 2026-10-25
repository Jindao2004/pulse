param()

$ErrorActionPreference = 'Stop'
$gameDir = Join-Path $env:APPDATA 'Pulse\game'
$helperPath = Join-Path $gameDir 'game-helper.ps1'
$resultPath = Join-Path $gameDir 'setup-result.json'
$taskName = 'Pulse Game Helper'
$result = [ordered]@{
  ok = $false
  taskName = $taskName
  helperPath = $helperPath
  error = $null
  ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

try {
  if (-not (Test-Path -LiteralPath $helperPath)) {
    throw "Game helper not found: $helperPath"
  }

  $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $argument = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $helperPath
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -StartWhenAvailable

  try {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  } catch {}

  Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'Pulse game acceleration helper' `
    -Force | Out-Null

  Start-ScheduledTask -TaskName $taskName
  $result.ok = $true
} catch {
  $result.error = $_.Exception.Message
}

$result | ConvertTo-Json -Compress | Set-Content -LiteralPath $resultPath -Encoding UTF8
if (-not $result.ok) { exit 1 }
