//! Whether the helper and the main exe next to it can be trusted (ADR-0021
//! decision 8) - the judgement only, over facts read from the OS.
//!
//! The facts ([`PlacementFacts`]) are collected on Windows by
//! `win::collect_placement_facts`, which opens each object first and reads
//! everything from that handle (its final path, attributes, owner and DACL),
//! so what is judged is the file the handle refers to. This module is the one
//! definition of the rule, shared by the helper (after it started, defence in
//! depth) and by the main app before it asks for elevation (E2, the primary
//! defence): same function, same tests.
//!
//! The rule, for the helper exe, the main exe next to it, and every folder
//! from theirs up to (and including) the Program Files known folder:
//!
//! - Both exes are strictly inside a Program Files known folder (compared by
//!   path element, case-insensitively), in the same folder, under their
//!   fixed names.
//! - No object is a reparse point (junction, symbolic link, ...).
//! - The owner is Administrators, SYSTEM or TrustedInstaller.
//! - The DACL exists (a NULL DACL grants everyone everything), and no allow
//!   ACE grants a write-type right ([`WRITE_RIGHTS`]) to any other SID.
//!   CREATOR OWNER's inherit-only ACEs are skipped (they never apply to the
//!   object itself). An ACE whose type or SID could not be read refuses.
//!
//! Any failure is decision 11's "precondition missing" (exit 2).

use std::fmt;

/// `S-1-5-32-544` BUILTIN\Administrators.
pub const SID_ADMINISTRATORS: &str = "S-1-5-32-544";
/// `S-1-5-18` NT AUTHORITY\SYSTEM.
pub const SID_SYSTEM: &str = "S-1-5-18";
/// NT SERVICE\TrustedInstaller.
pub const SID_TRUSTED_INSTALLER: &str =
    "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
/// `S-1-3-0` CREATOR OWNER (only meaningful in inheritable ACEs).
pub const SID_CREATOR_OWNER: &str = "S-1-3-0";

/// The SIDs that may own and write the checked objects.
pub const TRUSTED_SIDS: [&str; 3] = [SID_ADMINISTRATORS, SID_SYSTEM, SID_TRUSTED_INSTALLER];

// File access rights (winnt.h). For folders, the same bits are
// FILE_ADD_FILE / FILE_ADD_SUBDIRECTORY.
const FILE_WRITE_DATA: u32 = 0x0000_0002;
const FILE_APPEND_DATA: u32 = 0x0000_0004;
const FILE_WRITE_EA: u32 = 0x0000_0010;
const FILE_DELETE_CHILD: u32 = 0x0000_0040;
const FILE_WRITE_ATTRIBUTES: u32 = 0x0000_0100;
const DELETE: u32 = 0x0001_0000;
const WRITE_DAC: u32 = 0x0004_0000;
const WRITE_OWNER: u32 = 0x0008_0000;
const GENERIC_ALL: u32 = 0x1000_0000;
const GENERIC_WRITE: u32 = 0x4000_0000;

/// The rights that let a holder change, replace, delete or re-permission
/// the object (decision 8's list; `FILE_WRITE_EA` / `FILE_WRITE_ATTRIBUTES`
/// are included too, to stay on the strict side).
pub const WRITE_RIGHTS: u32 = FILE_WRITE_DATA
    | FILE_APPEND_DATA
    | FILE_WRITE_EA
    | FILE_DELETE_CHILD
    | FILE_WRITE_ATTRIBUTES
    | DELETE
    | WRITE_DAC
    | WRITE_OWNER
    | GENERIC_ALL
    | GENERIC_WRITE;

/// `INHERIT_ONLY_ACE`: the ACE applies to children only, not the object.
pub const INHERIT_ONLY_ACE: u8 = 0x08;

/// `FILE_ATTRIBUTE_DIRECTORY`.
pub const ATTRIBUTE_DIRECTORY: u32 = 0x0000_0010;
/// `FILE_ATTRIBUTE_REPARSE_POINT`.
pub const ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

/// ACE types (winnt.h) that grant: `ACCESS_ALLOWED_ACE_TYPE`,
/// `ACCESS_ALLOWED_OBJECT_ACE_TYPE`, `ACCESS_ALLOWED_CALLBACK_ACE_TYPE`,
/// `ACCESS_ALLOWED_CALLBACK_OBJECT_ACE_TYPE`.
const ALLOW_TYPES: [u8; 4] = [0x00, 0x05, 0x09, 0x0B];
/// ACE types that only deny (never widen access): the `DENIED` variants.
const DENY_TYPES: [u8; 4] = [0x01, 0x06, 0x0A, 0x0C];

