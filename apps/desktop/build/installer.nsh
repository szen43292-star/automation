; Before installing or uninstalling, stop FlowForge and the processes it runs from the install folder
; (its bundled Node.js server and PostgreSQL), which would otherwise keep files locked:
;   1. close FlowForge.exe - the server exits with it (it watches its parent)
;   2. stop PostgreSQL cleanly with pg_ctl
;   3. force-stop anything still running from the install folder
; The installer is a 32-bit process: it starts the 64-bit PowerShell (through "sysnative") and finds
; processes through WMI, which reports executable paths of 64-bit processes too. The folder is passed
; through an environment variable so any characters in the path are safe.
!macro FlowForgeStopProcesses Filter
  StrCpy $R9 "$WINDIR\sysnative\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists $R9 +2 0
    StrCpy $R9 "powershell.exe"
  nsExec::Exec `"$R9" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$dir = $$env:FLOWFORGE_INSTDIR.TrimEnd('\') + '\'; Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$dir, [StringComparison]::OrdinalIgnoreCase) ${Filter} } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Pop $0
!macroend

!macro customCheckAppRunning
  System::Call 'Kernel32::SetEnvironmentVariable(t "FLOWFORGE_INSTDIR", t "$INSTDIR")i'
  !insertmacro FlowForgeStopProcesses "-and $$_.Name -eq 'FlowForge.exe'"
  Sleep 2000
  IfFileExists "$INSTDIR\resources\runtime\postgres\bin\pg_ctl.exe" 0 +3
    nsExec::Exec '"$INSTDIR\resources\runtime\postgres\bin\pg_ctl.exe" stop -D "$APPDATA\FlowForge\database" -m fast -w -t 30'
    Pop $0
  !insertmacro FlowForgeStopProcesses ""
  Sleep 1000
!macroend
