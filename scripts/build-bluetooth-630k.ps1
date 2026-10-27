param(
  [string]$OutputPath = (Join-Path $PSScriptRoot 'bluetooth-630k-relay.exe')
)

$ErrorActionPreference = 'Stop'
$source = Join-Path (Split-Path -Parent $PSScriptRoot) 'windows/ble-630k-relay/Program.cs'
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing BLE relay source: $source" }

$roslynCandidates = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/2022/BuildTools/MSBuild/Current/Bin/Roslyn/csc.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/2022/Community/MSBuild/Current/Bin/Roslyn/csc.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft Visual Studio/2022/Enterprise/MSBuild/Current/Bin/Roslyn/csc.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
$compiler = $roslynCandidates | Select-Object -First 1
if (-not $compiler) {
  $compiler = Get-ChildItem -Path @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio'),
    (Join-Path $env:ProgramFiles 'Microsoft Visual Studio')
  ) -Filter csc.exe -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\Roslyn\\csc\.exe$' } |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $compiler) { throw 'Roslyn csc.exe was not found. Install Visual Studio 2022 Build Tools with the .NET desktop build tools.' }

$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/UnionMetadata'
$winmd = @(Get-ChildItem -LiteralPath $sdkRoot -Recurse -Filter Windows.winmd -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Length -gt 1MB -and $_.Directory.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
  Sort-Object { [version]$_.Directory.Name } -Descending |
  Select-Object -First 1 -ExpandProperty FullName)
if (-not $winmd.Count) { throw 'Windows.winmd was not found. Install a current Windows SDK.' }

$framework = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319'
foreach ($name in @('System.dll','System.Core.dll','System.Runtime.dll','System.Runtime.InteropServices.WindowsRuntime.dll','System.Net.Http.dll','System.Web.Extensions.dll','System.Runtime.WindowsRuntime.dll')) {
  if (-not (Test-Path -LiteralPath (Join-Path $framework $name) -PathType Leaf)) { throw "Missing .NET Framework assembly: $name" }
}

$resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $resolvedOutput
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$arguments = @(
  '/nologo',
  '/langversion:7.3',
  '/target:exe',
  '/platform:x64',
  '/optimize+',
  ('/out:' + $resolvedOutput),
  ('/r:' + (Join-Path $framework 'System.dll')),
  ('/r:' + (Join-Path $framework 'System.Core.dll')),
  ('/r:' + (Join-Path $framework 'System.Runtime.dll')),
  ('/r:' + (Join-Path $framework 'System.Runtime.InteropServices.WindowsRuntime.dll')),
  ('/r:' + (Join-Path $framework 'System.Net.Http.dll')),
  ('/r:' + (Join-Path $framework 'System.Web.Extensions.dll')),
  ('/r:' + (Join-Path $framework 'System.Runtime.WindowsRuntime.dll')),
  ('/r:' + $winmd),
  $source
)
& $compiler @arguments
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $resolvedOutput -PathType Leaf)) {
  throw "BLE relay compilation failed with exit code $LASTEXITCODE"
}
$hash = (Get-FileHash -LiteralPath $resolvedOutput -Algorithm SHA256).Hash
[pscustomobject]@{
  Output = $resolvedOutput
  Bytes = (Get-Item -LiteralPath $resolvedOutput).Length
  SHA256 = $hash
  WinMD = $winmd
  Compiler = $compiler
}
