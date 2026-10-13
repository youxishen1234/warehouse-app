param(
  [Parameter(Mandatory = $true)][string]$ConfigFile,
  [string]$NodeExe = (Join-Path $env:ProgramFiles 'nodejs/node.exe')
)

$ErrorActionPreference = 'Stop'
$configPath = (Resolve-Path -LiteralPath $ConfigFile).Path
$receiverRoot = Split-Path -Parent $configPath
$agentScript = Join-Path $receiverRoot 'scripts/remote-print-agent.cjs'
$nodePath = (Resolve-Path -LiteralPath $NodeExe).Path
if (-not (Test-Path -LiteralPath $agentScript -PathType Leaf)) { throw 'Remote print agent is missing.' }

$supervisorLog = Join-Path $receiverRoot 'supervisor.log'
$outputLog = Join-Path $receiverRoot 'receiver.log'
$errorLog = Join-Path $receiverRoot 'receiver-error.log'
try {
  # Keep the previous run's diagnostics. Never touch pairing or the job journal.
  $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss-fff')
  foreach ($log in @($outputLog, $errorLog)) {
    if (Test-Path -LiteralPath $log) { Move-Item -LiteralPath $log -Destination ($log + '.' + $stamp) }
  }
  Add-Content -LiteralPath $supervisorLog -Value ((Get-Date).ToString('o') + ' starting receiver') -Encoding UTF8
  # Wait for the actual agent so Task Scheduler can supervise it. Both the
  # launcher and Node must be hidden; a visible Node console can be closed.
  $child = Start-Process -FilePath $nodePath -ArgumentList @(('"{0}"' -f $agentScript), ('"{0}"' -f $configPath)) -WorkingDirectory $receiverRoot -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $outputLog -RedirectStandardError $errorLog
  $result = $child.ExitCode
  Add-Content -LiteralPath $supervisorLog -Value ((Get-Date).ToString('o') + ' receiver exited: ' + $result) -Encoding UTF8
  exit $result
} catch {
  Add-Content -LiteralPath $supervisorLog -Value ((Get-Date).ToString('o') + ' launcher failed: ' + $_.Exception.Message) -Encoding UTF8
  exit 1
}
