param(
  [string]$Source = 'dist',
  [string]$Target = 'www'
)
$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path -LiteralPath $Source).Path
$targetRoot = (Resolve-Path -LiteralPath $Target -ErrorAction SilentlyContinue)
if (-not $targetRoot) { New-Item -ItemType Directory -Force -Path $Target | Out-Null; $targetRoot = Resolve-Path -LiteralPath $Target }
$targetRoot = $targetRoot.Path
$exclude = @('js/home-search.js','css/polish.css')
Get-ChildItem -LiteralPath $sourceRoot -Recurse -File | ForEach-Object {
  $relative = $_.FullName.Substring($sourceRoot.Length).TrimStart([char[]]"\/").Replace('\','/')
  if ($exclude -notcontains $relative) {
    $destination = Join-Path $targetRoot ($relative -replace '/', [IO.Path]::DirectorySeparatorChar)
    $parent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
  }
}
