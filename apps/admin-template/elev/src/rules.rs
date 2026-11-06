//! The one rule the helper manages and whether an existing rule is the
//! helper's own (ADR-0021 decisions 1, 4, 5 and 6). Pure functions only.
//!
//! Ownership is judged by content, not by name: a rule is "owned" only when
//! EVERY value that defines the rule's shape matches what
//! [`crate::powershell::create_script`] creates, and the rule in effect comes
//! from the local PersistentStore. Anything else with the same name is a
//! conflict (exit 4) - it is neither reported as "already there" nor removed.

use std::collections::BTreeMap;
use std::fmt;

/// Whether `identifier` is in Tauri's bundle identifier alphabet - ASCII
/// letters, digits, `-` and `.`, starting with a letter or digit, at most 255
/// characters. The one definition: stage 1 (`src-tauri/src/firewall_status.rs`)
/// uses this function, and `firewallInfo.ts::isValidAppIdentifier` is its
/// TypeScript copy; `const` so that [`crate::IDENTIFIER`] is checked at
/// compile time.
pub const fn is_valid_identifier(identifier: &str) -> bool {
    let bytes = identifier.as_bytes();
    if bytes.is_empty() || bytes.len() > 255 || !bytes[0].is_ascii_alphanumeric() {
        return false;
    }
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if !(b.is_ascii_alphanumeric() || b == b'.' || b == b'-') {
            return false;
        }
        i += 1;
    }
    true
}

/// The rule's name (`-Name`) and group (`-Group`). Stage 1's
/// `firewall_status.rs::rule_names` takes its group and program rule name from
/// [`rule_names`], so its read finds stage 2's rule by construction
/// (`firewallInfo.ts::firewallRuleNames` is the TypeScript copy).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleNames {
    /// `<identifier>.lan.tcp.program`
    pub name: String,
    /// `<identifier>`
    pub group: String,
    /// `<identifier> LAN (TCP-In, program)` - stage 1's display name. Not
    /// compared for ownership (it is a label an administrator may localize).
    pub display_name: String,
}

/// The names for `identifier`, or `None` when it is not a valid identifier.
pub fn rule_names(identifier: &str) -> Option<RuleNames> {
    is_valid_identifier(identifier).then(|| RuleNames {
        name: format!("{identifier}.lan.tcp.program"),
        group: identifier.to_string(),
        display_name: format!("{identifier} LAN (TCP-In, program)"),
    })
}

/// The rule to create / own: decision 1's table, for `program` (the main
/// exe's path as read from its handle, decision 8).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleSpec {
    pub names: RuleNames,
    pub program: String,
}

/// One rule as the query script reports it: each property's values as
/// strings (an unset / `$null` value is an empty list).
pub type RuleFields = BTreeMap<String, Vec<String>>;

/// What the query script read (`powershell::parse_query_output`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RuleSnapshot {
    /// Rules of the name in the local PersistentStore (the store the helper
    /// writes).
    pub local: Vec<RuleFields>,
    /// Rules of the name in the ActiveStore (what Windows enforces, read with
    /// `-TracePolicyStore` so the source is reported).
    pub active: Vec<RuleFields>,
    /// The Private profile's `AllowLocalFirewallRules` in the ActiveStore
    /// (`True` / `False` / `NotConfigured`).
    pub allow_local_rules: Vec<String>,
}

impl RuleSnapshot {
    /// Whether a policy keeps local rules from being merged (decision 11's
    /// exit 5). Only an explicit `False` counts; `NotConfigured` merges.
    pub fn local_rules_disallowed(&self) -> bool {
        self.allow_local_rules
            .iter()
            .any(|v| v.trim().eq_ignore_ascii_case("False"))
    }
}

/// Where a differing value was found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Store {
    Local,
    Active,
}

/// Why a rule of the name is not the helper's own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Conflict {
    /// More than one rule of the name in the local store.
    MultipleLocal,
    /// More than one rule of the name in effect (e.g. a policy's rule of the
    /// same name besides the local one).
    MultipleActive,
    /// A rule of the name is in effect but none is in the local store (it
    /// comes from a policy, MDM, ...).
    NotLocal,
    /// A value differs from decision 1's rule (or is missing).
    Differs { store: Store, field: String },
}

