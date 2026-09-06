$ErrorActionPreference = 'Stop'
$Taro = $PSScriptRoot
$Root = Split-Path -Parent $Taro
$Www = (Get-ChildItem $Root -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'www\index.html') } | Select-Object -First 1).FullName
$Pub = (Get-ChildItem $Root -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'public\appupdate') } | Select-Object -First 1).FullName
$Www = Join-Path $Www 'www'
$Pub = Join-Path $Pub 'public\appupdate'
$BuildOut = 'dist_h5u'
$SrvUser = if ($env:SHUGUANG_SERVER_USER) { $env:SHUGUANG_SERVER_USER } else { 'ubuntu' }
$SrvHost = if ($env:SHUGUANG_SERVER_HOST) { $env:SHUGUANG_SERVER_HOST } else { '152.136.100.200' }
$SrvPw = $env:SHUGUANG_SERVER_PASSWORD
$SrvHostKey = if ($env:SHUGUANG_SERVER_HOST_KEY) { $env:SHUGUANG_SERVER_HOST_KEY } else { 'SHA256:mtT8ZZ+lZ55uyp9rxvupDHZSxMmIYo52m/xgspZh1rA' }
if (-not $SrvPw) { throw 'SHUGUANG_SERVER_PASSWORD is not set' }
$SrvDir = '/opt/shuguang/public/appupdate'
$Plink = Join-Path $Root 'tools\plink.exe'
$Pscp = Join-Path $Root 'tools\pscp.exe'

if (-not $Pub) { throw 'Update public directory not found' }

Push-Location $Taro
$env:TARO_OUTPUT_DIR = $BuildOut
try {
  npm run build:h5
  if ($LASTEXITCODE -ne 0) { throw 'H5 build failed' }
} finally {
  Pop-Location
  Remove-Item Env:TARO_OUTPUT_DIR -ErrorAction SilentlyContinue
}

$Dist = Join-Path $Taro $BuildOut
if (-not (Test-Path (Join-Path $Dist 'index.html'))) { throw 'Build output missing index.html' }

Add-Type -AssemblyName System.IO.Compression.FileSystem
New-Item -ItemType Directory -Force -Path $Pub | Out-Null
$Stage = Join-Path $env:TEMP ('shuguang-update-' + [guid]::NewGuid().ToString('N'))
$Zip = Join-Path $env:TEMP ('shuguang-update-' + [guid]::NewGuid().ToString('N') + '.zip')
New-Item -ItemType Directory -Force -Path $Stage | Out-Null
Copy-Item (Join-Path $Dist '*') $Stage -Recurse -Force
[System.IO.Compression.ZipFile]::CreateFromDirectory($Stage, $Zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
$ZipCheck = [System.IO.Compression.ZipFile]::OpenRead($Zip)
try {
  if ($ZipCheck.Entries.Count -lt 2) { throw 'Generated update ZIP is empty' }
} finally { $ZipCheck.Dispose() }
Remove-Item $Stage -Recurse -Force

$Version = Get-Date -Format 'yyyyMMddHHmm'
$Manifest = @{ version = $Version; url = 'www.zip'; publishedAt = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') } | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $Pub 'manifest.json'), $Manifest, [System.Text.UTF8Encoding]::new($false))

& $Plink -batch -ssh ($SrvUser + '@' + $SrvHost) -pw $SrvPw -hostkey $SrvHostKey ('mkdir -p ' + $SrvDir)
if ($LASTEXITCODE -ne 0) { throw 'Remote directory check failed' }
& $Pscp -batch -pw $SrvPw -hostkey $SrvHostKey $Zip ($SrvUser + '@' + $SrvHost + ':' + $SrvDir + '/www.zip.new')
if ($LASTEXITCODE -ne 0) { throw 'Upload failed: www.zip' }
& $Pscp -batch -pw $SrvPw -hostkey $SrvHostKey (Join-Path $Pub 'manifest.json') ($SrvUser + '@' + $SrvHost + ':' + $SrvDir + '/manifest.json.new')
if ($LASTEXITCODE -ne 0) { throw 'Upload failed: manifest.json' }
& $Plink -batch -ssh ($SrvUser + '@' + $SrvHost) -pw $SrvPw -hostkey $SrvHostKey ('mv ' + $SrvDir + '/www.zip.new ' + $SrvDir + '/www.zip && mv ' + $SrvDir + '/manifest.json.new ' + $SrvDir + '/manifest.json && find ' + $SrvDir + ' -maxdepth 1 -type f \( -name ''*.new'' -o -name ''www-*.zip'' -o -name ''manifest-*.json'' \) -delete')
if ($LASTEXITCODE -ne 0) { throw 'Remote publish or cleanup failed' }
Remove-Item $Zip -Force
Write-Host ('Published v' + $Version)
