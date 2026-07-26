@echo off
set "CARGO_HOME=F:\Huahaihuabu\build-cache\cargo-home"
set "CARGO_TARGET_DIR=F:\Huahaihuabu\build-cache\verified-commits"
set "TEMP=F:\Huahaihuabu\build-tmp\verified-commits"
set "TMP=F:\Huahaihuabu\build-tmp\verified-commits"
set "TMPDIR=F:\Huahaihuabu\build-tmp\verified-commits"
set "NPM_CONFIG_CACHE=F:\Huahaihuabu\build-cache\npm"
if not exist "%CARGO_HOME%" mkdir "%CARGO_HOME%"
if not exist "%CARGO_TARGET_DIR%" mkdir "%CARGO_TARGET_DIR%"
if not exist "%TEMP%" mkdir "%TEMP%"
if not exist "%NPM_CONFIG_CACHE%" mkdir "%NPM_CONFIG_CACHE%"
pushd "%~dp0..\src-tauri"
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat" -arch=x64
rem VsDevCmd is allowed to configure the compiler, but never the storage roots.
set "CARGO_HOME=F:\Huahaihuabu\build-cache\cargo-home"
set "CARGO_TARGET_DIR=F:\Huahaihuabu\build-cache\verified-commits"
set "TEMP=F:\Huahaihuabu\build-tmp\verified-commits"
set "TMP=F:\Huahaihuabu\build-tmp\verified-commits"
set "TMPDIR=F:\Huahaihuabu\build-tmp\verified-commits"
set "NPM_CONFIG_CACHE=F:\Huahaihuabu\build-cache\npm"
"C:\Users\DXY\.cargo\bin\cargo.exe" check --locked
popd