/// One ACE of a DACL, as read from the OS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AceFact {
    /// `ACE_HEADER::AceType`.
    pub ace_type: u8,
    /// `ACE_HEADER::AceFlags`.
    pub flags: u8,
    /// The access mask.
    pub mask: u32,
    /// The trustee as a string SID, `None` when it could not be read (the
    /// object ACE types, whose SID offset varies, are not decoded).
    pub sid: Option<String>,
}

/// One file or folder, as read through an open handle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectFacts {
    /// The final path of the handle (`GetFinalPathNameByHandleW`), as
    /// [`normalize_final_path`] returns it.
    pub path: String,
    /// The file attributes (`dwFileAttributes`).
    pub attributes: u32,
    /// The owner as a string SID.
    pub owner_sid: String,
    /// The DACL's ACEs in order; `None` for a NULL DACL.
    pub dacl: Option<Vec<AceFact>>,
}

/// Everything decision 8 judges.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PlacementFacts {
    /// The final path of the running exe the facts were collected for (the
    /// helper itself, or the main app in E2's pre-elevation check). It must
    /// be one of the two checked exes.
    pub anchor: String,
    /// The Program Files known folders (`FOLDERID_ProgramFiles`,
    /// `FOLDERID_ProgramFilesX86`) as final paths; those that could not be
    /// read are left out.
    pub program_files: Vec<String>,
    /// The helper exe next to the anchor, `None` when it is not there.
    pub helper: Option<ObjectFacts>,
    /// The main exe next to the anchor, `None` when it is not there.
    pub main: Option<ObjectFacts>,
    /// The folders from the exes' folder up to the Program Files folder, in
    /// that order ([`folder_chain`]). Empty when the exes are not inside one.
    pub folders: Vec<ObjectFacts>,
}

/// What [`check_installed_main`] judges for the uninstaller's
/// `firewall-remove-installed` (`crate::run_remove_installed`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct InstalledFacts {
    /// As in [`PlacementFacts::program_files`].
    pub program_files: Vec<String>,
    /// The fixed-name main exe in the install folder the uninstaller named,
    /// `None` when it is not there.
    pub main: Option<ObjectFacts>,
}

/// Which object a refusal is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Which {
    Helper,
    Main,
    Folder,
}

/// Why the placement is not trusted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlacementRefusal {
    /// The exe is not next to the anchor.
    Missing(Which),
    /// The running exe is neither of the two checked exes.
    AnchorNotChecked { path: String },
    /// The exe's final path does not end in its fixed name.
    WrongName { which: Which, path: String },
    /// The two exes are not in the same folder.
    NotSameFolder,
    /// The exes are not strictly inside a Program Files known folder (or no
    /// known folder could be read).
    NotUnderProgramFiles { path: String },
    /// The checked folders are not exactly the chain up to Program Files.
    FolderChainMismatch,
    /// An exe is a folder, or a folder of the chain is not.
    WrongKind { path: String },
    /// A reparse point on the way.
    ReparsePoint { path: String },
    /// Owned by someone else than Administrators / SYSTEM / TrustedInstaller.
    UntrustedOwner { path: String, sid: String },
    /// A NULL DACL (everyone has full access).
    NullDacl { path: String },
    /// An allow ACE grants a write-type right to another SID.
    WritableBy {
        path: String,
        sid: String,
        mask: u32,
    },
    /// An allow ACE whose SID could not be read, or an ACE of a type that
    /// does not belong in a DACL.
    UnreadableAce { path: String, ace_type: u8 },
}

