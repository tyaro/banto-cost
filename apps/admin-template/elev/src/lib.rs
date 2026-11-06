//! `admin-template-fw-elev.exe`: the UAC-elevated helper that adds and
//! removes the one Windows Firewall rule of Issue #219 stage 2
//! ([ADR-0021](../../../../docs/adr/0021-firewall-elevated-helper.md)).
//!
//! ```text
//! admin-template-fw-elev.exe firewall-allow | firewall-remove | firewall-status
//! admin-template-fw-elev.exe firewall-remove-installed <install folder>
//! ```
//!
//! The operation name is the only argument (decision 10): the identifier is
//! a build-time constant ([`IDENTIFIER`], decision 5), the program is the
//! main exe next to the helper ([`MAIN_EXE_FILE_NAME`], decision 8) and the
//! remote range is fixed to `LocalSubnet` (decision 4). Results are exit
//! codes only (decision 11): [`EXIT_OK`] 0, [`EXIT_FAILED`] 1,
//! [`EXIT_PRECONDITION`] 2, [`EXIT_ALREADY`] 3, [`EXIT_CONFLICT`] 4,
//! [`EXIT_POLICY`] 5, [`EXIT_USAGE`] 64. Callers always re-read the state
//! with stage 1's `firewall_rule_status` afterwards.
//!
//! The one exception is the uninstaller's [`REMOVE_INSTALLED_ARG`]
//! (decisions 3, 8 and 10): the NSIS uninstall hook runs a copy of this
//! helper it carries itself (extracted to its own `$PLUGINSDIR`), never the
//! one in the install folder, so that copy is not next to the main exe and
//! is told the install folder instead ([`run_remove_installed`]). It can
//! only remove the own rule for the fixed-name main exe in that folder.
//!
//! Layout (decision 7): this lib holds the pure functions - arguments,
//! rule ownership ([`rules`]), the placement judgement ([`placement`],
//! shared with the main app's pre-elevation check), the PowerShell scripts
//! and their output ([`powershell`]) - and the procedure [`run`] over two
//! traits, tested with fakes on every OS (no test touches the real
//! firewall or ACLs). [`win`] (Windows only) collects the facts from the OS
//! and runs PowerShell. The bin (`main.rs`) only passes its arguments here.

use std::ffi::OsString;
use std::fmt;

pub mod placement;
pub mod powershell;
pub mod rules;
#[cfg(windows)]
pub mod win;

use placement::{InstalledFacts, PlacementFacts, PlacementRefusal, Which};
use rules::{RuleNames, RuleSnapshot, RuleSpec, RuleState};

/// The app's Tauri bundle identifier (`apps/admin-template/src-tauri/tauri.conf.json`
/// `identifier`), fixed at build time (decision 5): the rule is
/// `<IDENTIFIER>.lan.tcp.program` in group `<IDENTIFIER>`. There is no
/// argument that could name another app's rule. A test checks it against
/// tauri.conf.json; the rename recipe must change both.
pub const IDENTIFIER: &str = "com.tyaro.bantocost";

/// This helper's file name (the `[[bin]]` name + `.exe`). The main app looks
/// for the helper next to itself under this name only (decision 8).
pub const HELPER_EXE_FILE_NAME: &str = "admin-template-fw-elev.exe";

/// The main app's file name next to the helper: the Tauri app's cargo
/// binary (`apps/admin-template/src-tauri/Cargo.toml` package name; Tauri
/// keeps the cargo binary's name unless `mainBinaryName` is set). A test
/// checks it against both files.
pub const MAIN_EXE_FILE_NAME: &str = "admin-template.exe";

