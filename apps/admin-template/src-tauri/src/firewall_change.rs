//! Issue #219 stage 2 (ADR-0021, E2): the pieces of the `firewall_rule_change`
//! command that do not need `AppState` - the pre-elevation placement check
//! (decision 8), what the helper's exit code means (decision 11) and the
//! response / audit shapes (decisions 11-13). The command itself (role gate,
//! target comparison, launch, audit, re-read) is in `lib.rs`.
//!
//! The placement rule is not restated here: [`judge_before_elevation`] calls
//! the helper crate's own `placement::check_placement` over the facts its
//! `win::collect_placement_facts` reads (the same function and tests as the
//! helper's own check after it started). Only the helper's lib is a
//! dependency - its bin and manifest stay out of this exe.
//!
//! Everything sent to the screen is a code; the screen builds the text
//! (conventions §13). Exit code 0 is reported as `done`, never as "reachable"
//! - whether other devices can connect is stage 1's reach check.

use admin_template_fw_elev::placement::{self, Placement, PlacementFacts, PlacementRefusal, Which};
use admin_template_fw_elev::{
    Operation, EXIT_ALREADY, EXIT_CONFLICT, EXIT_FAILED, EXIT_OK, EXIT_POLICY, EXIT_PRECONDITION,
    EXIT_USAGE, HELPER_EXE_FILE_NAME, MAIN_EXE_FILE_NAME,
};
use serde::{Deserialize, Serialize};

use crate::elevated_launch::LaunchError;
use crate::firewall_status::FirewallRuleStatus;

/// What the screen asks for. Only the two changing operations: the state is
/// read with stage 1's `firewall_rule_status`, without elevation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum FirewallChangeOperation {
    Allow,
    Remove,
}

impl FirewallChangeOperation {
    /// The helper's operation (decision 10).
    pub(crate) fn helper_operation(self) -> Operation {
        match self {
            Self::Allow => Operation::Allow,
            Self::Remove => Operation::Remove,
        }
    }
}

/// What the confirmation screen showed (decision 13): the main exe's path and
/// the server generation, both from the `firewall_rule_status` answer it
/// displayed (`expected.executablePath` / `generation`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FirewallChangeTarget {
    pub(crate) executable_path: Option<String>,
    pub(crate) generation: u64,
}

/// The in-process "a firewall change is running" guard (ADR-0021 decision
/// 13): taken with [`RunningGuard::try_take`], released on drop (every path,
/// panics included). Independent of the server lock, which is not held while
/// UAC waits.
pub(crate) struct RunningGuard<'a>(&'a std::sync::atomic::AtomicBool);

impl<'a> RunningGuard<'a> {
    /// `None` when another change holds the flag.
    pub(crate) fn try_take(flag: &'a std::sync::atomic::AtomicBool) -> Option<Self> {
        use std::sync::atomic::Ordering;
        flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self(flag))
    }
}

impl Drop for RunningGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::Release);
    }
}

/// How the change ended. Mirrors the frontend type to come (E3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum FirewallChangeOutcome {
    /// Another firewall change of this process is still running; nothing was
    /// started and nothing was audited. The screen shows the state again.
    Busy,
    /// The confirmed target is not the current one; nothing was started and
    /// no UAC prompt was shown. The screen asks to confirm again.
    TargetChanged,
    /// The placement is not trusted (exit 2 or the pre-elevation check).
    Precondition,
    /// The user declined the UAC prompt (`ERROR_CANCELLED`).
    Cancelled,
    /// The helper could not be started or waited for.
    LaunchFailed,
    /// Exit 0: `allow` created the rule, `remove` removed it or there was none.
    Done,
    /// Exit 3: the helper's own rule is already in place.
    Already,
    /// Exit 4: a rule of the name the helper does not own; nothing changed.
    Conflict,
    /// Exit 5: a policy keeps local rules from applying.
    Policy,
    /// Exit 1.
    Failed,
    /// Exit 64 (the app passed something the helper does not accept).
    Usage,
    /// Any other exit code.
    UnexpectedExit,
}