impl fmt::Display for PlacementRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let which = |w: &Which| match w {
            Which::Helper => "the helper exe",
            Which::Main => "the main exe",
            Which::Folder => "a folder",
        };
        match self {
            Self::Missing(w) => write!(f, "{} is not next to the helper", which(w)),
            Self::AnchorNotChecked { path } => {
                write!(f, "the running exe is not one of the checked ones: {path}")
            }
            Self::WrongName { which: w, path } => {
                write!(f, "{} has an unexpected name: {path}", which(w))
            }
            Self::NotSameFolder => f.write_str("the helper and the main exe are not in one folder"),
            Self::NotUnderProgramFiles { path } => {
                write!(f, "not installed under Program Files: {path}")
            }
            Self::FolderChainMismatch => {
                f.write_str("the folders up to Program Files could not all be checked")
            }
            Self::WrongKind { path } => write!(f, "unexpected file or folder: {path}"),
            Self::ReparsePoint { path } => write!(f, "a reparse point is on the path: {path}"),
            Self::UntrustedOwner { path, sid } => {
                write!(f, "owned by {sid} (not an administrator): {path}")
            }
            Self::NullDacl { path } => write!(f, "no access control list: {path}"),
            Self::WritableBy { path, sid, mask } => {
                write!(f, "{sid} may write ({mask:#010x}): {path}")
            }
            Self::UnreadableAce { path, ace_type } => {
                write!(
                    f,
                    "an access entry (type {ace_type}) could not be checked: {path}"
                )
            }
        }
    }
}

/// The trusted placement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placement {
    /// The helper exe's final path.
    pub helper_exe: String,
    /// The main exe's final path - the rule's `Program` (decision 6).
    pub main_exe: String,
}

/// A final path as `GetFinalPathNameByHandleW` (`VOLUME_NAME_DOS`) returns
/// it, without the `\\?\` prefix: `C:\...`. `None` for anything that is not a
/// plain drive-letter path (UNC, volume GUID, device paths, relative paths,
/// `.` / `..` elements, `/` separators, empty elements).
pub fn normalize_final_path(raw: &str) -> Option<String> {
    let path = raw.strip_prefix(r"\\?\").unwrap_or(raw);
    let bytes = path.as_bytes();
    let drive_ok =
        bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\';
    if !drive_ok || path.contains('/') {
        return None;
    }
    let rest = &path[3..];
    if rest.is_empty() {
        return Some(path.to_string());
    }
    let rest = rest.strip_suffix('\\').unwrap_or(rest);
    if rest
        .split('\\')
        .any(|e| e.is_empty() || e == "." || e == "..")
    {
        return None;
    }
    Some(format!("{}{rest}", &path[..3]))
}

/// The path's elements, case-folded (`C:` first).
fn elements(path: &str) -> Vec<String> {
    path.split('\\')
        .filter(|e| !e.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// Whether two normalized paths name the same place (case-insensitive,
/// element by element).
pub fn same_path(a: &str, b: &str) -> bool {
    elements(a) == elements(b)
}

/// Whether `path` is strictly inside `dir` (by element, case-insensitive):
/// `C:\Program Files\App` is inside `C:\Program Files`, but
/// `C:\Program Files Evil\App` and `C:\Program Files` itself are not.
pub fn is_strictly_inside(path: &str, dir: &str) -> bool {
    let (p, d) = (elements(path), elements(dir));
    !d.is_empty() && p.len() > d.len() && p[..d.len()] == d[..]
}

/// The parent folder of a normalized path (`None` for a drive root).
pub fn parent(path: &str) -> Option<&str> {
    let trimmed = path.strip_suffix('\\').unwrap_or(path);
    let idx = trimmed.rfind('\\')?;
    if idx < 2 {
        return None;
    }
    // Keep the root's backslash (`C:\`) when the parent is the drive root.
    Some(if idx == 2 {
        &trimmed[..3]
    } else {
        &trimmed[..idx]
    })
}

/// The last element of a normalized path.
pub fn file_name(path: &str) -> &str {
    path.rsplit('\\').next().unwrap_or(path)
}

/// The Program Files known folder `exe` is strictly inside, if any.
pub fn containing_program_files<'a>(exe: &str, program_files: &'a [String]) -> Option<&'a str> {
    program_files
        .iter()
        .map(String::as_str)
        .find(|pf| is_strictly_inside(exe, pf))
}

/// The folders to check for `exe`: its folder, each parent, up to and
/// including `program_files`. `None` when `exe` is not strictly inside it.
pub fn folder_chain(exe: &str, program_files: &str) -> Option<Vec<String>> {
    if !is_strictly_inside(exe, program_files) {
        return None;
    }
    let mut chain = Vec::new();
    let mut current = parent(exe)?;
    loop {
        chain.push(current.to_string());
        if same_path(current, program_files) {
            return Some(chain);
        }
        current = parent(current)?;
    }
}

/// The ACL rule for one object.
pub fn check_object(object: &ObjectFacts) -> Result<(), PlacementRefusal> {
    let path = || object.path.clone();
    if object.attributes & ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(PlacementRefusal::ReparsePoint { path: path() });
    }
    if !is_trusted(&object.owner_sid) {
        return Err(PlacementRefusal::UntrustedOwner {
            path: path(),
            sid: object.owner_sid.clone(),
        });
    }
    let Some(dacl) = &object.dacl else {
        return Err(PlacementRefusal::NullDacl { path: path() });
    };
    for ace in dacl {
        if DENY_TYPES.contains(&ace.ace_type) {
            continue;
        }
        if !ALLOW_TYPES.contains(&ace.ace_type) {
            return Err(PlacementRefusal::UnreadableAce {
                path: path(),
                ace_type: ace.ace_type,
            });
        }
        if ace.mask & WRITE_RIGHTS == 0 {
            continue;
        }
        let Some(sid) = &ace.sid else {
            return Err(PlacementRefusal::UnreadableAce {
                path: path(),
                ace_type: ace.ace_type,
            });
        };
        if is_trusted(sid) {
            continue;
        }
        if sid == SID_CREATOR_OWNER && ace.flags & INHERIT_ONLY_ACE != 0 {
            continue;
        }
        return Err(PlacementRefusal::WritableBy {
            path: path(),
            sid: sid.clone(),
            mask: ace.mask,
        });
    }
    Ok(())
}