/// Done: `firewall-allow` created the rule, `firewall-remove` removed it (or
/// there was none), `firewall-status` found no rule of the name.
pub const EXIT_OK: i32 = 0;
/// Any failure not covered below.
pub const EXIT_FAILED: i32 = 1;
/// The placement is not trusted (decision 8); nothing was touched.
pub const EXIT_PRECONDITION: i32 = 2;
/// The helper's own rule is already there as expected (`firewall-allow`,
/// `firewall-status`).
pub const EXIT_ALREADY: i32 = 3;
/// A rule of the name that is not the helper's own (decision 6); nothing
/// was changed.
pub const EXIT_CONFLICT: i32 = 4;
/// A policy keeps local rules from applying (e.g. Group Policy does not
/// merge local rules), even for an own rule already in place
/// (`firewall-allow`, `firewall-status`). Without a rule, `firewall-allow`
/// creates nothing when the policy is known up front, but keeps the rule
/// it created when only the re-read after creating it shows the policy -
/// so 5 does not always mean nothing was changed.
pub const EXIT_POLICY: i32 = 5;
/// Wrong usage (decision 10).
pub const EXIT_USAGE: i32 = 64;

// Decision 5: a malformed identifier is a build error, not a runtime one.
const _: () = assert!(rules::is_valid_identifier(IDENTIFIER));

/// The three operations (decision 10).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    Allow,
    Remove,
    Status,
}

impl Operation {
    pub const ALL: [Operation; 3] = [Self::Allow, Self::Remove, Self::Status];

    /// The argument that selects it.
    pub const fn arg(self) -> &'static str {
        match self {
            Self::Allow => "firewall-allow",
            Self::Remove => "firewall-remove",
            Self::Status => "firewall-status",
        }
    }
}

/// The uninstaller's operation (decisions 3 and 10): `firewall-remove` for
/// the main exe in the install folder given as the one further argument.
pub const REMOVE_INSTALLED_ARG: &str = "firewall-remove-installed";

/// What the arguments ask for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    /// One of the three operations, on the main exe next to this helper.
    Run(Operation),
    /// [`REMOVE_INSTALLED_ARG`]: remove the own rule of the main exe in
    /// `install_dir` (the NSIS uninstaller's `$INSTDIR`).
    RemoveInstalled { install_dir: String },
}

/// Why the arguments are wrong usage (all exit 64).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UsageError {
    /// No argument.
    Missing,
    /// More than one argument (a repeated operation included).
    TooMany(usize),
    /// An argument that is not valid UTF-8.
    NotUtf8,
    /// An empty argument.
    Empty,
    /// Not one of the three operations (exact, case-sensitive).
    Unknown(String),
    /// [`REMOVE_INSTALLED_ARG`] without the install folder.
    NoInstallDir,
}

impl fmt::Display for UsageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing => f.write_str("no operation given"),
            Self::TooMany(n) => write!(f, "exactly one argument is accepted ({n} given)"),
            Self::NotUtf8 => f.write_str("an argument is not valid UTF-8"),
            Self::Empty => f.write_str("an argument is empty"),
            Self::Unknown(arg) => write!(f, "unknown operation: {arg:?}"),
            Self::NoInstallDir => write!(f, "{REMOVE_INSTALLED_ARG} needs the install folder"),
        }
    }
}

/// Decision 10: exactly one argument, one of the three operation names -
/// or exactly [`REMOVE_INSTALLED_ARG`] and the install folder. Every
/// argument is checked (UTF-8, not empty) before the count, so no argument
/// is ever skipped unchecked.
pub fn parse_args<I: IntoIterator<Item = OsString>>(args: I) -> Result<Request, UsageError> {
    let mut texts = Vec::new();
    for arg in args {
        let text = arg.into_string().map_err(|_| UsageError::NotUtf8)?;
        if text.is_empty() {
            return Err(UsageError::Empty);
        }
        texts.push(text);
    }
    match texts.as_slice() {
        [] => Err(UsageError::Missing),
        [one] if one == REMOVE_INSTALLED_ARG => Err(UsageError::NoInstallDir),
        [one] => Operation::ALL
            .into_iter()
            .find(|op| op.arg() == one)
            .map(Request::Run)
            .ok_or_else(|| UsageError::Unknown(one.clone())),
        [op, dir] if op == REMOVE_INSTALLED_ARG => Ok(Request::RemoveInstalled {
            install_dir: dir.clone(),
        }),
        many => Err(UsageError::TooMany(many.len())),
    }
}

