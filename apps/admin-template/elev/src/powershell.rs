//! The firewall operations as fixed Windows PowerShell scripts (ADR-0021
//! decision 9) - the pure part: script text, the command line, the child's
//! environment, and parsing the query's output.
//!
//! - `powershell.exe` is run by absolute path under the system directory
//!   (`GetSystemDirectoryW`), with `-NoProfile -NonInteractive
//!   -EncodedCommand <base64 of UTF-16LE>` (the same flags as stage 1's
//!   `firewall_status.rs`), so the script never passes through a command
//!   line that cmd / PowerShell parse.
//! - The child's environment is cleared and rebuilt with only the values
//!   the helper derives from the system / Windows directories
//!   ([`child_environment`]): nothing is inherited from the caller, and
//!   `PSModulePath` is the in-box Modules folder only. NetSecurity is
//!   imported by absolute path.
//! - The scripts are fixed text. The only values put in are decided by the
//!   helper itself - the module path (system directory), the rule names
//!   (the build-time identifier, decision 5) and the main exe's path (read
//!   from its handle, decision 8) - written as PowerShell single-quoted
//!   literals ([`quote_literal`]) in one pass ([`fill`]).
//! - The query prints the rule's values as one ASCII-only JSON object after
//!   [`OUTPUT_MARKER`]; ownership is judged in Rust (`rules::classify`).

use serde_json::Value;

use crate::rules::{RuleFields, RuleNames, RuleSnapshot, RuleSpec};

/// What precedes the JSON on the query's stdout.
pub const OUTPUT_MARKER: &str = "BANTO-FW-ELEV-JSON:";

/// Where the in-box Windows PowerShell and its NetSecurity module are.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PowerShellPaths {
    /// `<system>\WindowsPowerShell\v1.0\powershell.exe`
    pub exe: String,
    /// `<system>\WindowsPowerShell\v1.0\Modules`
    pub modules_dir: String,
    /// `<system>\WindowsPowerShell\v1.0\Modules\NetSecurity\NetSecurity.psd1`
    pub net_security: String,
}

/// The paths under `system_dir` (`GetSystemDirectoryW`, e.g. `C:\Windows\System32`).
pub fn powershell_paths(system_dir: &str) -> PowerShellPaths {
    let base = format!(
        r"{}\WindowsPowerShell\v1.0",
        system_dir.trim_end_matches('\\')
    );
    PowerShellPaths {
        exe: format!(r"{base}\powershell.exe"),
        modules_dir: format!(r"{base}\Modules"),
        net_security: format!(r"{base}\Modules\NetSecurity\NetSecurity.psd1"),
    }
}

/// The child's whole environment (it starts empty): what PowerShell needs to
/// start, all derived from the system / Windows directories.
pub fn child_environment(system_dir: &str, windows_dir: &str) -> Vec<(String, String)> {
    let windows_dir = windows_dir.trim_end_matches('\\');
    let temp = format!(r"{windows_dir}\Temp");
    vec![
        ("SystemRoot".into(), windows_dir.into()),
        ("windir".into(), windows_dir.into()),
        (
            "SystemDrive".into(),
            windows_dir.get(..2).unwrap_or("").into(),
        ),
        (
            "ComSpec".into(),
            format!(r"{}\cmd.exe", system_dir.trim_end_matches('\\')),
        ),
        (
            "PSModulePath".into(),
            powershell_paths(system_dir).modules_dir,
        ),
        ("TEMP".into(), temp.clone()),
        ("TMP".into(), temp),
    ]
}

/// The arguments for `powershell.exe` (after the program name).
pub fn arguments(script: &str) -> Vec<String> {
    vec![
        "-NoProfile".into(),
        "-NonInteractive".into(),
        "-EncodedCommand".into(),
        encode_command(script),
    ]
}

/// `value` as a PowerShell single-quoted literal: wrapped in `'` with every
/// character PowerShell treats as a single quote (ASCII `'` and
/// U+2018-U+201B) doubled, so nothing inside is expanded. `None` when it
/// contains a control character. Stage 1 (`firewall_status.rs`) uses this function;
/// `firewallInfo.ts::quotePowerShellLiteral` is its TypeScript copy.
pub fn quote_literal(value: &str) -> Option<String> {
    if value.chars().any(char::is_control) {
        return None;
    }
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for c in value.chars() {
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
            out.push(c);
        }
        out.push(c);
    }
    out.push('\'');
    Some(out)
}

