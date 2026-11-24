; Always install for the current user only (Tyler, 2026-11-24): the "just me or all users" page is skipped, and a
; silent update never asks for admin. The template's "!ifmacrodef customInstallmode" matches this name: NSIS macro
; names ignore letter case.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customFinishPage
  !define MUI_FINISHPAGE_TEXT "Made for Lila, with love from Tyler 💚$\r$\n$\r$\nClick Finish to close Setup."
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif
  !insertmacro MUI_PAGE_FINISH
!macroend