/// The usage text.
pub fn usage_lines(reason: &str) -> Vec<String> {
    vec![
        format!("admin-template-fw-elev: {reason}"),
        "usage: admin-template-fw-elev.exe firewall-allow | firewall-remove | firewall-status"
            .into(),
        format!("       admin-template-fw-elev.exe {REMOVE_INSTALLED_ARG} <install folder>"),
    ]
}

/// Reads the facts decision 8 judges (Windows: `win::collect_placement_facts`).
pub trait PlacementProbe {
    /// `Err` when they could not be read at all (judged as exit 2: an
    /// unverifiable placement is not trusted).
    fn placement_facts(&self) -> Result<PlacementFacts, String>;
}

/// The firewall operations (Windows: PowerShell, `win::PowerShellFirewall`).
pub trait FirewallOps {
    /// The rule of `names` in the local and active stores, and the policy.
    fn query(&self, names: &RuleNames) -> Result<RuleSnapshot, String>;
    /// Creates `spec`'s rule in the local store.
    fn create(&self, spec: &RuleSpec) -> Result<(), String>;
    /// Removes the rule of `names` from the local store.
    fn remove(&self, names: &RuleNames) -> Result<(), String>;
}

/// Where [`run`] writes its lines (for an administrator running it by hand).
pub type Out<'a> = &'a mut dyn FnMut(&str);

/// Runs `op`: checks the placement (decision 8), reads the rule, and acts
/// on decision 6's ownership. Returns the exit code (decision 11).
pub fn run(op: Operation, probe: &impl PlacementProbe, fw: &impl FirewallOps, out: Out<'_>) -> i32 {
    let Some(names) = rules::rule_names(IDENTIFIER) else {
        out("the built-in identifier is not valid");
        return EXIT_FAILED;
    };
    let placement = match probe
        .placement_facts()
        .map_err(|e| format!("the placement could not be checked: {e}"))
        .and_then(|facts| {
            placement::check_placement(&facts, HELPER_EXE_FILE_NAME, MAIN_EXE_FILE_NAME)
                .map_err(|r: PlacementRefusal| r.to_string())
        }) {
        Ok(placement) => placement,
        Err(reason) => {
            out(&format!("precondition not met: {reason}"));
            return EXIT_PRECONDITION;
        }
    };
    let spec = RuleSpec {
        names,
        program: placement.main_exe,
    };
    act(op, &spec, fw, out)
}

/// [`REMOVE_INSTALLED_ARG`] (decisions 3, 8 and 10): `firewall-remove` for
/// the main exe in the install folder the NSIS uninstaller names.
///
/// This copy of the helper runs from the uninstaller's `$PLUGINSDIR` (it is
/// what the uninstaller carries, not the file in the install folder), so it
/// is not next to the main exe and decision 8's placement check does not
/// apply. What it checks instead ([`placement::check_installed_main`]):
/// the main exe is there under its fixed name, is a plain file (no reparse
/// point) and is strictly inside Program Files. No ACL check: removing the
/// own rule only narrows what the firewall lets in, and the rule's
/// ownership (decision 6, including `Program` = this exe's final path) is
/// still judged by content, so no other rule is touched.
pub fn run_remove_installed(
    facts: Result<InstalledFacts, String>,
    fw: &impl FirewallOps,
    out: Out<'_>,
) -> i32 {
    let Some(names) = rules::rule_names(IDENTIFIER) else {
        out("the built-in identifier is not valid");
        return EXIT_FAILED;
    };
    let main_exe = match facts
        .map_err(|e| format!("the install folder could not be checked: {e}"))
        .and_then(|facts| {
            placement::check_installed_main(&facts, MAIN_EXE_FILE_NAME).map_err(|r| match r {
                PlacementRefusal::Missing(Which::Main) => {
                    format!("{MAIN_EXE_FILE_NAME} is not in the install folder")
                }
                other => other.to_string(),
            })
        }) {
        Ok(main_exe) => main_exe,
        Err(reason) => {
            out(&format!("precondition not met: {reason}"));
            return EXIT_PRECONDITION;
        }
    };
    let spec = RuleSpec {
        names,
        program: main_exe,
    };
    act(Operation::Remove, &spec, fw, out)
}

