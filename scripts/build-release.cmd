@echo off
setlocal

if "%~1"=="" (
  echo Usage: build-release.cmd ^<updater-private-key-path^> [key-password]
  exit /b 2
)

if not exist "%~1" (
  echo Updater private key not found: %~1
  exit /b 2
)

pushd "%~dp0..\src-tauri"
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat" -arch=x64
for /f "usebackq delims=" %%V in (`powershell -NoProfile -Command "(Get-Content -LiteralPath 'tauri.conf.json' -Raw | ConvertFrom-Json).version"`) do set "HH_VERSION=%%V"
if "%HH_VERSION%"=="" (
  echo Unable to read application version from tauri.conf.json
  popd
  exit /b 2
)
rem Keep command-processor build paths ASCII-only.
set "CARGO_TARGET_DIR=F:\HuahaiBuild\release-%HH_VERSION%"
set "TEMP=F:\HuahaiBuild\tmp-release-%HH_VERSION%"
set "TMP=F:\HuahaiBuild\tmp-release-%HH_VERSION%"
set "TMPDIR=F:\HuahaiBuild\tmp-release-%HH_VERSION%"
if not exist "%CARGO_TARGET_DIR%" mkdir "%CARGO_TARGET_DIR%"
if not exist "%TEMP%" mkdir "%TEMP%"
set "TAURI_SIGNING_PRIVATE_KEY=%~1"
if "%~2"=="" (
  if not exist "%~1.password" (
    echo Updater key password file not found: %~1.password
    popd
    exit /b 2
  )
  set /p "TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<"%~1.password"
) else (
  set "TAURI_SIGNING_PRIVATE_KEY_PASSWORD=%~2"
)
"C:\Users\DXY\.cargo\bin\cargo.exe" tauri build --bundles nsis
set "BUILD_ERROR=%ERRORLEVEL%"
if not "%BUILD_ERROR%"=="0" (
  popd
  exit /b %BUILD_ERROR%
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0prepare-release-artifacts.ps1" -BundleDirectory "%CARGO_TARGET_DIR%\release\bundle\nsis" -Version "%HH_VERSION%"
set "BUILD_ERROR=%ERRORLEVEL%"
popd
exit /b %BUILD_ERROR%
