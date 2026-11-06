//! The procedure ([`run`]) over fakes, the arguments, and the build-time
//! constants against the app's own files. Nothing here touches the real
//! firewall, ACLs or processes.

use std::cell::RefCell;
use std::ffi::OsString;

use super::*;
use crate::placement::{
    AceFact, InstalledFacts, ObjectFacts, PlacementFacts, ATTRIBUTE_DIRECTORY, SID_ADMINISTRATORS,
    SID_SYSTEM, SID_TRUSTED_INSTALLER,
};
use crate::rules::{expected_fields, RuleFields, EXPECTED_SOURCE};

// --- arguments (decision 10) --------------------------------------------------

fn args(list: &[&str]) -> Vec<OsString> {
    list.iter().map(OsString::from).collect()
}

#[test]
fn each_operation_is_one_exact_argument() {
    assert_eq!(
        parse_args(args(&["firewall-allow"])),
        Ok(Request::Run(Operation::Allow))
    );
    assert_eq!(
        parse_args(args(&["firewall-remove"])),
        Ok(Request::Run(Operation::Remove))
    );
    assert_eq!(
        parse_args(args(&["firewall-status"])),
        Ok(Request::Run(Operation::Status))
    );
}

#[test]
fn anything_else_is_usage() {
    assert_eq!(parse_args(args(&[])), Err(UsageError::Missing));
    assert_eq!(
        parse_args(args(&["firewall-allow", "firewall-allow"])),
        Err(UsageError::TooMany(2))
    );
    assert_eq!(
        parse_args(args(&["firewall-allow", "C:\\other.exe"])),
        Err(UsageError::TooMany(2))
    );
    assert_eq!(parse_args(args(&[""])), Err(UsageError::Empty));
    assert_eq!(
        parse_args(args(&["firewall-allow", ""])),
        Err(UsageError::Empty)
    );
    for unknown in [
        "Firewall-Allow",
        "firewall-allow ",
        "--firewall-allow",
        "/firewall-allow",
        "firewall",
        "service-install",
    ] {
        assert_eq!(
            parse_args(args(&[unknown])),
            Err(UsageError::Unknown(unknown.into())),
            "{unknown}"
        );
    }
}

/// The uninstaller's request takes exactly the install folder after it;
/// no other operation takes a second argument.
#[test]
fn remove_installed_takes_exactly_the_install_folder() {
    assert_eq!(
        parse_args(args(&[
            REMOVE_INSTALLED_ARG,
            r"C:\Program Files\banto-admin"
        ])),
        Ok(Request::RemoveInstalled {
            install_dir: r"C:\Program Files\banto-admin".into()
        })
    );
    assert_eq!(
        parse_args(args(&[REMOVE_INSTALLED_ARG])),
        Err(UsageError::NoInstallDir)
    );
    assert_eq!(
        parse_args(args(&[REMOVE_INSTALLED_ARG, ""])),
        Err(UsageError::Empty)
    );
    assert_eq!(
        parse_args(args(&[REMOVE_INSTALLED_ARG, r"C:\a", r"C:\b"])),
        Err(UsageError::TooMany(3))
    );
    for op in Operation::ALL {
        assert_eq!(
            parse_args(args(&[op.arg(), r"C:\Program Files\banto-admin"])),
            Err(UsageError::TooMany(2)),
            "{op:?}"
        );
    }
    assert_eq!(
        parse_args(args(&[
            r"C:\Program Files\banto-admin",
            REMOVE_INSTALLED_ARG
        ])),
        Err(UsageError::TooMany(2))
    );
}

#[test]
fn a_non_utf8_argument_is_usage() {
    #[cfg(windows)]
    let bad = {
        use std::os::windows::ffi::OsStringExt;
        OsString::from_wide(&[0x66, 0xD800, 0x67])
    };
    #[cfg(unix)]
    let bad = {
        use std::os::unix::ffi::OsStringExt;
        OsString::from_vec(vec![0x66, 0xFF, 0x67])
    };
    assert_eq!(parse_args(vec![bad.clone()]), Err(UsageError::NotUtf8));
    assert_eq!(
        parse_args(vec![OsString::from("firewall-allow"), bad]),
        Err(UsageError::NotUtf8)
    );
}

