!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "MUI2.nsh"

!macro WeMailSkipIfInstalled
  ${If} ${isUpdated}
  ${OrIf} $WeMailExistingInstall == "1"
    Abort
  ${EndIf}
!macroend

!macro customInit
  StrCpy $WeMailExistingInstall "0"
  ${If} $hasPerUserInstallation == "1"
  ${OrIf} $hasPerMachineInstallation == "1"
    StrCpy $WeMailExistingInstall "1"
  ${EndIf}
!macroend

!macro customInstallMode
  ${If} $hasPerUserInstallation == "1"
  ${AndIf} $hasPerMachineInstallation == "0"
    StrCpy $isForceCurrentInstall "1"
  ${ElseIf} $hasPerUserInstallation == "0"
  ${AndIf} $hasPerMachineInstallation == "1"
    StrCpy $isForceMachineInstall "1"
  ${EndIf}
!macroend

!macro customCheckAppRunning
  System::Call 'Kernel32::SetEnvironmentVariable(t "WEMAIL_INSTALL_DIR", t "$INSTDIR")'
  nsExec::Exec `"$PowerShellPath" -NoProfile -ExecutionPolicy Bypass -Command "$$root=[IO.Path]::GetFullPath($$env:WEMAIL_INSTALL_DIR).TrimEnd('\')+'\'; if(@(Get-CimInstance Win32_Process | ? { $$_.Path -and [IO.Path]::GetFullPath($$_.Path).StartsWith($$root,[StringComparison]::OrdinalIgnoreCase) }).Count){ exit 0 }; exit 1"`
  Pop $R0
  ${If} $R0 == 0
    ${IfNot} ${isUpdated}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK wemail_close_retry
      Quit
    ${EndIf}
    wemail_close_retry:
      nsExec::Exec `"$PowerShellPath" -NoProfile -ExecutionPolicy Bypass -Command "$$root=[IO.Path]::GetFullPath($$env:WEMAIL_INSTALL_DIR).TrimEnd('\')+'\'; $$self=Get-CimInstance Win32_Process -Filter ('ProcessId='+$$PID); $$parentPid=$$self.ParentProcessId; for($$i=0; $$i -lt 20; $$i++){ $$running=@(Get-CimInstance Win32_Process | ? { $$_.ProcessId -ne $$parentPid -and $$_.Path -and [IO.Path]::GetFullPath($$_.Path).StartsWith($$root,[StringComparison]::OrdinalIgnoreCase) }); if($$running.Count -eq 0){ exit 0 }; $$running | % { & taskkill.exe /PID $$_.ProcessId /T /F | Out-Null }; Start-Sleep -Milliseconds 250 }; exit 1"`
      Pop $R0
      ${If} $R0 != 0
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY wemail_close_retry
        Quit
      ${EndIf}
  ${EndIf}
  !ifndef BUILD_UNINSTALLER
    ReadRegStr $R1 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
    ${If} $R1 == "1.0.0"
    ${OrIf} $R1 == "1.0.1"
    ${OrIf} $R1 == "1.0.2"
      DetailPrint "Bypassing legacy WeMail $R1 uninstaller for in-place upgrade"
      DeleteRegValue SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
    ${EndIf}
  !endif
  System::Call 'Kernel32::SetEnvironmentVariable(t "WEMAIL_INSTALL_DIR", t 0)'
!macroend

!macro customUnInstallCheck
  ${If} $R0 != 0
    DetailPrint "Previous WeMail uninstaller returned $R0; continuing with in-place upgrade"
    ClearErrors
    StrCpy $R0 0
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER
Var WeMailExistingInstall
Var WeMailDataDir
Var WeMailDataDirField
Var WeMailDataDirBrowse
Var WeMailCreateDesktopShortcut
Var WeMailDesktopShortcutCheckbox

; electron-builder may include this file before adding its plugin directory.
; Emit the page functions only after the complete installer header is ready.
!macro customHeader
Function WeMailDataDirPageCreate
  !insertmacro WeMailSkipIfInstalled
  ${If} $WeMailDataDir == ""
    IfFileExists "$APPDATA\wemail\data-location" 0 +5
      FileOpen $0 "$APPDATA\wemail\data-location" r
      FileRead $0 $WeMailDataDir
      FileClose $0
      Goto +2
    StrCpy $WeMailDataDir "$APPDATA\wemail\data"
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "数据存储位置" "选择邮件、附件和本地 AI 数据的保存目录"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "如果系统盘空间有限，可以现在将 WeMail 数据放到其他本地磁盘。安装后仍可在“设置 → 高级设置 → 数据与隐私”中迁移。"
  Pop $0
  ${NSD_CreateText} 0 36u 77% 13u "$WeMailDataDir"
  Pop $WeMailDataDirField
  ${NSD_CreateBrowseButton} 80% 35u 20% 15u "浏览…"
  Pop $WeMailDataDirBrowse
  ${NSD_OnClick} $WeMailDataDirBrowse WeMailBrowseDataDir
  ${NSD_CreateLabel} 0 58u 100% 20u "建议选择专用的空文件夹，例如 D:\WeMailData。不要使用磁盘根目录、网络目录或移动硬盘。"
  Pop $0
  nsDialogs::Show
