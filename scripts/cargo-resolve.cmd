@echo off
pushd "%~dp0..\src-tauri"
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat" -arch=x64
"C:\Users\DXY\.cargo\bin\cargo.exe" check
popd
