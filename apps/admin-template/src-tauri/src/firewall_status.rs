//! Spec §11.4 (LAN settings UX: documenting the OS-side Windows Firewall
//! behavior). Reads, without elevation, whether Windows Defender Firewall has
//! the rules the settings screen's administrator commands create (Issue #219,
//! stage 1 / PR-B), and compares them with what those commands would create
//! for the listener that is serving now.
//!
//! The rules are looked up by their deterministic `-Name` only
//! (`<identifier>.lan.tcp.program` / `.port`, the same names as
//! `firewallInfo.ts::firewallRuleNames`), and the `-Group <identifier>` is
//! only counted. The read never changes the firewall.
//!
//! What is compared is the rule IN EFFECT: the ActiveStore's rule of that
//! name, with its own filters, its source (`PolicyStoreSourceType` /
//! `PolicyStoreSource`, traced with `-TracePolicyStore`) and its
//! `EnforcementStatus`. Being in the ActiveStore is not being applied: only
//! `Full` counts as applied, a documented other code (`InactiveProfile`,
//! `LocalFirewallRulesDisallowed`, ...) as "there but not applied", and no
//! code or an unknown one as "not known" (owner review on PR #465). A
//! central policy (Group Policy, MDM) can define a rule of the same name that
//! wins over the local one, so the local (PersistentStore) rule is reported
//! only as a supplement - whether it exists and whether it has other values
//! (Codex review on PR #465).
//!
//! How it reads: a child `powershell.exe` (the in-box Windows PowerShell,
//! by absolute path under `%SystemRoot%`, never `PATH`) runs a FIXED script
//! passed as `-EncodedCommand` (base64 of UTF-16LE), so nothing goes through
//! a command line that cmd/PowerShell would parse. The only values in the
//! script are the rule names, built from an identifier checked against
//! Tauri's identifier alphabet ([`rule_names`]) and still written as
//! PowerShell single-quoted literals ([`quote_powershell_literal`]). The
//! script prints one ASCII-only JSON object ([`evaluate`] parses it). A
//! failure, a timeout ([`PROBE_TIMEOUT`]) or any output that does not parse
//! is reported as `unknown` with a reason code - never as `missing`
//! (security audit 2026-10-21: a failed read is not "no rule"). `missing`
//! needs the lookup itself to answer "no such rule"; missing cmdlets or a
//! module that does not load are a failed read (owner review on PR #465).
//!
//! Codes and values only: the frontend builds every text (conventions §13).

use admin_template_fw_elev::powershell::{
    encode_command, quote_literal as quote_powershell_literal,
};
use admin_template_fw_elev::rules::rule_names as elev_rule_names;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

/// How long the read may take before it is reported as `unknown`/`timeout`.
/// PowerShell's start plus the NetSecurity module's first load is a few
/// seconds on a warm machine but went past 10 s on a cold CI runner (PR #465),
/// so a slow PC right after boot gets room too. It runs off the async runtime
/// and only on the admin's request, so waiting longer blocks nothing else.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// Upper bound on what is read from the child's stdout. The real output is
/// well under 4 KiB.
#[cfg_attr(not(windows), allow(dead_code))]
const MAX_OUTPUT: u64 = 64 * 1024;

/// What the administrator commands create (`firewallInfo.ts`: `Inbound`,
/// `TCP`, `Private`, `LocalSubnet`, `Allow`), as `Get-NetFirewall*` reports it.
const EXPECTED_ENABLED: &str = "True";
const EXPECTED_DIRECTION: &str = "Inbound";
const EXPECTED_ACTION: &str = "Allow";
const EXPECTED_PROTOCOL: &str = "TCP";
const EXPECTED_PROFILE: &str = "Private";
const EXPECTED_REMOTE_ADDRESS: &str = "LocalSubnet";
/// What a rule filter reports when it does not restrict the value.
const ANY: &str = "Any";
/// `EnforcementStatus` code of a rule that is fully enforced (`Full`).
const ENFORCEMENT_FULL: u64 = 1;
/// `EnforcementStatus` codes by value, as `MSFT_NetFirewallRule` documents
/// them (0-23). Codes past these (a newer Windows) are not guessed at: they
/// make the enforcement `unknown`.
const ENFORCEMENT_NAMES: [&str; 24] = [
    "Invalid",
    "Full",
    "FirewallOffInProfile",
    "CategoryOff",
    "DisabledObject",
    "InactiveProfile",
    "LocalAddressResolutionEmpty",
    "RemoteAddressResolutionEmpty",
    "LocalPortResolutionEmpty",
    "RemotePortResolutionEmpty",
    "InterfaceResolutionEmpty",
    "ApplicationResolutionEmpty",
    "RemoteMachineEmpty",
    "RemoteUserEmpty",
    "LocalGlobalOpenPortsDisallowed",
    "LocalAuthorizedApplicationsDisallowed",
    "LocalFirewallRulesDisallowed",
    "LocalConsecRulesDisallowed",
    "NotTargetPlatform",
    "OptimizedOut",
    "LocalUserEmpty",
    "TransportMachinesEmpty",
    "TunnelMachinesEmpty",
    "TupleResolutionEmpty",
];

/// The rule names derived from the app identifier (Issue #219, PR #463).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RuleNames {
    pub(crate) group: String,
    pub(crate) program: String,
    pub(crate) port: String,
}

/// The rule names for `identifier`, or `None` when it is not a valid
/// identifier (then nothing is read). The group and the program rule's name
/// are the helper's own ([`elev_rule_names`]), so stage 1 reads exactly the
/// rule stage 2 creates; the port rule's name is read by stage 1 only.
pub(crate) fn rule_names(identifier: &str) -> Option<RuleNames> {
    let elev = elev_rule_names(identifier)?;
    Some(RuleNames {
        group: elev.group,
        program: elev.name,
        port: format!("{identifier}.lan.tcp.port"),
    })
}

