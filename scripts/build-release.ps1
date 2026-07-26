param(
  [Parameter(Mandatory = $true)][string]$PrivateKey,
  [string]$PasswordFile = "$PrivateKey.password"
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $PrivateKey)) { throw 'Updater private key was not found.' }
if (-not (Test-Path -LiteralPath $PasswordFile)) { throw 'Updater password file was not found.' }
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$config = Get-Content (Join-Path $root 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$build = "F:\HuahaiBuild\release-$($config.version)"
$temp = "F:\HuahaiBuild\tmp-release-$($config.version)"
$cargoHome = 'F:\Huahaihuabu\build-cache\cargo-home'
$npmCache = 'F:\Huahaihuabu\build-cache\npm'
if (-not (Test-Path -LiteralPath 'F:\')) { throw 'Release builds require the F: drive.' }
New-Item -ItemType Directory -Force -Path $build,$temp,$cargoHome,$npmCache | Out-Null
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
