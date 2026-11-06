//! Starts an exe elevated through UAC, waits for it and returns its exit
//! code (`ShellExecuteExW` with the verb `runas` + `SEE_MASK_NOCLOSEPROCESS`,
//! `WaitForSingleObject`, `GetExitCodeProcess`) - ADR-0021 decision 7.
//!
//! Copied from banto-industrial's `crates/banto-service-elev/src/launch.rs`
//! and made generic: no `thiserror` (codes only, the screen builds the text -
//! conventions §13), and a stub off Windows. What the exit code means is the
//! started program's business (for the firewall helper: decision 11, see
//! `firewall_change`). `ERROR_CANCELLED` (1223) from `ShellExecuteExW` is the
//! user declining the UAC prompt ([`LaunchError::is_cancelled`]).
//!
//! Arguments are limited to **tokens** (non-empty, ASCII alphanumerics and
//! `-` only): `ShellExecuteExW` passes them as one command line that the
//! started program's CRT splits again. Without spaces, quotes, `\` or shell
//! metacharacters no difference in the splitting rules can turn one argument
//! into another. The firewall helper's operation names
//! (`firewall-allow` / `firewall-remove`) fit.
//!
//! The caller passes the exe path; this module does not look for it (the
//! firewall helper's path is the one the pre-elevation placement check
//! accepted, next to the main exe under its fixed name - decision 8).

/// `ERROR_CANCELLED`: the user declined the UAC prompt.
pub(crate) const ERROR_CANCELLED: u32 = 1223;

/// Why [`run_elevated`] returned no exit code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LaunchError {
    /// An argument is not a token ([`is_valid_token`]); nothing was started.
    InvalidToken(String),
    /// `ShellExecuteExW` failed (`os error`): [`ERROR_CANCELLED`] when the
    /// UAC prompt was declined, otherwise e.g. the exe is missing.
    ShellExecute(u32),
    /// Started, but no process handle came back.
    #[cfg_attr(not(windows), allow(dead_code))]
    NoProcessHandle,
    /// `WaitForSingleObject` returned something else than `WAIT_OBJECT_0`
    /// and `WAIT_FAILED` (e.g. `WAIT_ABANDONED`): the wait status, which is
    /// not an OS error.
    #[cfg_attr(not(windows), allow(dead_code))]
    Wait(u32),
    /// `WaitForSingleObject` returned `WAIT_FAILED` (`os error` from
    /// `GetLastError`).
    #[cfg_attr(not(windows), allow(dead_code))]
    WaitFailed(u32),
    /// `GetExitCodeProcess` failed (`os error`).
    #[cfg_attr(not(windows), allow(dead_code))]
    ExitCode(u32),
    /// Not Windows: nothing can be elevated.
    #[cfg_attr(windows, allow(dead_code))]
    Unsupported,
}

impl LaunchError {
    /// The user declined the UAC prompt (decision 11: told apart by the
    /// launcher, not by the helper's exit code).
    pub(crate) fn is_cancelled(&self) -> bool {
        *self == Self::ShellExecute(ERROR_CANCELLED)
    }

    /// The OS error code, when there is one.
    pub(crate) fn os_error(&self) -> Option<u32> {
        match self {
            Self::ShellExecute(code) | Self::WaitFailed(code) | Self::ExitCode(code) => Some(*code),
            Self::InvalidToken(_) | Self::NoProcessHandle | Self::Wait(_) | Self::Unsupported => {
                None
            }
        }
    }
}

