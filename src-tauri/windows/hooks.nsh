; Étapes ajoutées à l'installateur NSIS de Tauri.
; Kysland peut masquer la barre des tâches / la pastille de volume et réserver de l'espace à
; l'écran : on le fait quitter proprement (il restaure tout) plutôt que de le laisser tuer.
; Une mise à jour lance l'ancien désinstalleur avec /UPDATE ($UpdateMode = 1) : ce qui ne
; concerne qu'une vraie désinstallation est donc conditionné.

!macro NSIS_HOOK_PREINSTALL
  IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 +3
    nsExec::Exec '"$INSTDIR\${MAINBINARYNAME}.exe" --quit'
    Sleep 1500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 +3
    nsExec::Exec '"$INSTDIR\${MAINBINARYNAME}.exe" --quit'
    Sleep 1500
  ${If} $UpdateMode <> 1
    ; Remise d'aplomb au cas où l'appli aurait planté, puis retrait du lancement au démarrage.
    ; La config dans ~\.config\kysland est conservée.
    nsExec::Exec '"$INSTDIR\${MAINBINARYNAME}.exe" --repair'
    nsExec::Exec 'schtasks.exe /Delete /TN "Kysland" /F'
  ${EndIf}
!macroend