impl FirewallChangeOutcome {
    /// The audit `result`: `ok` only when the rule is as asked.
    pub(crate) fn audit_result(self) -> &'static str {
        match self {
            Self::Done | Self::Already => "ok",
            _ => "failed",
        }
    }
}

/// Decision 11's exit codes.
pub(crate) fn outcome_of_exit(code: u32) -> FirewallChangeOutcome {
    match code as i32 {
        EXIT_OK => FirewallChangeOutcome::Done,
        EXIT_ALREADY => FirewallChangeOutcome::Already,
        EXIT_CONFLICT => FirewallChangeOutcome::Conflict,
        EXIT_POLICY => FirewallChangeOutcome::Policy,
        EXIT_PRECONDITION => FirewallChangeOutcome::Precondition,
        EXIT_FAILED => FirewallChangeOutcome::Failed,
        EXIT_USAGE => FirewallChangeOutcome::Usage,
        _ => FirewallChangeOutcome::UnexpectedExit,
    }
}

/// What the launch attempt came to (the parts of the response and the audit
/// detail that are not the re-read).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Attempt {
    pub(crate) outcome: FirewallChangeOutcome,
    pub(crate) exit_code: Option<u32>,
    /// Why the app's own pre-elevation check refused ([`refusal_code`]).
    pub(crate) refusal: Option<&'static str>,
    pub(crate) os_error: Option<u32>,
}

impl Attempt {
    pub(crate) fn refused(code: &'static str) -> Self {
        Self {
            outcome: FirewallChangeOutcome::Precondition,
            exit_code: None,
            refusal: Some(code),
            os_error: None,
        }
    }

    pub(crate) fn busy() -> Self {
        Self {
            outcome: FirewallChangeOutcome::Busy,
            exit_code: None,
            refusal: None,
            os_error: None,
        }
    }

    pub(crate) fn target_changed() -> Self {
        Self {
            outcome: FirewallChangeOutcome::TargetChanged,
            exit_code: None,
            refusal: None,
            os_error: None,
        }
    }

    /// From [`crate::elevated_launch::run_elevated`]'s answer (`None`: the
    /// blocking task itself did not finish).
    pub(crate) fn launched(result: Option<Result<u32, LaunchError>>) -> Self {
        match result {
            Some(Ok(code)) => Self {
                outcome: outcome_of_exit(code),
                exit_code: Some(code),
                refusal: None,
                os_error: None,
            },
            Some(Err(err)) => Self {
                outcome: if err.is_cancelled() {
                    FirewallChangeOutcome::Cancelled
                } else {
                    FirewallChangeOutcome::LaunchFailed
                },
                exit_code: None,
                refusal: None,
                os_error: err.os_error(),
            },
            None => Self {
                outcome: FirewallChangeOutcome::LaunchFailed,
                exit_code: None,
                refusal: None,
                os_error: None,
            },
        }
    }

    /// The audit `detail` (codes only).
    pub(crate) fn audit_detail(
        &self,
        operation: FirewallChangeOperation,
        stale: bool,
    ) -> serde_json::Value {
        let mut detail = serde_json::json!({
            "operation": operation,
            "outcome": self.outcome,
            "stale": stale,
        });
        let object = detail.as_object_mut().expect("an object");
        if let Some(code) = self.exit_code {
            object.insert("exitCode".into(), code.into());
        }
        if let Some(refusal) = self.refusal {
            object.insert("refusal".into(), refusal.into());
        }
        if let Some(os_error) = self.os_error {
            object.insert("osError".into(), os_error.into());
        }
        detail
    }
}

/// `firewall_rule_change`'s response. `status` is always a fresh stage-1
/// read (decision 11), taken after everything else.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FirewallChangeResult {
    pub(crate) operation: FirewallChangeOperation,
    pub(crate) outcome: FirewallChangeOutcome,
    pub(crate) exit_code: Option<u32>,
    pub(crate) refusal: Option<&'static str>,
    pub(crate) os_error: Option<u32>,
    /// The executable or the server generation changed while the helper
    /// ran (decision 13): the outcome is about a target the screen no longer
    /// shows, so it is "stale" - `status` tells what is there now.
    pub(crate) stale: bool,
    pub(crate) status: FirewallRuleStatus,
}

