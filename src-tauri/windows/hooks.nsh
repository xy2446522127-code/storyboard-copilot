; This hook runs before the generated Tauri NSIS installer copies app files.
; The file is saved as UTF-8 with a BOM: NSIS needs that marker to preserve
; the Chinese install folder name instead of interpreting it with an ANSI codepage.
!macro NSIS_HOOK_PREINSTALL
  StrCpy $INSTDIR "F:\Huahaihuabu\花海画布"
  CreateDirectory "$INSTDIR"
!macroend
