//! Dates and times as canonical strings (docs/design/date-time-pickers.md
//! §5.1 / §5.3 / §5.6, PR-5): the checks a resource's validation runs on a
//! `date`, `time` or `datetime` field, mirroring the frontend's
//! `validateField` (`@banto/forms`) and the grid's column validator.
//!
//! - A date is `YYYY-MM-DD` (years 0001-9999, a real calendar day), a time
//!   `HH:mm` (00:00-23:59, no seconds), a date and time `YYYY-MM-DDTHH:mm` - a
//!   wall-clock time with no time zone (D4). All are stored as TEXT (D16).
//! - Only the canonical forms are accepted here: lenient parsing (`2026/11/7`,
//!   full-width digits) is the UI's and the CSV import's job (§5.3).
//! - Fixed width, so string order = time order: `min` / `max` are string
//!   comparisons, like the frontend. The validators need no day-number
//!   arithmetic; the formatters at the bottom (`SystemTime` / epoch days ->
//!   text) are the one place that uses `chrono` (ADR-0029).
//! - The `validate_*` functions return the same default (Japanese) message as
//!   the frontend, in the same rule order (format, min, max, step); the
//!   frontend's `isDateDisabled` has no Rust counterpart (a resource writes
//!   that rule itself). Both sides run the edge cases in
//!   `tests/datetime-cases.json`.
//!
//! An empty value is the caller's to handle (`null` in the frontend, D6): an
//! empty string is not a valid date / time here.

use std::time::SystemTime;

use chrono::{DateTime, Datelike, NaiveDate, NaiveDateTime, NaiveTime, Timelike};

const MIN_YEAR: u32 = 1;
const MAX_YEAR: u32 = 9999;

