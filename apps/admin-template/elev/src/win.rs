//! The Windows side: collects decision 8's facts from the OS and runs the
//! PowerShell scripts (decision 9). The judgements are in
//! [`crate::placement`] / [`crate::rules`]; nothing here decides.
//!
//! Facts are read through handles: each object is opened first
//! (`CreateFileW` with `FILE_FLAG_OPEN_REPARSE_POINT`, so a link is opened as
//! itself and shows its reparse attribute, and `FILE_FLAG_BACKUP_SEMANTICS`
//! for folders) and its final path, attributes, owner and DACL all come from
//! that handle. The main exe's path - the rule's `Program` - is its handle's
//! final path. The handles ask only `READ_CONTROL | FILE_READ_ATTRIBUTES` and
//! share everything (an ordinary user can run the same check before asking
//! for elevation, E2).
//!
//! ACEs are read with `GetAce` in DACL order. The SID is decoded for the
//! plain ACE layouts (`ACCESS_ALLOWED` / `DENIED` and their `CALLBACK`
//! variants); the object ACE layouts keep `sid: None`, which the judgement
//! refuses when the ACE grants a write right (file systems do not use them).

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use windows_sys::core::{GUID, PWSTR};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, HANDLE,
    INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, GetSecurityInfo, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    GetAce, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, DACL_SECURITY_INFORMATION,
    OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, GetFileInformationByHandle, GetFinalPathNameByHandleW, BY_HANDLE_FILE_INFORMATION,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_NAME_NORMALIZED,
    FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    READ_CONTROL, VOLUME_NAME_DOS,
};
use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::System::SystemInformation::{
    GetSystemDirectoryW, GetSystemWindowsDirectoryW,
};
use windows_sys::Win32::UI::Shell::{
    FOLDERID_ProgramFiles, FOLDERID_ProgramFilesX86, SHGetKnownFolderPath,
};

use crate::placement::{self, AceFact, InstalledFacts, ObjectFacts, PlacementFacts};
use crate::powershell::{self, PowerShellPaths};
use crate::rules::{RuleNames, RuleSnapshot, RuleSpec};
use crate::{FirewallOps, PlacementProbe, HELPER_EXE_FILE_NAME, MAIN_EXE_FILE_NAME};

/// How long one PowerShell run may take (start + NetSecurity's first load
/// took over 10 s on a cold machine in stage 1, PR #465).
const POWERSHELL_TIMEOUT: Duration = Duration::from_secs(60);
/// Upper bound on what is read from the child's stdout / stderr.
const MAX_OUTPUT: u64 = 256 * 1024;

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// An open handle, closed on drop.
struct Handle(HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: `self.0` is a handle this module opened and still owns.
        unsafe { CloseHandle(self.0) };
    }
}

/// Opens `path` (a normalized `C:\...` path) for reading its attributes and
/// security, without following a final reparse point. `Ok(None)` when it
/// does not exist.
fn open(path: &str) -> Result<Option<Handle>, String> {
    // `\\?\`: no further normalization, no MAX_PATH limit.
    let name = wide(&format!(r"\\?\{path}"));
    // SAFETY: `name` is NUL-terminated and outlives the call; no security
    // attributes or template.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            READ_CONTROL | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        // SAFETY: reads this thread's last error.
        let error = unsafe { GetLastError() };
        if error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND {
            return Ok(None);
        }
        return Err(format!("could not open {path} (error {error})"));
    }
    Ok(Some(Handle(handle)))
}

/// The handle's final path, normalized (`placement::normalize_final_path`).
fn final_path(handle: &Handle) -> Result<String, String> {
    let mut buf = vec![0u16; 512];
    loop {
        // SAFETY: `buf` has `buf.len()` writable elements.
        let len = unsafe {
            GetFinalPathNameByHandleW(
                handle.0,
                buf.as_mut_ptr(),
                buf.len() as u32,
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
            )
        } as usize;
        if len == 0 {
            // SAFETY: reads this thread's last error.
            let error = unsafe { GetLastError() };
            return Err(format!("GetFinalPathNameByHandleW failed (error {error})"));
        }
        if len < buf.len() {
            let raw = String::from_utf16(&buf[..len])
                .map_err(|_| "a final path is not valid UTF-16".to_string())?;
            return placement::normalize_final_path(&raw)
                .ok_or_else(|| format!("not a plain drive path: {raw}"));
        }
        // Too small: `len` is the size needed, NUL included.
        buf.resize(len + 1, 0);
    }
}

fn attributes(handle: &Handle) -> Result<u32, String> {
    // SAFETY: an all-zero BY_HANDLE_FILE_INFORMATION is a valid value to be
    // overwritten.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: `info` is a valid out pointer.
    if unsafe { GetFileInformationByHandle(handle.0, &mut info) } == 0 {
        // SAFETY: reads this thread's last error.
        let error = unsafe { GetLastError() };
        return Err(format!("GetFileInformationByHandle failed (error {error})"));
    }
    Ok(info.dwFileAttributes)
}