/// The fixed read-only script. `{GROUP}`, `{PROGRAM}` and `{PORT}` are
/// replaced with quoted literals.
///
/// First it checks that the cmdlets it uses are there at all
/// (`Get-Command`): without them nothing can be read (the NetSecurity
/// module missing or failing to load), and the script exits with 3 - a
/// failed read, never "no rule" (owner review on PR #465:
/// `CommandNotFoundException` is also of the `ObjectNotFound` category).
///
/// Each rule is read twice: `local` from the default (PersistentStore)
/// store, the one the administrator commands write, and `effective` from the
/// ActiveStore, the merge of every store that Windows enforces (Codex review
/// on PR #465: a Group Policy rule of the same name wins there). The
/// ActiveStore read passes `-TracePolicyStore`, so `PolicyStoreSource` and
/// `PolicyStoreSourceType` say where the rule comes from, and reports the
/// raw `EnforcementStatus` codes (`uint16[]` of `MSFT_NetFirewallRule`, not
/// the module's display text), which tell whether it is enforced at all.
///
/// Each read reports `s` = `missing` only when the lookup itself answered
/// "no such rule" (`Test-BantoNotFound`: a `CimJobException` of category
/// `ObjectNotFound` whose error id is the cmdlet's own
/// `CmdletizationQuery_NotFound_*` for `Get-NetFirewallRule`, checked on a
/// real PC), `error` for anything else (or more than one object answering),
/// or `present` with its values. `group` is how many OTHER rules carry the
/// group, `-1` when unreadable (only a "no such group" answer is `0`). The
/// JSON is escaped to ASCII so the console code page cannot mangle a
/// non-ASCII path.
const PROBE_SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { $null = Get-Command -Name Get-NetFirewallRule, Get-NetFirewallApplicationFilter, Get-NetFirewallPortFilter, Get-NetFirewallAddressFilter -ErrorAction Stop } catch { exit 3 }
function Test-BantoNotFound($e) { ([string]$e.Exception.GetType().FullName -eq 'Microsoft.PowerShell.Cmdletization.Cim.CimJobException') -and ($e.CategoryInfo.Category -eq [System.Management.Automation.ErrorCategory]::ObjectNotFound) -and ([string]$e.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound_*,Get-NetFirewallRule') }
function Read-BantoStore([string]$name, [bool]$active) {
  try {
    if ($active) { $found = @(Get-NetFirewallRule -Name $name -PolicyStore ActiveStore -TracePolicyStore -ErrorAction Stop) }
    else { $found = @(Get-NetFirewallRule -Name $name -ErrorAction Stop) }
  } catch { if (Test-BantoNotFound $_) { return @{ s = 'missing' } }; return @{ s = 'error' } }
  if ($found.Count -ne 1) { return @{ s = 'error' } }
  $r = $found[0]
  try {
    $app = $r | Get-NetFirewallApplicationFilter -ErrorAction Stop
    $pf = $r | Get-NetFirewallPortFilter -ErrorAction Stop
    $af = $r | Get-NetFirewallAddressFilter -ErrorAction Stop
  } catch { return @{ s = 'error' } }
  $h = @{ s = 'present'; enabled = [string]$r.Enabled; direction = [string]$r.Direction; action = [string]$r.Action; profile = [string]$r.Profile; program = [string]$app.Program; protocol = [string]$pf.Protocol; localPort = @($pf.LocalPort | ForEach-Object { [string]$_ }); remoteAddress = @($af.RemoteAddress | ForEach-Object { [string]$_ }) }
  if ($active) {
    $h.source = [string]$r.PolicyStoreSource
    $h.sourceType = [string]$r.PolicyStoreSourceType
    $es = $r.PSBase.CimInstanceProperties['EnforcementStatus']
    $h.enforcement = @(if ($null -ne $es -and $null -ne $es.Value) { foreach ($v in $es.Value) { [int]$v } })
  }
  return $h
}
function Read-BantoRule([string]$name) { return @{ local = (Read-BantoStore $name $false); effective = (Read-BantoStore $name $true) } }
$group = -1
try { $group = @(Get-NetFirewallRule -Group {GROUP} -ErrorAction Stop | Where-Object { $_.Name -ne {PROGRAM} -and $_.Name -ne {PORT} }).Count }
catch { if (Test-BantoNotFound $_) { $group = 0 } }
$out = @{ program = (Read-BantoRule {PROGRAM}); port = (Read-BantoRule {PORT}); group = $group }
$json = ConvertTo-Json -InputObject $out -Compress -Depth 6
$sb = New-Object System.Text.StringBuilder
foreach ($c in $json.ToCharArray()) { if ([int]$c -lt 128) { [void]$sb.Append($c) } else { [void]$sb.AppendFormat('\u{0:x4}', [int]$c) } }
[Console]::Out.Write($sb.ToString())
"#;

/// The script for `names`, or `None` if a name cannot be quoted (it always
/// can for names from [`rule_names`]).
pub(crate) fn probe_script(names: &RuleNames) -> Option<String> {
    let group = quote_powershell_literal(&names.group)?;
    let program = quote_powershell_literal(&names.program)?;
    let port = quote_powershell_literal(&names.port)?;
    Some(
        PROBE_SCRIPT
            .replace("{GROUP}", &group)
            .replace("{PROGRAM}", &program)
            .replace("{PORT}", &port),
    )
}

/// Why a rule's state could not be told. Mirrors
/// `firewallRuleStatus.ts::FirewallUnknownReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum UnknownReason {
    /// This host is not Windows.
    #[cfg_attr(windows, allow(dead_code))]
    NotWindows,
    /// The app identifier is not a valid identifier, so no rule name exists.
    InvalidIdentifier,
    /// PowerShell could not be started.
    #[cfg_attr(not(windows), allow(dead_code))]
    LaunchFailed,
    /// The read did not finish within [`PROBE_TIMEOUT`].
    #[cfg_attr(not(windows), allow(dead_code))]
    Timeout,
    /// PowerShell reported an error (access refused, a policy that hides the
    /// rule store, the NetSecurity cmdlets missing or failing to load, ...):
    /// anything but the lookup answering "no such rule".
    QueryFailed,
    /// The output was not what the script prints.
    UnreadableOutput,
}

/// A rule value that differs from what the commands create (or could not be
/// compared). Mirrors `firewallRuleStatus.ts::FirewallField`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum FirewallField {
    Enabled,
    Direction,
    Action,
    Protocol,
    Profile,
    Program,
    LocalPort,
    RemoteAddress,
    /// The rule is in the local store but not in the ActiveStore: a policy
    /// (e.g. Group Policy not merging local rules) keeps it from applying.
    /// Only ever a mismatch, never unchecked (an unreadable ActiveStore makes
    /// the whole rule `unknown`).
    Active,
    /// The ActiveStore's rule is not fully enforced (`EnforcementStatus` is
    /// not `Full`, e.g. `InactiveProfile`, `LocalFirewallRulesDisallowed`):
    /// a mismatch then, and unchecked when the status is missing or unknown
    /// (owner review on PR #465: being in the ActiveStore is not being
    /// applied).
    Enforcement,
}

/// The values of a rule that exists, as `Get-NetFirewall*` reports them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FirewallRuleValues {
    pub(crate) enabled: String,
    pub(crate) direction: String,
    pub(crate) action: String,
    pub(crate) protocol: String,
    pub(crate) profile: String,
    pub(crate) program: String,
    pub(crate) local_ports: Vec<String>,
    pub(crate) remote_addresses: Vec<String>,
}

/// The kind of store the ActiveStore's rule comes from: its
/// `PolicyStoreSourceType` (read with `-TracePolicyStore`), by the names the
/// NetSecurity module gives them (its `PolicyStoreType`: `None`, `Local`,
/// `GroupPolicy`, `Dynamic`, `Generated`, `Hardcoded`, `MDM` and the
/// `HostFirewall*` ones, as `Get-NetFirewallRule -PolicyStoreSourceType`
/// documents). Mirrors `serverAdmin.ts::FirewallSourceKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SourceKind {
    /// The local store: the rule the administrator commands create.
    Local,
    /// A Group Policy object.
    GroupPolicy,
    /// Added at run time (not persisted).
    Dynamic,
    /// Generated by Windows.
    Generated,
    /// Built into Windows.
    Hardcoded,
    /// Mobile device management.
    Mdm,
    /// The `HostFirewall*` stores (Hyper-V host firewall).
    HostFirewallLocal,
    HostFirewallGroupPolicy,
    HostFirewallDynamic,
    HostFirewallMdm,
    /// Not reported (empty, missing or `None`): the source is not known.
    Unknown,
    /// A value outside the list above (shown as is).
    Other,
}

impl SourceKind {
    fn from_source_type(source_type: Option<&str>) -> Self {
        const NAMES: [(&str, SourceKind); 11] = [
            ("None", SourceKind::Unknown),
            ("Local", SourceKind::Local),
            ("GroupPolicy", SourceKind::GroupPolicy),
            ("Dynamic", SourceKind::Dynamic),
            ("Generated", SourceKind::Generated),
            ("Hardcoded", SourceKind::Hardcoded),
            ("MDM", SourceKind::Mdm),
            ("HostFirewallLocal", SourceKind::HostFirewallLocal),
            (
                "HostFirewallGroupPolicy",
                SourceKind::HostFirewallGroupPolicy,
            ),
            ("HostFirewallDynamic", SourceKind::HostFirewallDynamic),
            ("HostFirewallMDM", SourceKind::HostFirewallMdm),
        ];
        match source_type {
            None => Self::Unknown,
            Some(source_type) => NAMES
                .iter()
                .find(|(name, _)| source_type.eq_ignore_ascii_case(name))
                .map_or(Self::Other, |(_, kind)| *kind),
        }
    }
}

