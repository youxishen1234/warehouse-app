[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)][string]$ConfigFile,
  [ValidatePattern('^[a-zA-Z0-9_.-]{1,80}$')][string]$TaskName = 'Warehouse630KRemotePrint',
  [string]$NodeExe = (Join-Path $env:ProgramFiles 'nodejs/node.exe'),
  [switch]$Start
)

$ErrorActionPreference = 'Stop'
$configPath = (Resolve-Path -LiteralPath $ConfigFile).Path
$receiverRoot = Split-Path -Parent $configPath
$nodePath = (Resolve-Path -LiteralPath $NodeExe).Path
$agentScript = Join-Path $receiverRoot 'scripts/remote-print-agent.cjs'
if (-not (Test-Path -LiteralPath $agentScript -PathType Leaf)) { throw 'Remote print agent is missing.' }
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($config.origin -ne 'https://youxishen.online' -or $config.agent -cnotmatch '^[a-f0-9]{64}$' -or -not $config.printer) {
  throw 'Invalid remote print configuration.'
}
$launcherSource = Join-Path $PSScriptRoot 'run-remote-print-agent.ps1'
$launcherPath = Join-Path $receiverRoot 'scripts/run-remote-print-agent.ps1'
$powerShellExe = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$taskUser = if ($existing) { $existing.Principal.UserId } else { [Security.Principal.WindowsIdentity]::GetCurrent().Name }
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -ConfigFile "{1}" -NodeExe "{2}"' -f $launcherPath, $configPath, $nodePath
$action = New-ScheduledTaskAction -Execute $powerShellExe -Argument $arguments -WorkingDirectory $receiverRoot
$logon = New-ScheduledTaskTrigger -AtLogOn -User $taskUser
# No repetition duration: keep checking even after the failure retry limit.
# IgnoreNew leaves a healthy, running receiver alone.
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden

if ($PSCmdlet.ShouldProcess($TaskName, 'Install hidden remote print receiver with automatic recovery')) {
  if ($existing) {
    $backup = Join-Path $receiverRoot ($TaskName + '.before-' + (Get-Date).ToString('yyyyMMdd-HHmmss-fff') + '.xml')
    Export-ScheduledTask -TaskName $TaskName | Set-Content -LiteralPath $backup -Encoding Unicode
  }
  if ([IO.Path]::GetFullPath($launcherSource) -ne [IO.Path]::GetFullPath($launcherPath)) {
    Copy-Item -LiteralPath $launcherSource -Destination $launcherPath
  }
  if ($existing) {
    # Preserve the existing Windows identity and do not interrupt in-flight work.
    Set-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($logon, $watchdog) -Settings $settings | Out-Null
  } else {
    $principal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($logon, $watchdog) -Settings $settings -Principal $principal -Description 'Warehouse remote print receiver with hidden startup and automatic recovery' | Out-Null
  }
  if ($Start) { Start-ScheduledTask -TaskName $TaskName }
  Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
}