fn is_trusted(sid: &str) -> bool {
    TRUSTED_SIDS.iter().any(|t| t.eq_ignore_ascii_case(sid))
}

/// Decision 8, the whole rule. `helper_name` / `main_name` are the fixed
/// file names ([`crate::HELPER_EXE_FILE_NAME`] / [`crate::MAIN_EXE_FILE_NAME`]).
pub fn check_placement(
    facts: &PlacementFacts,
    helper_name: &str,
    main_name: &str,
) -> Result<Placement, PlacementRefusal> {
    // Where the install is comes first: the running exe (the anchor, always
    // present - it is one of the two checked exes, see below) outside a
    // Program Files folder is a portable / per-user / moved copy, and that
    // is the reason to give even when the helper is not shipped there. Every
    // case this early return refuses is refused below as well (an accepted
    // anchor is the helper or the main exe, in the helper's folder, which is
    // inside Program Files), so only the reason changes, never the verdict.
    if containing_program_files(&facts.anchor, &facts.program_files).is_none() {
        return Err(PlacementRefusal::NotUnderProgramFiles {
            path: facts.anchor.clone(),
        });
    }
    let helper = facts
        .helper
        .as_ref()
        .ok_or(PlacementRefusal::Missing(Which::Helper))?;
    let main = facts
        .main
        .as_ref()
        .ok_or(PlacementRefusal::Missing(Which::Main))?;
    for (which, object, name) in [
        (Which::Helper, helper, helper_name),
        (Which::Main, main, main_name),
    ] {
        if !file_name(&object.path).eq_ignore_ascii_case(name) {
            return Err(PlacementRefusal::WrongName {
                which,
                path: object.path.clone(),
            });
        }
    }
    if !same_path(&facts.anchor, &helper.path) && !same_path(&facts.anchor, &main.path) {
        return Err(PlacementRefusal::AnchorNotChecked {
            path: facts.anchor.clone(),
        });
    }
    let (Some(helper_dir), Some(main_dir)) = (parent(&helper.path), parent(&main.path)) else {
        return Err(PlacementRefusal::NotSameFolder);
    };
    if !same_path(helper_dir, main_dir) {
        return Err(PlacementRefusal::NotSameFolder);
    }
    let program_files =
        containing_program_files(&helper.path, &facts.program_files).ok_or_else(|| {
            PlacementRefusal::NotUnderProgramFiles {
                path: helper.path.clone(),
            }
        })?;
    let chain = folder_chain(&helper.path, program_files).ok_or_else(|| {
        PlacementRefusal::NotUnderProgramFiles {
            path: helper.path.clone(),
        }
    })?;
    if chain.len() != facts.folders.len()
        || chain
            .iter()
            .zip(&facts.folders)
            .any(|(want, got)| !same_path(want, &got.path))
    {
        return Err(PlacementRefusal::FolderChainMismatch);
    }
    for exe in [helper, main] {
        if exe.attributes & ATTRIBUTE_DIRECTORY != 0 {
            return Err(PlacementRefusal::WrongKind {
                path: exe.path.clone(),
            });
        }
        check_object(exe)?;
    }
    for folder in &facts.folders {
        if folder.attributes & ATTRIBUTE_DIRECTORY == 0 {
            return Err(PlacementRefusal::WrongKind {
                path: folder.path.clone(),
            });
        }
        check_object(folder)?;
    }
    Ok(Placement {
        helper_exe: helper.path.clone(),
        main_exe: main.path.clone(),
    })
}