/// Where the rule in effect (the ActiveStore's) comes from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuleOrigin {
    /// What `source_type` names (`unknown` when it was not reported).
    pub(crate) kind: SourceKind,
    /// `PolicyStoreSourceType` as reported, `None` when empty or missing.
    pub(crate) source_type: Option<String>,
    /// `PolicyStoreSource`: `PersistentStore` for a local rule, the policy
    /// otherwise (e.g. a GPO's domain path); `None` when empty or missing
    /// (then not known - an empty source is never taken for a policy).
    pub(crate) source: Option<String>,
}

impl RuleOrigin {
    fn from_value(value: &Value) -> Self {
        let text = |key: &str| {
            value
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        let source_type = text("sourceType");
        Self {
            kind: SourceKind::from_source_type(source_type.as_deref()),
            source_type,
            source: text("source"),
        }
    }
}

/// Whether the rule in effect is enforced: the ActiveStore's
/// `EnforcementStatus`. Mirrors `serverAdmin.ts::FirewallEnforcement`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum Enforcement {
    /// `Full` only: applied.
    Enforced,
    /// In the ActiveStore but not applied, for these documented reasons
    /// (`InactiveProfile`, `LocalFirewallRulesDisallowed`, ...).
    NotEnforced { reasons: Vec<String> },
    /// No status, or a code outside the documented ones, or `Full` next to
    /// another code (`values`, raw): whether it applies is not known.
    Unknown { values: Vec<u64> },
}

impl Enforcement {
    fn from_value(value: Option<&Value>) -> Self {
        let codes: Option<Vec<u64>> = match value {
            Some(Value::Array(items)) => items.iter().map(Value::as_u64).collect(),
            // PowerShell can unwrap a one-element array.
            Some(Value::Number(n)) => n.as_u64().map(|n| vec![n]),
            _ => None,
        };
        let Some(codes) = codes.filter(|codes| !codes.is_empty()) else {
            return Self::Unknown { values: Vec::new() };
        };
        let names: Option<Vec<&str>> = codes
            .iter()
            .map(|code| {
                usize::try_from(*code)
                    .ok()
                    .and_then(|i| ENFORCEMENT_NAMES.get(i).copied())
            })
            .collect();
        let full = codes.iter().filter(|c| **c == ENFORCEMENT_FULL).count();
        match names {
            Some(_) if full == codes.len() => Self::Enforced,
            Some(names) if full == 0 => {
                let mut reasons: Vec<String> = Vec::new();
                for name in names {
                    if !reasons.iter().any(|r| r == name) {
                        reasons.push(name.to_string());
                    }
                }
                Self::NotEnforced { reasons }
            }
            _ => Self::Unknown { values: codes },
        }
    }
}

/// The local (PersistentStore) rule of the same name, next to the one in
/// effect. Mirrors `serverAdmin.ts::FirewallLocalRule`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum LocalRule {
    /// No local rule of this name (the one in effect comes from elsewhere).
    Missing,
    /// The local rule has the same values as the reported `rule`.
    Same,
    /// The local rule has other values than the one in effect.
    Differs { rule: FirewallRuleValues },
    /// The local store could not be read.
    Unknown,
}

/// One rule's state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
// Two values per response, built once and serialized: boxing `Present` would
// only add an allocation.
#[allow(clippy::large_enum_variant)]
pub(crate) enum FirewallRuleCheck {
    /// No rule of this name, neither in effect nor in the local store.
    Missing,
    /// A rule of this name exists. `rule` holds the values in effect (the
    /// ActiveStore's), `origin` where they come from and `enforcement`
    /// whether Windows applies it (not `enforced`: `mismatches` has
    /// `enforcement`; unknown: `unchecked` has it). A rule only in the local
    /// store is not in effect: then `rule` is the local one, `origin` and
    /// `enforcement` are `None` and `mismatches` has `active`. `mismatches` lists what
    /// differs from the command's rule (empty = as expected); `unchecked`
    /// what could not be compared (no live listener or executable path to
    /// compare with). `local` tells the local rule apart from the one in
    /// effect.
    Present {
        rule: FirewallRuleValues,
        origin: Option<RuleOrigin>,
        enforcement: Option<Enforcement>,
        local: LocalRule,
        mismatches: Vec<FirewallField>,
        unchecked: Vec<FirewallField>,
    },
    /// The state could not be read.
    Unknown { reason: UnknownReason },
}

/// What the rules were compared with: the server snapshot of `generation`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FirewallExpectation {
    /// `server_status.executablePath` of the same snapshot.
    pub(crate) executable_path: Option<String>,
    /// `server_status.live.port` of the same snapshot (`None` when nothing
    /// is serving).
    pub(crate) port: Option<u16>,
}

/// `firewall_rule_status`'s response. Mirrors
/// `firewallRuleStatus.ts::FirewallRuleStatus`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FirewallRuleStatus {
    /// `ServerSlot::generation` of the snapshot `expected` came from, so the
    /// screen can drop a result for a listener it no longer shows.
    pub(crate) generation: u64,
    pub(crate) expected: FirewallExpectation,
    /// The per-executable rule (`<identifier>.lan.tcp.program`).
    pub(crate) program: FirewallRuleCheck,
    /// The per-port rule (`<identifier>.lan.tcp.port`).
    pub(crate) port: FirewallRuleCheck,
    /// How many other rules carry `-Group <identifier>` (a hint that a rule
    /// was made under another name); `None` when unknown.
    pub(crate) group_other_rules: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuleShape {
    Program,
    Port,
}

/// Builds the response from the probe's outcome (`Ok` = the script's stdout).
pub(crate) fn evaluate(
    generation: u64,
    expected: FirewallExpectation,
    outcome: Result<String, UnknownReason>,
) -> FirewallRuleStatus {
    let parsed = outcome.and_then(|stdout| {
        serde_json::from_str::<Value>(stdout.trim())
            .ok()
            .filter(Value::is_object)
            .ok_or(UnknownReason::UnreadableOutput)
    });
    let (program, port, group_other_rules) = match parsed {
        Err(reason) => (
            FirewallRuleCheck::Unknown { reason },
            FirewallRuleCheck::Unknown { reason },
            None,
        ),
        Ok(value) => (
            check_rule(value.get("program"), RuleShape::Program, &expected),
            check_rule(value.get("port"), RuleShape::Port, &expected),
            value
                .get("group")
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok()),
        ),
    };
    FirewallRuleStatus {
        generation,
        expected,
        program,
        port,
        group_other_rules,
    }
}

fn check_rule(
    value: Option<&Value>,
    shape: RuleShape,
    expected: &FirewallExpectation,
) -> FirewallRuleCheck {
    let Some(value) = value else {
        return FirewallRuleCheck::Unknown {
            reason: UnknownReason::UnreadableOutput,
        };
    };
    let local = read_store(value.get("local"));
    let effective = match read_store(value.get("effective")) {
        Ok(effective) => effective,
        // What applies is not known, whatever the local store says.
        Err(reason) => return FirewallRuleCheck::Unknown { reason },
    };
    match effective {
        Some((rule, read)) => {
            let local = match local {
                Err(_) => LocalRule::Unknown,
                Ok(None) => LocalRule::Missing,
                Ok(Some((local, _))) if same_values(&local, &rule) => LocalRule::Same,
                Ok(Some((local, _))) => LocalRule::Differs { rule: local },
            };
            let enforcement = Enforcement::from_value(read.get("enforcement"));
            let (mut mismatches, mut unchecked) = compare(&rule, shape, expected);
            match enforcement {
                Enforcement::Enforced => {}
                Enforcement::NotEnforced { .. } => mismatches.push(FirewallField::Enforcement),
                Enforcement::Unknown { .. } => unchecked.push(FirewallField::Enforcement),
            }
            mismatches.sort();
            unchecked.sort();
            FirewallRuleCheck::Present {
                rule,
                origin: Some(RuleOrigin::from_value(read)),
                enforcement: Some(enforcement),
                local,
                mismatches,
                unchecked,
            }
        }
        None => match local {
            Err(reason) => FirewallRuleCheck::Unknown { reason },
            Ok(None) => FirewallRuleCheck::Missing,
            Ok(Some((rule, _))) => {
                let (mut mismatches, unchecked) = compare(&rule, shape, expected);
                mismatches.push(FirewallField::Active);
                mismatches.sort();
                FirewallRuleCheck::Present {
                    rule,
                    origin: None,
                    enforcement: None,
                    local: LocalRule::Same,
                    mismatches,
                    unchecked,
                }
            }
        },
    }
}

