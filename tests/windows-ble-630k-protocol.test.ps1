param(
  [string]$OutputDirectory = (Join-Path ([IO.Path]::GetTempPath()) ('warehouse-ble-tests-' + [Guid]::NewGuid().ToString('N'))),
  [switch]$ProbeAdvertising
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $output -Force | Out-Null
$helper = Join-Path $output 'relay.exe'
$runner = Join-Path $output 'protocol-tests.exe'
$build = & (Join-Path $root 'scripts/build-bluetooth-630k.ps1') -OutputPath $helper
$framework = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319'
$arguments = @(
  '/nologo', '/langversion:7.3', '/platform:x64', '/target:exe', ('/out:' + $runner),
  ('/r:' + (Join-Path $framework 'System.dll')),
  ('/r:' + (Join-Path $framework 'System.Core.dll')),
  ('/r:' + (Join-Path $framework 'System.Net.Http.dll')),
  ('/r:' + (Join-Path $framework 'System.Web.Extensions.dll')),
  (Join-Path $root 'windows/ble-630k-relay/ProtocolTests.cs')
)
& $build.Compiler @arguments
if ($LASTEXITCODE -ne 0) { throw "Protocol test compilation failed: $LASTEXITCODE" }
& $runner $helper
if ($LASTEXITCODE -ne 0) { throw "Windows BLE protocol tests failed: $LASTEXITCODE" }
if ($ProbeAdvertising) {
  & node (Join-Path $PSScriptRoot 'windows-ble-630k-advertising-probe.cjs') $helper
  if ($LASTEXITCODE -ne 0) { throw "Windows BLE advertising probe failed: $LASTEXITCODE" }
}
Write-Host "Windows BLE test artifacts: $output"