/// Reads the rule and acts on decision 6's ownership, for a trusted `spec`.
fn act(op: Operation, spec: &RuleSpec, fw: &impl FirewallOps, out: Out<'_>) -> i32 {
    let read = |out: Out<'_>| match fw.query(&spec.names) {
        Ok(snapshot) => Some(snapshot),
        Err(e) => {
            out(&format!("the firewall could not be read: {e}"));
            None
        }
    };
    let Some(snapshot) = read(out) else {
        return EXIT_FAILED;
    };
    let state = match rules::classify(&snapshot, spec) {
        RuleState::Conflict(conflict) => {
            out(&format!(
                "conflict: a rule named {} exists that this helper does not own ({conflict}); nothing was changed",
                spec.names.name
            ));
            return EXIT_CONFLICT;
        }
        RuleState::Absent => Mine::Absent,
        RuleState::Owned => Mine::Owned,
        RuleState::OwnedNotInEffect => Mine::NotInEffect,
    };
    match (op, state) {
        (Operation::Status, Mine::Absent) => {
            out("no rule");
            EXIT_OK
        }
        (Operation::Status | Operation::Allow, Mine::Owned) => {
            out(&format!("the rule {} is in place", spec.names.name));
            EXIT_ALREADY
        }
        (Operation::Status | Operation::Allow, Mine::NotInEffect) => {
            out("the rule exists but a policy keeps local rules from applying");
            EXIT_POLICY
        }
        (Operation::Allow, Mine::Absent) => {
            if snapshot.local_rules_disallowed() {
                out("a policy keeps local rules from applying; no rule was created");
                return EXIT_POLICY;
            }
            if let Err(e) = fw.create(spec) {
                out(&format!("the rule could not be created: {e}"));
                return EXIT_FAILED;
            }
            let Some(after) = read(out) else {
                return EXIT_FAILED;
            };
            match rules::classify(&after, spec) {
                RuleState::Owned => {
                    out(&format!("created the rule {}", spec.names.name));
                    EXIT_OK
                }
                RuleState::OwnedNotInEffect => {
                    out("created the rule, but a policy keeps it from applying");
                    EXIT_POLICY
                }
                other => {
                    out(&format!(
                        "the rule is not as expected after creating it: {other:?}"
                    ));
                    EXIT_FAILED
                }
            }
        }
        (Operation::Remove, Mine::Absent) => {
            out("no rule to remove");
            EXIT_OK
        }
        (Operation::Remove, Mine::Owned | Mine::NotInEffect) => {
            if let Err(e) = fw.remove(&spec.names) {
                out(&format!("the rule could not be removed: {e}"));
                return EXIT_FAILED;
            }
            let Some(after) = read(out) else {
                return EXIT_FAILED;
            };
            if after.local.is_empty() {
                out(&format!("removed the rule {}", spec.names.name));
                EXIT_OK
            } else {
                out("a rule of the name is still in the local store after removing it");
                EXIT_FAILED
            }
        }
    }
}

/// [`RuleState`] once a conflict has been answered.
enum Mine {
    Absent,
    Owned,
    NotInEffect,
}

/// What the bin prints off Windows.
pub fn not_windows_lines() -> Vec<String> {
    usage_lines("this helper only runs on Windows")
}

#[cfg(test)]
mod tests;