/// A SID as its string form (`S-1-5-...`).
///
/// # Safety
/// `sid` must point to a valid SID.
unsafe fn sid_string(sid: PSID) -> Result<String, String> {
    let mut text: PWSTR = std::ptr::null_mut();
    // SAFETY: the caller guarantees `sid`; `text` is a valid out pointer.
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 || text.is_null() {
        return Err("ConvertSidToStringSidW failed".into());
    }
    let mut len = 0;
    // SAFETY: a successful call returns a NUL-terminated string.
    while unsafe { *text.add(len) } != 0 {
        len += 1;
    }
    // SAFETY: `len` characters were read above.
    let result = String::from_utf16(unsafe { std::slice::from_raw_parts(text, len) })
        .map_err(|_| "a SID string is not valid UTF-16".to_string());
    // SAFETY: `text` was allocated by ConvertSidToStringSidW with LocalAlloc.
    unsafe { LocalFree(text as _) };
    result
}

/// The ACEs of `acl` in order.
///
/// # Safety
/// `acl` must point to a valid ACL.
unsafe fn read_aces(acl: *const ACL) -> Result<Vec<AceFact>, String> {
    // SAFETY: the caller guarantees `acl`.
    let count = unsafe { (*acl).AceCount };
    let mut aces = Vec::with_capacity(count as usize);
    for index in 0..u32::from(count) {
        let mut ace: *mut core::ffi::c_void = std::ptr::null_mut();
        // SAFETY: `index` < AceCount; `ace` is a valid out pointer.
        if unsafe { GetAce(acl, index, &mut ace) } == 0 || ace.is_null() {
            return Err(format!("GetAce({index}) failed"));
        }
        // SAFETY: every ACE starts with an ACE_HEADER.
        let header = unsafe { *(ace as *const ACE_HEADER) };
        let plain = matches!(header.AceType, 0x00 | 0x01 | 0x09 | 0x0A);
        let object = matches!(header.AceType, 0x05 | 0x06 | 0x0B | 0x0C);
        let (mask, sid) = if plain {
            let allowed = ace as *const ACCESS_ALLOWED_ACE;
            // SAFETY: the plain layouts are ACE_HEADER, Mask, SID (the same
            // as ACCESS_ALLOWED_ACE); `SidStart` is where the SID begins.
            let mask = unsafe { (*allowed).Mask };
            // SAFETY: as above.
            let sid_ptr = unsafe { std::ptr::addr_of!((*allowed).SidStart) } as PSID;
            // SAFETY: points into the ACE's SID.
            (mask, Some(unsafe { sid_string(sid_ptr) }?))
        } else if object {
            // SAFETY: the object layouts start ACE_HEADER, Mask as well.
            (unsafe { (*(ace as *const ACCESS_ALLOWED_ACE)).Mask }, None)
        } else {
            (0, None)
        };
        aces.push(AceFact {
            ace_type: header.AceType,
            flags: header.AceFlags,
            mask,
            sid,
        });
    }
    Ok(aces)
}

