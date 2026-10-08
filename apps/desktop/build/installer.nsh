; Before installing or uninstalling, stop FlowForge and the processes it runs from the install folder
; (its bundled Node.js server and PostgreSQL), which would otherwise keep files locked:
;   1. close FlowForge.exe - the server exits with it (it watches its parent)
;   2. stop PostgreSQL cleanly with pg_ctl
;   3. force-stop anything still running from the install folder
; The folder is passed through an environment variable so any characters in the path are safe.
!macro FlowForgeStopProcesses Names
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$dir = $$env:FLOWFORGE_INSTDIR.TrimEnd('\') + '\'; Get-Process ${Names} -ErrorAction SilentlyContinue | Where-Object { $$_.Path -and $$_.Path.StartsWith($$dir, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force -ErrorAction SilentlyContinue"`
  Pop $0
!macroend

!macro customCheckAppRunning
  System::Call 'Kernel32::SetEnvironmentVariable(t "FLOWFORGE_INSTDIR", t "$INSTDIR")i'
  !insertmacro FlowForgeStopProcesses "FlowForge"
  Sleep 1500
  IfFileExists "$INSTDIR\resources\runtime\postgres\bin\pg_ctl.exe" 0 +3
    nsExec::Exec '"$INSTDIR\resources\runtime\postgres\bin\pg_ctl.exe" stop -D "$APPDATA\FlowForge\database" -m fast -w -t 30'
    Pop $0
  !insertmacro FlowForgeStopProcesses ""
  Sleep 500
!macroend