/// `template` with each `{KEY}` replaced by its value's quoted literal, in
/// one pass (a value containing `{...}` is never substituted again). `None`
/// when a value cannot be quoted or a placeholder has no value.
pub fn fill(template: &str, values: &[(&str, &str)]) -> Option<String> {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let key_end = after
            .find('}')
            .filter(|&end| after[..end].bytes().all(|b| b.is_ascii_uppercase()) && end > 0);
        match key_end {
            Some(end) => {
                let key = &after[..end];
                let value = values.iter().find(|(k, _)| *k == key)?.1;
                out.push_str(&quote_literal(value)?);
                rest = &after[end + 1..];
            }
            None => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    Some(out)
}

/// Common head: stop on any error, import NetSecurity by absolute path.
const HEAD: &str = r#"$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  Import-Module -Name {MODULE} -ErrorAction Stop
"#;

/// Common tail: any error is exit 1 with its text on stderr.
const TAIL: &str = r#"} catch { [Console]::Error.WriteLine([string]$_); exit 1 }
"#;

/// Reads the rule of `{NAME}` from the local PersistentStore and from the
/// ActiveStore (`-TracePolicyStore`: where it comes from), every filter's
/// values (decision 6's list, `rules::expected_fields`), and the Private
/// profile's `AllowLocalFirewallRules`. "No such rule" is only the lookup's
/// own `CmdletizationQuery_NotFound_*` answer (as stage 1 checked on a real
/// PC); any other error fails the whole read.
const QUERY_BODY: &str = r#"  function Test-BantoNotFound($e) { ([string]$e.Exception.GetType().FullName -eq 'Microsoft.PowerShell.Cmdletization.Cim.CimJobException') -and ($e.CategoryInfo.Category -eq [System.Management.Automation.ErrorCategory]::ObjectNotFound) -and ([string]$e.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound_*,Get-NetFirewallRule') }
  function S($v) { $a = @(foreach ($x in @($v)) { if ($null -ne $x) { [string]$x } }); return ,$a }
  function Read-BantoRule($r) {
    $app = $r | Get-NetFirewallApplicationFilter -ErrorAction Stop
    $pf = $r | Get-NetFirewallPortFilter -ErrorAction Stop
    $af = $r | Get-NetFirewallAddressFilter -ErrorAction Stop
    $tf = $r | Get-NetFirewallInterfaceTypeFilter -ErrorAction Stop
    $nf = $r | Get-NetFirewallInterfaceFilter -ErrorAction Stop
    $sf = $r | Get-NetFirewallServiceFilter -ErrorAction Stop
    $xf = $r | Get-NetFirewallSecurityFilter -ErrorAction Stop
    return [ordered]@{
      Name = (S $r.Name); Group = (S $r.Group); Enabled = (S $r.Enabled); Direction = (S $r.Direction); Action = (S $r.Action); Profile = (S $r.Profile)
      EdgeTraversalPolicy = (S $r.EdgeTraversalPolicy); LooseSourceMapping = (S $r.LooseSourceMapping); LocalOnlyMapping = (S $r.LocalOnlyMapping); Owner = (S $r.Owner); Platform = (S $r.Platform); RemoteDynamicKeywordAddresses = (S $r.RemoteDynamicKeywordAddresses)
      PolicyStoreSource = (S $r.PolicyStoreSource); PolicyStoreSourceType = (S $r.PolicyStoreSourceType)
      Program = (S $app.Program); Package = (S $app.Package)
      Protocol = (S $pf.Protocol); LocalPort = (S $pf.LocalPort); RemotePort = (S $pf.RemotePort); IcmpType = (S $pf.IcmpType); DynamicTarget = (S $pf.DynamicTarget)
      LocalAddress = (S $af.LocalAddress); RemoteAddress = (S $af.RemoteAddress)
      InterfaceType = (S $tf.InterfaceType); InterfaceAlias = (S $nf.InterfaceAlias); Service = (S $sf.Service)
      Authentication = (S $xf.Authentication); Encryption = (S $xf.Encryption); OverrideBlockRules = (S $xf.OverrideBlockRules); LocalUser = (S $xf.LocalUser); RemoteUser = (S $xf.RemoteUser); RemoteMachine = (S $xf.RemoteMachine)
    }
  }
  function Find-BantoRules([bool]$active) {
    try {
      if ($active) { $found = @(Get-NetFirewallRule -Name {NAME} -PolicyStore ActiveStore -TracePolicyStore -ErrorAction Stop) }
      else { $found = @(Get-NetFirewallRule -Name {NAME} -PolicyStore PersistentStore -ErrorAction Stop) }
    } catch { if (Test-BantoNotFound $_) { return ,@() }; throw }
    $rules = @(foreach ($r in $found) { Read-BantoRule $r })
    return ,$rules
  }
  $prof = Get-NetFirewallProfile -Name Private -PolicyStore ActiveStore -ErrorAction Stop
  $out = [ordered]@{ local = (Find-BantoRules $false); active = (Find-BantoRules $true); allowLocalRules = (S $prof.AllowLocalFirewallRules) }
  $json = ConvertTo-Json -InputObject $out -Compress -Depth 6
  $sb = New-Object System.Text.StringBuilder
  foreach ($c in $json.ToCharArray()) { if ([int]$c -lt 128) { [void]$sb.Append($c) } else { [void]$sb.AppendFormat('\u{0:x4}', [int]$c) } }
  [Console]::Out.Write({MARKER} + $sb.ToString())
  exit 0
"#;

/// Creates decision 1's rule in the local PersistentStore (the only values
/// set; everything else stays at the module's defaults, which is what
/// `rules::expected_fields` expects).
const CREATE_BODY: &str = r#"  $null = New-NetFirewallRule -Name {NAME} -DisplayName {DISPLAY} -Group {GROUP} -Direction Inbound -Action Allow -Program {PROGRAM} -Protocol TCP -Profile Private -RemoteAddress LocalSubnet -Enabled True -PolicyStore PersistentStore -ErrorAction Stop
  exit 0
"#;

/// Removes the rule of `{NAME}` from the local PersistentStore only.
const REMOVE_BODY: &str = r#"  Remove-NetFirewallRule -Name {NAME} -PolicyStore PersistentStore -ErrorAction Stop
  exit 0
"#;

fn script(body: &str, values: &[(&str, &str)]) -> Option<String> {
    fill(&format!("{HEAD}{body}{TAIL}"), values)
}

/// The query script for `names`.
pub fn query_script(paths: &PowerShellPaths, names: &RuleNames) -> Option<String> {
    script(
        QUERY_BODY,
        &[
            ("MODULE", &paths.net_security),
            ("NAME", &names.name),
            ("MARKER", OUTPUT_MARKER),
        ],
    )
}

/// The script creating `spec`'s rule.
pub fn create_script(paths: &PowerShellPaths, spec: &RuleSpec) -> Option<String> {
    script(
        CREATE_BODY,
        &[
            ("MODULE", &paths.net_security),
            ("NAME", &spec.names.name),
            ("DISPLAY", &spec.names.display_name),
            ("GROUP", &spec.names.group),
            ("PROGRAM", &spec.program),
        ],
    )
}

/// The script removing the rule of `names`.
pub fn remove_script(paths: &PowerShellPaths, names: &RuleNames) -> Option<String> {
    script(
        REMOVE_BODY,
        &[("MODULE", &paths.net_security), ("NAME", &names.name)],
    )
}

/// `script` as PowerShell's `-EncodedCommand` argument: base64 of its
/// UTF-16LE bytes. The result is only `[A-Za-z0-9+/=]`.
pub fn encode_command(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64_encode(&bytes)
}

/// Standard base64 with padding (RFC 4648 §4). Small enough to keep rather
/// than add a dependency for one call (conventions §3).
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// A value list: a JSON array of strings, a lone string, or `null`
/// (Windows PowerShell's `ConvertTo-Json` may collapse a one-element array).
fn string_list(value: &Value) -> Result<Vec<String>, String> {
    match value {
        Value::Null => Ok(vec![]),
        Value::String(s) => Ok(vec![s.clone()]),
        Value::Array(items) => items
            .iter()
            .map(|v| match v {
                Value::String(s) => Ok(s.clone()),
                other => Err(format!("not a string: {other}")),
            })
            .collect(),
        other => Err(format!("not a list of strings: {other}")),
    }
}

/// A list of rules: an array of objects (or a lone object, or `null`).
fn rule_list(value: Option<&Value>, key: &str) -> Result<Vec<RuleFields>, String> {
    let one = |v: &Value| -> Result<RuleFields, String> {
        let Value::Object(map) = v else {
            return Err(format!("{key}: a rule is not an object"));
        };
        map.iter()
            .map(|(k, v)| {
                Ok((
                    k.clone(),
                    string_list(v).map_err(|e| format!("{key}.{k}: {e}"))?,
                ))
            })
            .collect()
    };
    match value {
        None => Err(format!("{key} is missing")),
        Some(Value::Null) => Ok(vec![]),
        Some(Value::Array(items)) => items.iter().map(one).collect(),
        Some(v @ Value::Object(_)) => Ok(vec![one(v)?]),
        Some(_) => Err(format!("{key} is not a list")),
    }
}

/// The query script's stdout: the JSON after the last [`OUTPUT_MARKER`].
pub fn parse_query_output(stdout: &str) -> Result<RuleSnapshot, String> {
    let start = stdout
        .rfind(OUTPUT_MARKER)
        .ok_or("the query printed no result")?;
    let json = stdout[start + OUTPUT_MARKER.len()..]
        .lines()
        .next()
        .unwrap_or("")
        .trim();
    let value: Value =
        serde_json::from_str(json).map_err(|e| format!("the query result is not JSON: {e}"))?;
    let Value::Object(map) = &value else {
        return Err("the query result is not an object".into());
    };
    Ok(RuleSnapshot {
        local: rule_list(map.get("local"), "local")?,
        active: rule_list(map.get("active"), "active")?,
        allow_local_rules: string_list(map.get("allowLocalRules").unwrap_or(&Value::Null))
            .map_err(|e| format!("allowLocalRules: {e}"))?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::rule_names;

    fn paths() -> PowerShellPaths {
        powershell_paths(r"C:\Windows\System32")
    }

    fn spec() -> RuleSpec {
        RuleSpec {
            names: rule_names("dev.banto.admin").unwrap(),
            program: r"C:\Program Files\O'Brien {NAME}\admin-template.exe".into(),
        }
    }

    #[test]
    fn powershell_is_found_under_the_system_directory_only() {
        assert_eq!(
            powershell_paths(r"C:\Windows\System32\"),
            PowerShellPaths {
                exe: r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe".into(),
                modules_dir: r"C:\Windows\System32\WindowsPowerShell\v1.0\Modules".into(),
                net_security:
                    r"C:\Windows\System32\WindowsPowerShell\v1.0\Modules\NetSecurity\NetSecurity.psd1"
                        .into(),
            }
        );
    }

    #[test]
    fn the_environment_is_derived_not_inherited() {
        let env = child_environment(r"C:\Windows\System32", r"C:\Windows");
        let get = |k: &str| {
            env.iter()
                .find(|(key, _)| key == k)
                .map(|(_, v)| v.as_str())
        };
        assert_eq!(
            get("PSModulePath"),
            Some(r"C:\Windows\System32\WindowsPowerShell\v1.0\Modules")
        );
        assert_eq!(get("SystemRoot"), Some(r"C:\Windows"));
        assert_eq!(get("SystemDrive"), Some("C:"));
        assert_eq!(get("TEMP"), Some(r"C:\Windows\Temp"));
        assert_eq!(get("PATH"), None);
        assert_eq!(get("USERPROFILE"), None);
        assert_eq!(env.len(), 7);
    }

    #[test]
    fn the_command_line_is_fixed_flags_and_base64() {
        let args = arguments("Get-Date");
        assert_eq!(
            args,
            [
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                "RwBlAHQALQBEAGEAdABlAA=="
            ]
        );
    }

    #[test]
    fn base64_matches_rfc4648_vectors() {
        for (input, want) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64_encode(input.as_bytes()), want);
        }
    }

    #[test]
    fn quoting_doubles_every_single_quote_and_refuses_control_characters() {
        assert_eq!(quote_literal("abc").as_deref(), Some("'abc'"));
        assert_eq!(
            quote_literal("a'b\u{2018}c\u{2019}d\u{201A}e\u{201B}f").as_deref(),
            Some("'a''b\u{2018}\u{2018}c\u{2019}\u{2019}d\u{201A}\u{201A}e\u{201B}\u{201B}f'")
        );
        assert_eq!(quote_literal("$(evil) `n"), Some("'$(evil) `n'".into()));
        assert_eq!(quote_literal("a\nb"), None);
        assert_eq!(quote_literal("a\u{0}b"), None);
    }

    #[test]
    fn fill_substitutes_once_and_refuses_unknown_keys() {
        assert_eq!(
            fill("x {A} {B} {a} {} { y", &[("A", "{B}"), ("B", "b")]).as_deref(),
            Some("x '{B}' 'b' {a} {} { y")
        );
        assert_eq!(fill("{C}", &[("A", "a")]), None);
        assert_eq!(fill("{A}", &[("A", "a\r")]), None);
    }

    #[test]
    fn the_create_script_holds_decision_one_and_only_quoted_values() {
        let s = create_script(&paths(), &spec()).unwrap();
        assert!(s.contains(
            r"Import-Module -Name 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\NetSecurity\NetSecurity.psd1'"
        ));
        assert!(s.contains(
            "New-NetFirewallRule -Name 'dev.banto.admin.lan.tcp.program' -DisplayName 'dev.banto.admin LAN (TCP-In, program)' -Group 'dev.banto.admin' -Direction Inbound -Action Allow -Program 'C:\\Program Files\\O''Brien {NAME}\\admin-template.exe' -Protocol TCP -Profile Private -RemoteAddress LocalSubnet -Enabled True -PolicyStore PersistentStore"
        ));
        assert!(!s.contains("-LocalPort"), "decision 1: no port");
        assert!(!s.contains("{PROGRAM}") && !s.contains("{MODULE}"));
        assert!(!s.contains("$env:"), "nothing from the environment");
    }

    #[test]
    fn the_remove_and_query_scripts_name_the_local_store() {
        let names = &spec().names;
        let r = remove_script(&paths(), names).unwrap();
        assert!(r.contains(
            "Remove-NetFirewallRule -Name 'dev.banto.admin.lan.tcp.program' -PolicyStore PersistentStore"
        ));
        let q = query_script(&paths(), names).unwrap();
        assert!(q.contains(
            "Get-NetFirewallRule -Name 'dev.banto.admin.lan.tcp.program' -PolicyStore ActiveStore -TracePolicyStore"
        ));
        assert!(q.contains(
            "Get-NetFirewallRule -Name 'dev.banto.admin.lan.tcp.program' -PolicyStore PersistentStore"
        ));
        assert!(q.contains(&format!("[Console]::Out.Write('{OUTPUT_MARKER}'")));
        for s in [&r, &q] {
            assert!(!s.contains("$env:"));
            assert!(!s.contains("{NAME}") && !s.contains("{MODULE}"));
        }
    }

    /// The query reads every field `rules::expected_fields` compares, plus
    /// the source fields.
    #[test]
    fn the_query_reads_every_compared_field() {
        let q = query_script(&paths(), &spec().names).unwrap();
        let fields = crate::rules::expected_fields(&spec())
            .into_iter()
            .map(|(field, _)| field)
            .chain(
                crate::rules::EXPECTED_SOURCE
                    .iter()
                    .map(|(field, _)| *field),
            );
        for field in fields {
            assert!(q.contains(&format!("{field} = (S ")), "{field}");
        }
    }

    #[test]
    fn output_parses_lists_lone_values_and_nulls() {
        let out = format!(
            "noise\r\n{OUTPUT_MARKER}{}",
            r#"{"local":[{"Name":["n"],"Owner":[],"Package":null,"Program":"C:\\Program Files\\\u00e9\\a.exe"}],"active":[],"allowLocalRules":["NotConfigured"]}"#
        );
        let s = parse_query_output(&out).unwrap();
        assert_eq!(s.local.len(), 1);
        assert_eq!(s.local[0]["Name"], ["n"]);
        assert!(s.local[0]["Owner"].is_empty());
        assert!(s.local[0]["Package"].is_empty());
        assert_eq!(s.local[0]["Program"], [r"C:\Program Files\é\a.exe"]);
        assert!(s.active.is_empty());
        assert_eq!(s.allow_local_rules, ["NotConfigured"]);

        // A lone rule object (ConvertTo-Json unrolling a one-element array).
        let s = parse_query_output(&format!(
            r#"{OUTPUT_MARKER}{{"local":null,"active":{{"Name":"n"}},"allowLocalRules":"False"}}"#
        ))
        .unwrap();
        assert!(s.local.is_empty());
        assert_eq!(s.active.len(), 1);
        assert!(s.local_rules_disallowed());
    }

    #[test]
    fn unexpected_output_is_an_error_not_an_empty_store() {
        for bad in [
            String::new(),
            "no marker".to_string(),
            OUTPUT_MARKER.to_string(),
            format!("{OUTPUT_MARKER}not json"),
            format!("{OUTPUT_MARKER}[]"),
            format!(r#"{OUTPUT_MARKER}{{"active":[],"allowLocalRules":[]}}"#),
            format!(r#"{OUTPUT_MARKER}{{"local":[1],"active":[],"allowLocalRules":[]}}"#),
            format!(
                r#"{OUTPUT_MARKER}{{"local":[{{"Name":[1]}}],"active":[],"allowLocalRules":[]}}"#
            ),
            format!(r#"{OUTPUT_MARKER}{{"local":[],"active":"x","allowLocalRules":[]}}"#),
            format!(r#"{OUTPUT_MARKER}{{"local":[],"active":[],"allowLocalRules":{{}}}}"#),
        ] {
            assert!(parse_query_output(&bad).is_err(), "{bad}");
        }
    }
}
