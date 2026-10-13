param(
  [Parameter(Mandatory = $true)][string]$ConfigFile,
  [string]$NodeExe = (Join-Path $env:ProgramFiles 'nodejs/node.exe'),
  # The receiver's event-loop timer beats every 2s; its main loop finishes a round
  # within about 150s even when a 90-second native print times out. Both limits
  # leave wide margins so a slow print is never mistaken for a hang.
  [ValidateRange(5, 3600)][int]$LoopStaleSeconds = 90,
  [ValidateRange(5, 3600)][int]$ProgressStaleSeconds = 300
)

$ErrorActionPreference = 'Stop'
$configPath = (Resolve-Path -LiteralPath $ConfigFile).Path
$receiverRoot = Split-Path -Parent $configPath
$agentScript = Join-Path $receiverRoot 'scripts/remote-print-agent.cjs'
$watchdogScript = Join-Path $receiverRoot 'scripts/remote-print-watchdog.cjs'
$nodePath = (Resolve-Path -LiteralPath $NodeExe).Path
if (-not (Test-Path -LiteralPath $agentScript -PathType Leaf)) { throw 'Remote print agent is missing.' }

$supervisorLog = Join-Path $receiverRoot 'supervisor.log'
$outputLog = Join-Path $receiverRoot 'receiver.log'
$errorLog = Join-Path $receiverRoot 'receiver-error.log'
$heartbeatFile = Join-Path $receiverRoot 'receiver-heartbeat.json'
$restartFile = Join-Path $receiverRoot 'receiver-restarts.json'
$attentionFile = Join-Path $receiverRoot 'receiver-needs-attention.txt'
$stallFile = Join-Path $receiverRoot 'receiver-stall.json'

$restartBudget = 3
$restartWindowMinutes = 30

function Write-SupervisorLog([string]$message) {
  Add-Content -LiteralPath $supervisorLog -Value ((Get-Date).ToString('o') + ' ' + $message) -Encoding UTF8
}

function Read-RecentRestarts {
  $entries = @()
  if (Test-Path -LiteralPath $restartFile) {
    try { $entries = @(Get-Content -LiteralPath $restartFile -Raw | ConvertFrom-Json) } catch { $entries = @() }
  }
  $cutoff = (Get-Date).AddMinutes(-$restartWindowMinutes)
  @($entries | Where-Object { $_ -and $_.at } | Where-Object {
    try { [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$_.at).LocalDateTime -gt $cutoff } catch { $false }
  })
}

function Add-Restart([int]$receiverId, [double]$ageSeconds) {
  $entries = Read-RecentRestarts
  $entries += [pscustomobject]@{
    at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    pid = $receiverId
    ageSeconds = [Math]::Round($ageSeconds, 1)
  }
  Set-Content -LiteralPath $restartFile -Value (ConvertTo-Json -InputObject @($entries) -Compress) -Encoding UTF8
  return @($entries).Count
}

function Get-HeartbeatAge {
  if (-not (Test-Path -LiteralPath $heartbeatFile)) { return $null }
  try {
    $beat = Get-Content -LiteralPath $heartbeatFile -Raw | ConvertFrom-Json
    return ((Get-Date) - [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$beat.at).LocalDateTime).TotalSeconds
  } catch { return $null }
}

# Wait for an adopted receiver. It was NOT started by this launcher, so killing
# it would be overreach: log what we see and let its own lifecycle finish.
function Wait-AdoptedReceiver($Process) {
  $watchStart = Get-Date
  while (-not $Process.HasExited) {
    Start-Sleep -Seconds 5
    $Process.Refresh()
    if ($Process.HasExited) { break }
    $beat = Get-HeartbeatAge
    if ($null -eq $beat) {
      if (((Get-Date) - $watchStart).TotalSeconds -gt $loopStaleSeconds) {
        Write-SupervisorLog ('adopted receiver ' + $Process.Id + ' wrote no heartbeat; leaving it to the scheduler')
      }
    } elseif ($beat -gt $loopStaleSeconds) {
      Write-SupervisorLog ('adopted receiver ' + $Process.Id + ' heartbeat stalled (' + [Math]::Round($beat, 1) + 's); not killing a process this launcher does not own')
    }
  }
  return $Process.ExitCode
}

