!include "LogicLib.nsh"
!include "StrFunc.nsh"
!include "WinMessages.nsh"

${StrStr}
${StrRep}
${UnStrRep}

!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $0 HKCU "Environment" "Path"
  ${StrStr} $1 "$0" "$INSTDIR"
  ${If} $1 == ""
    ${If} $0 == ""
      WriteRegExpandStr HKCU "Environment" "Path" "$INSTDIR"
    ${Else}
      WriteRegExpandStr HKCU "Environment" "Path" "$0;$INSTDIR"
    ${EndIf}
  ${EndIf}
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\draftmatter.exe" "" "$INSTDIR\draftmatter.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\draftmatter.exe" "Path" "$INSTDIR"
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ReadRegStr $0 HKCU "Environment" "Path"
  ${UnStrRep} $1 "$0" "$INSTDIR;" ""
  ${UnStrRep} $2 "$1" ";$INSTDIR" ""
  ${If} $2 == "$INSTDIR"
    StrCpy $2 ""
  ${EndIf}
  WriteRegExpandStr HKCU "Environment" "Path" "$2"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\draftmatter.exe"
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend
