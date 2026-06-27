; AgentParty NSIS customizations.
;
; Add the bundled CLI dir (resources\bin) to the *per-user* PATH so that
; `agent-party` is runnable by name — including from a WSL terminal, because WSL
; appends the Windows PATH via interop (the same reason `code` works). Per-user
; install → HKCU\Environment, so we never touch the system PATH.
;
; Idempotent (no duplicates), removed on uninstall, and broadcast so it takes
; effect without a logout.

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
!macroend

!macro customUnInstall
  ReadRegStr $0 HKCU "Environment" "Path"
  ${WordReplace} "$0" ";$INSTDIR\resources\bin" "" "+" $1
  ${WordReplace} "$1" "$INSTDIR\resources\bin;" "" "+" $1
  ${WordReplace} "$1" "$INSTDIR\resources\bin" "" "+" $1
  WriteRegExpandStr HKCU "Environment" "Path" "$1"
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend
