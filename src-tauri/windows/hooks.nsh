; Steps added to Tauri's NSIS installer.
; Kysland can hide the volume flyout and reserve screen space, so it is asked to quit cleanly
; (it restores everything) instead of being killed.
; An update runs the old uninstaller with /UPDATE ($UpdateMode = 1): anything that only
; concerns a real uninstall is therefore conditional.

; Waits (up to 10 s) until Kysland has really quit and let go of its executable: a fixed pause
; wasn't always enough, and a file still in use is silently skipped (half-done update).
!macro KYSLAND_WAIT_UNLOCKED ID
  Push $R8
  Push $R9
  StrCpy $R9 0
  kysland_wait_${ID}:
    ClearErrors
    FileOpen $R8 "$INSTDIR\${MAINBINARYNAME}.exe" a
    IfErrors kysland_busy_${ID}
    FileClose $R8
    Goto kysland_free_${ID}
  kysland_busy_${ID}:
    IntOp $R9 $R9 + 1
    IntCmp $R9 40 kysland_free_${ID}
    Sleep 250
    Goto kysland_wait_${ID}
  kysland_free_${ID}:
  Pop $R9
  Pop $R8
!macroend

!macro NSIS_HOOK_PREINSTALL
  IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 kysland_preinstall_done
    nsExec::Exec '"$INSTDIR\${MAINBINARYNAME}.exe" --quit'
    !insertmacro KYSLAND_WAIT_UNLOCKED install
  kysland_preinstall_done:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Update: resources of older versions that no longer exist (themes removed in 0.2.0).
  RMDir /r "$INSTDIR\themes"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 kysland_preuninstall_done
    nsExec::Exec '"$INSTDIR\${MAINBINARYNAME}.exe" --quit'
    !insertmacro KYSLAND_WAIT_UNLOCKED uninstall
  kysland_preuninstall_done:
  ${If} $UpdateMode <> 1
    ; Cleanup in case the app crashed, then remove the start-with-Windows task.
    ; The config in ~\.config\kysland is kept.
    nsExec::Exec '"$INSTDIR\${MAINBINARYNAME}.exe" --repair'
    nsExec::Exec 'schtasks.exe /Delete /TN "Kysland" /F'
  ${EndIf}
!macroend
