; AgentParty NSIS customizations.
;
; Two things on top of the default install:
;
; 1. Add the bundled CLI dir (resources\bin) to the *per-user* PATH so that
;    `agent-party` is runnable by name — including from a WSL terminal, because
;    WSL appends the Windows PATH via interop (the same reason `code` works).
;
; 2. Register an Explorer context-menu entry ("AgentParty로 열기") on folders and
;    on the folder background, launching `AgentParty.exe --workspace "<folder>"`
;    so the picked directory opens as the workspace. The running instance routes
;    this into a new window (single-instance lock), so it never starts a rival
;    process on the same workspace.
;
; Per-user install (perMachine:false) → everything under HKCU. Idempotent,
; removed on uninstall, and PATH changes are broadcast so they take effect
; without a logout.

!include "WordFunc.nsh"
!include "WinMessages.nsh"

!macro customInstall
  DetailPrint "Registering agent-party on PATH"
  ReadRegStr $0 HKCU "Environment" "Path"
  ${If} $0 == ""
    WriteRegExpandStr HKCU "Environment" "Path" "$INSTDIR\resources\bin"
  ${Else}
    ; ${WordReplace} returns the string unchanged when the dir isn't present.
    ${WordReplace} "$0" "$INSTDIR\resources\bin" "" "+" $1
    ${If} "$1" == "$0"
      WriteRegExpandStr HKCU "Environment" "Path" "$0;$INSTDIR\resources\bin"
    ${EndIf}
  ${EndIf}
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000

  DetailPrint "Registering Explorer 'open here' menu"
  ; Right-click a folder.
  WriteRegStr HKCU "Software\Classes\Directory\shell\AgentParty" "" "AgentParty로 열기"
  WriteRegStr HKCU "Software\Classes\Directory\shell\AgentParty" "Icon" "$INSTDIR\AgentParty.exe,0"
  WriteRegStr HKCU "Software\Classes\Directory\shell\AgentParty\command" "" '"$INSTDIR\AgentParty.exe" --workspace "%V"'
  ; Right-click empty space inside a folder (the folder background).
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\AgentParty" "" "AgentParty로 열기"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\AgentParty" "Icon" "$INSTDIR\AgentParty.exe,0"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\AgentParty\command" "" '"$INSTDIR\AgentParty.exe" --workspace "%V"'
!macroend

!macro customUnInstall
  ReadRegStr $0 HKCU "Environment" "Path"
  ${WordReplace} "$0" ";$INSTDIR\resources\bin" "" "+" $1
  ${WordReplace} "$1" "$INSTDIR\resources\bin;" "" "+" $1
  ${WordReplace} "$1" "$INSTDIR\resources\bin" "" "+" $1
  WriteRegExpandStr HKCU "Environment" "Path" "$1"
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000

  DeleteRegKey HKCU "Software\Classes\Directory\shell\AgentParty"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\AgentParty"
!macroend
