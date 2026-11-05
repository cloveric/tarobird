; Electron installer hooks. Same semantics as client/src-tauri/windows/
; installer-hooks.nsh (fresh start only with consent, Host stopped before files
; change, notification shortcut ownership, history kept on update). Changes:
;   - recovery and fresh start use the standalone tarobot-installer-helper.exe:
;     an Electron executable cannot run from $PLUGINSDIR;
;   - Host shutdown asks the helper of an Electron install, or the main
;     executable of a Tauri install (`--stop-desktop-host`), whichever owns $INSTDIR.
; Notification registration/history stay with tarocub-client.exe, which must
; be the shortcut target.
!define TAROBOTHELPER "tarobot-installer-helper.exe"
Var TaroBotHostStopper

; Remember installation ownership BEFORE the upgrade page invokes the previous
; uninstaller. An interactive upgrade may not pass /UPDATE to that uninstaller.
; It must never be mistaken for a clean reinstall after its registry is removed.
Var TaroBotHadInstallation
Var TaroBotFreshPrepared
Var TaroBotClearSettings
!define MUI_CUSTOMFUNCTION_GUIINIT TaroBotRememberInstallation
Function TaroBotRememberInstallation
  ReadRegStr $TaroBotHadInstallation HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TaroBot" "UninstallString"
  ${If} $TaroBotHadInstallation == ""
    ReadRegStr $TaroBotHadInstallation HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\TaroBot" "UninstallString"
  ${EndIf}
FunctionEnd

!macro TaroBotFreshStart HELPER
  Push $R0
  ClearErrors
  ExecWait '"${HELPER}" --prepare-fresh-install' $R0
  ${If} ${Errors}
    MessageBox MB_ICONSTOP|MB_OK "无法准备全新安装，原数据未被删除。请关闭 TaroBot 后重试。$\r$\nUnable to prepare a fresh start. Close TaroBot and retry." /SD IDOK
    Abort
  ${EndIf}
  ${If} $R0 == 21
    MessageBox MB_ICONSTOP|MB_OK "这台电脑安装了共享数据的 TaroBot CLI 服务，暂不能清空。请先运行 tarobot service uninstall，再重新安装。$\r$\nA CLI service owns this host. Uninstall that service before resetting." /SD IDOK
    Abort
  ${ElseIf} $R0 == 22
    MessageBox MB_ICONSTOP|MB_OK "本机主机仍在运行，或无法确认它已退出。请退出 TaroBot、停止本机 CLI 后重试。原数据会保留。$\r$\nHost shutdown could not be confirmed. Stop TaroBot and its CLI, then retry." /SD IDOK
    Abort
  ${ElseIf} $R0 == 24
    MessageBox MB_ICONSTOP|MB_OK "安装已停止：部分旧数据已备份，但恢复原位置失败。请保留 AppData 中的 TaroBot-backup 文件夹并联系支持，不要继续启动主机。$\r$\nReset rollback is incomplete. Preserve the TaroBot-backup folders and contact support." /SD IDOK
    Abort
  ${ElseIf} $R0 <> 0
    MessageBox MB_ICONSTOP|MB_OK "无法完成全新安装，数据未被删除。请关闭 TaroBot 后重试；若仍失败，请联系支持。$\r$\nFresh start could not finish. Data has not been deleted. Close TaroBot and retry." /SD IDOK
    Abort
  ${EndIf}
  Pop $R0
!macroend

!macro TaroBotStageRecovery
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=tarobot-recovery.exe "${TB_HELPER}"
  SetOutPath "$INSTDIR"
!macroend

