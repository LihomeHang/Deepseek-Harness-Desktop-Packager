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

; electron-builder checks for running processes before both installs and
; uninstalls. The desktop app also owns a bundled Node backend, which is not
; always terminated when only the Electron executable is closed. End every
; process rooted in the current installation directory (including descendants)
; before files are replaced, so an in-place upgrade does not leave resources
; locked and fall back to a manual uninstall.
!macro CloseDeepSeekHarnessProcesses
  DetailPrint "Closing DeepSeek Harness..."
  ; The direct image-name shutdown also detects a process that was launched
  ; with higher privileges and whose executable path cannot be inspected.
  nsExec::Exec `"$SYSDIR\taskkill.exe" /IM "${APP_FILENAME}.exe" /T /F`
  Pop $0
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$deadline = [DateTime]::UtcNow.AddSeconds(12); do { $$processes = @(Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase') }); if ($$processes.Count -eq 0) { exit 0 }; foreach ($$process in $$processes) { & '$SYSDIR\taskkill.exe' /PID $$process.ProcessId /T /F 2>$$null | Out-Null }; Start-Sleep -Milliseconds 400 } while ([DateTime]::UtcNow -lt $$deadline); exit 1"`
  Pop $0
!macroend

Function CloseDeepSeekHarnessProcesses
  !insertmacro CloseDeepSeekHarnessProcesses
FunctionEnd

Function un.CloseDeepSeekHarnessProcesses
  !insertmacro CloseDeepSeekHarnessProcesses
FunctionEnd

!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
  Call un.CloseDeepSeekHarnessProcesses
  !else
  Call CloseDeepSeekHarnessProcesses
  !endif
!macroend

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
