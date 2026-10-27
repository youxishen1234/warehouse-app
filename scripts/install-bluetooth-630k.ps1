[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)][string]$ReceiverRoot,
  [string]$TaskName = 'Warehouse630KRemotePrint',
  [switch]$BuildOnly,
  [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'

function Remove-ReceiverInstallStage {
  param([Parameter(Mandatory = $true)][string]$StagePath,
    [Parameter(Mandatory = $true)][string]$TargetScripts)
  $stage = [IO.Path]::GetFullPath($StagePath)
  $parent = [IO.Path]::GetFullPath($TargetScripts).TrimEnd([char[]]'\/')
  if ([IO.Path]::GetDirectoryName($stage) -ne $parent -or
    [IO.Path]::GetFileName($stage) -notlike '.bluetooth-630k-stage-*') {
    throw 'Receiver staging cleanup target is outside the intended scripts directory.'
  }
  if (Test-Path -LiteralPath $stage) {
    if ((Get-Item -LiteralPath $stage -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw 'Receiver staging cleanup target is a reparse point.'
    }
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction Stop
  }
}

function New-ReceiverInstallStage {
  param(
    [Parameter(Mandatory = $true)][string]$SourceScripts,
    [Parameter(Mandatory = $true)][string]$TargetScripts,
    [Parameter(Mandatory = $true)][string[]]$Files,
    [Parameter(Mandatory = $true)][string]$Stamp
  )

  $stagePath = Join-Path $TargetScripts ('.bluetooth-630k-stage-' + $PID + '-' + $Stamp)
  if (Test-Path -LiteralPath $stagePath) { throw "Receiver staging directory already exists: $stagePath" }
  New-Item -ItemType Directory -Path $stagePath -ErrorAction Stop | Out-Null
  try {
    foreach ($name in $Files) {
      if ([IO.Path]::GetFileName($name) -ne $name) { throw "Invalid staged receiver filename: $name" }
      $source = Join-Path $SourceScripts $name
      if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing staged receiver file: $name" }
      $destination = Join-Path $stagePath $name
      [IO.File]::Copy($source, $destination, $false)
      $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
      $stagedHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
      if ($sourceHash -ne $stagedHash) { throw "Receiver staging verification failed: $name" }
    }
    return [pscustomobject]@{ Path = $stagePath; Files = @($Files) }
  } catch {
    Remove-ReceiverInstallStage -StagePath $stagePath -TargetScripts $TargetScripts
    throw
  }
}

function Invoke-ReceiverInstallTransaction {
  param(
    [Parameter(Mandatory = $true)][string]$StagePath,
    [Parameter(Mandatory = $true)][string]$TargetScripts,
    [Parameter(Mandatory = $true)][string[]]$Files,
    [Parameter(Mandatory = $true)][string]$Stamp,
    [scriptblock]$AfterReplace
  )

  $changes = New-Object System.Collections.Generic.List[object]
  try {
    foreach ($name in $Files) {
      if ([IO.Path]::GetFileName($name) -ne $name) { throw "Invalid receiver filename: $name" }
      $staged = Join-Path $StagePath $name
      $target = Join-Path $TargetScripts $name
      if (-not (Test-Path -LiteralPath $staged -PathType Leaf)) { throw "Staged receiver file is missing: $name" }
      if (Test-Path -LiteralPath $target -PathType Container) { throw "Receiver file path is a directory: $target" }
      $existed = Test-Path -LiteralPath $target -PathType Leaf
      $backup = if ($existed) { $target + '.before-bluetooth-' + $Stamp } else { $null }
      if ($backup -and (Test-Path -LiteralPath $backup)) { throw "Receiver backup already exists: $backup" }
      $changes.Add([pscustomobject]@{ Name = $name; Target = $target; Staged = $staged; Existed = $existed; Backup = $backup })
      if ($existed) {
        [IO.File]::Replace($staged, $target, $backup, $true)
      } else {
        [IO.File]::Move($staged, $target)
      }
      if ($AfterReplace) { & $AfterReplace $target }
    }
    return @($changes | ForEach-Object { if ($_.Backup) { $_.Backup } })
  } catch {
    $installError = $_.Exception.Message
    $rollbackErrors = New-Object System.Collections.Generic.List[string]
    for ($index = $changes.Count - 1; $index -ge 0; $index--) {
      $change = $changes[$index]
      try {
        if ($change.Existed) {
          if (Test-Path -LiteralPath $change.Backup -PathType Leaf) {
            $restore = Join-Path $TargetScripts ('.' + $change.Name + '.rollback-' + $Stamp)
            $failedVersion = $change.Target + '.failed-bluetooth-' + $Stamp
            [IO.File]::Copy($change.Backup, $restore, $false)
            [IO.File]::Replace($restore, $change.Target, $failedVersion, $true)
          }
        } elseif (-not (Test-Path -LiteralPath $change.Staged) -and (Test-Path -LiteralPath $change.Target -PathType Leaf)) {
          [IO.File]::Delete($change.Target)
        }
      } catch {
        $rollbackErrors.Add(($change.Name + ': ' + $_.Exception.Message))
      }
    }
    if ($rollbackErrors.Count) { throw ($installError + '; rollback failed for ' + ($rollbackErrors -join '; ') + '. Original backups remain in place.') }
    throw ($installError + '; installed files were rolled back and original backups were retained.')
  }
}

function Get-ReceiverProcessIds {
  param([Parameter(Mandatory = $true)][string]$Receiver)
  $ids = New-Object System.Collections.Generic.List[int]
  $lockPath = Join-Path $Receiver 'agent.lock'
  $heartbeatPath = Join-Path $Receiver 'receiver-heartbeat.json'
  if (Test-Path -LiteralPath $lockPath -PathType Leaf) {
    $text = (Get-Content -LiteralPath $lockPath -Raw -ErrorAction Stop).Trim()
    if ($text -notmatch '^[1-9][0-9]*$') { throw 'Receiver agent.lock is invalid; no process will be terminated.' }
    $ids.Add([int]$text)
  }
  if (Test-Path -LiteralPath $heartbeatPath -PathType Leaf) {
    try { $beat = Get-Content -LiteralPath $heartbeatPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'Receiver heartbeat is invalid; no process will be terminated.' }
    if ($null -eq $beat.pid -or [string]$beat.pid -notmatch '^[1-9][0-9]*$') { throw 'Receiver heartbeat PID is invalid; no process will be terminated.' }
    $ids.Add([int]$beat.pid)
  }
  return @($ids | Select-Object -Unique)
}

function Test-ExactReceiverProcess {
  param([Parameter(Mandatory = $true)][object]$Process,
    [Parameter(Mandatory = $true)][string]$Receiver)
  $agentScript = [IO.Path]::GetFullPath((Join-Path (Join-Path $Receiver 'scripts') 'remote-print-agent.cjs'))
  $agentConfig = [IO.Path]::GetFullPath((Join-Path $Receiver 'agent.json'))
  $agentArgument = '(?i)(?:^|\s)"?' + [regex]::Escape($agentScript) + '"?(?=\s|$)'
  $configArgument = '(?i)(?:^|\s)"?' + [regex]::Escape($agentConfig) + '"?(?=\s|$)'
  return [IO.Path]::GetFileNameWithoutExtension([string]$Process.Name) -eq 'node' -and
    [string]$Process.CommandLine -match $agentArgument -and [string]$Process.CommandLine -match $configArgument
}

function Assert-NoRunningReceiverProcess {
  param([Parameter(Mandatory = $true)][string]$Receiver)
  foreach ($processId in (Get-ReceiverProcessIds -Receiver $Receiver)) {
    $process = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + $processId) -ErrorAction Stop
    if ($null -eq $process) { continue }
    if (-not (Test-ExactReceiverProcess -Process $process -Receiver $Receiver)) {
      throw "PID $processId from receiver state does not match this receiver's exact Node entry point; no process was terminated."
    }
    throw "Receiver PID $processId is still running outside the stopped scheduled task; install was not applied."
  }
}

function Stop-VerifiedReceiverProcess {
  param([Parameter(Mandatory = $true)][string]$Receiver)
  foreach ($processId in (Get-ReceiverProcessIds -Receiver $Receiver)) {
    $process = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + $processId) -ErrorAction Stop
    if ($null -eq $process) { continue }
    if (-not (Test-ExactReceiverProcess -Process $process -Receiver $Receiver)) {
      throw "PID $processId from receiver state does not match this receiver's exact Node entry point; no process was terminated."
    }
    Stop-Process -Id $processId -Force -ErrorAction Stop
    $deadline = (Get-Date).AddSeconds(10)
    do {
      Start-Sleep -Milliseconds 200
      $stillRunning = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + $processId) -ErrorAction Stop
    } while ($stillRunning -and (Get-Date) -lt $deadline)
    if ($stillRunning) { throw "Verified receiver PID $processId did not exit after termination." }
  }
}