; Tauri CLI 2.12.1 invokes POSTINSTALL after its owned Start Menu shortcuts.
; Reuse those links, including upgrade locations; never create another shortcut.
!macro TaroBotRegisterNotificationShortcut LINK
  !insertmacro IsShortcutTarget "${LINK}" "$INSTDIR\${MAINBINARYNAME}.exe"
  Pop $R0
  ${If} $R0 = 1
    ClearErrors
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --register-notification-shortcut "${LINK}"' $R0
    ${If} ${Errors}
    ${OrIf} $R0 <> 0
      DetailPrint "TaroBot notification shortcut registration failed."
      MessageBox MB_ICONSTOP|MB_OK "TaroBot 通知注册失败，请保留开始菜单快捷方式后重试安装。$\r$\nNotification registration failed. Retry installation with a Start Menu shortcut." /SD IDOK
      Abort
    ${EndIf}
    StrCpy $R1 1
  ${EndIf}
!macroend

!macro TaroBotStopLocalHost INSTALLER
  ; The companion had no runtime. Never signal unrelated node.exe processes.
  ; An Electron install answers through its helper; a Tauri install through
  ; its own main executable, exactly as its hooks did.
  StrCpy $TaroBotHostStopper ""
  ${If} ${FileExists} "$INSTDIR\${TAROBOTHELPER}"
    StrCpy $TaroBotHostStopper "$INSTDIR\${TAROBOTHELPER}"
  ${ElseIf} ${FileExists} "$INSTDIR\host\node.exe"
    ${AndIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $TaroBotHostStopper "$INSTDIR\${MAINBINARYNAME}.exe"
  ${EndIf}
  ${If} $TaroBotHostStopper != ""
    Push $R0
    ClearErrors
    ExecWait '"$TaroBotHostStopper" --stop-desktop-host' $R0
    ${If} ${Errors}
    ${OrIf} $R0 <> 0
      !if "${INSTALLER}" == "1"
        ; The installed binary may predate native recovery and have a broken
        ; Node graph. Use the new helper only to VERIFY shutdown, never pretend
        ; to stop through a staged executable with no adjacent host runtime.
        !insertmacro TaroBotStageRecovery
        ClearErrors
        ExecWait '"$PLUGINSDIR\tarobot-recovery.exe" --confirm-host-stopped' $R0
        ${If} ${Errors}
          StrCpy $R0 1
        ${EndIf}
        Delete "$PLUGINSDIR\tarobot-recovery.exe"
      !endif
    ${EndIf}
    ${If} ${Errors}
    ${OrIf} $R0 <> 0
      MessageBox MB_ICONSTOP|MB_OK "无法停止本机主机，请退出 TaroBot 后重试。数据会保留。$\r$\nUnable to stop the local host. Please quit TaroBot and retry." /SD IDOK
      Abort
    ${EndIf}
    Pop $R0
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  StrCpy $TaroBotFreshPrepared 0
  ; Silent/passive installs and every upgrade keep state. Only an interactive
  ; reinstall with residual data offers a fresh start, and only after consent.
  ${IfNot} ${Silent}
  ${AndIf} $PassiveMode <> 1
  ${AndIf} $UpdateMode <> 1
  ${AndIf} $TaroBotHadInstallation == ""
    ${If} ${FileExists} "$APPDATA\com.tarobot.client"
    ${OrIf} ${FileExists} "$LOCALAPPDATA\com.tarobot.client"
    ${OrIf} ${FileExists} "$APPDATA\com.tarocub.client"
    ${OrIf} ${FileExists} "$LOCALAPPDATA\com.tarocub.client"
      MessageBox MB_ICONQUESTION|MB_YESNOCANCEL|MB_DEFBUTTON2 "发现上次安装留下的 TaroBot 数据。是否全新开始？$\r$\n$\r$\n是：备份这台电脑的旧配置、配对和本地数据，安装后像第一次使用一样重新配置。$\r$\n否：继续使用旧数据。$\r$\n取消：停止安装。$\r$\n$\r$\n不会修改 Mac mini 或其他主机。旧数据会保留在 AppData 的 TaroBot-backup 文件夹。$\r$\n$\r$\nPrevious data found. Start fresh?$\r$\nYes: back up local data and set up again. No: keep existing data." IDYES tarobot_fresh_install IDNO tarobot_keep_data
      Abort
      tarobot_fresh_install:
      !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
      !insertmacro TaroBotStageRecovery
      !insertmacro TaroBotFreshStart "$PLUGINSDIR\tarobot-recovery.exe"
      StrCpy $TaroBotFreshPrepared 1
      Delete "$PLUGINSDIR\tarobot-recovery.exe"
      tarobot_keep_data:
    ${EndIf}
  ${EndIf}
  ${If} $TaroBotFreshPrepared <> 1
    !insertmacro TaroBotStopLocalHost 1
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $R0
  Push $R1
  StrCpy $R1 0
  !insertmacro TaroBotRegisterNotificationShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  ${If} $R1 = 0
    !insertmacro TaroBotRegisterNotificationShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  ${EndIf}
  ${If} $R1 = 0
    ; /NS or an upgrade with a deleted shortcut: do not report notification-ready.
    Delete "$INSTDIR\tarocub-notification-shortcut.json"
    DetailPrint "No owned Start Menu shortcut; TaroBot desktop notifications are unavailable."
  ${EndIf}
  ; Tauri -> Electron: an update skips the old uninstaller, so the Tauri Host
  ; runtime in host\ would stay forever. The helper takes no path: it removes
  ; exactly host\ beside itself, only an identified bundled runtime without
  ; reparse points, after resources\host is written and the Host is stopped.
  ; A refusal keeps the folder and never fails the installation.
  ${If} ${FileExists} "$INSTDIR\host\*.*"
    ClearErrors
    ExecWait '"$INSTDIR\${TAROBOTHELPER}" --remove-legacy-host-runtime' $R0
    ${If} ${Errors}
    ${OrIf} $R0 <> 0
      DetailPrint "TaroBot kept the previous host folder (code $R0)."
    ${EndIf}
  ${EndIf}
  Pop $R1
  Pop $R0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\tarocub-notification-shortcut.json"
  RMDir "$INSTDIR"
  ${If} $TaroBotClearSettings = 1
    DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty SHCTX "${MANUKEY}"
    DeleteRegValue HKCU "${MANUPRODUCTKEY}" "Installer Language"
    DeleteRegKey /ifempty HKCU "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty HKCU "${MANUKEY}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro TaroBotStopLocalHost 0
  ${If} $UpdateMode <> 1
  ${AndIf} $DeleteAppDataCheckboxState = 1
    MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON2 "移除这台电脑的 TaroBot 配置并保留恢复备份？$\r$\n$\r$\n旧配置和本地数据会移入 AppData 的 TaroBot-backup 文件夹，重装后从首次配置开始。这不是安全擦除。不会更改其他主机。$\r$\n$\r$\nRemove local configuration and keep a recovery backup? This is not secure erasure." IDYES tarobot_uninstall_fresh
    Abort
    tarobot_uninstall_fresh:
    !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
    !insertmacro TaroBotFreshStart "$INSTDIR\${TAROBOTHELPER}"
    ; The native helper has backed up the fixed Known Folders. Never let the
    ; template recursively delete shared CLI data or an environment-derived path.
    StrCpy $DeleteAppDataCheckboxState 0
    StrCpy $TaroBotClearSettings 1
  ${EndIf}
  ; Updates retain history. An old install must not clear a newer owner's notices.
  ${If} $UpdateMode <> 1
    Push $R0
    ReadRegStr $R0 SHCTX "Software\Classes\tarocub\shell\open\command" ""
    ${If} $R0 == '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"'
      !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
      ClearErrors
      ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --clear-notification-history' $R0
      ${If} ${Errors}
      ${OrIf} $R0 <> 0
        MessageBox MB_ICONSTOP|MB_OK "无法清理 TaroCub 系统通知，请重试卸载。$\r$\nUnable to clear TaroBot notifications. Retry uninstalling." /SD IDOK
        Abort
      ${EndIf}
    ${EndIf}
    Pop $R0
  ${EndIf}
!macroend
