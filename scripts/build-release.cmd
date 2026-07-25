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
rem Keep command-processor paths ASCII-only. The app itself still keeps all user
rem data on F:\Huahaihuabu\花海画布; this avoids cmd.exe Unicode path corruption.
set "CARGO_TARGET_DIR=F:\HuahaiBuild\release-5.8.0"
set "TEMP=F:\HuahaiBuild\tmp-release-5.8.0"
set "TMP=F:\HuahaiBuild\tmp-release-5.8.0"
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
popd
exit /b %BUILD_ERROR%