try {
  # Stop thrashing before starting anything: repeated watchdog kills mean the
  # fault is not transient, so a person has to look at the machine.
  $recent = Read-RecentRestarts
  if ($recent.Count -ge $restartBudget) {
    if (-not (Test-Path -LiteralPath $attentionFile)) {
      Set-Content -LiteralPath $attentionFile -Encoding UTF8 -Value (@(
        'Remote print receiver kept hanging and was restarted ' + $recent.Count + ' times in ' + $restartWindowMinutes + ' minutes.'
        'Last restart: ' + [DateTimeOffset]::FromUnixTimeMilliseconds([int64]($recent[-1].at)).LocalDateTime
        'Check the printer driver, USB connection and Windows print spooler on this computer.'
        'Delete this file to let automatic recovery start the receiver again.'
      ) -join [Environment]::NewLine)
    }
    Write-SupervisorLog ('restart budget exhausted (' + $recent.Count + ' in ' + $restartWindowMinutes + 'min); not starting a receiver until this file is deleted: ' + $attentionFile)
    exit 3
  }
  if (Test-Path -LiteralPath $attentionFile) {
    # The window has passed with no new hangs, so the fault cleared itself.
    Remove-Item -LiteralPath $attentionFile -Force
    Write-SupervisorLog 'restart budget recovered; clearing the needs-attention marker'
  }

  # A stopped scheduler launcher can leave a detached Node process behind.
  # Supervise that exact receiver until it exits instead of starting another
  # instance or trying to rotate files it still holds open. PID alone is not
  # sufficient: Windows may reuse the number for an unrelated process.
  $lockFile = Join-Path $receiverRoot 'agent.lock'
  if (Test-Path -LiteralPath $lockFile) {
    $receiverId = 0
    if ([int]::TryParse((Get-Content -LiteralPath $lockFile -Raw).Trim(), [ref]$receiverId) -and $receiverId -gt 0) {
      $running = Get-Process -Id $receiverId -ErrorAction SilentlyContinue
      if ($running) {
        $details = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $receiverId)
        $command = ([string]$details.CommandLine).Replace('\', '/')
        $agentMatch = '(?:^|["\s])' + [regex]::Escape($agentScript.Replace('\', '/')) + '(?:["\s]|$)'
        $configMatch = '(?:^|["\s])' + [regex]::Escape($configPath.Replace('\', '/')) + '(?:["\s]|$)'
        if ($details.ExecutablePath -and [IO.Path]::GetFullPath($details.ExecutablePath) -eq $nodePath -and $command -imatch $agentMatch -and $command -imatch $configMatch) {
          Write-SupervisorLog ('supervising existing receiver: ' + $receiverId)
          $adopted = Wait-AdoptedReceiver $running
          Write-SupervisorLog ('adopted receiver exited: ' + $adopted)
          # Fall through: the orphan is gone, so this launcher now starts the
          # replacement receiver exactly as it would on a normal cold start.
        }
      }
    }
  }
  # Keep the previous run's diagnostics. Never touch pairing or the job journal.
  $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss-fff')
  foreach ($log in @($outputLog, $errorLog)) {
    if (Test-Path -LiteralPath $log) { Move-Item -LiteralPath $log -Destination ($log + '.' + $stamp) }
  }
  # A stale stall marker from a previous run must not be mistaken for this one.
  if (Test-Path -LiteralPath $stallFile) { Remove-Item -LiteralPath $stallFile -Force }

  Write-SupervisorLog 'starting receiver'
  # Both the launcher and Node must stay hidden; a visible Node console can be closed.
  # Not using -Wait: the watchdog needs this receiver's PID before we block.
  # Windows PowerShell 5.1 only reports ExitCode for a -PassThru process without
  # -Wait if its handle was opened while the process was still running.
  $child = Start-Process -FilePath $nodePath -ArgumentList @(('"{0}"' -f $agentScript), ('"{0}"' -f $configPath)) -WorkingDirectory $receiverRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $outputLog -RedirectStandardError $errorLog
  $null = $child.Handle
  $receiverId = $child.Id

  # The watchdog is a separate process because this thread is blocked waiting.
  # It only ever ends this exact PID (and its print child) on a stale heartbeat.
  $watchdog = $null
  if (Test-Path -LiteralPath $watchdogScript -PathType Leaf) {
    $watchdog = Start-Process -FilePath $nodePath -ArgumentList @(
      ('"{0}"' -f $watchdogScript), $receiverId, ('"{0}"' -f $heartbeatFile), ('"{0}"' -f $stallFile),
      $loopStaleSeconds, $progressStaleSeconds
    ) -WorkingDirectory $receiverRoot -WindowStyle Hidden -PassThru
  } else {
    Write-SupervisorLog 'watchdog script is missing; running without hang detection'
  }

  $child.WaitForExit()
  $result = $child.ExitCode

  if ($watchdog) {
    try { if (-not $watchdog.HasExited) { Stop-Process -Id $watchdog.Id -Force -ErrorAction Stop } } catch { Write-SupervisorLog ('could not stop watchdog ' + $watchdog.Id + ': ' + $_.Exception.Message) }
  }

  if (Test-Path -LiteralPath $stallFile) {
    $stall = $null
    try { $stall = Get-Content -LiteralPath $stallFile -Raw | ConvertFrom-Json } catch { $stall = $null }
    Remove-Item -LiteralPath $stallFile -Force
    $age = if ($stall) { [double]$stall.ageSeconds } else { 0 }
    $reason = if ($stall -and $stall.reason) { [string]$stall.reason } else { 'unknown' }
    $count = Add-Restart $receiverId $age
    Write-SupervisorLog ('heartbeat stalled (' + $reason + ', ' + $age + 's); watchdog ended receiver ' + $receiverId + '; restart ' + $count + ' of ' + $restartBudget + ' within ' + $restartWindowMinutes + ' minutes')
    exit 3
  }

  Write-SupervisorLog ('receiver exited: ' + $result)
  exit $result
} catch {
  Write-SupervisorLog ('launcher failed: ' + $_.Exception.Message)
  exit 1
}
