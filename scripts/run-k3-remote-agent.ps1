param(
  [string]$ConfigFile = (Join-Path $PSScriptRoot '../k3-agent.json'),
  [string]$NodeExe = (Join-Path $env:ProgramFiles 'nodejs/node.exe'),
  # The serial print budget is 90s; two minutes gives a slow physical page room
  # to finish before the supervisor reports a stall.
  [ValidateRange(30, 1800)][int]$ProgressStaleSeconds = 150
)

$ErrorActionPreference = 'Stop'
$configPath = (Resolve-Path -LiteralPath $ConfigFile).Path
$root = Split-Path -Parent $configPath
$agentScript = Join-Path $root 'scripts/k3-remote-agent.cjs'
$nodePath = (Resolve-Path -LiteralPath $NodeExe).Path
$outputLog = Join-Path $root 'k3-receiver.log'
$errorLog = Join-Path $root 'k3-receiver-error.log'
$heartbeatFile = Join-Path $root 'k3-heartbeat.json'
$supervisorLog = Join-Path $root 'k3-supervisor.log'

function Write-SupervisorLog([string]$message) {
  Add-Content -LiteralPath $supervisorLog -Value ((Get-Date).ToString('o') + ' ' + $message) -Encoding UTF8
}

function Read-HeartbeatAge {
  if (-not (Test-Path -LiteralPath $heartbeatFile)) { return $null }
  try {
    $beat = Get-Content -LiteralPath $heartbeatFile -Raw | ConvertFrom-Json
    return ((Get-Date) - [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$beat.at).LocalDateTime).TotalSeconds
  } catch { return $null }
}

if (-not (Test-Path -LiteralPath $agentScript -PathType Leaf)) { throw 'K3 label receiver is missing.' }
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw 'K3 label configuration is missing.' }

try {
  $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss-fff')
  foreach ($log in @($outputLog, $errorLog)) {
    if (Test-Path -LiteralPath $log) { Move-Item -LiteralPath $log -Destination ($log + '.' + $stamp) }
  }

  Write-SupervisorLog 'starting K3 label receiver'
  $child = Start-Process -FilePath $nodePath `
    -ArgumentList @(('"{0}"' -f $agentScript), ('"{0}"' -f $configPath)) `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $outputLog -RedirectStandardError $errorLog
  $null = $child.Handle
  $started = Get-Date
  Write-SupervisorLog ('receiver pid ' + $child.Id)

  while (-not $child.HasExited) {
    Start-Sleep -Seconds 5
    $child.Refresh()
    if ($child.HasExited) { break }
    $age = Read-HeartbeatAge
    if ($null -eq $age -and ((Get-Date) - $started).TotalSeconds -gt 30) {
      Write-SupervisorLog 'receiver has written no heartbeat for 30s; exiting so the scheduler can restart it'
      break
    }
    if ($null -ne $age -and $age -gt $ProgressStaleSeconds) {
      Write-SupervisorLog ('receiver heartbeat is ' + [Math]::Round($age, 1) + 's old; exiting')
      break
    }
  }

  if (-not $child.HasExited) {
    # Only stop the process this launcher started. A second receiver must never
    # be killed from here; the named-pipe lock already prevents double starts.
    try { Stop-Process -Id $child.Id -Force -ErrorAction Stop } catch { }
    $child.WaitForExit()
    Write-SupervisorLog 'receiver did not exit after a stall; launcher ended it'
    exit 3
  }
  Write-SupervisorLog ('receiver exited: ' + $child.ExitCode)
  exit $child.ExitCode
} catch {
  Write-SupervisorLog ('launcher failed: ' + $_.Exception.Message)
  exit 1
}