function Wait-ReceiverTaskStopped {
  param([Parameter(Mandatory = $true)][string]$TaskName,
    [Parameter(Mandatory = $true)][string]$Receiver)
  $deadline = (Get-Date).AddSeconds(20)
  do {
    $current = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $current -or $current.State -ne 'Running') { break }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  $current = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($current -and $current.State -eq 'Running') {
    Stop-VerifiedReceiverProcess -Receiver $Receiver
    $deadline = (Get-Date).AddSeconds(10)
    do {
      Start-Sleep -Milliseconds 250
      $current = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    } while ($current -and $current.State -eq 'Running' -and (Get-Date) -lt $deadline)
    if ($current -and $current.State -eq 'Running') { throw "Scheduled task '$TaskName' did not stop." }
  }
  Stop-VerifiedReceiverProcess -Receiver $Receiver
}

$dotSourced = $MyInvocation.InvocationName -eq '.'
if (-not $dotSourced) {
  $sourceRoot = Split-Path -Parent $PSScriptRoot
  $receiver = (Resolve-Path -LiteralPath $ReceiverRoot).Path
  $scripts = Join-Path $receiver 'scripts'
  if (-not (Test-Path -LiteralPath $scripts -PathType Container)) { throw "Receiver scripts directory is missing: $scripts" }

  $files = @('remote-print-agent.cjs', 'bluetooth-print-relay.cjs', 'bluetooth-relay-process.cjs', 'remote-print-lock.cjs', 'bluetooth-630k-relay.exe')
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  $taskWasRunning = [bool]($task -and $task.State -eq 'Running')
  if ($NoRestart -and $taskWasRunning) { throw '任务当前正在运行；NoRestart 已跳过文件更改，安装未执行。' }

  $buildScript = Join-Path $PSScriptRoot 'build-bluetooth-630k.ps1'
  $stagedHelper = Join-Path $PSScriptRoot 'bluetooth-630k-relay.exe'
  $build = & $buildScript -OutputPath $stagedHelper
  if ($BuildOnly) { $build; return }
  foreach ($name in $files) {
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $name) -PathType Leaf)) { throw "Missing staged receiver file: $name" }
  }
  foreach ($name in @('remote-print-agent.cjs', 'bluetooth-print-relay.cjs', 'bluetooth-relay-process.cjs')) {
    & node --check (Join-Path $PSScriptRoot $name)
    if ($LASTEXITCODE -ne 0) { throw "Node syntax check failed: $name" }
  }
  if (-not $PSCmdlet.ShouldProcess($receiver, 'Install the encrypted 630K Bluetooth relay transactionally without changing agent.json or the job journal')) { return }

  $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss-fff') + '-' + $PID
  $stage = New-ReceiverInstallStage -SourceScripts $PSScriptRoot -TargetScripts $scripts -Files $files -Stamp $stamp
  $restartRequired = $taskWasRunning
  $taskDisabled = $false
  $taskWasEnabled = [bool]($task -and $task.Settings.Enabled)
  try {
    if ($taskWasEnabled) {
      Disable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null
      $taskDisabled = $true
    }
    $currentTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $restartRequired = $restartRequired -or [bool]($currentTask -and $currentTask.State -eq 'Running')
    if ($NoRestart -and $restartRequired) { throw 'Receiver started during staging; NoRestart left all installed files unchanged.' }
    if ($restartRequired) {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
      Wait-ReceiverTaskStopped -TaskName $TaskName -Receiver $receiver
    } else { Assert-NoRunningReceiverProcess -Receiver $receiver }
    $backups = Invoke-ReceiverInstallTransaction -StagePath $stage.Path -TargetScripts $scripts -Files $files -Stamp $stamp
  } finally {
    try { Remove-ReceiverInstallStage -StagePath $stage.Path -TargetScripts $scripts }
    finally {
      if ($taskDisabled) { Enable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null }
      if ($restartRequired -and -not $NoRestart) {
        $currentTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($currentTask -and $currentTask.State -ne 'Running') { Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop }
      }
    }
  }

  [pscustomobject]@{
    Receiver = $receiver
    Installed = $true
    Files = $files
    Backups = @($backups)
    HelperSHA256 = $build.SHA256
    TaskRestarted = $restartRequired
    AgentConfigUntouched = $true
    JobJournalUntouched = $true
  }
}
