param(
  [string]$ReceiverRoot = 'E:\aoo\warehouse-app\release\k3-usb-remote-20261023\receiver',
  [string]$ConfigFile = '',
  [string]$NodeExe = (Join-Path $env:ProgramFiles 'nodejs/node.exe'),
  [string]$TaskName = 'WarehouseK3RemotePrint',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
if ($TaskName -ne 'WarehouseK3RemotePrint') { throw 'Only WarehouseK3RemotePrint may be managed here.' }
if (-not $ConfigFile) { $ConfigFile = Join-Path $ReceiverRoot 'k3-agent.json' }
$root = (Resolve-Path -LiteralPath $ReceiverRoot).Path
$configPath = (Resolve-Path -LiteralPath $ConfigFile).Path
$runScript = Join-Path $root 'scripts/run-k3-remote-agent.ps1'
$agentScript = Join-Path $root 'scripts/k3-remote-agent.cjs'
$nodePath = (Resolve-Path -LiteralPath $NodeExe).Path

if ($Uninstall) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  # Stopping the scheduled task only ends the launcher; the Node receiver is
  # its child. Stop that exact heartbeat PID so an uninstall never leaves an
  # orphaned receiver polling for and printing labels.
  $heartbeatFile = Join-Path $root 'k3-heartbeat.json'
  if (Test-Path -LiteralPath $heartbeatFile -PathType Leaf) {
    try {
      $pidToStop = [int](Get-Content -LiteralPath $heartbeatFile -Raw | ConvertFrom-Json).pid
      $receiver = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $pidToStop) -ErrorAction SilentlyContinue
      if ($receiver -and $receiver.Name -eq 'node.exe' -and
          $receiver.CommandLine -like ('*' + (Join-Path $root 'scripts\k3-remote-agent.cjs') + '*')) {
        Stop-Process -Id $pidToStop -Force -ErrorAction Stop
      }
    } catch {
      Write-Warning ('Could not stop the heartbeat receiver automatically: ' + $_.Exception.Message)
    }
  }
  Write-Output 'WarehouseK3RemotePrint removed.'
  exit 0
}

foreach ($file in @($runScript, $agentScript, $configPath)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw ('Required file is missing: ' + $file) }
}
$probe = 'for (const name of ["electron", "pngjs", "qrcode"]) { try { require.resolve(name, { paths: [process.argv[1]] }); } catch { console.error(name); process.exit(1); } }'
& $nodePath -e $probe $root
if ($LASTEXITCODE -ne 0) { throw 'Receiver dependency is missing; install electron, pngjs and qrcode for the receiver.' }
& $nodePath --check $agentScript
if ($LASTEXITCODE -ne 0) { throw 'K3 receiver JavaScript failed syntax validation.' }

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  $backup = Join-Path $root ('k3-task-backup-' + (Get-Date).ToString('yyyyMMdd-HHmmss-fff') + '.xml')
  Export-ScheduledTask -TaskName $TaskName | Set-Content -LiteralPath $backup -Encoding UTF8
}

$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
  -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -ConfigFile "{1}" -NodeExe "{2}"' -f $runScript, $configPath, $nodePath) `
  -WorkingDirectory $root
$trigger = @(
  (New-ScheduledTaskTrigger -AtLogOn -User $userId)
  (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650))
)
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden -MultipleInstances IgnoreNew `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Description 'K3 标签远程打印接收端，仅使用 COM3 串口，不连接送货单 630K' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Output 'WarehouseK3RemotePrint installed and started.'