/// The uninstaller's request (`crate::run_remove_installed`): the main exe
/// in the install folder is there under `main_name`, is a file and not a
/// reparse point, and is strictly inside a Program Files known folder.
/// Returns its final path - the rule's `Program`. Neither the owner nor the
/// ACL is judged here: this only removes the own rule (see the caller).
pub fn check_installed_main(
    facts: &InstalledFacts,
    main_name: &str,
) -> Result<String, PlacementRefusal> {
    let main = facts
        .main
        .as_ref()
        .ok_or(PlacementRefusal::Missing(Which::Main))?;
    if !file_name(&main.path).eq_ignore_ascii_case(main_name) {
        return Err(PlacementRefusal::WrongName {
            which: Which::Main,
            path: main.path.clone(),
        });
    }
    if main.attributes & ATTRIBUTE_DIRECTORY != 0 {
        return Err(PlacementRefusal::WrongKind {
            path: main.path.clone(),
        });
    }
    if main.attributes & ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(PlacementRefusal::ReparsePoint {
            path: main.path.clone(),
        });
    }
    if containing_program_files(&main.path, &facts.program_files).is_none() {
        return Err(PlacementRefusal::NotUnderProgramFiles {
            path: main.path.clone(),
        });
    }
    Ok(main.path.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PF: &str = r"C:\Program Files";
    const PF86: &str = r"C:\Program Files (x86)";
    const HELPER: &str = "app-fw-elev.exe";
    const MAIN: &str = "app.exe";
    const HELPER_PATH: &str = r"C:\Program Files\Vendor\App\app-fw-elev.exe";
    const USERS: &str = "S-1-5-32-545";
    const AUTH_USERS: &str = "S-1-5-11";
    const ALL_APP_PACKAGES: &str = "S-1-15-2-1";
    /// `FILE_GENERIC_READ | FILE_GENERIC_EXECUTE` (`0x1200a9`).
    const READ_EXECUTE: u32 = 0x0012_00A9;
    /// `FILE_ALL_ACCESS`.
    const FULL: u32 = 0x001F_01FF;
    /// `FILE_GENERIC_*` "Modify" (`0x1301bf`).
    const MODIFY: u32 = 0x0013_01BF;

    fn allow(sid: &str, mask: u32, flags: u8) -> AceFact {
        AceFact {
            ace_type: 0,
            flags,
            mask,
            sid: Some(sid.into()),
        }
    }

    /// The DACL Windows gives Program Files and what an installer puts in it.
    fn stock_dacl() -> Vec<AceFact> {
        vec![
            allow(SID_TRUSTED_INSTALLER, FULL, 0),
            allow(SID_TRUSTED_INSTALLER, GENERIC_ALL, 0x0A),
            allow(SID_SYSTEM, MODIFY, 0),
            allow(SID_SYSTEM, GENERIC_ALL, 0x0B),
            allow(SID_ADMINISTRATORS, MODIFY, 0),
            allow(SID_ADMINISTRATORS, GENERIC_ALL, 0x0B),
            allow(USERS, READ_EXECUTE, 0),
            allow(USERS, 0xA000_0000, 0x0B),
            allow(SID_CREATOR_OWNER, GENERIC_ALL, 0x0B),
            allow(ALL_APP_PACKAGES, READ_EXECUTE, 0),
        ]
    }

    fn object(path: &str, attributes: u32) -> ObjectFacts {
        ObjectFacts {
            path: path.into(),
            attributes,
            owner_sid: SID_TRUSTED_INSTALLER.into(),
            dacl: Some(stock_dacl()),
        }
    }

    fn facts() -> PlacementFacts {
        PlacementFacts {
            anchor: HELPER_PATH.into(),
            program_files: vec![PF.into(), PF86.into()],
            helper: Some(object(r"C:\Program Files\Vendor\App\app-fw-elev.exe", 0x20)),
            main: Some(object(r"C:\Program Files\Vendor\App\app.exe", 0x20)),
            folders: vec![
                object(r"C:\Program Files\Vendor\App", ATTRIBUTE_DIRECTORY),
                object(r"C:\Program Files\Vendor", ATTRIBUTE_DIRECTORY),
                object(PF, ATTRIBUTE_DIRECTORY),
            ],
        }
    }

    fn check(f: &PlacementFacts) -> Result<Placement, PlacementRefusal> {
        check_placement(f, HELPER, MAIN)
    }

    #[test]
    fn a_stock_per_machine_install_is_trusted() {
        assert_eq!(
            check(&facts()),
            Ok(Placement {
                helper_exe: r"C:\Program Files\Vendor\App\app-fw-elev.exe".into(),
                main_exe: r"C:\Program Files\Vendor\App\app.exe".into(),
            })
        );
    }

    #[test]
    fn program_files_x86_counts_too() {
        let mut f = facts();
        f.anchor = r"C:\Program Files (x86)\App\app.exe".into();
        f.helper = Some(object(r"C:\Program Files (x86)\App\app-fw-elev.exe", 0));
        f.main = Some(object(r"C:\Program Files (x86)\App\APP.EXE", 0));
        f.folders = vec![
            object(r"C:\Program Files (x86)\App", ATTRIBUTE_DIRECTORY),
            object(r"c:\program files (x86)", ATTRIBUTE_DIRECTORY),
        ];
        assert!(check(&f).is_ok());
    }

    #[test]
    fn final_paths_are_normalized_and_odd_ones_refused() {
        assert_eq!(
            normalize_final_path(r"\\?\C:\Program Files\App\app.exe").as_deref(),
            Some(r"C:\Program Files\App\app.exe")
        );
        assert_eq!(
            normalize_final_path(r"\\?\C:\Program Files\").as_deref(),
            Some(r"C:\Program Files")
        );
        assert_eq!(normalize_final_path(r"C:\").as_deref(), Some(r"C:\"));
        for bad in [
            r"\\?\UNC\server\share\app.exe",
            r"\\?\Volume{0b1c2d3e-0000-0000-0000-100000000000}\app.exe",
            r"\\.\C:\app.exe",
            r"app.exe",
            r"C:app.exe",
            r"C:\Program Files\..\Users\x\app.exe",
            r"C:\Program Files\.\App\app.exe",
            r"C:\Program Files\\App\app.exe",
            r"C:/Program Files/App/app.exe",
            r"C:\\",
            "",
        ] {
            assert_eq!(normalize_final_path(bad), None, "{bad}");
        }
    }

    /// Decision 8: compared by path element, not by string prefix.
    #[test]
    fn inside_is_by_element_and_case_insensitive() {
        assert!(is_strictly_inside(r"C:\Program Files\App\a.exe", PF));
        assert!(is_strictly_inside(r"c:\PROGRAM FILES\App\a.exe", PF));
        assert!(!is_strictly_inside(r"C:\Program Files Evil\App\a.exe", PF));
        assert!(!is_strictly_inside(r"C:\Program FilesX\a.exe", PF));
        assert!(!is_strictly_inside(PF, PF));
        assert!(!is_strictly_inside(r"D:\Program Files\App\a.exe", PF));
        assert!(!is_strictly_inside(
            r"C:\Users\me\AppData\Local\App\a.exe",
            PF
        ));
        assert!(!is_strictly_inside(r"C:\a.exe", ""));
    }

    #[test]
    fn the_chain_runs_up_to_program_files_inclusive() {
        assert_eq!(
            folder_chain(r"C:\Program Files\Vendor\App\a.exe", PF),
            Some(vec![
                r"C:\Program Files\Vendor\App".to_string(),
                r"C:\Program Files\Vendor".to_string(),
                PF.to_string(),
            ])
        );
        assert_eq!(
            folder_chain(r"C:\Program Files\a.exe", PF),
            Some(vec![PF.to_string()])
        );
        assert_eq!(folder_chain(r"C:\Other\a.exe", PF), None);
        assert_eq!(parent(r"C:\a.exe"), Some(r"C:\"));
        assert_eq!(parent(r"C:\"), None);
    }

    #[test]
    fn portable_and_per_user_copies_are_refused() {
        for dir in [
            r"C:\Users\me\AppData\Local\App",
            r"C:\Tools\App",
            r"C:\Program Files Evil\App",
            r"D:\Program Files\App",
        ] {
            let mut f = facts();
            f.anchor = format!(r"{dir}\app-fw-elev.exe");
            f.helper = Some(object(&format!(r"{dir}\app-fw-elev.exe"), 0));
            f.main = Some(object(&format!(r"{dir}\app.exe"), 0));
            assert!(
                matches!(
                    check(&f),
                    Err(PlacementRefusal::NotUnderProgramFiles { .. })
                ),
                "{dir}"
            );
        }
        // No known folder could be read: refused, not assumed.
        let mut f = facts();
        f.program_files.clear();
        assert!(matches!(
            check(&f),
            Err(PlacementRefusal::NotUnderProgramFiles { .. })
        ));
    }

    #[test]
    fn outside_program_files_is_reported_before_a_missing_helper() {
        // Per-user / portable copy without the helper: the place is the reason.
        let dir = r"C:\Users\me\AppData\Local\App";
        let mut f = facts();
        f.anchor = format!(r"{dir}\app.exe");
        f.helper = None;
        f.main = Some(object(&format!(r"{dir}\app.exe"), 0));
        f.folders.clear();
        assert!(matches!(
            check(&f),
            Err(PlacementRefusal::NotUnderProgramFiles { .. })
        ));
        // Inside Program Files, only the helper missing: still Missing(Helper).
        let mut f = facts();
        f.anchor = r"C:\Program Files\Vendor\App\app.exe".into();
        f.helper = None;
        assert_eq!(check(&f), Err(PlacementRefusal::Missing(Which::Helper)));
    }

    #[test]
    fn the_running_exe_must_be_one_of_the_checked_ones() {
        let mut f = facts();
        f.anchor = r"C:\Program Files\Vendor\App\APP.exe".into();
        assert!(check(&f).is_ok(), "the main app (E2) as anchor");
        f.anchor = r"C:\Program Files\Vendor\App\copy-of-helper.exe".into();
        assert!(matches!(
            check(&f),
            Err(PlacementRefusal::AnchorNotChecked { .. })
        ));
    }

    #[test]
    fn missing_or_misnamed_or_split_exes_are_refused() {
        let mut f = facts();
        f.main = None;
        assert_eq!(check(&f), Err(PlacementRefusal::Missing(Which::Main)));
        let mut f = facts();
        f.helper = None;
        assert_eq!(check(&f), Err(PlacementRefusal::Missing(Which::Helper)));
        let mut f = facts();
        f.main = Some(object(r"C:\Program Files\Vendor\App\other.exe", 0));
        assert!(matches!(
            check(&f),
            Err(PlacementRefusal::WrongName {
                which: Which::Main,
                ..
            })
        ));
        let mut f = facts();
        f.main = Some(object(r"C:\Program Files\Vendor\Other\app.exe", 0));
        assert_eq!(check(&f), Err(PlacementRefusal::NotSameFolder));
    }

    #[test]
    fn every_folder_up_to_program_files_must_be_checked() {
        let mut f = facts();
        f.folders.pop();
        assert_eq!(check(&f), Err(PlacementRefusal::FolderChainMismatch));
        let mut f = facts();
        f.folders.swap(0, 1);
        assert_eq!(check(&f), Err(PlacementRefusal::FolderChainMismatch));
        let mut f = facts();
        f.folders[1].path = r"C:\Program Files\Elsewhere".into();
        assert_eq!(check(&f), Err(PlacementRefusal::FolderChainMismatch));
    }

    #[test]
    fn kinds_must_match() {
        let mut f = facts();
        f.folders[1].attributes = 0x20;
        assert!(matches!(check(&f), Err(PlacementRefusal::WrongKind { .. })));
        let mut f = facts();
        f.main.as_mut().unwrap().attributes = ATTRIBUTE_DIRECTORY;
        assert!(matches!(check(&f), Err(PlacementRefusal::WrongKind { .. })));
    }

    #[test]
    fn a_reparse_point_anywhere_is_refused() {
        for i in 0..5 {
            let mut f = facts();
            let target = match i {
                0 => f.helper.as_mut().unwrap(),
                1 => f.main.as_mut().unwrap(),
                n => &mut f.folders[n - 2],
            };
            target.attributes |= ATTRIBUTE_REPARSE_POINT;
            assert!(
                matches!(check(&f), Err(PlacementRefusal::ReparsePoint { .. })),
                "object {i}"
            );
        }
    }

    #[test]
    fn owners_other_than_administrators_system_trustedinstaller_are_refused() {
        for owner in [SID_ADMINISTRATORS, SID_SYSTEM, SID_TRUSTED_INSTALLER] {
            let mut f = facts();
            f.folders[0].owner_sid = owner.into();
            assert!(check(&f).is_ok(), "{owner}");
        }
        for owner in ["S-1-5-21-1-2-3-1001", USERS, AUTH_USERS, SID_CREATOR_OWNER] {
            let mut f = facts();
            f.folders[0].owner_sid = owner.into();
            assert!(
                matches!(check(&f), Err(PlacementRefusal::UntrustedOwner { .. })),
                "{owner}"
            );
        }
    }

    /// The "vendor folder writable by users" case: string checks pass, the
    /// ACL check refuses.
    #[test]
    fn each_write_right_for_another_sid_is_refused() {
        let rights = [
            FILE_WRITE_DATA,
            FILE_APPEND_DATA,
            FILE_WRITE_EA,
            FILE_DELETE_CHILD,
            FILE_WRITE_ATTRIBUTES,
            DELETE,
            WRITE_DAC,
            WRITE_OWNER,
            GENERIC_ALL,
            GENERIC_WRITE,
            MODIFY,
            FULL,
        ];
        for right in rights {
            for target in 0..3 {
                let mut f = facts();
                let object = match target {
                    0 => f.helper.as_mut().unwrap(),
                    1 => f.main.as_mut().unwrap(),
                    _ => &mut f.folders[1],
                };
                object
                    .dacl
                    .as_mut()
                    .unwrap()
                    .push(allow(AUTH_USERS, right, 0));
                assert!(
                    matches!(check(&f), Err(PlacementRefusal::WritableBy { .. })),
                    "{right:#x} on {target}"
                );
            }
        }
    }

    #[test]
    fn inherit_only_is_skipped_for_creator_owner_only() {
        // CREATOR OWNER, inherit-only: fine (in the stock DACL already).
        assert!(check(&facts()).is_ok());
        // CREATOR OWNER applying to the object itself: refused.
        let mut f = facts();
        f.folders[0]
            .dacl
            .as_mut()
            .unwrap()
            .push(allow(SID_CREATOR_OWNER, GENERIC_ALL, 0x03));
        assert!(matches!(
            check(&f),
            Err(PlacementRefusal::WritableBy { .. })
        ));
        // Users, inherit-only: still refused (decision 8 only exempts CREATOR OWNER).
        let mut f = facts();
        f.folders[0]
            .dacl
            .as_mut()
            .unwrap()
            .push(allow(USERS, MODIFY, 0x0B));
        assert!(matches!(
            check(&f),
            Err(PlacementRefusal::WritableBy { .. })
        ));
    }

    #[test]
    fn deny_aces_and_read_only_grants_pass() {
        let mut f = facts();
        let dacl = f.folders[0].dacl.as_mut().unwrap();
        dacl.push(AceFact {
            ace_type: 0x01,
            flags: 0,
            mask: FULL,
            sid: Some(USERS.into()),
        });
        dacl.push(allow("S-1-1-0", READ_EXECUTE, 0));
        assert!(check(&f).is_ok());
    }

    #[test]
    fn a_null_dacl_and_unreadable_aces_refuse() {
        let mut f = facts();
        f.main.as_mut().unwrap().dacl = None;
        assert!(matches!(check(&f), Err(PlacementRefusal::NullDacl { .. })));
        // An object allow ACE (SID not decoded) granting a write right.
        let mut f = facts();
        f.folders[0].dacl.as_mut().unwrap().push(AceFact {
            ace_type: 0x05,
            flags: 0,
            mask: FILE_WRITE_DATA,
            sid: None,
        });
        assert!(matches!(
            check(&f),
            Err(PlacementRefusal::UnreadableAce { ace_type: 5, .. })
        ));
        // A type that does not belong in a DACL (e.g. a mandatory label).
        let mut f = facts();
        f.folders[0].dacl.as_mut().unwrap().push(AceFact {
            ace_type: 0x11,
            flags: 0,
            mask: 0,
            sid: Some("S-1-16-12288".into()),
        });
        assert!(matches!(
            check(&f),
            Err(PlacementRefusal::UnreadableAce { ace_type: 0x11, .. })
        ));
        // An unreadable SID on a read-only grant does not matter.
        let mut f = facts();
        f.folders[0].dacl.as_mut().unwrap().push(AceFact {
            ace_type: 0x05,
            flags: 0,
            mask: READ_EXECUTE,
            sid: None,
        });
        assert!(check(&f).is_ok());
    }

    #[test]
    fn an_empty_dacl_is_fine() {
        // An empty (not NULL) DACL grants nothing.
        let mut f = facts();
        f.folders[1].dacl = Some(vec![]);
        assert!(check(&f).is_ok());
    }
}
