; 花海画布 is intentionally an F: drive local-first application.  This hook runs
; before any application files are copied by the generated Tauri NSIS installer.
!macro NSIS_HOOK_PREINSTALL
  StrCpy $INSTDIR "F:\Huahaihuabu\花海画布"
  CreateDirectory "$INSTDIR"
!macroend
