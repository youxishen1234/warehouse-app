$ErrorActionPreference = 'Stop'
$testId = [Guid]::NewGuid().ToString('N')
$taskName = 'WarehousePrintRecoveryTest-' + $testId
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('warehouse-print-watchdog-' + $testId)
$projectRoot = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Path (Join-Path $testRoot 'scripts') -Force | Out-Null
$configPath = Join-Path $testRoot 'agent.json'
@{ origin = 'https://youxishen.online'; agent = ('a' * 64); printer = 'test-only-no-printer' } | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding ASCII
@'
const fs = require('node:fs'), path = require('node:path');
const file = path.join(path.dirname(process.argv[2]), 'starts.json');
const starts = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
starts.push(Date.now());
fs.writeFileSync(file, JSON.stringify(starts));
console.log('isolated recovery fixture', starts.length);
process.exit(starts.length === 1 ? 7 : 0);
'@ | Set-Content -LiteralPath (Join-Path $testRoot 'scripts/remote-print-agent.cjs') -Encoding ASCII
try {
  & (Join-Path $projectRoot 'scripts/install-remote-print-task.ps1') -ConfigFile $configPath -TaskName $taskName -Start | Out-Null
  $deadline = (Get-Date).AddSeconds(100)
  $stateFile = Join-Path $testRoot 'starts.json'
  do {
    Start-Sleep -Seconds 2
    $starts = if (Test-Path -LiteralPath $stateFile) { @(Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json) } else { @() }
  } while ($starts.Count -lt 2 -and (Get-Date) -lt $deadline)
  if ($starts.Count -lt 2) { throw 'The scheduler did not restart the failed test receiver.' }
  [pscustomobject]@{ automaticRecovery = $true; starts = $starts.Count; recoverySeconds = [Math]::Round(($starts[1] - $starts[0]) / 1000, 1); physicalPrints = 0 } | ConvertTo-Json -Compress
} finally {
  # This task and directory are unique fixtures; never stop the real receiver.
  $fixture = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($fixture) { Stop-ScheduledTask -TaskName $taskName; Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $expected = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('warehouse-print-watchdog-' + $testId)))
  if ($resolved -ne $expected) { throw 'Unexpected test cleanup path.' }
  for ($retry = 0; $retry -lt 6; $retry++) {
    try { if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }; break }
    catch { if ($retry -eq 5) { throw }; Start-Sleep -Milliseconds 500 }
  }
}