impl FirewallChangeResult {
    pub(crate) fn new(
        operation: FirewallChangeOperation,
        attempt: Attempt,
        stale: bool,
        status: FirewallRuleStatus,
    ) -> Self {
        Self {
            operation,
            outcome: attempt.outcome,
            exit_code: attempt.exit_code,
            refusal: attempt.refusal,
            os_error: attempt.os_error,
            stale,
            status,
        }
    }
}

/// The code of a refused placement (the response's and audit's `refusal`).
// Used by the Windows check (and the tests on every OS).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn refusal_code(refusal: &PlacementRefusal) -> &'static str {
    match refusal {
        PlacementRefusal::Missing(Which::Helper) => "helperMissing",
        PlacementRefusal::Missing(Which::Main) => "mainMissing",
        PlacementRefusal::Missing(Which::Folder) => "folderMissing",
        PlacementRefusal::AnchorNotChecked { .. } => "anchorNotChecked",
        PlacementRefusal::WrongName { .. } => "wrongName",
        PlacementRefusal::NotSameFolder => "notSameFolder",
        PlacementRefusal::NotUnderProgramFiles { .. } => "notUnderProgramFiles",
        PlacementRefusal::FolderChainMismatch => "folderChainMismatch",
        PlacementRefusal::WrongKind { .. } => "wrongKind",
        PlacementRefusal::ReparsePoint { .. } => "reparsePoint",
        PlacementRefusal::UntrustedOwner { .. } => "untrustedOwner",
        PlacementRefusal::NullDacl { .. } => "nullDacl",
        PlacementRefusal::WritableBy { .. } => "writableByOthers",
        PlacementRefusal::UnreadableAce { .. } => "unreadableAce",
    }
}

/// The facts could not be read at all (an unverifiable placement is not
/// trusted, like the helper's exit 2).
pub(crate) const REFUSAL_UNVERIFIABLE: &str = "unverifiable";
/// The running exe is the helper's neighbour but not the main exe.
// Used by the Windows check (and the tests on every OS).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) const REFUSAL_NOT_MAIN_EXE: &str = "notMainExe";
/// The app's bundle identifier is not the helper's built-in one (a rename
/// that changed one but not the other): the helper would act on another
/// rule than the one the screen reads.
pub(crate) const REFUSAL_IDENTIFIER_MISMATCH: &str = "identifierMismatch";
/// Not Windows.
#[cfg_attr(windows, allow(dead_code))]
pub(crate) const REFUSAL_UNSUPPORTED: &str = "unsupported";

/// Decision 8 before asking for elevation, over facts anchored at the running
/// (main) exe: the helper's own rule, plus that the anchor is the main exe
/// (the helper accepts either exe as its anchor; the main app is the main
/// exe). The accepted `helper_exe` is the path to start.
// Used by the Windows check (and the tests on every OS).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn judge_before_elevation(facts: &PlacementFacts) -> Result<Placement, &'static str> {
    let accepted = placement::check_placement(facts, HELPER_EXE_FILE_NAME, MAIN_EXE_FILE_NAME)
        .map_err(|refusal| refusal_code(&refusal))?;
    if !placement::same_path(&facts.anchor, &accepted.main_exe) {
        return Err(REFUSAL_NOT_MAIN_EXE);
    }
    Ok(accepted)
}

/// The pre-elevation check of the installation the running exe belongs to
/// (blocking: opens and reads every object). The helper is looked for next
/// to the running exe under its fixed name only - no CWD or other fallback.
#[cfg(windows)]
pub(crate) fn check_before_elevation() -> Result<Placement, &'static str> {
    let exe = std::env::current_exe().map_err(|_| REFUSAL_UNVERIFIABLE)?;
    let facts = admin_template_fw_elev::win::collect_placement_facts(&exe)
        .map_err(|_| REFUSAL_UNVERIFIABLE)?;
    judge_before_elevation(&facts)
}