/// Whether the local rule `local` has the values of `effective`, ignoring
/// ASCII case. The ActiveStore expands environment variables in a program
/// path (`%SystemRoot%\...` reads back as `C:\WINDOWS\...`, checked on a
/// real PC), so a local path with `%` is not held against it.
fn same_values(local: &FirewallRuleValues, effective: &FirewallRuleValues) -> bool {
    let same = |a: &str, b: &str| a.eq_ignore_ascii_case(b);
    let same_list =
        |a: &[String], b: &[String]| a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b));
    same(&local.enabled, &effective.enabled)
        && same(&local.direction, &effective.direction)
        && same(&local.action, &effective.action)
        && same(&local.protocol, &effective.protocol)
        && same(&local.profile, &effective.profile)
        && (local.program.contains('%') || same(&local.program, &effective.program))
        && same_list(&local.local_ports, &effective.local_ports)
        && same_list(&local.remote_addresses, &effective.remote_addresses)
}

/// One store's read: `Ok(None)` = no rule of this name there; otherwise the
/// rule's values and the read itself (for the ActiveStore's source and
/// enforcement).
fn read_store(
    value: Option<&Value>,
) -> Result<Option<(FirewallRuleValues, &Value)>, UnknownReason> {
    let value = value.ok_or(UnknownReason::UnreadableOutput)?;
    match value.get("s").and_then(Value::as_str) {
        Some("missing") => Ok(None),
        Some("error") => Err(UnknownReason::QueryFailed),
        Some("present") => parse_values(value)
            .map(|rule| Some((rule, value)))
            .ok_or(UnknownReason::UnreadableOutput),
        _ => Err(UnknownReason::UnreadableOutput),
    }
}

fn parse_values(value: &Value) -> Option<FirewallRuleValues> {
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
    Some(FirewallRuleValues {
        enabled: text("enabled")?,
        direction: text("direction")?,
        action: text("action")?,
        protocol: text("protocol")?,
        profile: text("profile")?,
        program: text("program")?,
        local_ports: string_list(value.get("localPort")?)?,
        remote_addresses: string_list(value.get("remoteAddress")?)?,
    })
}

/// A JSON string array, or a lone string (PowerShell can unwrap a
/// one-element array).
fn string_list(value: &Value) -> Option<Vec<String>> {
    match value {
        Value::String(s) => Some(vec![s.clone()]),
        Value::Array(items) => items
            .iter()
            .map(|item| item.as_str().map(str::to_string))
            .collect(),
        _ => None,
    }
}

/// `list` is exactly the one value `expected` (ignoring ASCII case).
fn is_only(list: &[String], expected: &str) -> bool {
    matches!(list, [only] if only.eq_ignore_ascii_case(expected))
}

/// Compares `rule` with what the command for `shape` creates. Windows paths
/// are compared ignoring case.
fn compare(
    rule: &FirewallRuleValues,
    shape: RuleShape,
    expected: &FirewallExpectation,
) -> (Vec<FirewallField>, Vec<FirewallField>) {
    let mut mismatches = Vec::new();
    let mut unchecked = Vec::new();
    let mut expect = |field, ok: bool| {
        if !ok {
            mismatches.push(field);
        }
    };
    expect(
        FirewallField::Enabled,
        rule.enabled.eq_ignore_ascii_case(EXPECTED_ENABLED),
    );
    expect(
        FirewallField::Direction,
        rule.direction.eq_ignore_ascii_case(EXPECTED_DIRECTION),
    );
    expect(
        FirewallField::Action,
        rule.action.eq_ignore_ascii_case(EXPECTED_ACTION),
    );
    expect(
        FirewallField::Protocol,
        rule.protocol.eq_ignore_ascii_case(EXPECTED_PROTOCOL),
    );
    expect(
        FirewallField::Profile,
        rule.profile.eq_ignore_ascii_case(EXPECTED_PROFILE),
    );
    expect(
        FirewallField::RemoteAddress,
        is_only(&rule.remote_addresses, EXPECTED_REMOTE_ADDRESS),
    );
    match shape {
        RuleShape::Program => {
            match &expected.executable_path {
                Some(path) => expect(
                    FirewallField::Program,
                    rule.program.to_lowercase() == path.to_lowercase(),
                ),
                None => unchecked.push(FirewallField::Program),
            }
            expect(FirewallField::LocalPort, is_only(&rule.local_ports, ANY));
        }
        RuleShape::Port => {
            expect(
                FirewallField::Program,
                rule.program.eq_ignore_ascii_case(ANY),
            );
            match expected.port {
                Some(port) => expect(
                    FirewallField::LocalPort,
                    is_only(&rule.local_ports, &port.to_string()),
                ),
                None => unchecked.push(FirewallField::LocalPort),
            }
        }
    }
    mismatches.sort();
    unchecked.sort();
    (mismatches, unchecked)
}

/// Reads the rules for `names` (blocking, up to [`PROBE_TIMEOUT`]). Returns
/// the script's stdout; [`evaluate`] interprets it.
pub(crate) fn probe(names: &RuleNames) -> Result<String, UnknownReason> {
    let script = probe_script(names).ok_or(UnknownReason::InvalidIdentifier)?;
    run_encoded(&encode_command(&script), PROBE_TIMEOUT)
}

#[cfg(not(windows))]
fn run_encoded(_encoded: &str, _timeout: Duration) -> Result<String, UnknownReason> {
    Err(UnknownReason::NotWindows)
}

/// The in-box Windows PowerShell under `%SystemRoot%`, so neither `PATH` nor
/// the working directory decides which program runs.
#[cfg(windows)]
fn windows_powershell() -> Option<std::path::PathBuf> {
    let root = std::path::PathBuf::from(std::env::var_os("SystemRoot")?);
    if !root.is_absolute() {
        return None;
    }
    let exe = root.join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    exe.is_file().then_some(exe)
}

/// `timeout` is [`PROBE_TIMEOUT`] for the real read; the Windows-only tests
/// pass a longer one, since a cold CI runner can take more than 10 s just to
/// start PowerShell and load the NetSecurity module.
#[cfg(windows)]
fn run_encoded(encoded: &str, timeout: Duration) -> Result<String, UnknownReason> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Instant;
    /// No console window flashes up for the child.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let exe = windows_powershell().ok_or(UnknownReason::LaunchFailed)?;
    let mut child = Command::new(exe)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            encoded,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|_| UnknownReason::LaunchFailed)?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(UnknownReason::LaunchFailed);
    };
    // Read on another thread so a full pipe cannot stall the child while
    // this one waits for it.
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        stdout.take(MAX_OUTPUT).read_to_end(&mut buf).map(|_| buf)
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(UnknownReason::Timeout);
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(UnknownReason::QueryFailed);
            }
        }
    };
    let output = reader
        .join()
        .ok()
        .and_then(Result::ok)
        .ok_or(UnknownReason::UnreadableOutput)?;
    if !status.success() {
        return Err(UnknownReason::QueryFailed);
    }
    String::from_utf8(output).map_err(|_| UnknownReason::UnreadableOutput)
}