/// The owner (string SID) and DACL (`None` = NULL DACL) of the handle.
fn security(handle: &Handle) -> Result<(String, Option<Vec<AceFact>>), String> {
    let mut owner: PSID = std::ptr::null_mut();
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: valid out pointers; the group and SACL are not asked for.
    let error = unsafe {
        GetSecurityInfo(
            handle.0,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if error != 0 {
        return Err(format!("GetSecurityInfo failed (error {error})"));
    }
    let result = (|| {
        if owner.is_null() {
            return Err("no owner".to_string());
        }
        // SAFETY: `owner` points into `descriptor`, alive until LocalFree.
        let owner = unsafe { sid_string(owner) }?;
        let aces = if dacl.is_null() {
            None
        } else {
            // SAFETY: `dacl` points into `descriptor`, alive until LocalFree.
            Some(unsafe { read_aces(dacl) }?)
        };
        Ok((owner, aces))
    })();
    // SAFETY: `descriptor` was allocated by GetSecurityInfo with LocalAlloc.
    unsafe { LocalFree(descriptor as _) };
    result
}

/// Everything about one object, read from its handle. `Ok(None)` when it
/// does not exist.
fn object_facts(path: &str) -> Result<Option<ObjectFacts>, String> {
    let Some(handle) = open(path)? else {
        return Ok(None);
    };
    let (owner_sid, dacl) = security(&handle)?;
    Ok(Some(ObjectFacts {
        path: final_path(&handle)?,
        attributes: attributes(&handle)?,
        owner_sid,
        dacl,
    }))
}

/// A known folder's path (from the OS settings, not the environment).
fn known_folder(id: &GUID) -> Result<String, String> {
    let mut path: PWSTR = std::ptr::null_mut();
    // SAFETY: `id` is a valid GUID; `path` is freed with CoTaskMemFree in
    // every case.
    let hr = unsafe { SHGetKnownFolderPath(id, 0, std::ptr::null_mut(), &mut path) };
    let result = if hr >= 0 && !path.is_null() {
        let mut len = 0;
        // SAFETY: a successful call returns a NUL-terminated string.
        while unsafe { *path.add(len) } != 0 {
            len += 1;
        }
        // SAFETY: `len` characters were read above.
        String::from_utf16(unsafe { std::slice::from_raw_parts(path, len) })
            .map_err(|_| "a known folder path is not valid UTF-16".to_string())
    } else {
        Err(format!("SHGetKnownFolderPath failed (HRESULT {hr:#010x})"))
    };
    // SAFETY: `path` is SHGetKnownFolderPath's allocation or null.
    unsafe { CoTaskMemFree(path as *const core::ffi::c_void) };
    result
}

/// The Program Files known folders, each resolved to its final path through
/// a handle (so they compare with the exes' final paths). Folders that
/// cannot be read are left out.
pub fn program_files_dirs() -> Vec<String> {
    [&FOLDERID_ProgramFiles, &FOLDERID_ProgramFilesX86]
        .into_iter()
        .filter_map(|id| known_folder(id).ok())
        .filter_map(|path| placement::normalize_final_path(&path))
        .filter_map(|path| open(&path).ok().flatten())
        .filter_map(|handle| final_path(&handle).ok())
        .fold(Vec::new(), |mut dirs, dir| {
            if !dirs.iter().any(|d| placement::same_path(d, &dir)) {
                dirs.push(dir);
            }
            dirs
        })
}

/// Decision 8's facts for the installation `anchor` (a running exe: the
/// helper's own, or the main app's in E2) belongs to: the two fixed-name
/// exes next to the anchor's final path, and every folder from there up to
/// the Program Files known folder. No path from the environment, the CWD or
/// arguments is used.
pub fn collect_placement_facts(anchor: &Path) -> Result<PlacementFacts, String> {
    let anchor = anchor
        .to_str()
        .and_then(placement::normalize_final_path)
        .ok_or("the running exe's path is not a plain drive path")?;
    let anchor = object_facts(&anchor)?.ok_or("the running exe could not be found")?;
    let dir = placement::parent(&anchor.path)
        .ok_or("the running exe has no folder")?
        .to_string();
    let next_to = |name: &str| object_facts(&format!(r"{}\{name}", dir.trim_end_matches('\\')));
    let program_files = program_files_dirs();
    let mut folders = Vec::new();
    if let Some(chain) = placement::containing_program_files(&anchor.path, &program_files)
        .and_then(|pf| placement::folder_chain(&anchor.path, pf))
    {
        for folder in chain {
            folders.push(object_facts(&folder)?.ok_or(format!("{folder} is gone"))?);
        }
    }
    Ok(PlacementFacts {
        anchor: anchor.path,
        program_files,
        helper: next_to(HELPER_EXE_FILE_NAME)?,
        main: next_to(MAIN_EXE_FILE_NAME)?,
        folders,
    })
}

/// The facts for the uninstaller's `firewall-remove-installed`
/// (`crate::run_remove_installed`): the fixed-name main exe in
/// `install_dir`, read through its handle like every other object (its
/// final path is the rule's `Program`). `install_dir` must be a plain drive
/// path.
pub fn collect_installed_facts(install_dir: &str) -> Result<InstalledFacts, String> {
    let dir = placement::normalize_final_path(install_dir)
        .ok_or("the install folder is not a plain drive path")?;
    Ok(InstalledFacts {
        program_files: program_files_dirs(),
        main: object_facts(&format!(
            r"{}\{MAIN_EXE_FILE_NAME}",
            dir.trim_end_matches('\\')
        ))?,
    })
}

/// The helper's own [`PlacementProbe`]: anchored at `current_exe()`.
pub struct CurrentExeProbe;

impl PlacementProbe for CurrentExeProbe {
    fn placement_facts(&self) -> Result<PlacementFacts, String> {
        let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
        collect_placement_facts(&exe)
    }
}

/// A directory from `GetSystemDirectoryW` / `GetSystemWindowsDirectoryW`.
fn directory(get: unsafe extern "system" fn(PWSTR, u32) -> u32) -> Result<String, String> {
    let mut buf = vec![0u16; 260];
    loop {
        // SAFETY: `buf` has `buf.len()` writable elements.
        let len = unsafe { get(buf.as_mut_ptr(), buf.len() as u32) } as usize;
        if len == 0 {
            return Err("the system directory could not be read".into());
        }
        if len < buf.len() {
            return String::from_utf16(&buf[..len])
                .map_err(|_| "the system directory is not valid UTF-16".into());
        }
        buf.resize(len + 1, 0);
    }
}

/// The system directory (`C:\Windows\System32`).
pub fn system_directory() -> Result<String, String> {
    directory(GetSystemDirectoryW)
}

/// The Windows directory (`C:\Windows`).
pub fn windows_directory() -> Result<String, String> {
    directory(GetSystemWindowsDirectoryW)
}

/// What a PowerShell run returned.
struct RunOutput {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Runs `script` in the in-box Windows PowerShell with a rebuilt minimal
/// environment, the system directory as its working directory, and a time
/// limit.
fn run_powershell(script: &str) -> Result<RunOutput, String> {
    let system = system_directory()?;
    let windows = windows_directory()?;
    let paths = powershell::powershell_paths(&system);
    let mut child = Command::new(&paths.exe)
        .args(powershell::arguments(script))
        .env_clear()
        .envs(powershell::child_environment(&system, &windows))
        .current_dir(&system)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("powershell.exe could not be started: {e}"))?;
    let reader = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut text = Vec::new();
            if let Some(pipe) = pipe {
                let _ = pipe.take(MAX_OUTPUT).read_to_end(&mut text);
            }
            String::from_utf8_lossy(&text).into_owned()
        })
    };
    let stdout = reader(child.stdout.take().map(|p| Box::new(p) as _));
    let stderr = reader(child.stderr.take().map(|p| Box::new(p) as _));
    let deadline = Instant::now() + POWERSHELL_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("PowerShell did not finish in time".into());
            }
            Err(e) => return Err(format!("waiting for PowerShell failed: {e}")),
        }
    };
    Ok(RunOutput {
        code: status.code(),
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

/// Runs a script that must exit 0.
fn run_checked(script: Option<String>) -> Result<String, String> {
    let script = script.ok_or("a value could not be written into the script")?;
    let out = run_powershell(&script)?;
    if out.code != Some(0) {
        let detail = out.stderr.lines().next().unwrap_or("").trim().to_string();
        return Err(format!("PowerShell exited with {:?}: {detail}", out.code));
    }
    Ok(out.stdout)
}

/// [`FirewallOps`] through the fixed PowerShell scripts.
pub struct PowerShellFirewall {
    paths: PowerShellPaths,
}

impl PowerShellFirewall {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            paths: powershell::powershell_paths(&system_directory()?),
        })
    }
}

