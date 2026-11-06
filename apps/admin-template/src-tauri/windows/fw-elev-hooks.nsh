; NSIS hooks of the Tauri installer (tauri.conf.json bundle.windows.nsis.installerHooks).
;
; Issue #219 stage 2, ADR-0021 decision 3 (docs/adr/0021-firewall-elevated-helper.md):
; - Installing creates NO firewall rule. Allowing is an admin's explicit action in the app.
; - Uninstalling asks the helper to remove the one rule this app owns
;   (`firewall-remove-installed`; the helper checks ownership by content, decision 6, and
;   never touches a rule it does not own).
; - A failure never stops the uninstall: it only prints how to remove the rule by hand.
;
; No name is written here: the helper is `<main binary>-fw-elev` (ADR-0021 decisions 7
; and 8; `apps/admin-template/elev` tests check that its [[bin]] name and the externalBin
; of tauri.fw-elev.conf.json follow this) and the rule is `<identifier>.lan.tcp.program`
; (decision 5). Both come from Tauri's own defines (MAINBINARYNAME, BUNDLEID), so
; renaming the app needs no edit here.
;
; The uninstaller of a perMachine install runs elevated, so nsExec can start the
; helper (requireAdministrator) without another UAC prompt, and without a console
; window (its output goes to the details log). `$UpdateMode` is the
; Tauri template's flag for an update in place (same install path, so the rule
; still names the right exe): the rule is kept then.
;
; Order (Tauri 2.12.3 installer.nsi, Section Uninstall): this hook runs first, then
; Tauri's CheckIfAppIsRunning (whose Cancel aborts the uninstall), then the files are
; deleted. So the hook runs that same check itself BEFORE touching the rule: a Cancel
; then aborts with the rule still in place, and Tauri's own call afterwards finds the
; app already closed. There is no other abort point before the files are deleted.
;
; Which helper runs elevated (ADR-0021 decision 8). NOT the one in the install folder:
; its ACL is its own, so even with the folder and uninstall.exe protected, a helper
; exe that ordinary users may write would run changed code as administrator, and
; nothing this hook checks by path or attribute would notice (checking the ACL here
; first would still leave the gap between the check and the launch). Instead the
; uninstaller carries its own copy - the same file the installer installs, embedded
; at build time by the `File` below, which in the Uninstall section goes into
; uninstall.exe - extracts it to its `$PLUGINSDIR` and runs that copy with
; `firewall-remove-installed "$INSTDIR"`. The copy is not next to the main exe, so it
; is told the install folder; it checks that the fixed-name main exe there is a plain
; file under Program Files and removes only the rule it owns for that exe's final path.
; What remains: `$PLUGINSDIR` is a new folder in the elevated user's %TEMP%, which that
; user's unelevated processes can also write when an administrator approves their own
; UAC prompt. NSIS uninstallers already run from such a copy (uninstall.exe copies
; itself to %TEMP% and starts that), so this is the uninstaller's own level of risk,
; not a new one.
;
; The helper is embedded only when the build placed it (`tauri:build:windows`, i.e.
; `tauri build --config src-tauri/tauri.fw-elev.conf.json`; scripts/build-fw-elev.mjs
; writes `src-tauri/binaries/<helper>-<target triple>.exe` for Tauri's externalBin).
; A build without it (plain `tauri build`) still compiles: its uninstaller only prints
; how to remove the rule by hand. The triple is Tauri's MSVC target for ${ARCH}.

!define FW_ELEV_HOOKS_DIR "${__FILEDIR__}"

!macro NSIS_HOOK_PREUNINSTALL
  !if "${ARCH}" == "x64"
    !define /redef FW_ELEV_TRIPLE "x86_64-pc-windows-msvc"
  !else if "${ARCH}" == "arm64"
    !define /redef FW_ELEV_TRIPLE "aarch64-pc-windows-msvc"
  !else
    !define /redef FW_ELEV_TRIPLE "i686-pc-windows-msvc"
  !endif
  !define /redef FW_ELEV_SOURCE "${FW_ELEV_HOOKS_DIR}\..\binaries\${MAINBINARYNAME}-fw-elev-${FW_ELEV_TRIPLE}.exe"

  ${If} $UpdateMode <> 1
    ; May abort the uninstall (Cancel at the close prompt); nothing is changed yet.
    !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

    Push $0
    DetailPrint "Removing the Windows Firewall rule ${BUNDLEID}.lan.tcp.program (only if this app created it)..."
    ; $0 = the result: the reason it did not run, or the helper's exit code.
    !if /FileExists "${FW_ELEV_SOURCE}"
      InitPluginsDir
      ClearErrors
      ; `try`: a file that cannot be written is skipped (no Abort/Retry/Ignore prompt).
      SetOverwrite try
      File "/oname=$PLUGINSDIR\${MAINBINARYNAME}-fw-elev.exe" "${FW_ELEV_SOURCE}"
      SetOverwrite lastused
      ${If} ${Errors}
      ${OrIfNot} ${FileExists} "$PLUGINSDIR\${MAINBINARYNAME}-fw-elev.exe"
        StrCpy $0 "the helper could not be extracted"
      ${Else}
        ClearErrors
        ; nsExec pushes the exit code, or "error" when it could not start the program.
        nsExec::ExecToLog '"$PLUGINSDIR\${MAINBINARYNAME}-fw-elev.exe" firewall-remove-installed "$INSTDIR"'
        Pop $0
        ${If} $0 == "error"
          StrCpy $0 "not started"
        ${EndIf}
      ${EndIf}
    !else
      StrCpy $0 "this uninstaller does not carry the helper"
    !endif
    ${If} $0 == 0
      DetailPrint "The firewall rule was removed (or there was none)."
    ${Else}
      ; The helper's exit codes: 2 = the main exe in $INSTDIR is not a plain file
      ; under Program Files, 4 = a rule of that name that this app does not own
      ; (e.g. changed by an administrator), others = failed.
      DetailPrint "The firewall rule could not be removed (result: $0). The uninstall continues."
      DetailPrint "To remove it by hand, run in an administrator PowerShell:"
      DetailPrint "  Remove-NetFirewallRule -Name '${BUNDLEID}.lan.tcp.program'"
      DetailPrint "or delete the inbound rule '${BUNDLEID} LAN (TCP-In, program)' (group ${BUNDLEID})"
      DetailPrint "in 'Windows Defender Firewall with Advanced Security'. Check first that it is the rule you expect."
    ${EndIf}
    Pop $0
  ${EndIf}
!macroend