impl fmt::Display for Conflict {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MultipleLocal => f.write_str("more than one local rule has the name"),
            Self::MultipleActive => f.write_str("more than one rule of the name is in effect"),
            Self::NotLocal => f.write_str("the rule in effect is not a local rule"),
            Self::Differs { store, field } => {
                let store = match store {
                    Store::Local => "local",
                    Store::Active => "active",
                };
                write!(f, "{field} differs from the helper's rule ({store} store)")
            }
        }
    }
}

/// The state of the helper's rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuleState {
    /// No rule of the name anywhere.
    Absent,
    /// The local rule is the helper's own and it is the one in effect.
    Owned,
    /// The local rule is the helper's own but nothing of the name is in
    /// effect (a policy does not merge local rules, decision 11's exit 5).
    OwnedNotInEffect,
    /// A rule of the name that is not the helper's own (exit 4).
    Conflict(Conflict),
}

/// Values every filter reports when it does not restrict anything.
const ANY: &str = "Any";

/// Decision 6's list: every value that defines the rule's shape, as
/// `Get-NetFirewall*` reports it for a rule created by
/// [`crate::powershell::create_script`]. An empty list means "unset"
/// (`$null` / empty). Not compared: `DisplayName` / `Description` (labels).
pub fn expected_fields(spec: &RuleSpec) -> Vec<(&'static str, Vec<String>)> {
    let one = |v: &str| vec![v.to_string()];
    vec![
        ("Name", one(&spec.names.name)),
        ("Group", one(&spec.names.group)),
        ("Enabled", one("True")),
        ("Direction", one("Inbound")),
        ("Action", one("Allow")),
        ("Profile", one("Private")),
        ("EdgeTraversalPolicy", one("Block")),
        ("LooseSourceMapping", one("False")),
        ("LocalOnlyMapping", one("False")),
        ("Owner", vec![]),
        ("Platform", vec![]),
        // Application filter
        ("Program", one(&spec.program)),
        ("Package", vec![]),
        // Port filter
        ("Protocol", one("TCP")),
        ("LocalPort", one(ANY)),
        ("RemotePort", one(ANY)),
        ("IcmpType", one(ANY)),
        ("DynamicTarget", one(ANY)),
        // Address filter
        ("LocalAddress", one(ANY)),
        ("RemoteAddress", one("LocalSubnet")),
        // Interface type / interface / service filters
        ("InterfaceType", one(ANY)),
        ("InterfaceAlias", one(ANY)),
        ("Service", one(ANY)),
        // Security filter
        ("Authentication", one("NotRequired")),
        ("Encryption", one("NotRequired")),
        ("OverrideBlockRules", one("False")),
        ("LocalUser", one(ANY)),
        ("RemoteUser", one(ANY)),
        ("RemoteMachine", one(ANY)),
        // Newer Windows only (a missing property reads as empty, the same as
        // unset).
        ("RemoteDynamicKeywordAddresses", vec![]),
    ]
}

/// Where the rule in effect must come from (read with `-TracePolicyStore`).
pub const EXPECTED_SOURCE: [(&str, &str); 2] = [
    ("PolicyStoreSource", "PersistentStore"),
    ("PolicyStoreSourceType", "Local"),
];

/// A value list for comparison: trimmed, empties dropped, case folded,
/// sorted (order and case carry no meaning in these values; Windows paths
/// compare case-insensitively).
fn normalized(values: &[String]) -> Vec<String> {
    let mut out: Vec<String> = values
        .iter()
        .map(|v| v.trim().to_lowercase())
        .filter(|v| !v.is_empty())
        .collect();
    out.sort();
    out
}

/// The first field of `rule` that differs from `spec` (a missing field
/// differs), or `None` when all match.
fn first_difference(rule: &RuleFields, spec: &RuleSpec, active: bool) -> Option<String> {
    let mut expected: Vec<(&str, Vec<String>)> = expected_fields(spec);
    if active {
        expected.extend(
            EXPECTED_SOURCE
                .iter()
                .map(|(k, v)| (*k, vec![(*v).to_string()])),
        );
    }
    expected.into_iter().find_map(|(field, want)| {
        let same = rule
            .get(field)
            .is_some_and(|got| normalized(got) == normalized(&want));
        (!same).then(|| field.to_string())
    })
}

