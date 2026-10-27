$ErrorActionPreference = 'Stop'
$scriptPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../scripts/install-bluetooth-630k.ps1'))
$tokens = $null
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors) | Out-Null
if ($parseErrors.Count) { throw ('Installer AST parse failed: ' + ($parseErrors -join '; ')) }

$fixture = Join-Path ([IO.Path]::GetTempPath()) ('bluetooth-630k-installer-test-' + [guid]::NewGuid().ToString('N'))
$root = Join-Path $fixture 'receiver'
$sourceScripts = Join-Path $fixture 'source'
$targetScripts = Join-Path $root 'scripts'
New-Item -ItemType Directory -Path $sourceScripts, $targetScripts -Force | Out-Null
try {
  . $scriptPath -ReceiverRoot $root
  $files = @('remote-print-agent.cjs', 'bluetooth-print-relay.cjs', 'new-helper.exe', 'fourth.txt')
  foreach ($name in $files) { [IO.File]::WriteAllText((Join-Path $sourceScripts $name), ('new:' + $name)) }
  [IO.File]::WriteAllText((Join-Path $targetScripts $files[0]), 'old:agent')
  [IO.File]::WriteAllText((Join-Path $targetScripts $files[1]), 'old:relay')
  $unrelated = Join-Path $targetScripts 'unrelated.txt'
  [IO.File]::WriteAllText($unrelated, 'unrelated-preserved')
  $config = Join-Path $root 'agent.json'
  $journal = Join-Path $root 'jobs.json'
  [IO.File]::WriteAllText($config, 'config-preserved')
  [IO.File]::WriteAllText($journal, 'journal-preserved')

  $successStamp = 'success-' + [guid]::NewGuid().ToString('N')
  $successStage = New-ReceiverInstallStage -SourceScripts $sourceScripts -TargetScripts $targetScripts -Files $files -Stamp $successStamp
  $backups = Invoke-ReceiverInstallTransaction -StagePath $successStage.Path -TargetScripts $targetScripts -Files $files -Stamp $successStamp
  foreach ($name in $files) {
    if ([IO.File]::ReadAllText((Join-Path $targetScripts $name)) -ne ('new:' + $name)) { throw "Successful transaction did not install $name" }
  }
  if ($backups.Count -ne 2) { throw "Expected two retained backups, got $($backups.Count)" }
  if ([IO.File]::ReadAllText($backups[0]) -ne 'old:agent' -or [IO.File]::ReadAllText($backups[1]) -ne 'old:relay') { throw 'Successful transaction did not preserve original backups' }
  if ([IO.File]::ReadAllText($unrelated) -ne 'unrelated-preserved') { throw 'Unrelated receiver script changed during successful transaction' }
  if ([IO.File]::ReadAllText($config) -ne 'config-preserved' -or [IO.File]::ReadAllText($journal) -ne 'journal-preserved') { throw 'Receiver config or journal changed during successful transaction' }

  [IO.File]::Delete((Join-Path $targetScripts $files[2]))
  [IO.File]::Delete((Join-Path $targetScripts $files[3]))
  foreach ($name in $files) { [IO.File]::WriteAllText((Join-Path $sourceScripts $name), ('rollback-new:' + $name)) }
  $rollbackStamp = 'rollback-' + [guid]::NewGuid().ToString('N')
  $rollbackStage = New-ReceiverInstallStage -SourceScripts $sourceScripts -TargetScripts $targetScripts -Files $files -Stamp $rollbackStamp
  $replacementCounter = [pscustomobject]@{ Value = 0 }
  $failAfterThirdReplacement = { param($target) $replacementCounter.Value++; if ($replacementCounter.Value -eq 3) { throw 'injected middle transaction failure' } }.GetNewClosure()
  $threw = $false
  try {
    Invoke-ReceiverInstallTransaction -StagePath $rollbackStage.Path -TargetScripts $targetScripts -Files $files -Stamp $rollbackStamp -AfterReplace $failAfterThirdReplacement | Out-Null
  } catch {
    if ($_.Exception.Message -notmatch 'rolled back') { throw }
    $threw = $true
  }
  if (-not $threw) { throw 'Injected transaction failure did not fail the transaction' }
  if ([IO.File]::ReadAllText((Join-Path $targetScripts $files[0])) -ne 'new:remote-print-agent.cjs' -or [IO.File]::ReadAllText((Join-Path $targetScripts $files[1])) -ne 'new:bluetooth-print-relay.cjs') { throw 'Middle transaction failure did not restore both prior files' }
  if (Test-Path -LiteralPath (Join-Path $targetScripts $files[2])) { throw 'New file remained after rollback' }
  if (Test-Path -LiteralPath (Join-Path $targetScripts $files[3])) { throw 'Untouched later new file appeared after rollback' }
  $rollbackBackups = @(Get-ChildItem -LiteralPath $targetScripts -Filter '*.before-bluetooth-rollback-*' -File)
  if ($rollbackBackups.Count -ne 2) { throw "Rollback did not retain its two original backups: $($rollbackBackups.Count)" }
  if ([IO.File]::ReadAllText($config) -ne 'config-preserved' -or [IO.File]::ReadAllText($journal) -ne 'journal-preserved' -or [IO.File]::ReadAllText($unrelated) -ne 'unrelated-preserved') { throw 'Rollback changed unrelated receiver files' }

  $agentPath = [IO.Path]::GetFullPath((Join-Path $targetScripts 'remote-print-agent.cjs'))
  $configPath = [IO.Path]::GetFullPath($config)
  $matchingProcess = [pscustomobject]@{ Name = 'node.exe'; CommandLine = '"C:\Program Files\nodejs\node.exe" "' + $agentPath + '" "' + $configPath + '"' }
  if (-not (Test-ExactReceiverProcess -Process $matchingProcess -Receiver $root)) { throw 'Exact receiver process identity was not recognized' }
  $foreignProcess = [pscustomobject]@{ Name = 'node.exe'; CommandLine = '"C:\Program Files\nodejs\node.exe" "C:\other\scripts\remote-print-agent.cjs" "' + $configPath + '"' }
  if (Test-ExactReceiverProcess -Process $foreignProcess -Receiver $root) { throw 'Foreign Node process incorrectly matched the receiver identity' }
  $wrongExecutable = [pscustomobject]@{ Name = 'other.exe'; CommandLine = $matchingProcess.CommandLine }
  if (Test-ExactReceiverProcess -Process $wrongExecutable -Receiver $root) { throw 'Non-Node process incorrectly matched the receiver identity' }
  'PASS: installer AST, atomic same-volume staging, success backups, rollback, untouched files, exact receiver process matching.'
} finally {
  Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
}