/// Off Windows there is no helper to start.
#[cfg(not(windows))]
pub(crate) fn check_before_elevation() -> Result<Placement, &'static str> {
    Err(REFUSAL_UNSUPPORTED)
}

#[cfg(test)]
mod tests {
    use super::*;
    use admin_template_fw_elev::placement::{
        AceFact, ObjectFacts, ATTRIBUTE_DIRECTORY, SID_ADMINISTRATORS, SID_SYSTEM,
        SID_TRUSTED_INSTALLER,
    };

    const DIR: &str = r"C:\Program Files\Banto Admin";
    const READ_EXECUTE: u32 = 0x0012_00A9;
    const FULL: u32 = 0x001F_01FF;

    fn object(path: &str, attributes: u32) -> ObjectFacts {
        let allow = |sid: &str, mask| AceFact {
            ace_type: 0,
            flags: 0,
            mask,
            sid: Some(sid.into()),
        };
        ObjectFacts {
            path: path.into(),
            attributes,
            owner_sid: SID_TRUSTED_INSTALLER.into(),
            dacl: Some(vec![
                allow(SID_TRUSTED_INSTALLER, FULL),
                allow(SID_SYSTEM, FULL),
                allow(SID_ADMINISTRATORS, FULL),
                allow("S-1-5-32-545", READ_EXECUTE),
            ]),
        }
    }

    /// A per-machine install, anchored at the main exe (the main app's view).
    fn facts() -> PlacementFacts {
        PlacementFacts {
            anchor: format!(r"{DIR}\{MAIN_EXE_FILE_NAME}"),
            program_files: vec![r"C:\Program Files".into()],
            helper: Some(object(&format!(r"{DIR}\{HELPER_EXE_FILE_NAME}"), 0x20)),
            main: Some(object(&format!(r"{DIR}\{MAIN_EXE_FILE_NAME}"), 0x20)),
            folders: vec![
                object(DIR, ATTRIBUTE_DIRECTORY),
                object(r"C:\Program Files", ATTRIBUTE_DIRECTORY),
            ],
        }
    }

    #[test]
    fn a_per_machine_install_is_accepted_and_the_checked_helper_is_started() {
        assert_eq!(
            judge_before_elevation(&facts()),
            Ok(Placement {
                helper_exe: format!(r"{DIR}\{HELPER_EXE_FILE_NAME}"),
                main_exe: format!(r"{DIR}\{MAIN_EXE_FILE_NAME}"),
            })
        );
    }

    /// The main app must be the main exe (the helper's rule also accepts the
    /// helper as its anchor).
    #[test]
    fn the_anchor_must_be_the_main_exe() {
        let mut f = facts();
        f.anchor = format!(r"{DIR}\{HELPER_EXE_FILE_NAME}");
        assert_eq!(judge_before_elevation(&f), Err(REFUSAL_NOT_MAIN_EXE));
    }

    /// The helper's own judgement is used (spot checks; its full tests are
    /// in the helper crate): portable copies and writable folders refuse.
    #[test]
    fn the_helpers_rule_refuses_with_a_code() {
        let mut portable = facts();
        let dir = r"C:\Users\u\Desktop\app";
        portable.anchor = format!(r"{dir}\{MAIN_EXE_FILE_NAME}");
        portable.helper = Some(object(&format!(r"{dir}\{HELPER_EXE_FILE_NAME}"), 0x20));
        portable.main = Some(object(&format!(r"{dir}\{MAIN_EXE_FILE_NAME}"), 0x20));
        portable.folders = vec![];
        assert_eq!(
            judge_before_elevation(&portable),
            Err("notUnderProgramFiles")
        );

        let mut writable = facts();
        writable.folders[0].dacl.as_mut().unwrap().push(AceFact {
            ace_type: 0,
            flags: 0,
            mask: FULL,
            sid: Some("S-1-5-11".into()),
        });
        assert_eq!(judge_before_elevation(&writable), Err("writableByOthers"));

        let mut no_helper = facts();
        no_helper.helper = None;
        assert_eq!(judge_before_elevation(&no_helper), Err("helperMissing"));
    }