FunctionEnd

Function WeMailBrowseDataDir
  ${NSD_GetText} $WeMailDataDirField $WeMailDataDir
  nsDialogs::SelectFolderDialog "选择 WeMail 数据目录" "$WeMailDataDir"
  Pop $0
  ${If} $0 != error
    StrCpy $WeMailDataDir $0
    ${NSD_SetText} $WeMailDataDirField $WeMailDataDir
  ${EndIf}
FunctionEnd

Function WeMailDataDirPageLeave
  ${NSD_GetText} $WeMailDataDirField $WeMailDataDir
  ${If} $WeMailDataDir == ""
    MessageBox MB_ICONEXCLAMATION|MB_OK "请选择数据存储目录。"
    Abort
  ${EndIf}
  StrLen $0 $WeMailDataDir
  ${If} $0 <= 3
    MessageBox MB_ICONEXCLAMATION|MB_OK "不能直接使用磁盘根目录，请选择一个专用文件夹。"
    Abort
  ${EndIf}
  CreateDirectory "$WeMailDataDir"
  FindFirst $0 $1 "$WeMailDataDir\*"
  ${DoWhile} $1 != ""
    ${If} $1 != "."
    ${AndIf} $1 != ".."
      FindClose $0
      MessageBox MB_ICONEXCLAMATION|MB_YESNO "所选目录不是空文件夹。继续可能与已有文件混合，是否仍要使用？" IDYES data_dir_confirmed
      Abort
    ${EndIf}
    FindNext $0 $1
  ${Loop}
  FindClose $0
  data_dir_confirmed:
FunctionEnd

Function WeMailInstallOptionsPageCreate
  !insertmacro WeMailSkipIfInstalled

  ${If} $WeMailCreateDesktopShortcut == ""
    StrCpy $WeMailCreateDesktopShortcut ${BST_CHECKED}
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "安装选项" "选择安装完成后创建的快捷方式"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateCheckbox} 0 8u 100% 14u "创建桌面快捷方式"
  Pop $WeMailDesktopShortcutCheckbox
  ${NSD_SetState} $WeMailDesktopShortcutCheckbox $WeMailCreateDesktopShortcut
  ${NSD_CreateLabel} 0 32u 100% 28u "快捷方式和 WeMail 主程序将使用相同的 WeMail Logo。以后也可以从开始菜单启动 WeMail。"
  Pop $0
  nsDialogs::Show
FunctionEnd

Function WeMailInstallOptionsPageLeave
  ${NSD_GetState} $WeMailDesktopShortcutCheckbox $WeMailCreateDesktopShortcut
FunctionEnd
!macroend

!macro customPageAfterChangeDir
  Page custom WeMailDataDirPageCreate WeMailDataDirPageLeave
  Page custom WeMailInstallOptionsPageCreate WeMailInstallOptionsPageLeave
!macroend
!endif

!macro customInstall
  ${If} $WeMailDataDir != ""
    CreateDirectory "$APPDATA\wemail"
    CreateDirectory "$WeMailDataDir"
    FileOpen $1 "$APPDATA\wemail\data-location" w
    FileWrite $1 "$WeMailDataDir"
    FileClose $1
    DetailPrint "WeMail data directory: $WeMailDataDir"
  ${EndIf}
  ${If} $WeMailCreateDesktopShortcut == ${BST_CHECKED}
    CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\resources\assets\wemail.ico" 0 SW_SHOWNORMAL "" "${APP_DESCRIPTION}"
    WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"
    DetailPrint "Created WeMail desktop shortcut"
  ${ElseIf} $WeMailCreateDesktopShortcut == ${BST_UNCHECKED}
    Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
    DetailPrint "Desktop shortcut not selected"
  ${EndIf}
  ; Upgrade path: the options page (with the desktop-shortcut checkbox) is
  ; skipped via WeMailSkipIfInstalled on updates, so $WeMailCreateDesktopShortcut
  ; stays empty. 1.0.0 never created a shortcut, so upgrades from it would land
  ; here without one. Create it if missing; leave existing shortcuts untouched.
  ; Fresh installs always set BST_CHECKED/BST_UNCHECKED via the page, so an
  ; explicit opt-out is never overridden by this branch.
  ${If} $WeMailCreateDesktopShortcut == ""
    IfFileExists "$DESKTOP\${SHORTCUT_NAME}.lnk" wemail_desktop_shortcut_present
      CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\resources\assets\wemail.ico" 0 SW_SHOWNORMAL "" "${APP_DESCRIPTION}"
      WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"
      DetailPrint "Created WeMail desktop shortcut during upgrade (was missing)"
    wemail_desktop_shortcut_present:
  ${EndIf}
  ; Never modify certificate trust stores during application installation.
  ; Self-signed development certificates require a separate, explicit action.
!macroend

!macro customUnInstall
  WinShell::UninstShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk"
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
!macroend
