; Steps added to Tauri's NSIS installer.
; Kysland can hide the volume flyout and reserve screen space, so it is asked to quit cleanly
; (it restores everything) instead of being killed.
; An update runs the old uninstaller with /UPDATE ($UpdateMode = 1): anything that only
; concerns a real uninstall is therefore conditional.

!macro NSIS_HOOK_PREINSTALL
  IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 +3
    nsExec::Exec '"$INSTDIR\${MAINBINARYNAME}.exe" --quit'
    Sleep 1500
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Update: resources of older versions that no longer exist (themes removed in 0.2.0).
  RMDir /r "$INSTDIR\themes"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 +3
    nsExec::Exec '"$INSTDIR\${MAINBINARYNAME}.exe" --quit'
    Sleep 1500
  ${If} $UpdateMode <> 1
    ; Cleanup in case the app crashed, then remove the start-with-Windows task.
    ; The config in ~\.config\kysland is kept.
    nsExec::Exec '"$INSTDIR\${MAINBINARYNAME}.exe" --repair'
    nsExec::Exec 'schtasks.exe /Delete /TN "Kysland" /F'
  ${EndIf}
!macroend