/// Non-empty and only ASCII alphanumerics and `-` (pure).
pub(crate) fn is_valid_token(token: &str) -> bool {
    !token.is_empty()
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Checks the tokens and joins them with single spaces (pure). The first
/// token that is not one is [`LaunchError::InvalidToken`].
pub(crate) fn parameters_from_tokens(tokens: &[&str]) -> Result<String, LaunchError> {
    if let Some(bad) = tokens.iter().find(|t| !is_valid_token(t)) {
        return Err(LaunchError::InvalidToken((*bad).to_string()));
    }
    Ok(tokens.join(" "))
}

/// `ShellExecuteExW` flags: keep the process handle (to wait on it), and
/// `SEE_MASK_NOASYNC` because the caller is a background thread with no
/// message loop (the docs require it there; without it the launch can end
/// early and a valid request would come back as `launchFailed`).
#[cfg(windows)]
const LAUNCH_MASK: u32 = windows_sys::Win32::UI::Shell::SEE_MASK_NOCLOSEPROCESS
    | windows_sys::Win32::UI::Shell::SEE_MASK_NOASYNC;

/// Initializes COM (STA) on the current thread for the `ShellExecuteExW` call
/// (as its docs recommend) and uninitializes it on drop - only if this call
/// succeeded. Drop it before waiting for the program: the wait pumps no
/// messages.
#[cfg(windows)]
struct ComApartment(bool);

#[cfg(windows)]
impl ComApartment {
    fn init() -> Self {
        use windows_sys::Win32::System::Com::{
            CoInitializeEx, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
        };
        // SAFETY: no reserved pointer; the flags are valid.
        let hr = unsafe {
            CoInitializeEx(
                std::ptr::null(),
                (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
            )
        };
        // S_OK / S_FALSE (already initialized) both count one reference that
        // `CoUninitialize` must release. A failure such as RPC_E_CHANGED_MODE
        // (the thread is already in another mode) added none, so we go on
        // without COM of our own and do not uninitialize.
        Self(hr >= 0)
    }
}

#[cfg(windows)]
impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.0 {
            // SAFETY: pairs the successful `CoInitializeEx` in `init`.
            unsafe { windows_sys::Win32::System::Com::CoUninitialize() };
        }
    }
}

/// Starts `exe` elevated (verb `runas`, `SW_HIDE`) with `tokens` as its
/// arguments, waits until it ends and returns its exit code.
///
/// The calling thread blocks without a time limit - as long as the user
/// leaves the UAC prompt open, then as long as the program runs - so call it
/// from a blocking thread (`spawn_blocking`) and hold no lock meanwhile
/// (decision 13).
#[cfg(windows)]
pub(crate) fn run_elevated(exe: &std::path::Path, tokens: &[&str]) -> Result<u32, LaunchError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, WAIT_FAILED, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, WaitForSingleObject, INFINITE,
    };
    use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SHELLEXECUTEINFOW};
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let parameters = parameters_from_tokens(tokens)?;

    let file: Vec<u16> = exe
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let params: Vec<u16> = parameters
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let verb: Vec<u16> = "runas".encode_utf16().chain(std::iter::once(0)).collect();

    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: LAUNCH_MASK,
        lpVerb: verb.as_ptr(),
        lpFile: file.as_ptr(),
        lpParameters: params.as_ptr(),
        // The helper is a console program: a shown window would be an empty
        // console flashing up. Hiding it does not affect the UAC prompt.
        nShow: SW_HIDE,
        ..Default::default()
    };

    // COM only around the launch call: the STA is released before the wait
    // below, which pumps no messages (`WaitForSingleObject` docs: waiting
    // without pumping on a COM thread can deadlock). `spawn_blocking` threads
    // are reused, so init and uninit must pair.
    let com = ComApartment::init();
    // SAFETY: the strings are NUL-terminated and live for this scope.
    let launched = unsafe { ShellExecuteExW(&mut info) } != 0;
    // SAFETY: only reads why the call just before failed - before
    // `CoUninitialize`, which may overwrite the last error.
    let launch_error = (!launched).then(|| unsafe { GetLastError() });
    drop(com);

    if let Some(code) = launch_error {
        return Err(LaunchError::ShellExecute(code));
    }
    if info.hProcess.is_null() {
        return Err(LaunchError::NoProcessHandle);
    }

    // SAFETY: a valid process handle from `ShellExecuteExW` (closed below).
    let wait = unsafe { WaitForSingleObject(info.hProcess, INFINITE) };
    let result = if wait == WAIT_FAILED {
        // SAFETY: only reads why the call just before failed.
        Err(LaunchError::WaitFailed(unsafe { GetLastError() }))
    } else if wait != WAIT_OBJECT_0 {
        Err(LaunchError::Wait(wait))
    } else {
        let mut exit_code: u32 = 0;
        // SAFETY: a valid handle and a place to write to.
        if unsafe { GetExitCodeProcess(info.hProcess, &mut exit_code) } == 0 {
            // SAFETY: only reads why the call just before failed.
            Err(LaunchError::ExitCode(unsafe { GetLastError() }))
        } else {
            Ok(exit_code)
        }
    };
    // SAFETY: the handle above, closed once.
    unsafe { CloseHandle(info.hProcess) };
    result
}

