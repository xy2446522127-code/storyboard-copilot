param(
  [Parameter(Mandatory = $true)][string]$PrivateKey,
  [string]$PasswordFile = "$PrivateKey.password",
  [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $PrivateKey)) { throw 'Updater private key was not found.' }
if (-not (Test-Path -LiteralPath $PasswordFile)) { throw 'Updater password file was not found.' }
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$config = Get-Content (Join-Path $root 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$build = if ($OutputDirectory) { $OutputDirectory } else { "F:\HuahaiBuild\release-$($config.version)" }
if ($build -notmatch '^[Ff]:\\') { throw 'Release output must be on the F: drive.' }
$temp = "F:\HuahaiBuild\tmp-release-$($config.version)"
$cargoHome = 'F:\Huahaihuabu\build-cache\cargo-home'
$npmCache = 'F:\Huahaihuabu\build-cache\npm'
$sharedNsis = 'F:\HuahaiBuild\tauri-bundler-tools\NSIS'
if (-not (Test-Path -LiteralPath 'F:\')) { throw 'Release builds require the F: drive.' }
New-Item -ItemType Directory -Force -Path $build,$temp,$cargoHome,$npmCache | Out-Null
# Tauri puts downloadable bundler tools under each target directory. Reusing a
# verified F-drive NSIS cache prevents a clean release output from attempting a
# new tool download (which can be blocked by workstation policy) or writing to
# an uncontrolled default cache location.
if (-not (Test-Path -LiteralPath $sharedNsis)) {
    $cached = Get-ChildItem -LiteralPath 'F:\HuahaiBuild' -Directory -Filter 'release-*' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        ForEach-Object { Join-Path $_.FullName '.tauri\NSIS' } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
    if (-not $cached) { throw 'No verified F-drive NSIS cache is available for the release build.' }
    New-Item -ItemType Directory -Force -Path (Split-Path $sharedNsis -Parent) | Out-Null
    Copy-Item -LiteralPath $cached -Destination $sharedNsis -Recurse -Force
}
if (-not (Test-Path -LiteralPath (Join-Path $build '.tauri\NSIS'))) {
    New-Item -ItemType Directory -Force -Path (Join-Path $build '.tauri') | Out-Null
    Copy-Item -LiteralPath $sharedNsis -Destination (Join-Path $build '.tauri\NSIS') -Recurse -Force
}
# Keep every cache, build artifact and diagnostic log off the system drive.  The
# bundled program has its own F: runtime paths; these settings cover the tools
# that create the signed installer.
$env:CARGO_TARGET_DIR = $build; $env:CARGO_HOME = $cargoHome
$env:TEMP = $temp; $env:TMP = $temp; $env:TMPDIR = $temp
$env:NPM_CONFIG_CACHE = $npmCache
$env:TAURI_SIGNING_PRIVATE_KEY = $PrivateKey
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content -LiteralPath $PasswordFile -Raw).Trim()
& (Join-Path $PSScriptRoot 'prepare-fixed-webview-runtime.ps1')
Push-Location (Join-Path $root 'src-tauri')
try { cargo tauri build --bundles nsis; if ($LASTEXITCODE) { throw 'Tauri bundle failed.' } }
finally { Pop-Location }
& (Join-Path $PSScriptRoot 'prepare-release-artifacts.ps1') -BundleDirectory "$build\release\bundle\nsis" -Version $config.version
