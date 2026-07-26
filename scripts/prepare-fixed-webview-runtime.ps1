[CmdletBinding()]
param([switch]$Force)

$ErrorActionPreference = 'Stop'
$version = '150.0.4078.99'
$url = 'https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/1c394b0d-2689-4d8b-af57-2f2018abccf6/Microsoft.WebView2.FixedVersionRuntime.150.0.4078.99.x64.cab'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$runtime = Join-Path $root 'src-tauri\webview2-runtime'
$runtimeDirectory = Join-Path $runtime "Microsoft.WebView2.FixedVersionRuntime.$version.x64"
$cache = "F:\Huahaihuabu\build-cache\webview2-runtime\Microsoft.WebView2.FixedVersionRuntime.$version.x64.cab"
$expectedExecutable = Join-Path $runtimeDirectory 'msedgewebview2.exe'

if (-not $Force -and (Test-Path -LiteralPath $expectedExecutable)) {
    Write-Host "Fixed WebView2 runtime $version is ready at $runtimeDirectory"
    exit 0
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cache),$runtime | Out-Null
if (-not (Test-Path -LiteralPath $cache)) {
    Write-Host "Downloading Microsoft WebView2 fixed runtime $version to F:"
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $cache
}

if ((Get-Item -LiteralPath $cache).Length -lt 100MB) {
    throw "The fixed WebView2 archive is unexpectedly small: $cache"
}

& "$env:SystemRoot\System32\expand.exe" $cache '-F:*' $runtime
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $expectedExecutable)) {
    throw "Failed to extract the fixed WebView2 runtime to $runtime"
}

Write-Host "Fixed WebView2 runtime $version is ready at $runtimeDirectory"
