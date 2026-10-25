param()

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$lhmDir = Join-Path $scriptDir 'lhm'
$outputPath = Join-Path $scriptDir 'sensors.json'
$errorPath = Join-Path $scriptDir 'sensor-error.txt'
$logPath = Join-Path $scriptDir 'sensor-helper.log'

function Write-Log([string]$message) {
  try {
    $line = '{0:o} {1}' -f (Get-Date), $message
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  } catch {}
}

try {
  $mutex = New-Object System.Threading.Mutex($false, 'Global\PulseSensorHelper')
  if (-not $mutex.WaitOne(0)) { exit 0 }

  Set-Location $lhmDir
  Add-Type -Path (Join-Path $lhmDir 'LibreHardwareMonitorLib.dll')

  $computer = New-Object LibreHardwareMonitor.Hardware.Computer
  $computer.IsCpuEnabled = $true
  $computer.IsGpuEnabled = $true
  $computer.IsMotherboardEnabled = $true
  $computer.IsControllerEnabled = $true
  $computer.IsMemoryEnabled = $false
  $computer.IsStorageEnabled = $false
  $computer.IsNetworkEnabled = $false
  $computer.Open()

  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
  )

  $script:sensors = @()

  function Collect-Hardware($hardware) {
    $hardware.Update()
    foreach ($sensor in $hardware.Sensors) {
      if ($sensor.SensorType -notin @('Fan', 'Temperature', 'Clock', 'Power')) { continue }
      $value = $sensor.Value
      if ($null -ne $value -and -not [double]::IsNaN($value) -and -not [double]::IsInfinity($value)) {
        $script:sensors += [pscustomobject]@{
          id = $sensor.Identifier.ToString()
          hardware = $hardware.Name
          hardwareType = [string]$hardware.HardwareType
          type = [string]$sensor.SensorType
          name = $sensor.Name
          value = [math]::Round([double]$value, 3)
        }
      }
    }
    foreach ($sub in $hardware.SubHardware) {
      Collect-Hardware $sub
    }
  }

  while ($true) {
    try {
      $script:sensors = @()
      foreach ($hardware in $computer.Hardware) {
        Collect-Hardware $hardware
      }

      $payload = [pscustomobject]@{
        ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        admin = $admin
        sensors = $script:sensors
      }
      $json = $payload | ConvertTo-Json -Depth 5 -Compress
      $tempPath = $outputPath + '.tmp'
      [System.IO.File]::WriteAllText($tempPath, $json, (New-Object System.Text.UTF8Encoding($false)))
      Move-Item -LiteralPath $tempPath -Destination $outputPath -Force
      if (Test-Path -LiteralPath $errorPath) { Remove-Item -LiteralPath $errorPath -Force }
    } catch {
      $message = '{0:o} {1}' -f (Get-Date), $_.Exception.ToString()
      try { [System.IO.File]::WriteAllText($errorPath, $message, (New-Object System.Text.UTF8Encoding($false))) } catch {}
      Write-Log $message
    }
    Start-Sleep -Milliseconds 1000
  }
} catch {
  $message = '{0:o} {1}' -f (Get-Date), $_.Exception.ToString()
  try { [System.IO.File]::WriteAllText($errorPath, $message, (New-Object System.Text.UTF8Encoding($false))) } catch {}
  Write-Log $message
  exit 1
}