    /// The real collection runs without elevation and refuses a build
    /// folder. Usually the test exe is not under Program Files (that reason
    /// is given before the missing helper, #480); a checkout or target dir
    /// under Program Files has no helper beside the test exe instead. Which
    /// reason comes first is pinned by the synthetic placement tests.
    #[cfg(windows)]
    #[test]
    fn the_real_check_refuses_a_build_folder() {
        let refusal = check_before_elevation().expect_err("a build folder must be refused");
        assert!(
            matches!(refusal, "notUnderProgramFiles" | "helperMissing"),
            "unexpected refusal: {refusal}"
        );
    }

    #[test]
    fn exit_codes_map_to_outcomes() {
        use FirewallChangeOutcome::*;
        for (code, outcome) in [
            (0, Done),
            (1, Failed),
            (2, Precondition),
            (3, Already),
            (4, Conflict),
            (5, Policy),
            (64, Usage),
            (6, UnexpectedExit),
            (1223, UnexpectedExit),
            (u32::MAX, UnexpectedExit),
        ] {
            assert_eq!(outcome_of_exit(code), outcome, "{code}");
        }
        assert_eq!(Done.audit_result(), "ok");
        assert_eq!(Already.audit_result(), "ok");
        for other in [
            Precondition,
            Cancelled,
            Conflict,
            Policy,
            Failed,
            LaunchFailed,
        ] {
            assert_eq!(other.audit_result(), "failed", "{other:?}");
        }
    }

    /// UAC's `ERROR_CANCELLED` is told apart by the launcher (decision 11).
    #[test]
    fn a_declined_uac_prompt_is_cancelled() {
        let cancelled = Attempt::launched(Some(Err(LaunchError::ShellExecute(1223))));
        assert_eq!(cancelled.outcome, FirewallChangeOutcome::Cancelled);
        assert_eq!(cancelled.os_error, Some(1223));
        let missing = Attempt::launched(Some(Err(LaunchError::ShellExecute(2))));
        assert_eq!(missing.outcome, FirewallChangeOutcome::LaunchFailed);
        assert_eq!(
            Attempt::launched(None).outcome,
            FirewallChangeOutcome::LaunchFailed
        );
        let exited = Attempt::launched(Some(Ok(3)));
        assert_eq!(exited.outcome, FirewallChangeOutcome::Already);
        assert_eq!(exited.exit_code, Some(3));
    }

    #[test]
    fn the_audit_detail_carries_codes_only() {
        let detail =
            Attempt::refused("reparsePoint").audit_detail(FirewallChangeOperation::Allow, false);
        assert_eq!(
            detail,
            serde_json::json!({
                "operation": "allow",
                "outcome": "precondition",
                "stale": false,
                "refusal": "reparsePoint",
            })
        );
        let detail =
            Attempt::launched(Some(Ok(0))).audit_detail(FirewallChangeOperation::Remove, true);
        assert_eq!(
            detail,
            serde_json::json!({
                "operation": "remove",
                "outcome": "done",
                "stale": true,
                "exitCode": 0,
            })
        );
    }

    #[test]
    fn operations_are_the_two_changing_ones() {
        assert_eq!(
            FirewallChangeOperation::Allow.helper_operation().arg(),
            "firewall-allow"
        );
        assert_eq!(
            FirewallChangeOperation::Remove.helper_operation().arg(),
            "firewall-remove"
        );
        assert!(serde_json::from_str::<FirewallChangeOperation>("\"status\"").is_err());
        assert_eq!(
            serde_json::from_str::<FirewallChangeOperation>("\"allow\"").unwrap(),
            FirewallChangeOperation::Allow
        );
    }
}
