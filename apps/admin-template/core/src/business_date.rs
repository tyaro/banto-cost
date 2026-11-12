//! The business date and the company's fiscal calendar (banto-cost P8d,
//! design §8・§10.1, review §8-5・§8-12).
//!
//! Every "today" the services use (a forecast's base date, a budget draft's
//! date, a settlement / reopening date, the date a calc-basis value is read
//! on) comes from [`today`], in the company's time zone
//! ([`BusinessTimeZone::COMPANY_DEFAULT`], Asia/Tokyo) - not from the
//! database's or the OS's local time, which made a server in UTC treat the
//! morning before 9:00 as the previous day.
//!
//! [`calendar`] is what `GET /api/calendar` / Tauri `business_calendar_get`
//! return, so the screens take the period numbers and today's date from the
//! server instead of repeating the company's numbers in TypeScript.

use chrono::Utc;
use cost_domain::{BusinessTimeZone, Date, FiscalCalendar, YearMonth};
use serde::Serialize;

/// The company's time zone (one company: the constant, like the fiscal year).
pub const TIME_ZONE: BusinessTimeZone = BusinessTimeZone::COMPANY_DEFAULT;
/// The company's fiscal year (6月開始、第13期 = 2026年6月〜2027年5月).
pub const FISCAL: FiscalCalendar = FiscalCalendar::COMPANY_DEFAULT;

/// How many periods after the current one [`calendar`] lists (every period
/// from 第1期 up to the current one is listed, so old periods stay reachable).
const PERIODS_AFTER: i32 = 1;

fn unix_now() -> i64 {
    Utc::now().timestamp()
}

/// The business date today, in the company's time zone.
pub fn today() -> Date {
    TIME_ZONE.date_at(unix_now())
}

/// The local date and time now (`YYYY-MM-DD HH:MM:SS`, a report's output time).
pub fn now_local() -> String {
    TIME_ZONE.date_time_at(unix_now())
}

/// One fiscal period, for the period pickers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FiscalPeriod {
    pub period: i32,
    /// `第13期（2026年6月〜2027年5月）`.
    pub label: String,
    /// `YYYY-MM`.
    pub first_month: String,
    /// `YYYY-MM`.
    pub last_month: String,
}

/// The business calendar the screens read once per session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BusinessCalendar {
    /// The business date today (`YYYY-MM-DD`).
    pub today: String,
    /// The server's clock when this was made (UNIX milliseconds). The screens
    /// count from it instead of the device's clock, which may be off.
    pub now_ms: i64,
    /// The time zone's name (`Asia/Tokyo`).
    pub time_zone: String,
    /// Its fixed offset from UTC in minutes (no daylight saving).
    pub utc_offset_minutes: i32,
    /// The first month of a fiscal year (1-12).
    pub start_month: u8,
    /// One period number and the year it starts in; the others follow.
    pub base_period: i32,
    pub base_start_year: i32,
    /// The period `today` falls in.
    pub current_period: i32,
    /// 第1期 to the period after the current one, oldest first.
    pub periods: Vec<FiscalPeriod>,
}

fn period(fiscal: &FiscalCalendar, period: i32) -> FiscalPeriod {
    let (first, last): (YearMonth, YearMonth) = fiscal.period_range(period);
    FiscalPeriod {
        period,
        label: fiscal.label(period),
        first_month: first.to_string(),
        last_month: last.to_string(),
    }
}

/// The calendar at `now_ms` (UNIX milliseconds).
pub fn calendar_at(now_ms: i64) -> BusinessCalendar {
    let today = TIME_ZONE.date_at(now_ms.div_euclid(1000));
    let current = FISCAL.period_of(today.year_month());
    BusinessCalendar {
        today: today.to_string(),
        now_ms,
        time_zone: TIME_ZONE.name.to_string(),
        utc_offset_minutes: TIME_ZONE.utc_offset_minutes,
        start_month: FISCAL.start_month,
        base_period: FISCAL.base_period,
        base_start_year: FISCAL.base_start_year,
        current_period: current,
        periods: (1..=current + PERIODS_AFTER)
            .map(|p| period(&FISCAL, p))
            .collect(),
    }
}

/// The calendar as of the business date today.
pub fn calendar() -> BusinessCalendar {
    calendar_at(Utc::now().timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn t15_the_calendar_lists_the_current_period_and_its_neighbours() {
        let at = |date: &str, hour: i64| {
            (Date::parse(date).unwrap().day_number() * 86_400 + hour * 3600) * 1000
        };
        // 2026-11-12 08:00 UTC = 17:00 in Tokyo.
        let cal = calendar_at(at("2026-11-12", 8));
        assert_eq!(cal.now_ms, at("2026-11-12", 8));
        assert_eq!(cal.today, "2026-11-12");
        assert_eq!(cal.time_zone, "Asia/Tokyo");
        assert_eq!(cal.utc_offset_minutes, 540);
        assert_eq!(cal.current_period, 13);
        assert_eq!(
            (cal.start_month, cal.base_period, cal.base_start_year),
            (6, 13, 2026)
        );
        let numbers: Vec<i32> = cal.periods.iter().map(|p| p.period).collect();
        assert_eq!(numbers, (1..=14).collect::<Vec<_>>());
        let p13 = cal.periods.iter().find(|p| p.period == 13).unwrap();
        assert_eq!(p13.label, "第13期（2026年6月〜2027年5月）");
        assert_eq!(
            (p13.first_month.as_str(), p13.last_month.as_str()),
            ("2026-06", "2027-05")
        );
        // May still belongs to the period that started the previous June:
        // 2027-05-31 14:59 UTC is May 31 in Tokyo, 15:00 is June 1.
        assert_eq!(
            calendar_at(at("2027-05-31", 15) - 60_000).current_period,
            13
        );
        assert_eq!(calendar_at(at("2027-05-31", 15)).current_period, 14);
    }

    #[test]
    fn today_is_a_valid_business_date() {
        assert!(Date::parse(&today().to_string()).is_some());
        let now = now_local();
        assert!(Date::parse(&now[..10]).is_some(), "{now}");
        assert_eq!(now.len(), 19, "{now}");
    }
}
