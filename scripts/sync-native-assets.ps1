param(
  [string]$Source = 'dist',
  [string]$Target = 'www'
)
$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path -LiteralPath $Source).Path
$targetRoot = (Resolve-Path -LiteralPath $Target -ErrorAction SilentlyContinue)
if (-not $targetRoot) { New-Item -ItemType Directory -Force -Path $Target | Out-Null; $targetRoot = Resolve-Path -LiteralPath $Target }
$targetRoot = $targetRoot.Path
if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'index.html') -PathType Leaf)) { throw 'Build has no index.html.' }
$sourceRoot = $sourceRoot.TrimEnd([char[]]"\/")
$targetRoot = [IO.Path]::GetFullPath($targetRoot).TrimEnd([char[]]"\/")
if ($sourceRoot -eq $targetRoot -or $targetRoot.StartsWith($sourceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $sourceRoot.StartsWith($targetRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Source and target must be separate directories.' }
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd([char[]]"\/")
if ($targetRoot -eq $workspaceRoot -or $workspaceRoot.StartsWith($targetRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to replace workspace or ancestor directory.' }
Get-ChildItem -LiteralPath $targetRoot -Force | ForEach-Object {
  $resolved = [IO.Path]::GetFullPath($_.FullName)
  if (-not $resolved.StartsWith($targetRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Asset outside target.' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
Get-ChildItem -LiteralPath $sourceRoot -Recurse -File | ForEach-Object {
  $relative = $_.FullName.Substring($sourceRoot.Length).TrimStart([char[]]"\/").Replace('\','/')
    $destination = Join-Path $targetRoot ($relative -replace '/', [IO.Path]::DirectorySeparatorChar)
    $parent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
}