fn is_leap_year(year: u32) -> bool {
    (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        2 if is_leap_year(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// `n` ASCII digits as a number (`None` when `s` is not exactly that).
fn digits(s: &str, n: usize) -> Option<u32> {
    if s.len() != n || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// Is `value` a canonical `YYYY-MM-DD` real calendar day (0001-01-01 to 9999-12-31)?
pub fn is_iso_date(value: &str) -> bool {
    let mut parts = value.split('-');
    let (Some(y), Some(m), Some(d), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    let (Some(year), Some(month), Some(day)) = (digits(y, 4), digits(m, 2), digits(d, 2)) else {
        return false;
    };
    (MIN_YEAR..=MAX_YEAR).contains(&year)
        && (1..=12).contains(&month)
        && day >= 1
        && day <= days_in_month(year, month)
}

/// Minutes since 00:00 of a canonical `HH:mm` (00:00-23:59), else `None`.
fn time_minutes(value: &str) -> Option<u32> {
    let (h, m) = value.split_once(':')?;
    let (hour, minute) = (digits(h, 2)?, digits(m, 2)?);
    (hour <= 23 && minute <= 59).then_some(hour * 60 + minute)
}

/// Is `value` a canonical `HH:mm` (00:00-23:59, no seconds)?
pub fn is_iso_time(value: &str) -> bool {
    time_minutes(value).is_some()
}

/// The date and time of a canonical `YYYY-MM-DDTHH:mm`, else `None`.
fn split_datetime(value: &str) -> Option<(&str, &str)> {
    let (date, time) = value.split_once('T')?;
    (is_iso_date(date) && is_iso_time(time)).then_some((date, time))
}

/// Is `value` a canonical `YYYY-MM-DDTHH:mm` (a real day, 00:00-23:59, no
/// seconds, no offset)?
pub fn is_iso_datetime(value: &str) -> bool {
    split_datetime(value).is_some()
}

/// Is the canonical `HH:mm` `time` on the `step`-minute grid counted from
/// 00:00 (D8)? `None` or `Some(0)` is no step (always true); a time that is
/// not canonical is never on it.
pub fn is_on_time_step(time: &str, step: Option<u32>) -> bool {
    match step {
        None | Some(0) => true,
        Some(step) => time_minutes(time).is_some_and(|minutes| minutes % step == 0),
    }
}

/// `2026-11-07T09:30` as shown in messages: `2026-11-07 09:30`.
fn shown_datetime(value: &str) -> String {
    value.replacen('T', " ", 1)
}

/// Check a `date` field's canonical value against inclusive bounds. Returns
/// the error message (the frontend's default), or `None` when valid.
pub fn validate_date(value: &str, min: Option<&str>, max: Option<&str>) -> Option<String> {
    if !is_iso_date(value) {
        return Some("日付を YYYY-MM-DD の形で入力してください".to_string());
    }
    if let Some(min) = min.filter(|min| value < *min) {
        return Some(format!("{min}以降の日付を入力してください"));
    }
    if let Some(max) = max.filter(|max| value > *max) {
        return Some(format!("{max}以前の日付を入力してください"));
    }
    None
}

fn step_message(step: u32) -> String {
    format!("{step}分刻みの時刻を入力してください")
}

/// Check a `time` field's canonical value against inclusive bounds and the
/// step in minutes (`None` / `Some(0)`: any minute). Returns the error
/// message (the frontend's default), or `None` when valid.
pub fn validate_time(
    value: &str,
    min: Option<&str>,
    max: Option<&str>,
    step: Option<u32>,
) -> Option<String> {
    if !is_iso_time(value) {
        return Some("時刻を HH:mm の形で入力してください".to_string());
    }
    if let Some(min) = min.filter(|min| value < *min) {
        return Some(format!("{min}以降の時刻を入力してください"));
    }
    if let Some(max) = max.filter(|max| value > *max) {
        return Some(format!("{max}以前の時刻を入力してください"));
    }
    if !is_on_time_step(value, step) {
        return step.map(step_message);
    }
    None
}

/// Check a `datetime` field's canonical value against inclusive bounds and
/// the step of its time in minutes (`None` / `Some(0)`: any minute). Returns
/// the error message (the frontend's default; bounds shown with a space), or
/// `None` when valid.
pub fn validate_datetime(
    value: &str,
    min: Option<&str>,
    max: Option<&str>,
    step: Option<u32>,
) -> Option<String> {
    let Some((_, time)) = split_datetime(value) else {
        return Some("日時を YYYY-MM-DD HH:mm の形で入力してください".to_string());
    };
    if let Some(min) = min.filter(|min| value < *min) {
        return Some(format!(
            "{}以降の日時を入力してください",
            shown_datetime(min)
        ));
    }
    if let Some(max) = max.filter(|max| value > *max) {
        return Some(format!(
            "{}以前の日時を入力してください",
            shown_datetime(max)
        ));
    }
    if !is_on_time_step(time, step) {
        return step.map(step_message);
    }
    None
}

// --- Formatting ---------------------------------------------------------
//
// `SystemTime` / epoch days -> canonical text, the one shared implementation
// (ADR-0029; it replaced three hand-written `civil_from_days` ports). None of
// these panics: `chrono`'s `Option`-returning constructors are used so an
// out-of-range value (a file mtime is an external input) falls back to the
// UNIX epoch, like a time before the epoch always did.

/// Days from chrono's day 1 (0001-01-01) to 1970-01-01.
const DAYS_FROM_CE_TO_UNIX_EPOCH: i64 = 719_163;

/// Whole seconds since the UNIX epoch; a time before it counts as the epoch,
/// and the sub-second part is dropped.
fn unix_secs(time: SystemTime) -> i64 {
    time.duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_secs()).ok())
        .unwrap_or(0)
}

/// `time` as a UTC date and time of day (the epoch when out of chrono's range).
fn utc_naive(time: SystemTime) -> NaiveDateTime {
    DateTime::from_timestamp(unix_secs(time), 0)
        .unwrap_or(DateTime::UNIX_EPOCH)
        .naive_utc()
}

/// `YYYY-MM-DD` (a year past 9999 keeps its extra digits, as before).
fn format_date(date: NaiveDate) -> String {
    format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day())
}

/// `HH:MM:SS`.
fn format_time(time: NaiveTime) -> String {
    format!(
        "{:02}:{:02}:{:02}",
        time.hour(),
        time.minute(),
        time.second()
    )
}

/// Days since 1970-01-01 -> `YYYY-MM-DD` (`-1` is `1969-12-31`). A day count
/// outside chrono's range gives `1970-01-01`.
pub fn iso_date_from_days_since_epoch(days: i64) -> String {
    let date = days
        .checked_add(DAYS_FROM_CE_TO_UNIX_EPOCH)
        .and_then(|d| i32::try_from(d).ok())
        .and_then(NaiveDate::from_num_days_from_ce_opt)
        .unwrap_or_else(|| DateTime::UNIX_EPOCH.date_naive());
    format_date(date)
}

/// `SystemTime` -> `"YYYY-MM-DD HH:MM:SS"` (UTC): exactly the text SQLite's
/// `datetime('now')` produces. A time before the epoch (or out of range) is
/// the epoch; fractions of a second are dropped.
pub fn iso_datetime_from_system_time(time: SystemTime) -> String {
    let t = utc_naive(time);
    format!("{} {}", format_date(t.date()), format_time(t.time()))
}

/// `SystemTime` -> `"YYYY-MM-DDTHH:MM:SSZ"` (UTC, ISO 8601). Same range rules
/// as [`iso_datetime_from_system_time`].
pub fn iso8601_utc_from_system_time(time: SystemTime) -> String {
    let t = utc_naive(time);
    format!("{}T{}Z", format_date(t.date()), format_time(t.time()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn at(secs: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(secs)
    }

    #[test]
    fn formats_the_epoch_and_known_values() {
        assert_eq!(
            iso_datetime_from_system_time(SystemTime::UNIX_EPOCH),
            "1970-01-01 00:00:00"
        );
        assert_eq!(
            iso8601_utc_from_system_time(SystemTime::UNIX_EPOCH),
            "1970-01-01T00:00:00Z"
        );
        assert_eq!(
            iso_datetime_from_system_time(at(86_400 + 3661)),
            "1970-01-02 01:01:01"
        );
        assert_eq!(
            iso8601_utc_from_system_time(at(86_400 + 3661)),
            "1970-01-02T01:01:01Z"
        );
        // 2026-07-02 12:34:56 UTC = 20636 days + 45296 s.
        assert_eq!(
            iso_datetime_from_system_time(at(20_636 * 86_400 + 45_296)),
            "2026-07-02 12:34:56"
        );
        assert_eq!(
            iso_datetime_from_system_time(at(86_399)),
            "1970-01-01 23:59:59"
        );
    }

    #[test]
    fn formats_leap_day_boundaries() {
        // 2024-02-29 (divisible by 4, not by 100) and 2000-02-29 (by 400).
        assert_eq!(
            iso8601_utc_from_system_time(at(19_782 * 86_400)),
            "2024-02-29T00:00:00Z"
        );
        assert_eq!(
            iso8601_utc_from_system_time(at(11_016 * 86_400)),
            "2000-02-29T00:00:00Z"
        );
        assert_eq!(iso_date_from_days_since_epoch(19_782), "2024-02-29");
        assert_eq!(iso_date_from_days_since_epoch(19_783), "2024-03-01");
        // 2100-03-01 follows 2100-02-28 (2100 is not a leap year).
        assert_eq!(iso_date_from_days_since_epoch(47_541), "2100-03-01");
    }

    #[test]
    fn drops_the_fraction_of_a_second() {
        let t = SystemTime::UNIX_EPOCH + Duration::from_millis(1_999);
        assert_eq!(iso_datetime_from_system_time(t), "1970-01-01 00:00:01");
        assert_eq!(iso8601_utc_from_system_time(t), "1970-01-01T00:00:01Z");
    }

    #[test]
    fn a_time_before_the_epoch_is_the_epoch() {
        let t = SystemTime::UNIX_EPOCH - Duration::from_secs(90_000);
        assert_eq!(iso_datetime_from_system_time(t), "1970-01-01 00:00:00");
        assert_eq!(iso8601_utc_from_system_time(t), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn an_extreme_time_does_not_panic_and_falls_back_to_the_epoch() {
        // Far beyond chrono's year range (~262143), and beyond i64 seconds.
        for secs in [u64::MAX, i64::MAX as u64, 1u64 << 50] {
            let t = SystemTime::UNIX_EPOCH.checked_add(Duration::from_secs(secs));
            // Some platforms cannot even represent the instant; only check
            // the ones that can.
            if let Some(t) = t {
                assert_eq!(iso_datetime_from_system_time(t), "1970-01-01 00:00:00");
                assert_eq!(iso8601_utc_from_system_time(t), "1970-01-01T00:00:00Z");
            }
        }
    }

    #[test]
    fn epoch_days_to_a_date() {
        assert_eq!(iso_date_from_days_since_epoch(0), "1970-01-01");
        assert_eq!(iso_date_from_days_since_epoch(1), "1970-01-02");
        assert_eq!(iso_date_from_days_since_epoch(-1), "1969-12-31");
        assert_eq!(iso_date_from_days_since_epoch(-365), "1969-01-01");
        // 2026-07-02, the demo seed's fixed "today".
        assert_eq!(iso_date_from_days_since_epoch(20_636), "2026-07-02");
        // Out of range never panics.
        assert_eq!(iso_date_from_days_since_epoch(i64::MAX), "1970-01-01");
        assert_eq!(iso_date_from_days_since_epoch(i64::MIN), "1970-01-01");
    }

    #[test]
    fn leap_years_follow_the_gregorian_rule() {
        assert!(is_iso_date("2024-02-29"));
        assert!(is_iso_date("2000-02-29"));
        assert!(!is_iso_date("1900-02-29"));
        assert!(!is_iso_date("2025-02-29"));
    }

    #[test]
    fn non_ascii_digits_are_refused() {
        // `str::parse` would not take them either, but the length check is
        // in bytes: a multi-byte digit must not slip through.
        assert!(!is_iso_time("０9:30"));
        assert!(!is_iso_date("２０２６-11-07"));
    }

    #[test]
    fn signs_are_refused() {
        assert!(!is_iso_time("+9:30"));
        assert!(!is_iso_date("+026-11-07"));
    }

    #[test]
    fn a_bound_that_is_not_canonical_is_still_compared_as_a_string() {
        // Like the frontend (`value < min` on strings).
        assert_eq!(
            validate_time("09:00", Some("9:00"), None, None).as_deref(),
            Some("9:00以降の時刻を入力してください")
        );
    }
}