#[cfg(test)]
mod tests {
    use super::*;
    use admin_template_fw_elev::rules::is_valid_identifier;
    use serde_json::json;

    const EXE: &str = r"C:\Program Files\Banto\banto.exe";

    fn expected() -> FirewallExpectation {
        FirewallExpectation {
            executable_path: Some(EXE.to_string()),
            port: Some(8721),
        }
    }

    fn present(overrides: Value) -> Value {
        let mut rule = json!({
            "s": "present",
            "enabled": "True",
            "direction": "Inbound",
            "action": "Allow",
            "protocol": "TCP",
            "profile": "Private",
            "program": "Any",
            "localPort": ["Any"],
            "remoteAddress": ["LocalSubnet"],
            "source": "PersistentStore",
            "sourceType": "Local",
            "enforcement": [1]
        });
        for (key, value) in overrides.as_object().unwrap() {
            rule[key] = value.clone();
        }
        rule
    }

    /// The same read from the local store and the ActiveStore: a local
    /// rule in effect.
    fn both(read: Value) -> Value {
        json!({ "local": read, "effective": read })
    }

    fn program_values(overrides: Value) -> Value {
        let mut rule = present(json!({ "program": EXE }));
        for (key, value) in overrides.as_object().unwrap() {
            rule[key] = value.clone();
        }
        rule
    }

    fn port_values(overrides: Value) -> Value {
        let mut rule = present(json!({ "localPort": ["8721"] }));
        for (key, value) in overrides.as_object().unwrap() {
            rule[key] = value.clone();
        }
        rule
    }

    fn program_rule(overrides: Value) -> Value {
        both(program_values(overrides))
    }

    fn port_rule(overrides: Value) -> Value {
        both(port_values(overrides))
    }

    fn missing() -> Value {
        json!({ "s": "missing" })
    }

    fn run(output: Value) -> FirewallRuleStatus {
        evaluate(7, expected(), Ok(output.to_string()))
    }

    fn mismatches(check: &FirewallRuleCheck) -> Vec<FirewallField> {
        match check {
            FirewallRuleCheck::Present { mismatches, .. } => mismatches.clone(),
            other => panic!("not present: {other:?}"),
        }
    }

