; Adds the bundled dsh and pnpm command shims to the current user's PATH.
;
; The shim at "$INSTDIR\resources\bin\dsh.cmd" launches the bundled Node
; runtime ("$INSTDIR\resources\node-runtime\node.exe") and the bundled
; @deepseek-ai/dsh CLI ("$INSTDIR\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js"),
; while pnpm.cmd provides the package manager used by `dsh plugin`. No
; separate Node.js or pnpm installation is required.

!include "StrFunc.nsh"
!include "WordFunc.nsh"
${StrStr}
${UnStrStr}

!macro customInstall
  DetailPrint "Adding dsh to the user PATH"
  ReadRegStr $0 HKCU "Environment" "Path"
  ${StrStr} $1 "$0" "$INSTDIR\resources\bin"
  ${If} $1 == ""
    ${If} $0 == ""
      StrCpy $0 "$INSTDIR\resources\bin"
    ${Else}
      StrCpy $0 "$0;$INSTDIR\resources\bin"
    ${EndIf}
    WriteRegExpandStr HKCU "Environment" "Path" "$0"
    SendMessage 0xffff 0x1a 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}
!macroend

!macro customUnInstall
  DetailPrint "Removing dsh from the user PATH"
  ReadRegStr $0 HKCU "Environment" "Path"
  ${UnStrStr} $1 "$0" "$INSTDIR\resources\bin"
  ${If} $1 != ""
    ${WordReplace} "$0" "$INSTDIR\resources\bin" "" "+" $0
    WriteRegExpandStr HKCU "Environment" "Path" "$0"
    SendMessage 0xffff 0x1a 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}
!macroend
