# ADR-0021: For stage 2, a UAC-elevated helper adds and removes a single per-executable firewall rule

> 日本語: [0021-firewall-elevated-helper.md](0021-firewall-elevated-helper.md)

- Status: Accepted (2026-10-22; decisions 1-4 are the owner's decisions; decisions 5 onward were confirmed by the reviews of E2-E4 (#474, #475, #476) and the Windows real-machine test)
- Date: 2026-10-22
- Related: Issue #219 (the 2026-10-11 design review, the 2026-10-21 plan and security audit, the same day's addendum on automatic port selection, the 2026-10-22 scope change) / #459 / #460 /
  [conventions.md](../conventions.en.md) §1, §3, §6 /
  [ADR-0001](0001-rest-tauri-two-path-symmetry.en.md), [ADR-0002](0002-minimal-dependencies.en.md) /
  stage 1: `apps/admin-template/src/routes/(app)/settings/firewallInfo.ts`, `apps/admin-template/src-tauri/src/firewall_status.rs`

## Context

Exposing Banto's built-in server on the LAN needs an inbound allow rule in the Windows built-in
firewall (Windows Defender Firewall). Issue #219 supports this in two stages.

- **Stage 1 (no elevation, implemented)**: "Server & connectivity" shows and copies what the rule
  needs (the executable's absolute path, inbound, TCP port, profile, remote range) plus a PowerShell
  command for an administrator. It reports, read-only, whether Banto's rule exists
  (`firewall_rule_status`) and records reach checks from another device. Rule names are
  `<identifier>.lan.tcp.program` / `<identifier>.lan.tcp.port`, the group is `<identifier>`
  (`firewallRuleNames` in `firewallInfo.ts`, `rule_names` in `firewall_status.rs`).
- **Stage 2 (this ADR)**: add and remove the allow rule from inside the app with one UAC approval.
  The app keeps running unelevated; only a small helper that accepts fixed actions is elevated.

What has to be decided:

- **The rule's shape.** Since v6.8.0 the server picks a free port in +1..+19 at startup when the saved
  port is busy, and saves it (#460, `PORT_FALLBACK_SPAN` in `crates/banto-server/src/server.rs`). That
  switch happens without UAC, so a port-pinned rule silently goes stale. On the other hand, as the
  2026-10-21 audit (priority 3) points out, a per-executable rule is not "skipping port tracking"
  but "widening what is allowed".
- **What makes the helper and the exe next to it trustworthy.** "Same folder" or "under the install
  directory" string checks alone do not stop an ordinary user from swapping the helper, the app or a
  DLL (audit priority 2). The template's Tauri config has no NSIS settings today, so it installs with
  the default currentUser mode (under `%LOCALAPPDATA%`, writable by the user), which conflicts with
  trusting an elevated helper.
- **In-app authorization and audit versus UAC** (design review 1 of 2026-10-11), **drift between what
  was confirmed and the rule actually created** (design review 2, audit priority 4), and **how to treat
  rules Banto does not own** (audit priority 4).
- **Dependencies.** Launching through UAC and embedding a manifest need Win32 APIs and resource
  compilation ([conventions.md](../conventions.en.md) §3, [ADR-0002](0002-minimal-dependencies.en.md)).

The models are banto-industrial's `apps/chronogazer/elev` (`chronogazer-elev`) and
`crates/banto-service-elev` (`launch.rs`). banto cannot depend on industrial, so the generic parts are
brought back into banto. As the audit notes, though, `launch.rs` is an argument-checking and runas
launching part and does not vouch for the exe's authenticity, and the Hub helper lookup's fallback to
the parent folder or the CWD is not carried over.

## Decision

### 1. One per-executable rule (owner decision)

The helper creates exactly this one rule.

| Field              | Value                                          |
| ------------------ | ---------------------------------------------- |
| Direction / Action | Inbound / Allow                                |
| Program            | the app's exe (next to the helper, decision 8) |
| Protocol           | TCP                                            |
| LocalPort          | **not specified**                              |
| Profile            | Private                                        |
| RemoteAddress      | LocalSubnet                                    |

Why:

- Automatic port selection (#460) happens without UAC; a port-pinned rule would silently go stale.
  A per-executable rule stays one rule when the port changes, with no UAC per port change.
- Adding or removing takes one UAC prompt, ownership can be judged by the exe path (decision 6), and
  an installer can handle the same shape (decision 3).

**The price is that the allowance widens to every TCP port that exe listens on** (it also passes if
the same exe listens on another port). What is actually reachable is only what is listening, but that
is decided by the app, not the rule. The confirmation screen therefore always states both:

- "Allows **all TCP ports** this executable listens on, from private networks."
- "The remote range 'local subnet' can include the subnet of each network adapter or VPN the PC has"
  (it is not the same as the one NIC you picked).

Stage 1's per-port proposal (`<identifier>.lan.tcp.port`) stays as something an administrator uses by
hand; the stage-2 helper does not create per-port rules.

### 2. The template installs perMachine by default (owner decision)

The NSIS default in `apps/admin-template/src-tauri/tauri.conf.json` becomes perMachine (under Program
Files). Stage 2 works **only for a perMachine install under Program Files**. For portable, per-user or
moved copies the helper stops with "precondition missing" (exit 2) and the screen falls back to stage 1's
guidance.

The effect on derived apps (install location moves to Program Files, UAC at install time, how existing
per-user installs move over) is written into `docs/upgrading.md` in the implementation PR.

### 3. The NSIS hook only removes (owner decision)

- No allow rule is created at install time. Allowing is done explicitly by an admin inside the app.
- A PREUNINSTALL hook has the helper remove only the owned rule. What it starts is not the helper in the
  install folder but a copy of the helper embedded in the uninstaller (`firewall-remove-installed`,
  decisions 8 and 10).
- Failure does not stop the uninstall; a `DetailPrint` explains how to remove the rule by hand (its name).

### 4. The remote range is fixed to LocalSubnet (owner decision)

The helper takes no CIDR or other remote-range input, to keep argument validation simple. Environments
that need another range use stage 1's copied PowerShell, edited by an administrator.

### 5. The identifier carries over from stage 1 and is built into the helper

- Rule name `<identifier>.lan.tcp.program`, group `<identifier>` (as in stage 1), so stage 1's reader
  (`firewall_rule_status`) finds the stage-2 rule as is.
- The identifier (Tauri bundle identifier) is a build-time constant of the helper, not an argument.
  Names are per derived app, and there is no argument that could point at another app's rule.

Alternative: take the identifier as a validated argument - more input to validate, and it could point
at another app's rule, so rejected.

### 6. Ownership is judged by content, not only by name

A rule is "owned" only when all of these match. Every item that defines the rule shape in decision 1
is compared, without exception.

- Name = `<identifier>.lan.tcp.program`, Group = `<identifier>`
- Program path equals the app exe next to the helper
- Direction = Inbound, Action = Allow, Protocol = TCP
- Profile = Private only (Public and Domain not included)
- RemoteAddress = LocalSubnet only
- LocalPort = Any (not specified)
- All other filter conditions left at their defaults (LocalAddress, RemotePort, InterfaceType, Service
  and so on; the implementation lists the items it compares)
- Enabled = True
- PolicyStoreSource is the local PersistentStore (not from GPO and the like)

If even one differs, it is a "conflict" (exit 4): `firewall-allow` does not report "already there",
and `firewall-remove` does not delete it.
A rule with the same name but different content, pointing at another install's path, or changed by an
administrator (Profile widened to Public, RemoteAddress set to Any, a LocalPort added, disabled, and so
on), **stops as a "conflict" (exit 4) and is neither overwritten nor deleted**. Block rules
Banto does not own, profile settings and turning the firewall on or off are never touched.

Alternative: judge by name (or prefix) alone - would treat derived apps, multiple installs and
administrator-edited rules as "already there, success" (audit priority 4), so rejected.

### 7. The helper is its own crate; the runas launch is a small module in src-tauri

- The helper lives in its own crate with a bin and a pure-function lib, e.g. `apps/admin-template/elev`.
  The exe is named like `<app>-fw-elev.exe`, and scaffold and the rename recipe follow it.
- The manifest (`requireAdministrator`) is embedded only into the bin via embed-resource's
  `compile_for`, and `manifest_required()` turns a missing embed into a build failure (test executables
  do not get it).
- `main` calls `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)` first, limiting DLL lookup to System32.
- Firewall operations go through a trait and tests use a fake (tests never change the machine).
  Pure functions - argument parsing, ownership checks, exit-code mapping - stay outside `cfg(windows)`
  so the Linux CI can test them.
- The runas launch copies and generalizes the shape of banto-industrial's
  `crates/banto-service-elev/src/launch.rs` (`ShellExecuteExW` with `runas` + `SEE_MASK_NOCLOSEPROCESS`
  - wait + `GetExitCodeProcess`, 1223 = UAC cancelled) as a small module in `apps/admin-template/src-tauri`.

Alternatives:

- A second bin in src-tauri - risks clashing with the manifest tauri-build embeds, and the helper would
  pull all of the app's dependencies, so rejected.
- A new shared crate - no benefit while admin-template is the only user; reconsider when there are more.

### 8. Trust rests on "fixed name next to me" plus an effective-ACL check before and after elevation

- The helper does not take the app exe as an argument. It only targets the fixed-name exe in the parent
  folder of `current_exe()`; no fallback to the CWD or a parent folder. The app likewise looks for the
  helper only by its fixed name next to itself. The one exception is `firewall-remove-installed`, used by
  the copy the uninstaller starts (see "Launch from the NSIS uninstall hook" below): it takes the install
  folder and can only remove the rule of the fixed-name app exe there.
- The helper checks that both it and the app are under Program Files (compared on path-component
  boundaries, case-insensitively) and otherwise stops with exit 2. The Program Files location comes from
  the OS known folder (KNOWNFOLDERID), not an environment variable.
- The string check alone is not enough: a portable copy placed in a folder under Program Files that a
  vendor made writable for ordinary users would pass it. **The core of the trust is the effective-ACL
  check**, performed both by the app before it asks for elevation and by the helper at startup (see "Check
  before asking for elevation" below).
  - What is checked: the helper's own exe, the app exe next to it, and every folder from the one
    containing them up to the Program Files known folder.
  - If the owner is anything other than Administrators, SYSTEM or TrustedInstaller, stop with exit 2
    (precondition missing).
  - If an ACE granting a write-type right (WRITE_DATA / APPEND_DATA / WRITE_DAC / WRITE_OWNER / DELETE /
    FILE_DELETE_CHILD / GENERIC_WRITE / GENERIC_ALL and the like) has a SID other than Administrators,
    SYSTEM or TrustedInstaller, stop with exit 2 (inherit-only ACEs for CREATOR OWNER may be excluded,
    since they do not apply to the object itself).
  - If a reparse point (junction or symbolic link) is anywhere on the path, stop with exit 2.
  - To leave no window for swapping the path (TOCTOU), open handles first, check through them, and use
    exactly the checked files (the app exe path is taken from that handle too).
- Replacement during updates is done only by the (elevated) installer. Implementation details such as
  how ACEs are enumerated are settled in the E1 PR; changing the rules above means updating this ADR.

Check before asking for elevation:

- A check after the helper starts is not enough on its own. If the helper has been swapped, the swapped
  code runs as administrator the moment UAC is approved, so the helper's own check comes too late.
- So the app (the unelevated Tauri side, E2's launcher module) also runs the same check before it asks for
  elevation with `ShellExecuteExW` `runas`. The targets (the helper exe, the app exe next to it, and every
  folder from theirs up to the Program Files known folder) and the rules (the Program Files string
  condition, owner, write-type ACEs, reparse points on the path) are identical to the above.
- If they are not met, the app does not start the helper, shows no UAC prompt, and falls back to the
  stage-1 guidance. The result is audited and shown as "precondition missing" (equivalent to exit 2,
  decision 11).
- The rules are defined in one place, and the app and the helper share the same pure functions and the
  same tests (e.g. the app also uses the lib of E1's helper crate; details are left to E1 and E2).
- Role: **the pre-launch check is the primary defence** (no administrator rights are handed via UAC to a
  swapped helper); the helper's post-launch check stays as defence in depth (the helper can also be
  started directly or from the NSIS hook).
- Remaining risk: a swap between the check and the runas launch (TOCTOU). `ShellExecuteExW` launches by
  path, so the checked handle cannot be pinned to the launch. But passing the ACL check means ordinary
  users cannot write to that path, so only someone who already has administrator rights could swap it
  after the check; that does not cross the elevation boundary. It is accepted on that basis.
- Launch from the NSIS uninstall hook (E4): **the helper in the install folder is never started.** ACLs
  are per file: even with the folder and `uninstall.exe` protected, if only the helper exe grants ordinary
  users a write right (FILE_WRITE_DATA etc.), its contents can be changed with no change of path or
  reparse point, and the elevated uninstaller would run them as administrator (the helper's own check
  after launch is too late). So the uninstaller carries its own copy. At build time, the same file the
  installer bundles (`src-tauri/binaries/<helper>-<target triple>.exe`, the source of Tauri's
  `externalBin`) is embedded into `uninstall.exe` by a `File` in the Uninstall section; at run time it is
  extracted into `$PLUGINSDIR` (after `InitPluginsDir`) and that copy is started with
  `firewall-remove-installed "$INSTDIR"`. The copy is not next to the app exe, so the placement check above
  does not apply; instead it opens the fixed-name app exe in `$INSTDIR` by handle, checks that it is a file,
  not a reparse point, and inside a Program Files known folder, and removes only its own rule (decision 6's
  content check) whose Program is that handle's final path. The app exe's ACL is not judged (removing only
  narrows what is allowed and touches no other rule). If the copy cannot be extracted or started, or a build
  without the helper (plain `tauri build`) has no copy, the rule is left as is and the reason and how to
  remove it by hand are printed; the uninstall continues.
  - Not adopted: an effective-ACL check equivalent to `check_object` in NSIS before starting the installed
    helper. A gap between the check and the launch by path (TOCTOU) would remain, and the case it must
    stop is exactly the one where ordinary users can write the file, so the runas reasoning above ("after
    passing the check only administrators can swap it") does not hold.
  - Remaining risk: `$PLUGINSDIR` is a new folder under the elevated user's `%TEMP%`. When administrators
    approve their own UAC prompt, that user's unelevated processes can write there too, and could swap the
    copy between extraction and launch. NSIS uninstallers already copy themselves to `%TEMP%` and run that
    copy, so this is the level of risk the uninstaller itself already carries, not a new one (when the
    prompt is approved with another administrator's credentials, it is that administrator's `%TEMP%`, which
    ordinary users cannot write).

Alternatives:

- Verify the Authenticode signature - not required, since derived apps do not necessarily sign. An extra
  check when a signature is present is left as room for the future.
- Check only after the helper starts - rejected: once UAC is approved, the swapped code already runs as
  administrator, which is too late.

### 9. Firewall operations run through PowerShell with a fixed environment (recommended; may be revisited)

- Run `powershell.exe` by its absolute path from `GetSystemDirectoryW`, with `-NoProfile
-NonInteractive -EncodedCommand`. The script is a fixed text embedded in the helper, and its values are
  only those the helper determined itself (decisions 5 and 8) - no user input.
- The child's environment is pinned to a minimum; user variables such as `PSModulePath` are not
  inherited. The NetSecurity module is imported by absolute path.

Alternatives:

- COM `INetFwPolicy2` - no child process, but needs a windows crate feature (COM wrappers). If the
  implementation PR finds COM better for dependencies and safety, this ADR is updated and we switch.
- `netsh advfirewall` - locale-dependent output, and it cannot reliably read the attributes the ownership
  check (decision 6) needs, so rejected.

### 10. Fixed actions and arguments

- Only three actions: `firewall-allow` / `firewall-remove` / `firewall-status`. By decisions 1, 4, 5
  and 8 nothing else is needed (**the only argument is the action name**).
- The single exception is `firewall-remove-installed <install folder>`, used by the uninstaller's copy
  (decisions 3 and 8). It takes only the folder, targets the fixed-name app exe there, and can only remove
  the owned rule. Any other action with a second argument stays a usage error (64).
- A wrong argument count, unknown action, duplicate, empty argument or non-UTF-8 argument is a usage
  error (64).
- The helper validates assuming a Windows administrator may launch it directly (a separate boundary from
  the app's admin authorization).

### 11. Results are exit codes, and the caller always re-reads

| Code | Meaning                                                                                                                                                                                                                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | done (`firewall-allow` created it; `firewall-remove` removed it or there was none; `firewall-status` found no owned rule)                                                                                                                                                                                         |
| 3    | already there (the owned rule is as expected; `firewall-allow` and `firewall-status`)                                                                                                                                                                                                                             |
| 4    | conflict (a same-name rule not owned, decision 6; nothing changed)                                                                                                                                                                                                                                                |
| 5    | not effective due to policy (e.g. GPO disables local rule merge; 5 even with an owned rule already in place. `firewall-allow` stops without creating the rule when there is none, but keeps the rule it created when only the re-read after creating it shows the policy. 5 does not always mean nothing changed) |
| 2    | precondition missing (untrusted placement, decision 8)                                                                                                                                                                                                                                                            |
| 1    | failure (anything else)                                                                                                                                                                                                                                                                                           |
| 64   | usage error (decision 10)                                                                                                                                                                                                                                                                                         |

UAC cancellation is told apart by the launcher's `ERROR_CANCELLED` (1223), not by a helper exit code.

Whatever the result, the caller re-reads the actual state with stage 1's reader (`firewall_rule_status`)
and shows that. Exit 0, or the rule existing, is never shown as "reachable"; reachability is shown by
stage 1's reach check.

### 12. In-app authorization and audit are separate from UAC

- The Tauri command launches the helper only after `require_role(Admin)` passes; with an insufficient
  role it does not launch.
- Success, failure and UAC cancellation are audited. As per the existing convention, `denied` is
  recorded only for an insufficient role, and nothing is recorded without a session. A new action name
  `firewall_change` is introduced (named after the existing `settings_change`).
- The new command is classified as `DESKTOP_ONLY` in `scripts/verify-architecture.mjs`; no mutating REST
  API is added (the same treatment as the existing desktop-only commands under
  [conventions.md](../conventions.en.md) §1).

### 13. Check what was confirmed against what the rule targets

- The confirmed target (the app exe path and the generation of the server's applied state) is passed to
  the Tauri command, which compares it right before launching the helper; on a mismatch it does not
  launch and asks to confirm again.
- After the helper exits it compares again; if things changed, the result is treated as stale and re-read.
- No lock is held while waiting for UAC (the user decides how long that takes).
- Firewall changes within the same process run one at a time under a running guard independent of the server lock; an overlapping request starts nothing and answers `busy` (not audited; the re-read is still attached). Separate processes are out of scope.

### 14. Dependencies: versions already in the lock, only for the helper and the launcher

`windows-sys` and `embed-resource` become direct, feature-limited dependencies of the helper crate and
the launcher module only. Both pin to the versions already in `Cargo.lock` transitively (`windows-sys`
0.61.2, `embed-resource` 3.0.11), so **no crate is added to the build**. That is the reason for this
"add it" exception under [ADR-0002](0002-minimal-dependencies.en.md) and
[conventions.md](../conventions.en.md) §3 (the third, after Paraglide and sysinfo).

Alternative: declare the Win32 APIs ourselves with `extern "system"` - no new dependency, but struct
layouts and constants would be kept by hand with no type checks, so rejected. Embedding a manifest by
hand is also hard.

### 15. Negative acceptance cases

From the 2026-10-21 audit's "negative cases acceptance tests must not skip", the stage-2 and real-network
ones are completion criteria.

- Helper: writable or bogus helper placement (including a user-writable folder under Program Files;
  the app's pre-elevation check must stop it without showing UAC, and a directly started helper must stop
  with exit 2 on decision 8's ACL check), a CWD decoy, direct CLI input, invalid arguments, a rule
  with the same ID but different content, multiple installs, UAC cancellation, settings changing while
  UAC waits, partial failure while adding or removing.
- Real network: no reach via other TCP ports (not listening), UDP, the Public profile or disallowed
  sources; with an explicit block or GPO disabling local merge, a successful rule creation is never shown
  as successful reach.

Adding, removing, UAC cancellation and port changes on real Windows are checked by the owner. Vendor
security products are out of scope; they get only stage 1's common guidance and caveat (2026-10-22 scope change).

## Alternatives considered

- **Rule shape**
  - **A (adopted): per executable** (decision 1). Does not go stale with automatic port selection; the price, widening to all TCP ports, is stated on the confirmation screen.
  - **B (rejected): exe + applied port** (the audit's recommendation). Narrowest, but needs UAC on every port change and silently goes stale on each automatic selection (#460), which happens without UAC.
  - **C (rejected): exe + saved port..+19**. Follows automatic selection, but changing the base port needs a rule swap (UAC), and it widens the allowance anyway - only by degree less than A.
  - **D (rejected): port only**. Other executables pass on the same port.
- **Install mode**
  - **A (adopted): perMachine by default; stage 2 stops otherwise** (decision 2).
  - **B (rejected): use the helper with per-user installs**. `%LOCALAPPDATA%` is user-writable, so the authenticity of what UAC approves cannot be kept (audit priority 2).
- **NSIS hook**
  - **A (adopted): remove only** (decision 3).
  - **B (rejected): also allow at install time**. Opens the hole before an admin decides in the app to expose to the LAN.
- **Remote range**
  - **A (adopted): fixed LocalSubnet** (decision 4).
  - **B (rejected): CIDR as an argument**. More input to validate, and the risk of falling back to Any on bad values.
- **Helper placement, operation method, dependencies**: alternatives and reasons are under decisions 7, 8, 9 and 14.

## Consequences

- The allowance becomes all TCP ports of that exe, the Private profile, and the local subnet (which may
  include several NICs and VPNs). The confirmation screen must keep saying exactly that.
- The template's default install location moves to Program Files and installing shows UAC. Derived apps
  pick this up on their next update (`docs/upgrading.md` is updated in the implementation PR). Portable
  and per-user installs cannot use stage 2 and get only stage 1's guidance.
- A helper crate, a launcher module and an NSIS hook are added; scaffold and the rename recipe must
  follow the helper's exe name and identifier (a structural change, so check with a scaffold dry-run).
- `windows-sys` and `embed-resource` become direct dependencies (no new crates). When bumping them,
  keep them aligned with the transitive versions in the lock.
- Expected split of implementation PRs (**implementation starts after this ADR is reviewed**):
  1. E1: the helper crate (pure functions, tests with a fake). The placement rules (decision 8) live as
     pure functions in the lib so the app can use them too
  2. E2: the launcher module, the pre-elevation placement check (sharing E1's rules), Tauri command, audit
     and generation check
  3. E3: the screens (confirmation, results and re-reading)
  4. E4: perMachine default and NSIS hook, scaffold follow-up, `docs/upgrading.md`
