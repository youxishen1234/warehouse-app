$ErrorActionPreference = 'Stop'
$env:TARO_PUBLIC_PATH = './'
npm run build:h5
if ($LASTEXITCODE -ne 0) { throw "H5 build failed with exit code $LASTEXITCODE" }
npm run verify:fast
if ($LASTEXITCODE -ne 0) { throw "Verification failed with exit code $LASTEXITCODE" }
npm run test:browser
if ($LASTEXITCODE -ne 0) { throw "Browser smoke test failed with exit code $LASTEXITCODE" }
$artifactArgs = @('--dist', 'dist')
if ($env:RELEASE_ZIP) { $artifactArgs += @('--zip', $env:RELEASE_ZIP) }
node scripts/verify-release-artifacts.cjs @artifactArgs
if ($LASTEXITCODE -ne 0) { throw "Release artifact verification failed with exit code $LASTEXITCODE" }