/// Off Windows nothing is started (the tokens are still checked first).
#[cfg(not(windows))]
pub(crate) fn run_elevated(_exe: &std::path::Path, tokens: &[&str]) -> Result<u32, LaunchError> {
    parameters_from_tokens(tokens)?;
    Err(LaunchError::Unsupported)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Whether the current thread is in a single-threaded apartment (the
    /// process's first STA reports as the main STA; an implicit MTA from other
    /// test threads does not count).
    #[cfg(windows)]
    fn in_sta() -> bool {
        use windows_sys::Win32::System::Com::{CoGetApartmentType, APTTYPE_MAINSTA, APTTYPE_STA};
        let (mut kind, mut qualifier) = (-1, 0);
        // SAFETY: two places to write to.
        let hr = unsafe { CoGetApartmentType(&mut kind, &mut qualifier) };
        hr >= 0 && (kind == APTTYPE_STA || kind == APTTYPE_MAINSTA)
    }

    #[cfg(windows)]
    #[test]
    fn com_apartment_is_left_when_the_guard_drops() {
        // A fresh thread: no apartment before, one while the guard lives, and
        // none again after it drops (so the wait after the launch holds no STA).
        std::thread::spawn(|| {
            assert!(!in_sta());
            let com = ComApartment::init();
            assert!(com.0);
            assert!(in_sta());
            drop(com);
            assert!(!in_sta());
        })
        .join()
        .unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn launch_mask_has_noasync_and_noclose_process() {
        use windows_sys::Win32::UI::Shell::{SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS};
        assert_eq!(LAUNCH_MASK & SEE_MASK_NOASYNC, SEE_MASK_NOASYNC);
        assert_eq!(
            LAUNCH_MASK & SEE_MASK_NOCLOSEPROCESS,
            SEE_MASK_NOCLOSEPROCESS
        );
    }

    #[test]
    fn tokens_accept_the_helper_operations() {
        for good in [
            "firewall-allow",
            "firewall-remove",
            "firewall-status",
            "a",
            "0",
        ] {
            assert!(is_valid_token(good), "{good}");
        }
    }

    #[test]
    fn tokens_reject_anything_that_could_split_or_escape_the_command_line() {
        for bad in [
            "",
            " ",
            "a b",
            "a\tb",
            "\"",
            "a\"b",
            "'",
            "a\\b",
            "C:\\Program Files\\x.exe",
            "a;b",
            "a&b",
            "a|b",
            "a^b",
            "%PATH%",
            "a>b",
            "a<b",
            "a\nb",
            "a\0b",
            "a_b",
            "a.b",
            "a/b",
            "a=b",
            "ａ",
            "é",
        ] {
            assert!(!is_valid_token(bad), "{bad:?}");
        }
    }

    #[test]
    fn parameters_join_valid_tokens_with_single_spaces() {
        assert_eq!(parameters_from_tokens(&[]).unwrap(), "");
        assert_eq!(
            parameters_from_tokens(&["firewall-allow"]).unwrap(),
            "firewall-allow"
        );
        assert_eq!(parameters_from_tokens(&["a-b", "c"]).unwrap(), "a-b c");
    }

    #[test]
    fn parameters_reject_the_first_bad_token() {
        assert_eq!(
            parameters_from_tokens(&["firewall-allow", "x y", "x\"y"]),
            Err(LaunchError::InvalidToken("x y".to_string()))
        );
    }

    #[test]
    fn only_error_cancelled_from_shell_execute_is_a_cancel() {
        assert!(LaunchError::ShellExecute(ERROR_CANCELLED).is_cancelled());
        assert!(!LaunchError::ShellExecute(2).is_cancelled());
        assert!(!LaunchError::Wait(ERROR_CANCELLED).is_cancelled());
        assert!(!LaunchError::WaitFailed(ERROR_CANCELLED).is_cancelled());
        assert!(!LaunchError::ExitCode(ERROR_CANCELLED).is_cancelled());
        assert_eq!(LaunchError::ShellExecute(5).os_error(), Some(5));
        assert_eq!(LaunchError::NoProcessHandle.os_error(), None);
        // WAIT_FAILED carries GetLastError; other wait statuses are no OS error.
        assert_eq!(LaunchError::WaitFailed(6).os_error(), Some(6));
        assert_eq!(LaunchError::Wait(0xffff_ffff).os_error(), None);
        assert_eq!(LaunchError::Wait(0x80).os_error(), None);
    }

    /// A malformed argument starts nothing (`ShellExecuteExW` is not reached).
    #[test]
    fn run_elevated_rejects_bad_tokens_without_launching() {
        let exe = std::path::Path::new("Z:\\does-not-exist\\never-launched.exe");
        assert_eq!(
            run_elevated(exe, &["firewall-allow", "\" & calc"]),
            Err(LaunchError::InvalidToken("\" & calc".to_string()))
        );
    }
}