// --- build-time constants against the app's files (decisions 5 and 8) --------

fn tauri_conf() -> serde_json::Value {
    serde_json::from_str(include_str!("../../src-tauri/tauri.conf.json")).unwrap()
}

/// Decision 5: the helper's identifier is the app's bundle identifier, so
/// the rule it manages is the one stage 1 reads.
#[test]
fn identifier_matches_tauri_conf() {
    assert_eq!(
        tauri_conf()["identifier"].as_str(),
        Some(IDENTIFIER),
        "IDENTIFIER must equal tauri.conf.json's identifier (change both when renaming)"
    );
}

/// The main exe next to the helper is the Tauri app's binary.
#[test]
fn main_exe_name_matches_the_tauri_binary() {
    let conf = tauri_conf();
    let binary = match conf["mainBinaryName"].as_str() {
        Some(name) => name.to_string(),
        None => {
            let manifest = include_str!("../../src-tauri/Cargo.toml");
            package_name(manifest).expect("src-tauri's package name")
        }
    };
    assert_eq!(MAIN_EXE_FILE_NAME, format!("{binary}.exe"));
}

/// The helper's name is this crate's `[[bin]]` (what build.rs embeds the
/// manifest into), and the manifest asks for administrator rights.
#[test]
fn helper_name_and_manifest_match_the_build() {
    let manifest = include_str!("../Cargo.toml");
    let bin = manifest
        .split("[[bin]]")
        .nth(1)
        .and_then(package_name)
        .expect("the [[bin]] name");
    assert_eq!(HELPER_EXE_FILE_NAME, format!("{bin}.exe"));
    let build = include_str!("../build.rs");
    assert!(
        build.contains(&format!("[\"{bin}\"]")),
        "build.rs targets the bin"
    );
    assert!(build.contains(".manifest_required()"));
    let app_manifest = include_str!("../admin-template-fw-elev.manifest");
    assert!(app_manifest.contains(r#"level="requireAdministrator""#));
    assert!(include_str!("../admin-template-fw-elev.rc")
        .contains("1 24 \"admin-template-fw-elev.manifest\""));
}

/// E4 (decisions 2, 3, 7 and 8): the installer puts the helper next to the
/// main exe under the fixed name both sides look for, the default install is
/// perMachine, and the uninstall hook embeds the same helper file into the
/// uninstaller, runs that copy (not the installed one) and names the rule
/// through Tauri's defines - which only works while the helper is
/// `<main binary>-fw-elev.exe`.
#[test]
fn installer_bundles_the_helper_next_to_the_main_exe() {
    let main_stem = MAIN_EXE_FILE_NAME.strip_suffix(".exe").unwrap();
    let helper_stem = HELPER_EXE_FILE_NAME.strip_suffix(".exe").unwrap();
    assert_eq!(helper_stem, format!("{main_stem}-fw-elev"));

    // Tauri strips the `-<target triple>` of an externalBin and installs it
    // into the install folder, i.e. next to the main exe.
    let fw_elev_conf: serde_json::Value =
        serde_json::from_str(include_str!("../../src-tauri/tauri.fw-elev.conf.json")).unwrap();
    assert_eq!(
        fw_elev_conf["bundle"]["externalBin"],
        serde_json::json!([format!("binaries/{helper_stem}")])
    );
    // Only the NSIS installer has the uninstall hook below; an MSI would bundle
    // the helper but leave the rule behind on uninstall.
    assert_eq!(
        fw_elev_conf["bundle"]["targets"],
        serde_json::json!(["nsis"])
    );

    let nsis = &tauri_conf()["bundle"]["windows"]["nsis"];
    assert_eq!(nsis["installMode"].as_str(), Some("perMachine"));
    assert_eq!(
        nsis["installerHooks"].as_str(),
        Some("windows/fw-elev-hooks.nsh")
    );

    let hooks = include_str!("../../src-tauri/windows/fw-elev-hooks.nsh");
    assert!(hooks.contains("!macro NSIS_HOOK_PREUNINSTALL"));
    assert!(hooks.contains("${BUNDLEID}.lan.tcp.program"));
    // Decision 8: the uninstaller runs the helper it carries (the externalBin
    // source, embedded by `File` and extracted to $PLUGINSDIR), never the
    // file in the install folder.
    assert!(hooks.contains(&format!(
        r"\..\{}\${{MAINBINARYNAME}}-fw-elev-${{FW_ELEV_TRIPLE}}.exe",
        fw_elev_conf["bundle"]["externalBin"][0]
            .as_str()
            .unwrap()
            .strip_suffix(&format!("/{helper_stem}"))
            .unwrap()
    )));
    assert!(hooks.contains(r#"File "/oname=$PLUGINSDIR\${MAINBINARYNAME}-fw-elev.exe""#));
    // The helper runs via nsExec (no console window; its output goes to the
    // details log), and its exit code is popped into $0 right after.
    let launch_line = format!(
        r#"nsExec::ExecToLog '"$PLUGINSDIR\${{MAINBINARYNAME}}-fw-elev.exe" {REMOVE_INSTALLED_ARG} "$INSTDIR"'"#
    );
    assert!(hooks.contains(&launch_line));
    assert_eq!(hooks.matches("nsExec::ExecToLog '").count(), 1);
    assert!(!hooks.contains("ExecWait"));
    let after_launch = &hooks[hooks.find(&launch_line).unwrap() + launch_line.len()..];
    assert!(after_launch.trim_start().starts_with("Pop $0"));
    assert!(!hooks.contains(r"$INSTDIR\${MAINBINARYNAME}-fw-elev.exe"));
    // The app-running check (whose Cancel aborts the uninstall) comes before the
    // rule is touched.
    let check = hooks
        .find("!insertmacro CheckIfAppIsRunning")
        .expect("the hook runs Tauri's app-running check");
    let launch = hooks.find(&launch_line).unwrap();
    assert!(check < launch);
    // Decision 3: nothing is created at install time.
    assert!(!hooks.contains("firewall-allow"));
    assert!(!hooks.contains("NSIS_HOOK_POSTINSTALL"));
}

/// The first `name = "..."` of a TOML fragment.
fn package_name(toml: &str) -> Option<String> {
    toml.lines().find_map(|line| {
        let rest = line.trim().strip_prefix("name")?.trim_start();
        let value = rest.strip_prefix('=')?.trim();
        Some(value.strip_prefix('"')?.strip_suffix('"')?.to_string())
    })
}

// --- run over fakes (decisions 6, 8 and 11) ----------------------------------

const DIR: &str = r"C:\Program Files\banto-admin";

fn trusted(path: &str, attributes: u32) -> ObjectFacts {
    let allow = |sid: &str, mask: u32| AceFact {
        ace_type: 0,
        flags: 0,
        mask,
        sid: Some(sid.into()),
    };
    ObjectFacts {
        path: path.into(),
        attributes,
        owner_sid: SID_ADMINISTRATORS.into(),
        dacl: Some(vec![
            allow(SID_TRUSTED_INSTALLER, 0x001F_01FF),
            allow(SID_SYSTEM, 0x001F_01FF),
            allow(SID_ADMINISTRATORS, 0x001F_01FF),
            allow("S-1-5-32-545", 0x0012_00A9),
        ]),
    }
}

fn good_facts() -> PlacementFacts {
    PlacementFacts {
        anchor: format!(r"{DIR}\{HELPER_EXE_FILE_NAME}"),
        program_files: vec![r"C:\Program Files".into()],
        helper: Some(trusted(&format!(r"{DIR}\{HELPER_EXE_FILE_NAME}"), 0x20)),
        main: Some(trusted(&format!(r"{DIR}\{MAIN_EXE_FILE_NAME}"), 0x20)),
        folders: vec![
            trusted(DIR, ATTRIBUTE_DIRECTORY),
            trusted(r"C:\Program Files", ATTRIBUTE_DIRECTORY),
        ],
    }
}

struct FakeProbe(Result<PlacementFacts, String>);

impl PlacementProbe for FakeProbe {
    fn placement_facts(&self) -> Result<PlacementFacts, String> {
        self.0.clone()
    }
}

fn program() -> String {
    format!(r"{DIR}\{MAIN_EXE_FILE_NAME}")
}

fn spec() -> RuleSpec {
    RuleSpec {
        names: rules::rule_names(IDENTIFIER).unwrap(),
        program: program(),
    }
}

fn owned(active: bool) -> RuleFields {
    let mut rule: RuleFields = expected_fields(&spec())
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
    if active {
        for (k, v) in EXPECTED_SOURCE {
            rule.insert(k.into(), vec![v.into()]);
        }
    }
    rule
}

/// A fake firewall: a local and an active store, a merge policy, and
/// scripted failures. Records what it was asked.
#[derive(Default)]
struct FakeFirewall {
    state: RefCell<RuleSnapshot>,
    /// Whether a created local rule appears in the active store.
    merges: bool,
    fail_query: bool,
    fail_create: bool,
    fail_remove: bool,
    /// The remove "succeeds" but the rule stays (a partial failure).
    remove_is_ignored: bool,
    calls: RefCell<Vec<String>>,
}

impl FakeFirewall {
    fn with(local: Vec<RuleFields>, active: Vec<RuleFields>) -> Self {
        Self {
            state: RefCell::new(RuleSnapshot {
                local,
                active,
                allow_local_rules: vec!["NotConfigured".into()],
            }),
            merges: true,
            ..Self::default()
        }
    }
    fn empty() -> Self {
        Self::with(vec![], vec![])
    }
    fn calls(&self) -> Vec<String> {
        self.calls.borrow().clone()
    }
}

impl FirewallOps for FakeFirewall {
    fn query(&self, names: &RuleNames) -> Result<RuleSnapshot, String> {
        self.calls
            .borrow_mut()
            .push(format!("query {}", names.name));
        if self.fail_query {
            return Err("access denied".into());
        }
        Ok(self.state.borrow().clone())
    }
    fn create(&self, spec: &RuleSpec) -> Result<(), String> {
        self.calls
            .borrow_mut()
            .push(format!("create {} {}", spec.names.name, spec.program));
        if self.fail_create {
            return Err("New-NetFirewallRule failed".into());
        }
        let mut state = self.state.borrow_mut();
        let fields: RuleFields = expected_fields(spec)
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
        state.local.push(fields.clone());
        if self.merges {
            let mut active = fields;
            for (k, v) in EXPECTED_SOURCE {
                active.insert(k.into(), vec![v.into()]);
            }
            state.active.push(active);
        }
        Ok(())
    }
    fn remove(&self, names: &RuleNames) -> Result<(), String> {
        self.calls
            .borrow_mut()
            .push(format!("remove {}", names.name));
        if self.fail_remove {
            return Err("Remove-NetFirewallRule failed".into());
        }
        if !self.remove_is_ignored {
            let mut state = self.state.borrow_mut();
            state.local.clear();
            state.active.clear();
        }
        Ok(())
    }
}

fn run_op(op: Operation, probe: &FakeProbe, fw: &FakeFirewall) -> (i32, Vec<String>) {
    let mut lines = Vec::new();
    let code = run(op, probe, fw, &mut |l| lines.push(l.to_string()));
    (code, lines)
}

fn good() -> FakeProbe {
    FakeProbe(Ok(good_facts()))
}

/// The rule name of the built-in identifier (not a literal, so the tests
/// keep passing after the rename recipe changes [`IDENTIFIER`]).
fn rule_name() -> String {
    format!("{IDENTIFIER}.lan.tcp.program")
}

#[test]
fn allow_creates_decision_ones_rule_for_the_main_exe() {
    let name = rule_name();
    let fw = FakeFirewall::empty();
    let (code, _) = run_op(Operation::Allow, &good(), &fw);
    assert_eq!(code, EXIT_OK);
    assert_eq!(
        fw.calls(),
        [
            format!("query {name}"),
            format!("create {name} {}", program()),
            format!("query {name}"),
        ]
    );
    // Then status and allow see it as the helper's own.
    assert_eq!(run_op(Operation::Status, &good(), &fw).0, EXIT_ALREADY);
    assert_eq!(run_op(Operation::Allow, &good(), &fw).0, EXIT_ALREADY);
}

#[test]
fn status_reports_absent_owned_conflict_and_policy() {
    let name = rule_name();
    assert_eq!(
        run_op(Operation::Status, &good(), &FakeFirewall::empty()).0,
        EXIT_OK
    );
    let fw = FakeFirewall::with(vec![owned(false)], vec![owned(true)]);
    assert_eq!(run_op(Operation::Status, &good(), &fw).0, EXIT_ALREADY);
    let fw = FakeFirewall::with(vec![owned(false)], vec![]);
    assert_eq!(run_op(Operation::Status, &good(), &fw).0, EXIT_POLICY);
    let mut widened = owned(false);
    widened.insert("Profile".into(), vec!["Private, Public".into()]);
    let fw = FakeFirewall::with(vec![widened], vec![owned(true)]);
    assert_eq!(run_op(Operation::Status, &good(), &fw).0, EXIT_CONFLICT);
    assert_eq!(fw.calls(), [format!("query {name}")]);
}

/// Decision 6: a rule of the name that is not the helper's own is neither
/// "already there" nor removed.
#[test]
fn a_conflicting_rule_is_never_overwritten_or_removed() {
    let name = rule_name();
    let mut other_install = owned(false);
    other_install.insert(
        "Program".into(),
        vec![r"C:\Program Files\banto-admin-2\admin-template.exe".into()],
    );
    let mut any_address = owned(false);
    any_address.insert("RemoteAddress".into(), vec!["Any".into()]);
    let mut disabled = owned(false);
    disabled.insert("Enabled".into(), vec!["False".into()]);
    let mut gpo = owned(true);
    gpo.insert("PolicyStoreSourceType".into(), vec!["GroupPolicy".into()]);
    for (local, active) in [
        (vec![other_install.clone()], vec![]),
        (vec![any_address], vec![]),
        (vec![disabled], vec![]),
        (vec![], vec![gpo.clone()]),
        (vec![owned(false)], vec![gpo]),
        (vec![owned(false), owned(false)], vec![]),
    ] {
        for op in [Operation::Allow, Operation::Remove, Operation::Status] {
            let fw = FakeFirewall::with(local.clone(), active.clone());
            let (code, _) = run_op(op, &good(), &fw);
            assert_eq!(code, EXIT_CONFLICT, "{op:?} {local:?}");
            assert_eq!(fw.calls(), [format!("query {name}")], "{op:?}: only read");
        }
    }
}

#[test]
fn allow_stops_with_policy_when_local_rules_are_not_merged() {
    let name = rule_name();
    let fw = FakeFirewall::empty();
    fw.state.borrow_mut().allow_local_rules = vec!["False".into()];
    assert_eq!(run_op(Operation::Allow, &good(), &fw).0, EXIT_POLICY);
    assert_eq!(fw.calls(), [format!("query {name}")], "nothing created");

    // An own local rule that is not in effect: allow does not add another.
    let fw = FakeFirewall::with(vec![owned(false)], vec![]);
    assert_eq!(run_op(Operation::Allow, &good(), &fw).0, EXIT_POLICY);
    assert_eq!(fw.calls().len(), 1);

    // Created, but the active store does not show it.
    let mut fw = FakeFirewall::empty();
    fw.merges = false;
    assert_eq!(run_op(Operation::Allow, &good(), &fw).0, EXIT_POLICY);
}

#[test]
fn an_existing_own_rule_is_policy_when_local_rules_are_not_merged() {
    let name = rule_name();
    let fw = FakeFirewall::with(vec![owned(false)], vec![owned(true)]);
    fw.state.borrow_mut().allow_local_rules = vec!["False".into()];
    for op in [Operation::Status, Operation::Allow] {
        assert_eq!(run_op(op, &good(), &fw).0, EXIT_POLICY, "{op:?}");
    }
    assert_eq!(fw.calls().len(), 2, "only reads, nothing created");

    // Remove still takes the rule away.
    let fw = FakeFirewall::with(vec![owned(false)], vec![owned(true)]);
    fw.state.borrow_mut().allow_local_rules = vec!["False".into()];
    assert_eq!(run_op(Operation::Remove, &good(), &fw).0, EXIT_OK);
    assert!(fw.calls().contains(&format!("remove {name}")));
}

#[test]
fn remove_removes_only_the_own_rule_and_absent_is_done() {
    let name = rule_name();
    let fw = FakeFirewall::with(vec![owned(false)], vec![owned(true)]);
    assert_eq!(run_op(Operation::Remove, &good(), &fw).0, EXIT_OK);
    assert_eq!(
        fw.calls(),
        [
            format!("query {name}"),
            format!("remove {name}"),
            format!("query {name}"),
        ]
    );
    let fw = FakeFirewall::empty();
    assert_eq!(run_op(Operation::Remove, &good(), &fw).0, EXIT_OK);
    assert_eq!(fw.calls(), [format!("query {name}")]);
    // Own rule not in effect: still removable.
    let fw = FakeFirewall::with(vec![owned(false)], vec![]);
    assert_eq!(run_op(Operation::Remove, &good(), &fw).0, EXIT_OK);
}

#[test]
fn failures_are_exit_one() {
    let mut fw = FakeFirewall::empty();
    fw.fail_query = true;
    for op in Operation::ALL {
        assert_eq!(run_op(op, &good(), &fw).0, EXIT_FAILED, "{op:?}");
    }
    let mut fw = FakeFirewall::empty();
    fw.fail_create = true;
    assert_eq!(run_op(Operation::Allow, &good(), &fw).0, EXIT_FAILED);
    let mut fw = FakeFirewall::with(vec![owned(false)], vec![owned(true)]);
    fw.fail_remove = true;
    assert_eq!(run_op(Operation::Remove, &good(), &fw).0, EXIT_FAILED);
    let mut fw = FakeFirewall::with(vec![owned(false)], vec![owned(true)]);
    fw.remove_is_ignored = true;
    assert_eq!(run_op(Operation::Remove, &good(), &fw).0, EXIT_FAILED);
}

/// Decision 8: an untrusted placement is exit 2 before the firewall is
/// even read (portable copy, user-writable vendor folder, unreadable facts).
#[test]
fn an_untrusted_placement_touches_nothing() {
    let mut portable = good_facts();
    portable.anchor = format!(r"C:\Tools\{HELPER_EXE_FILE_NAME}");
    portable.helper.as_mut().unwrap().path = format!(r"C:\Tools\{HELPER_EXE_FILE_NAME}");
    portable.main.as_mut().unwrap().path = format!(r"C:\Tools\{MAIN_EXE_FILE_NAME}");
    let mut writable = good_facts();
    writable.folders[0].dacl.as_mut().unwrap().push(AceFact {
        ace_type: 0,
        flags: 0x03,
        mask: 0x0013_01BF,
        sid: Some("S-1-5-11".into()),
    });
    let mut no_main = good_facts();
    no_main.main = None;
    for probe in [
        FakeProbe(Ok(portable)),
        FakeProbe(Ok(writable)),
        FakeProbe(Ok(no_main)),
        FakeProbe(Err("SHGetKnownFolderPath failed".into())),
    ] {
        for op in Operation::ALL {
            let fw = FakeFirewall::with(vec![owned(false)], vec![owned(true)]);
            let (code, lines) = run_op(op, &probe, &fw);
            assert_eq!(code, EXIT_PRECONDITION, "{op:?}");
            assert!(fw.calls().is_empty(), "{op:?}: firewall untouched");
            assert!(lines[0].starts_with("precondition not met"));
        }
    }
}

// --- the uninstaller's copy (decisions 3, 8 and 10) ---------------------------

fn installed(main: Option<ObjectFacts>) -> Result<InstalledFacts, String> {
    Ok(InstalledFacts {
        program_files: vec![r"C:\Program Files".into()],
        main,
    })
}

fn run_installed(facts: Result<InstalledFacts, String>, fw: &FakeFirewall) -> (i32, Vec<String>) {
    let mut lines = Vec::new();
    let code = run_remove_installed(facts, fw, &mut |l| lines.push(l.to_string()));
    (code, lines)
}

/// The rule's `Program` is the main exe's final path, so only the rule this
/// app created for it is removed - same as `firewall-remove` next to it.
#[test]
fn remove_installed_removes_only_the_own_rule_of_that_main_exe() {
    let name = rule_name();
    let main = || Some(trusted(&program(), 0x20));
    let fw = FakeFirewall::with(vec![owned(false)], vec![owned(true)]);
    assert_eq!(run_installed(installed(main()), &fw).0, EXIT_OK);
    assert_eq!(
        fw.calls(),
        [
            format!("query {name}"),
            format!("remove {name}"),
            format!("query {name}"),
        ]
    );
    let fw = FakeFirewall::empty();
    assert_eq!(run_installed(installed(main()), &fw).0, EXIT_OK);
    assert_eq!(fw.calls(), [format!("query {name}")]);
    // A rule of the name for another exe is a conflict, never removed.
    let other = Some(trusted(
        &format!(r"C:\Program Files\other\{MAIN_EXE_FILE_NAME}"),
        0x20,
    ));
    let fw = FakeFirewall::with(vec![owned(false)], vec![owned(true)]);
    assert_eq!(run_installed(installed(other), &fw).0, EXIT_CONFLICT);
    assert!(!fw.calls().iter().any(|c| c.starts_with("remove")));
    // No ACL check: a main exe others may write still gets its rule removed.
    let mut writable = trusted(&program(), 0x20);
    writable.dacl.as_mut().unwrap().push(AceFact {
        ace_type: 0,
        flags: 0,
        mask: 0x0013_01BF,
        sid: Some("S-1-5-11".into()),
    });
    let fw = FakeFirewall::with(vec![owned(false)], vec![owned(true)]);
    assert_eq!(run_installed(installed(Some(writable)), &fw).0, EXIT_OK);
}

#[test]
fn remove_installed_needs_the_fixed_name_main_exe_under_program_files() {
    for facts in [
        installed(None),
        installed(Some(trusted(&format!(r"{DIR}\other.exe"), 0x20))),
        installed(Some(trusted(&program(), ATTRIBUTE_DIRECTORY))),
        installed(Some(trusted(&program(), 0x400))),
        installed(Some(trusted(
            &format!(r"C:\Tools\{MAIN_EXE_FILE_NAME}"),
            0x20,
        ))),
        Err("the install folder is not a plain drive path".into()),
    ] {
        let fw = FakeFirewall::with(vec![owned(false)], vec![owned(true)]);
        let (code, lines) = run_installed(facts.clone(), &fw);
        assert_eq!(code, EXIT_PRECONDITION, "{facts:?}");
        assert!(fw.calls().is_empty(), "{facts:?}: firewall untouched");
        assert!(lines[0].starts_with("precondition not met"));
    }
}

#[test]
fn exit_codes_are_decision_elevens() {
    assert_eq!(
        [
            EXIT_OK,
            EXIT_FAILED,
            EXIT_PRECONDITION,
            EXIT_ALREADY,
            EXIT_CONFLICT,
            EXIT_POLICY,
            EXIT_USAGE
        ],
        [0, 1, 2, 3, 4, 5, 64]
    );
}
