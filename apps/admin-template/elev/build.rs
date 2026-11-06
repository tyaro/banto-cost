//! ADR-0021 decision 7: embeds the `requireAdministrator` manifest
//! (`admin-template-fw-elev.manifest`) into `admin-template-fw-elev.exe` only.
//!
//! `embed_resource::compile_for` emits `cargo:rustc-link-arg-bin=` for the
//! named `[[bin]]` only, so the lib's test binaries carry no manifest and run
//! without elevation. `manifest_required()` is always `Ok` off Windows and
//! fails the build on Windows when the manifest could not be embedded: the
//! elevation manifest is this helper's premise, so a build without it must
//! not pass silently.

fn main() {
    println!("cargo:rerun-if-changed=admin-template-fw-elev.rc");
    println!("cargo:rerun-if-changed=admin-template-fw-elev.manifest");
    embed_resource::compile_for(
        "admin-template-fw-elev.rc",
        ["admin-template-fw-elev"],
        embed_resource::NONE,
    )
    .manifest_required()
    .expect("failed to embed the requireAdministrator manifest into admin-template-fw-elev.exe");
}
