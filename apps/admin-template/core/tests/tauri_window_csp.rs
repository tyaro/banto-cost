//! Two-path CSP symmetry (conventions.md §1, `banto_server::CONTENT_SECURITY_POLICY`'s
//! doc): the Tauri window CSP in `src-tauri/tauri.conf.json` must be exactly
//! the policy the LAN server sends, plus Tauri IPC in `connect-src`.
//!
//! `src-tauri` is not compiled in CI, so this check lives in `core` (which
//! is) and reads the JSON file. It complements `scripts/verify-architecture.mjs`
//! rule 12 (directive-by-directive) with an exact-string comparison built
//! through banto-server's own API, so neither side can drift silently and no
//! string surgery on the policy is needed. If either side changes on
//! purpose, change the other in the same PR.

use banto_server::{SecurityHeaders, TAURI_IPC_CONNECT_SRC};

#[test]
fn window_csp_is_the_served_csp_plus_tauri_ipc() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../src-tauri/tauri.conf.json");
    let conf: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("read tauri.conf.json"))
            .expect("tauri.conf.json is JSON");
    let window_csp = conf["app"]["security"]["csp"]
        .as_str()
        .expect("app.security.csp is a string");

    let expected = SecurityHeaders::new()
        .extra_connect_src(TAURI_IPC_CONNECT_SRC)
        .expect("TAURI_IPC_CONNECT_SRC is valid")
        .content_security_policy();
    assert_eq!(window_csp, expected);
}