/// Decision 6: whether the rule of `spec`'s name is the helper's own.
pub fn classify(snapshot: &RuleSnapshot, spec: &RuleSpec) -> RuleState {
    let conflict = RuleState::Conflict;
    match snapshot.local.as_slice() {
        [] => {
            if snapshot.active.is_empty() {
                RuleState::Absent
            } else {
                conflict(Conflict::NotLocal)
            }
        }
        [local] => {
            if let Some(field) = first_difference(local, spec, false) {
                return conflict(Conflict::Differs {
                    store: Store::Local,
                    field,
                });
            }
            match snapshot.active.as_slice() {
                [] => RuleState::OwnedNotInEffect,
                [active] => match first_difference(active, spec, true) {
                    None if snapshot.local_rules_disallowed() => RuleState::OwnedNotInEffect,
                    None => RuleState::Owned,
                    Some(field) => conflict(Conflict::Differs {
                        store: Store::Active,
                        field,
                    }),
                },
                _ => conflict(Conflict::MultipleActive),
            }
        }
        _ => conflict(Conflict::MultipleLocal),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> RuleSpec {
        RuleSpec {
            names: rule_names("com.example.app").unwrap(),
            program: r"C:\Program Files\Example\example.exe".into(),
        }
    }

    /// A rule exactly as the create script makes it (`active` adds the
    /// source fields `-TracePolicyStore` reports).
    fn owned_rule(active: bool) -> RuleFields {
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

    fn snapshot(local: Vec<RuleFields>, active: Vec<RuleFields>) -> RuleSnapshot {
        RuleSnapshot {
            local,
            active,
            allow_local_rules: vec!["NotConfigured".into()],
        }
    }

    #[test]
    fn identifier_alphabet() {
        assert!(is_valid_identifier("dev.banto.admin"));
        assert!(is_valid_identifier("a"));
        assert!(is_valid_identifier(&"a".repeat(255)));
        assert!(!is_valid_identifier(&"a".repeat(256)));
        assert!(!is_valid_identifier(""));
        assert!(!is_valid_identifier(".a"));
        assert!(!is_valid_identifier("-a"));
        assert!(!is_valid_identifier("a b"));
        assert!(!is_valid_identifier("a'b"));
        assert!(!is_valid_identifier("a*"));
        assert!(!is_valid_identifier("é"));
    }

    #[test]
    fn names_match_stage_one() {
        assert_eq!(
            rule_names("com.example.banto"),
            Some(RuleNames {
                name: "com.example.banto.lan.tcp.program".into(),
                group: "com.example.banto".into(),
                display_name: "com.example.banto LAN (TCP-In, program)".into(),
            })
        );
        assert_eq!(rule_names("bad id"), None);
    }

    #[test]
    fn nothing_anywhere_is_absent() {
        assert_eq!(
            classify(&snapshot(vec![], vec![]), &spec()),
            RuleState::Absent
        );
    }

    #[test]
    fn exact_rule_in_effect_is_owned() {
        let s = snapshot(vec![owned_rule(false)], vec![owned_rule(true)]);
        assert_eq!(classify(&s, &spec()), RuleState::Owned);
    }

    #[test]
    fn case_order_and_empty_values_do_not_matter() {
        let mut local = owned_rule(false);
        local.insert(
            "Program".into(),
            vec![r"c:\program files\EXAMPLE\Example.EXE".into()],
        );
        local.insert("Owner".into(), vec!["".into()]);
        local.insert("Direction".into(), vec![" inbound ".into()]);
        let s = snapshot(vec![local], vec![owned_rule(true)]);
        assert_eq!(classify(&s, &spec()), RuleState::Owned);
    }

    #[test]
    fn matching_active_rule_is_not_in_effect_when_local_rules_are_disallowed() {
        for (value, expected) in [
            ("False", RuleState::OwnedNotInEffect),
            ("NotConfigured", RuleState::Owned),
            ("True", RuleState::Owned),
        ] {
            let mut s = snapshot(vec![owned_rule(false)], vec![owned_rule(true)]);
            s.allow_local_rules = vec![value.into()];
            assert_eq!(classify(&s, &spec()), expected, "{value}");
        }
    }

    #[test]
    fn local_rule_not_in_effect_is_reported_apart() {
        let s = snapshot(vec![owned_rule(false)], vec![]);
        assert_eq!(classify(&s, &spec()), RuleState::OwnedNotInEffect);
    }

    /// Decision 6's examples: every changed value makes it a conflict.
    #[test]
    fn any_changed_value_is_a_conflict() {
        let changes: [(&str, Vec<&str>); 12] = [
            ("Profile", vec!["Private, Public"]),
            ("Profile", vec!["Any"]),
            ("RemoteAddress", vec!["Any"]),
            ("RemoteAddress", vec!["LocalSubnet", "10.0.0.0/8"]),
            ("LocalPort", vec!["8080"]),
            ("Enabled", vec!["False"]),
            ("Action", vec!["Block"]),
            ("Program", vec![r"C:\Other\example.exe"]),
            ("Group", vec!["com.example.other"]),
            ("Service", vec!["Spooler"]),
            ("InterfaceType", vec!["Wireless"]),
            ("Owner", vec!["S-1-5-21-1-2-3-1001"]),
        ];
        for (field, values) in changes {
            let mut local = owned_rule(false);
            local.insert(field.into(), values.iter().map(|v| v.to_string()).collect());
            let s = snapshot(vec![local], vec![owned_rule(true)]);
            assert_eq!(
                classify(&s, &spec()),
                RuleState::Conflict(Conflict::Differs {
                    store: Store::Local,
                    field: field.into()
                }),
                "{field} = {values:?}"
            );
        }
    }

    #[test]
    fn a_missing_field_is_a_conflict() {
        let mut local = owned_rule(false);
        local.remove("RemotePort");
        let s = snapshot(vec![local], vec![owned_rule(true)]);
        assert_eq!(
            classify(&s, &spec()),
            RuleState::Conflict(Conflict::Differs {
                store: Store::Local,
                field: "RemotePort".into()
            })
        );
    }

    #[test]
    fn a_rule_in_effect_from_a_policy_is_a_conflict() {
        let mut gpo = owned_rule(true);
        gpo.insert(
            "PolicyStoreSource".into(),
            vec!["contoso.com\\Firewall".into()],
        );
        gpo.insert("PolicyStoreSourceType".into(), vec!["GroupPolicy".into()]);
        // With the local rule: the one in effect is not it.
        let s = snapshot(vec![owned_rule(false)], vec![gpo.clone()]);
        assert_eq!(
            classify(&s, &spec()),
            RuleState::Conflict(Conflict::Differs {
                store: Store::Active,
                field: "PolicyStoreSource".into()
            })
        );
        // Without one.
        assert_eq!(
            classify(&snapshot(vec![], vec![gpo.clone()]), &spec()),
            RuleState::Conflict(Conflict::NotLocal)
        );
        // Both in effect.
        let s = snapshot(vec![owned_rule(false)], vec![owned_rule(true), gpo]);
        assert_eq!(
            classify(&s, &spec()),
            RuleState::Conflict(Conflict::MultipleActive)
        );
    }

    #[test]
    fn the_active_rule_needs_the_source_fields() {
        let s = snapshot(vec![owned_rule(false)], vec![owned_rule(false)]);
        assert_eq!(
            classify(&s, &spec()),
            RuleState::Conflict(Conflict::Differs {
                store: Store::Active,
                field: "PolicyStoreSource".into()
            })
        );
    }

    #[test]
    fn two_local_rules_are_a_conflict() {
        let s = snapshot(
            vec![owned_rule(false), owned_rule(false)],
            vec![owned_rule(true)],
        );
        assert_eq!(
            classify(&s, &spec()),
            RuleState::Conflict(Conflict::MultipleLocal)
        );
    }

    #[test]
    fn another_installation_path_is_a_conflict() {
        let other = RuleSpec {
            names: spec().names,
            program: r"C:\Program Files\Example2\example.exe".into(),
        };
        let s = snapshot(vec![owned_rule(false)], vec![owned_rule(true)]);
        assert!(matches!(
            classify(&s, &other),
            RuleState::Conflict(Conflict::Differs { field, .. }) if field == "Program"
        ));
    }

    #[test]
    fn only_an_explicit_false_disallows_local_rules() {
        let mut s = RuleSnapshot::default();
        assert!(!s.local_rules_disallowed());
        s.allow_local_rules = vec!["NotConfigured".into()];
        assert!(!s.local_rules_disallowed());
        s.allow_local_rules = vec!["True".into()];
        assert!(!s.local_rules_disallowed());
        s.allow_local_rules = vec!["false".into()];
        assert!(s.local_rules_disallowed());
    }
}