impl FirewallOps for PowerShellFirewall {
    fn query(&self, names: &RuleNames) -> Result<RuleSnapshot, String> {
        let stdout = run_checked(powershell::query_script(&self.paths, names))?;
        powershell::parse_query_output(&stdout)
    }

    fn create(&self, spec: &RuleSpec) -> Result<(), String> {
        run_checked(powershell::create_script(&self.paths, spec)).map(|_| ())
    }

    fn remove(&self, names: &RuleNames) -> Result<(), String> {
        run_checked(powershell::remove_script(&self.paths, names)).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Read-only: the system directories and the Program Files known folders
    /// resolve to plain drive paths. Changes nothing.
    #[test]
    fn directories_and_known_folders_resolve() {
        let system = system_directory().unwrap();
        assert!(system.to_lowercase().ends_with(r"\system32"), "{system}");
        assert!(!windows_directory().unwrap().is_empty());
        let dirs = program_files_dirs();
        assert!(!dirs.is_empty(), "{dirs:?}");
        assert!(dirs
            .iter()
            .all(|d| placement::normalize_final_path(d).is_some()));
    }

    /// Read-only: facts of a real folder are read through its handle.
    #[test]
    fn facts_of_a_system_folder_are_read() {
        let system = system_directory().unwrap();
        let facts = object_facts(&system).unwrap().unwrap();
        assert!(placement::same_path(&facts.path, &system));
        assert_ne!(facts.attributes & placement::ATTRIBUTE_DIRECTORY, 0);
        assert!(facts.owner_sid.starts_with("S-1-"));
        assert!(facts.dacl.is_some_and(|aces| !aces.is_empty()));
        assert_eq!(
            object_facts(&format!(r"{system}\no-such-file.banto")),
            Ok(None)
        );
    }

    /// Read-only: a test binary (under `target\`, not Program Files) is not
    /// a trusted placement - and the check gets that far without failing.
    #[test]
    fn the_test_binary_is_not_a_trusted_placement() {
        let facts = CurrentExeProbe.placement_facts().unwrap();
        assert!(facts.helper.is_none() || facts.folders.is_empty());
        assert!(
            placement::check_placement(&facts, HELPER_EXE_FILE_NAME, MAIN_EXE_FILE_NAME).is_err()
        );
    }
}