    #[test]
    fn identifiers_follow_the_tauri_alphabet() {
        assert!(is_valid_identifier("com.example.banto"));
        assert!(is_valid_identifier("a"));
        assert!(is_valid_identifier(&"a".repeat(255)));
        for bad in [
            "",
            ".com.example",
            "-x",
            "com example",
            "com'example",
            "com.example;calc",
            "com.例",
            "a$b",
            &"a".repeat(256),
        ] {
            assert!(!is_valid_identifier(bad), "{bad:?}");
            assert_eq!(rule_names(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn rule_names_match_the_commands() {
        assert_eq!(
            rule_names("com.example.banto"),
            Some(RuleNames {
                group: "com.example.banto".into(),
                program: "com.example.banto.lan.tcp.program".into(),
                port: "com.example.banto.lan.tcp.port".into(),
            })
        );
    }

    #[test]
    fn quoting_doubles_every_single_quote_and_refuses_control_characters() {
        assert_eq!(quote_powershell_literal("abc").as_deref(), Some("'abc'"));
        assert_eq!(
            quote_powershell_literal("a'b\u{2018}c\u{2019}d\u{201A}e\u{201B}f").as_deref(),
            Some("'a''b\u{2018}\u{2018}c\u{2019}\u{2019}d\u{201A}\u{201A}e\u{201B}\u{201B}f'")
        );
        assert_eq!(
            quote_powershell_literal("$(calc) `x` \"y\"").as_deref(),
            Some("'$(calc) `x` \"y\"'")
        );
        assert_eq!(quote_powershell_literal("a\nb"), None);
        assert_eq!(quote_powershell_literal("a\u{0}b"), None);
        assert_eq!(quote_powershell_literal("a\u{85}b"), None);
    }

    #[test]
    fn the_script_names_only_the_quoted_rule_names_and_changes_nothing() {
        let names = rule_names("com.example.banto").unwrap();
        let script = probe_script(&names).unwrap();
        assert!(!script.contains("{GROUP}") && !script.contains("{PROGRAM}"));
        assert!(script.contains("Read-BantoRule 'com.example.banto.lan.tcp.program'"));
        assert!(script.contains("Read-BantoRule 'com.example.banto.lan.tcp.port'"));
        assert!(script.contains("-Group 'com.example.banto'"));
        // Read-only: no cmdlet that changes the firewall.
        for verb in [
            "New-NetFirewall",
            "Set-NetFirewall",
            "Remove-NetFirewall",
            "Enable-NetFirewall",
            "Disable-NetFirewall",
            "Rename-NetFirewall",
            "Copy-NetFirewall",
            "Invoke-Expression",
            "iex ",
        ] {
            assert!(!script.contains(verb), "{verb}");
        }
    }

    #[test]
    fn the_encoded_command_is_base64_of_utf16le() {
        // `[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('dir'))`
        assert_eq!(encode_command("dir"), "ZABpAHIA");
        let names = rule_names("com.example.banto").unwrap();
        let encoded = encode_command(&probe_script(&names).unwrap());
        assert!(encoded
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'='));
    }

    #[test]
    fn rules_as_the_commands_create_them_match() {
        let status = run(
            json!({ "program": program_rule(json!({})), "port": port_rule(json!({})), "group": 0 }),
        );
        assert_eq!(mismatches(&status.program), vec![]);
        assert_eq!(mismatches(&status.port), vec![]);
        assert_eq!(status.group_other_rules, Some(0));
        assert_eq!(status.generation, 7);
        assert_eq!(status.expected, expected());
    }

    #[test]
    fn missing_rules_are_missing_and_errors_are_unknown() {
        let status = run(json!({
            "program": both(missing()),
            "port": both(json!({ "s": "error" })),
            "group": -1
        }));
        assert_eq!(status.program, FirewallRuleCheck::Missing);
        assert_eq!(
            status.port,
            FirewallRuleCheck::Unknown {
                reason: UnknownReason::QueryFailed
            }
        );
        assert_eq!(status.group_other_rules, None);
    }

    #[test]
    fn a_failed_read_is_never_reported_as_missing() {
        for reason in [
            UnknownReason::NotWindows,
            UnknownReason::LaunchFailed,
            UnknownReason::Timeout,
            UnknownReason::QueryFailed,
        ] {
            let status = evaluate(1, expected(), Err(reason));
            assert_eq!(status.program, FirewallRuleCheck::Unknown { reason });
            assert_eq!(status.port, FirewallRuleCheck::Unknown { reason });
            assert_eq!(status.group_other_rules, None);
        }
        for garbage in [
            "",
            "not json",
            "[]",
            "#< CLIXML",
            "{\"program\":{\"s\":\"maybe\"}}",
        ] {
            let status = evaluate(1, expected(), Ok(garbage.to_string()));
            assert_eq!(
                status.program,
                FirewallRuleCheck::Unknown {
                    reason: UnknownReason::UnreadableOutput
                },
                "{garbage:?}"
            );
        }
        // A present rule with a missing value is not guessed at.
        for key in ["action", "localPort"] {
            let mut rule = program_values(json!({}));
            rule.as_object_mut().unwrap().remove(key);
            let status = run(json!({ "program": both(rule), "port": both(missing()) }));
            assert_eq!(
                status.program,
                FirewallRuleCheck::Unknown {
                    reason: UnknownReason::UnreadableOutput
                },
                "{key}"
            );
        }
    }

    /// (a) Only the local rule, and it is the one in effect.
    #[test]
    fn a_local_rule_in_effect_is_as_expected() {
        // The ActiveStore expands `%SystemRoot%`; case may differ too.
        let status = run(json!({
            "program": { "local": program_values(json!({ "program": r"%ProgramFiles%\Banto\banto.exe" })), "effective": program_values(json!({})) },
            "port": { "local": port_values(json!({ "profile": "private" })), "effective": port_values(json!({})) },
        }));
        for check in [&status.program, &status.port] {
            match check {
                FirewallRuleCheck::Present {
                    local, mismatches, ..
                } => {
                    assert_eq!(local, &LocalRule::Same);
                    assert_eq!(mismatches, &vec![]);
                }
                other => panic!("{other:?}"),
            }
        }

        let status =
            run(json!({ "program": program_rule(json!({})), "port": port_rule(json!({})) }));
        match &status.program {
            FirewallRuleCheck::Present {
                origin,
                local,
                mismatches,
                ..
            } => {
                let origin = origin.as_ref().expect("in effect");
                assert_eq!(origin.kind, SourceKind::Local);
                assert_eq!(origin.source_type.as_deref(), Some("Local"));
                assert_eq!(origin.source.as_deref(), Some("PersistentStore"));
                assert_eq!(local, &LocalRule::Same);
                assert_eq!(mismatches, &vec![]);
            }
            other => panic!("{other:?}"),
        }
    }

    /// (b) A Group Policy rule of the same name wins in the ActiveStore: it
    /// is compared, not the local Allow (Codex review on PR #465).
    #[test]
    fn a_group_policy_rule_of_the_same_name_is_what_is_compared() {
        let gpo = json!({ "action": "Block", "source": "contoso.local\\Banto", "sourceType": "GroupPolicy" });
        let status = run(json!({
            "program": { "local": program_values(json!({})), "effective": program_values(gpo.clone()) },
            "port": { "local": missing(), "effective": port_values(gpo) },
        }));
        match &status.program {
            FirewallRuleCheck::Present {
                rule,
                origin,
                local,
                mismatches,
                ..
            } => {
                assert_eq!(rule.action, "Block");
                let origin = origin.as_ref().expect("in effect");
                assert_eq!(origin.kind, SourceKind::GroupPolicy);
                assert_eq!(origin.source_type.as_deref(), Some("GroupPolicy"));
                assert_eq!(origin.source.as_deref(), Some("contoso.local\\Banto"));
                assert_eq!(mismatches, &vec![FirewallField::Action]);
                match local {
                    LocalRule::Differs { rule } => assert_eq!(rule.action, "Allow"),
                    other => panic!("{other:?}"),
                }
            }
            other => panic!("{other:?}"),
        }
        // No local rule at all: the policy's rule is still what applies.
        match &status.port {
            FirewallRuleCheck::Present { local, origin, .. } => {
                assert_eq!(local, &LocalRule::Missing);
                assert_eq!(origin.as_ref().unwrap().kind, SourceKind::GroupPolicy);
            }
            other => panic!("{other:?}"),
        }
        // A policy rule identical to the command's matches, but still says
        // where it comes from.
        let same = json!({ "source": "contoso.local\\Banto", "sourceType": "GroupPolicy" });
        let status = run(json!({
            "program": { "local": program_values(json!({})), "effective": program_values(same) },
            "port": port_rule(json!({})),
        }));
        match &status.program {
            FirewallRuleCheck::Present {
                origin,
                local,
                mismatches,
                ..
            } => {
                assert_eq!(mismatches, &vec![]);
                assert_eq!(origin.as_ref().unwrap().kind, SourceKind::GroupPolicy);
                // Same values: only the source differs.
                assert_eq!(local, &LocalRule::Same);
            }
            other => panic!("{other:?}"),
        }
    }

    /// (c) In the local store but not in the ActiveStore: not in effect.
    #[test]
    fn a_local_rule_not_in_effect_is_told_apart() {
        let status = run(json!({
            "program": { "local": program_values(json!({})), "effective": missing() },
            "port": { "local": port_values(json!({ "enabled": "False" })), "effective": missing() },
        }));
        match &status.program {
            FirewallRuleCheck::Present {
                origin,
                local,
                mismatches,
                ..
            } => {
                assert_eq!(origin, &None);
                assert_eq!(local, &LocalRule::Same);
                assert_eq!(mismatches, &vec![FirewallField::Active]);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            mismatches(&status.port),
            vec![FirewallField::Enabled, FirewallField::Active]
        );
    }

    /// (d) An unreadable ActiveStore is `unknown` whatever the local store
    /// holds; an unreadable local store only blurs the supplement.
    #[test]
    fn an_unreadable_active_store_is_unknown() {
        let error = json!({ "s": "error" });
        let status = run(json!({
            "program": { "local": program_values(json!({})), "effective": error.clone() },
            "port": { "local": missing(), "effective": error.clone() },
        }));
        let unknown = FirewallRuleCheck::Unknown {
            reason: UnknownReason::QueryFailed,
        };
        assert_eq!(status.program, unknown);
        assert_eq!(status.port, unknown);

        let status = run(json!({
            "program": { "local": error.clone(), "effective": program_values(json!({})) },
            "port": { "local": error, "effective": missing() },
        }));
        match &status.program {
            FirewallRuleCheck::Present {
                local, mismatches, ..
            } => {
                assert_eq!(local, &LocalRule::Unknown);
                assert_eq!(mismatches, &vec![]);
            }
            other => panic!("{other:?}"),
        }
        // Not in effect, and the local store unreadable: not "no rule".
        assert_eq!(status.port, unknown);
    }

    #[test]
    fn administrator_changes_are_told_apart() {
        let status = run(json!({
            "program": program_rule(json!({ "action": "Block" })),
            "port": port_rule(json!({ "remoteAddress": ["192.168.1.10"] })),
        }));
        assert_eq!(mismatches(&status.program), vec![FirewallField::Action]);
        assert_eq!(mismatches(&status.port), vec![FirewallField::RemoteAddress]);

        // Another executable; an old port.
        let status = run(json!({
            "program": program_rule(json!({ "program": r"D:\old\banto.exe" })),
            "port": port_rule(json!({ "localPort": ["8720"] })),
        }));
        assert_eq!(mismatches(&status.program), vec![FirewallField::Program]);
        assert_eq!(mismatches(&status.port), vec![FirewallField::LocalPort]);

        // Disabled, broader profile, more than one address.
        let status = run(json!({
            "program": program_rule(json!({ "enabled": "False" })),
            "port": port_rule(json!({ "profile": "Private, Public", "remoteAddress": ["LocalSubnet", "10.0.0.0/8"] })),
        }));
        assert_eq!(mismatches(&status.program), vec![FirewallField::Enabled]);
        assert_eq!(
            mismatches(&status.port),
            vec![FirewallField::Profile, FirewallField::RemoteAddress]
        );

        // Shape mixed up: a program rule narrowed to a port, a port rule
        // narrowed to a program, UDP, outbound.
        let status = run(json!({
            "program": program_rule(json!({ "localPort": ["8721"], "direction": "Outbound" })),
            "port": port_rule(json!({ "program": EXE, "protocol": "UDP" })),
        }));
        assert_eq!(
            mismatches(&status.program),
            vec![FirewallField::Direction, FirewallField::LocalPort]
        );
        assert_eq!(
            mismatches(&status.port),
            vec![FirewallField::Protocol, FirewallField::Program]
        );
    }

    #[test]
    fn paths_compare_ignoring_case_and_lone_strings_are_lists() {
        let status = run(json!({
            "program": program_rule(json!({ "program": EXE.to_uppercase(), "remoteAddress": "LocalSubnet", "localPort": "Any" })),
            "port": port_rule(json!({ "localPort": "8721" })),
        }));
        assert_eq!(mismatches(&status.program), vec![]);
        assert_eq!(mismatches(&status.port), vec![]);
    }

    #[test]
    fn values_without_a_basis_are_unchecked_not_mismatched() {
        let status = evaluate(
            3,
            FirewallExpectation {
                executable_path: None,
                port: None,
            },
            Ok(json!({
                "program": program_rule(json!({})),
                "port": port_rule(json!({})),
            })
            .to_string()),
        );
        match &status.program {
            FirewallRuleCheck::Present {
                mismatches,
                unchecked,
                ..
            } => {
                assert_eq!(mismatches, &vec![]);
                assert_eq!(unchecked, &vec![FirewallField::Program]);
            }
            other => panic!("{other:?}"),
        }
        match &status.port {
            FirewallRuleCheck::Present { unchecked, .. } => {
                assert_eq!(unchecked, &vec![FirewallField::LocalPort]);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_response_serializes_as_codes_and_values() {
        let status = run(json!({
            "program": program_rule(json!({ "action": "Block" })),
            "port": both(missing()),
            "group": 2,
        }));
        let value = serde_json::to_value(&status).unwrap();
        assert_eq!(value["generation"], 7);
        assert_eq!(value["expected"]["executablePath"], EXE);
        assert_eq!(value["expected"]["port"], 8721);
        assert_eq!(value["program"]["state"], "present");
        assert_eq!(value["program"]["mismatches"], json!(["action"]));
        assert_eq!(value["program"]["rule"]["localPorts"], json!(["Any"]));
        assert_eq!(
            value["program"]["rule"]["remoteAddresses"],
            json!(["LocalSubnet"])
        );
        assert_eq!(
            value["program"]["origin"],
            json!({ "kind": "local", "sourceType": "Local", "source": "PersistentStore" })
        );
        assert_eq!(
            value["program"]["enforcement"],
            json!({ "state": "enforced" })
        );
        assert_eq!(value["program"]["local"], json!({ "state": "same" }));
        assert_eq!(value["port"], json!({ "state": "missing" }));
        assert_eq!(value["groupOtherRules"], 2);
        let differs = run(json!({
            "program": { "local": program_values(json!({})), "effective": program_values(json!({ "action": "Block", "sourceType": "GroupPolicy" })) },
            "port": { "local": port_values(json!({})), "effective": missing() },
        }));
        let value = serde_json::to_value(&differs).unwrap();
        assert_eq!(value["program"]["local"]["state"], "differs");
        assert_eq!(value["program"]["local"]["rule"]["action"], "Allow");
        assert_eq!(value["port"]["origin"], Value::Null);
        assert_eq!(value["port"]["enforcement"], Value::Null);
        assert_eq!(value["port"]["mismatches"], json!(["active"]));
        let unknown =
            serde_json::to_value(evaluate(1, expected(), Err(UnknownReason::Timeout))).unwrap();
        assert_eq!(
            unknown["program"],
            json!({ "state": "unknown", "reason": "timeout" })
        );
        assert_eq!(unknown["groupOtherRules"], Value::Null);
    }

    /// The script reads only after checking the cmdlets are there, tells
    /// "no such rule" apart by the lookup's own error, traces where the rule
    /// in effect comes from and reports its enforcement (owner review on PR
    /// #465).
    #[test]
    fn the_script_checks_the_cmdlets_traces_the_source_and_reads_enforcement() {
        let script = probe_script(&rule_names("com.example.banto").unwrap()).unwrap();
        let check = script
            .find("Get-Command -Name Get-NetFirewallRule")
            .expect("cmdlet check");
        assert!(script[check..].starts_with(
            "Get-Command -Name Get-NetFirewallRule, Get-NetFirewallApplicationFilter, Get-NetFirewallPortFilter, Get-NetFirewallAddressFilter -ErrorAction Stop } catch { exit 3 }"
        ));
        // Checked before anything is read.
        assert!(check < script.find("function Read-BantoStore").unwrap());
        assert!(check < script.find("-Group 'com.example.banto'").unwrap());
        // "No such rule" is the cmdlet's own not-found answer, not just the
        // `ObjectNotFound` category (which `CommandNotFoundException` has too).
        assert!(script.contains("'Microsoft.PowerShell.Cmdletization.Cim.CimJobException'"));
        assert!(script.contains("-like 'CmdletizationQuery_NotFound_*,Get-NetFirewallRule'"));
        assert!(script.contains(
            "Get-NetFirewallRule -Name $name -PolicyStore ActiveStore -TracePolicyStore -ErrorAction Stop"
        ));
        assert!(script.contains("CimInstanceProperties['EnforcementStatus']"));
        // A group read that fails is -1 (unknown) unless it is "not found".
        assert!(script.contains("$group = -1"));
        assert!(script.contains("catch { if (Test-BantoNotFound $_) { $group = 0 } }"));
    }

    fn enforcement_of(code: Option<Value>) -> FirewallRuleCheck {
        let mut rule = program_values(json!({}));
        match code {
            Some(code) => rule["enforcement"] = code,
            None => {
                rule.as_object_mut().unwrap().remove("enforcement");
            }
        }
        let read = json!({ "local": program_values(json!({})), "effective": rule });
        run(json!({ "program": read, "port": both(missing()) })).program
    }

    /// Only `Full` is applied; a documented other code is "there but not
    /// applied"; no code or an unknown one is not known (owner review on PR
    /// #465).
    #[test]
    fn only_a_fully_enforced_rule_counts_as_applied() {
        let present = |check: FirewallRuleCheck| match check {
            FirewallRuleCheck::Present {
                enforcement,
                mismatches,
                unchecked,
                ..
            } => (enforcement.expect("in effect"), mismatches, unchecked),
            other => panic!("{other:?}"),
        };
        let (enforcement, differing, unchecked) = present(enforcement_of(Some(json!([1]))));
        assert_eq!(enforcement, Enforcement::Enforced);
        assert_eq!((differing, unchecked), (vec![], vec![]));
        // A lone code (PowerShell unwrapping the array) reads the same.
        let (enforcement, ..) = present(enforcement_of(Some(json!(1))));
        assert_eq!(enforcement, Enforcement::Enforced);

        for (code, reason) in [
            (5, "InactiveProfile"),
            (16, "LocalFirewallRulesDisallowed"),
            (3, "CategoryOff"),
            (0, "Invalid"),
        ] {
            let (enforcement, differing, unchecked) = present(enforcement_of(Some(json!([code]))));
            assert_eq!(
                enforcement,
                Enforcement::NotEnforced {
                    reasons: vec![reason.to_string()]
                },
                "{code}"
            );
            assert_eq!(differing, vec![FirewallField::Enforcement], "{code}");
            assert_eq!(unchecked, vec![], "{code}");
        }
        let (enforcement, ..) = present(enforcement_of(Some(json!([5, 16, 5]))));
        assert_eq!(
            enforcement,
            Enforcement::NotEnforced {
                reasons: vec![
                    "InactiveProfile".to_string(),
                    "LocalFirewallRulesDisallowed".to_string()
                ]
            }
        );

        // No value, an empty list, something not a code, a code past the
        // documented ones, `Full` next to a reason: not known.
        for (code, values) in [
            (None, vec![]),
            (Some(json!([])), vec![]),
            (Some(json!(null)), vec![]),
            (Some(json!(["Full"])), vec![]),
            (Some(json!([25])), vec![25]),
            (Some(json!([1, 5])), vec![1, 5]),
        ] {
            let (enforcement, differing, unchecked) = present(enforcement_of(code.clone()));
            assert_eq!(enforcement, Enforcement::Unknown { values }, "{code:?}");
            assert_eq!(differing, vec![], "{code:?}");
            assert_eq!(unchecked, vec![FirewallField::Enforcement], "{code:?}");
        }

        // Next to other differences, sorted with them.
        let mut rule = program_values(json!({ "action": "Block", "enforcement": [16] }));
        rule["program"] = json!(EXE);
        let status = run(json!({
            "program": { "local": missing(), "effective": rule },
            "port": both(missing()),
        }));
        assert_eq!(
            mismatches(&status.program),
            vec![FirewallField::Action, FirewallField::Enforcement]
        );
        let value = serde_json::to_value(&status).unwrap();
        assert_eq!(
            value["program"]["enforcement"],
            json!({ "state": "notEnforced", "reasons": ["LocalFirewallRulesDisallowed"] })
        );
        assert_eq!(
            value["program"]["mismatches"],
            json!(["action", "enforcement"])
        );
        let unknown = serde_json::to_value(enforcement_of(Some(json!([25])))).unwrap();
        assert_eq!(
            unknown["enforcement"],
            json!({ "state": "unknown", "values": [25] })
        );
        assert_eq!(unknown["unchecked"], json!(["enforcement"]));
    }

    fn origin_of(source_type: Option<&str>, source: Option<&str>) -> RuleOrigin {
        let mut rule = program_values(json!({}));
        let object = rule.as_object_mut().unwrap();
        object.remove("sourceType");
        object.remove("source");
        if let Some(t) = source_type {
            object.insert("sourceType".into(), json!(t));
        }
        if let Some(s) = source {
            object.insert("source".into(), json!(s));
        }
        let read = json!({ "local": missing(), "effective": rule });
        match run(json!({ "program": read, "port": both(missing()) })).program {
            FirewallRuleCheck::Present { origin, .. } => origin.expect("in effect"),
            other => panic!("{other:?}"),
        }
    }

    /// Every documented `PolicyStoreSourceType` keeps its own kind; an
    /// unreported one is "not known", never central management; anything
    /// else is "other" with its value (owner review on PR #465).
    #[test]
    fn the_source_is_classified_by_its_type_and_unknown_when_not_reported() {
        for (source_type, kind) in [
            ("Local", SourceKind::Local),
            ("GroupPolicy", SourceKind::GroupPolicy),
            ("Dynamic", SourceKind::Dynamic),
            ("Generated", SourceKind::Generated),
            ("Hardcoded", SourceKind::Hardcoded),
            ("MDM", SourceKind::Mdm),
            ("mdm", SourceKind::Mdm),
            ("HostFirewallLocal", SourceKind::HostFirewallLocal),
            (
                "HostFirewallGroupPolicy",
                SourceKind::HostFirewallGroupPolicy,
            ),
            ("HostFirewallDynamic", SourceKind::HostFirewallDynamic),
            ("HostFirewallMDM", SourceKind::HostFirewallMdm),
            ("SomethingNew", SourceKind::Other),
            ("7", SourceKind::Other),
            ("None", SourceKind::Unknown),
        ] {
            let origin = origin_of(Some(source_type), Some("x"));
            assert_eq!(origin.kind, kind, "{source_type}");
            assert_eq!(origin.source_type.as_deref(), Some(source_type));
        }
        // Not traced: no type, an empty type, an empty or blank source.
        let origin = origin_of(None, None);
        assert_eq!(
            origin,
            RuleOrigin {
                kind: SourceKind::Unknown,
                source_type: None,
                source: None
            }
        );
        let origin = origin_of(Some(""), Some(""));
        assert_eq!(origin.kind, SourceKind::Unknown);
        assert_eq!((origin.source_type, origin.source), (None, None));
        let origin = origin_of(Some("GroupPolicy"), Some("  "));
        assert_eq!(origin.kind, SourceKind::GroupPolicy);
        assert_eq!(origin.source, None);
        // An untraced origin does not make the rule unreadable: its values
        // are still compared.
        let mut rule = program_values(json!({}));
        rule.as_object_mut().unwrap().remove("sourceType");
        let status = run(json!({ "program": both(rule), "port": both(missing()) }));
        assert_eq!(mismatches(&status.program), vec![]);
        let value = serde_json::to_value(&status).unwrap();
        assert_eq!(
            value["program"]["origin"],
            json!({ "kind": "unknown", "sourceType": null, "source": "PersistentStore" })
        );
    }

    /// Runs the real script with `prefix` in front (Windows only). Nothing
    /// is changed: the prefixes below keep the script from reading at all.
    #[cfg(windows)]
    fn probe_with_prefix(prefix: &str) -> Result<String, UnknownReason> {
        let names = rule_names("com.example.banto.probe-test").unwrap();
        let script = format!("{prefix}\n{}", probe_script(&names).unwrap());
        // Generous: these tests check what the script reports, not how fast a
        // cold CI runner loads the module (PR #465's Windows CI timed out at
        // the 10 s of the real read).
        run_encoded(&encode_command(&script), Duration::from_secs(120))
    }

    /// `Get-NetFirewallRule` cannot be found (module auto-loading off, as
    /// when the NetSecurity module is missing): `CommandNotFoundException`,
    /// whose category is `ObjectNotFound` too, must not read as "no rule"
    /// (owner review on PR #465). The cmdlet check exits with 3.
    #[cfg(windows)]
    #[test]
    fn a_missing_cmdlet_is_a_failed_read_not_missing() {
        let outcome = probe_with_prefix("$PSModuleAutoLoadingPreference = 'None'");
        assert_eq!(outcome, Err(UnknownReason::QueryFailed));
        let status = evaluate(0, expected(), outcome);
        let unknown = FirewallRuleCheck::Unknown {
            reason: UnknownReason::QueryFailed,
        };
        assert_eq!(status.program, unknown);
        assert_eq!(status.port, unknown);
        assert_eq!(status.group_other_rules, None);
    }

    /// The cmdlet is there by name but cannot run (a stand-in that throws
    /// `CommandNotFoundException`, as a module that fails to load does): the
    /// reads are errors, not "missing", and the group count is unknown.
    #[cfg(windows)]
    #[test]
    fn a_cmdlet_that_fails_is_not_missing() {
        let outcome = probe_with_prefix(
            // Loaded first, so auto-loading the module later cannot put the
            // real cmdlet back over the stand-in.
            "Import-Module NetSecurity
function Get-NetFirewallRule { throw [System.Management.Automation.CommandNotFoundException]::new('Get-NetFirewallRule') }",
        );
        let stdout = outcome.clone().expect("the script still prints its JSON");
        let value: Value = serde_json::from_str(&stdout).unwrap();
        for rule in ["program", "port"] {
            for store in ["local", "effective"] {
                assert_eq!(value[rule][store]["s"], "error", "{rule} {store}");
            }
        }
        assert_eq!(value["group"], -1);
        let status = evaluate(0, expected(), outcome);
        let unknown = FirewallRuleCheck::Unknown {
            reason: UnknownReason::QueryFailed,
        };
        assert_eq!(status.program, unknown);
        assert_eq!(status.port, unknown);
        assert_eq!(status.group_other_rules, None);
    }

    /// Reads this PC's real firewall (read-only). Not run by default - CI is
    /// Linux and the result depends on the machine; run it by hand with
    /// `cargo test --lib firewall_status -- --ignored --nocapture`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn reads_the_real_firewall() {
        let names = rule_names("com.example.banto.probe-test").unwrap();
        let outcome = probe(&names);
        println!("{outcome:?}");
        let status = evaluate(0, expected(), outcome);
        println!("{status:?}");
        assert_eq!(status.program, FirewallRuleCheck::Missing);
        assert_eq!(status.port, FirewallRuleCheck::Missing);
        assert_eq!(status.group_other_rules, Some(0));
    }

    #[cfg(not(windows))]
    #[test]
    fn other_platforms_report_not_windows() {
        let names = rule_names("com.example.banto").unwrap();
        assert_eq!(probe(&names), Err(UnknownReason::NotWindows));
    }
}
