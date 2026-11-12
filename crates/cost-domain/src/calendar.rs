//! 日付・年月と会社の年度（期番号）。

use std::fmt;

/// 暦日。タイムゾーンは会社の業務日付（Asia/Tokyo）で解釈済みのものを渡す。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Date {
    pub year: i32,
    pub month: u8,
    pub day: u8,
}

impl Date {
    pub fn new(year: i32, month: u8, day: u8) -> Option<Self> {
        if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
            return None;
        }
        Some(Self { year, month, day })
    }

    /// `YYYY-MM-DD` を読む。
    pub fn parse(s: &str) -> Option<Self> {
        let mut it = s.split('-');
        let (y, m, d) = (it.next()?, it.next()?, it.next()?);
        if it.next().is_some() || y.len() != 4 || m.len() != 2 || d.len() != 2 {
            return None;
        }
        Self::new(y.parse().ok()?, m.parse().ok()?, d.parse().ok()?)
    }

    /// 1970-01-01 からの日数（日付の差を求める用、Howard Hinnant の days_from_civil）。
    pub fn day_number(self) -> i64 {
        let (m, d) = (i64::from(self.month), i64::from(self.day));
        let y = i64::from(self.year) - i64::from(m <= 2);
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146_097 + doe - 719_468
    }

    /// [`Date::day_number`] の逆（Howard Hinnant の civil_from_days）。
    pub fn from_day_number(n: i64) -> Self {
        let z = n + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = (doy - (153 * mp + 2) / 5 + 1) as u8;
        let month = if mp < 10 { mp + 3 } else { mp - 9 } as u8;
        let year = (yoe + era * 400 + i64::from(month <= 2)) as i32;
        Self { year, month, day }
    }

    pub fn year_month(self) -> YearMonth {
        YearMonth {
            year: self.year,
            month: self.month,
        }
    }
}

impl fmt::Display for Date {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }
}

fn days_in_month(year: i32, month: u8) -> u8 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        _ => 28,
    }
}

/// 年月（月次集計・売上予定月の単位）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct YearMonth {
    pub year: i32,
    pub month: u8,
}

impl YearMonth {
    pub fn new(year: i32, month: u8) -> Option<Self> {
        (1..=12).contains(&month).then_some(Self { year, month })
    }

    /// `YYYY-MM` を読む。
    pub fn parse(s: &str) -> Option<Self> {
        let (y, m) = s.split_once('-')?;
        if y.len() != 4 || m.len() != 2 {
            return None;
        }
        Self::new(y.parse().ok()?, m.parse().ok()?)
    }

    /// その月の末日。
    pub fn last_day(self) -> Date {
        Date {
            year: self.year,
            month: self.month,
            day: days_in_month(self.year, self.month),
        }
    }

    /// 次の月。
    pub fn next(self) -> Self {
        if self.month == 12 {
            Self {
                year: self.year + 1,
                month: 1,
            }
        } else {
            Self {
                year: self.year,
                month: self.month + 1,
            }
        }
    }

    /// 前の月。
    pub fn previous(self) -> Self {
        if self.month == 1 {
            Self {
                year: self.year - 1,
                month: 12,
            }
        } else {
            Self {
                year: self.year,
                month: self.month - 1,
            }
        }
    }
}

impl fmt::Display for YearMonth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:04}-{:02}", self.year, self.month)
    }
}

/// 会社の年度。開始月と、ある期の番号・開始年の組から期番号を計算する。
///
/// 2026-11-06 決定：6月開始、期番号表示。第13期 ＝ 2026年6月〜2027年5月。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FiscalCalendar {
    pub start_month: u8,
    pub base_period: i32,
    pub base_start_year: i32,
}

impl FiscalCalendar {
    /// この会社の既定値（6月開始、第13期は2026年6月開始）。
    pub const COMPANY_DEFAULT: Self = Self {
        start_month: 6,
        base_period: 13,
        base_start_year: 2026,
    };

    /// その年月が属する期の開始年。
    pub fn start_year_of(&self, ym: YearMonth) -> i32 {
        if ym.month >= self.start_month {
            ym.year
        } else {
            ym.year - 1
        }
    }

    /// 期番号。
    pub fn period_of(&self, ym: YearMonth) -> i32 {
        self.base_period + (self.start_year_of(ym) - self.base_start_year)
    }

    /// 期の最初と最後の月。
    pub fn period_range(&self, period: i32) -> (YearMonth, YearMonth) {
        let sy = self.base_start_year + (period - self.base_period);
        let first = YearMonth {
            year: sy,
            month: self.start_month,
        };
        let last = if self.start_month == 1 {
            YearMonth {
                year: sy,
                month: 12,
            }
        } else {
            YearMonth {
                year: sy + 1,
                month: self.start_month - 1,
            }
        };
        (first, last)
    }

    /// 表示用ラベル（例：`第13期（2026年6月〜2027年5月）`）。
    pub fn label(&self, period: i32) -> String {
        let (a, b) = self.period_range(period);
        format!(
            "第{period}期（{}年{}月〜{}年{}月）",
            a.year, a.month, b.year, b.month
        )
    }
}

/// 業務日付を決めるタイムゾーン（設計案 8章：Asia/Tokyo）。
///
/// 業務日付（今日・今月・締めの月）は実行環境の地域設定でなく、これで決める。
/// Asia/Tokyo は夏時間がないので UTC からの固定の差（分）で表す。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BusinessTimeZone {
    pub name: &'static str,
    pub utc_offset_minutes: i32,
}

impl BusinessTimeZone {
    /// この会社の既定値（Asia/Tokyo、UTC+9:00）。
    pub const COMPANY_DEFAULT: Self = Self {
        name: "Asia/Tokyo",
        utc_offset_minutes: 9 * 60,
    };

    /// UNIX 時刻（秒）のその地の日付と、その日の0時からの秒数。
    pub fn local_at(&self, unix_seconds: i64) -> (Date, u32) {
        let local = unix_seconds + i64::from(self.utc_offset_minutes) * 60;
        let day = local.div_euclid(86_400);
        let seconds = local.rem_euclid(86_400) as u32;
        (Date::from_day_number(day), seconds)
    }

    /// UNIX 時刻（秒）の業務日付。
    pub fn date_at(&self, unix_seconds: i64) -> Date {
        self.local_at(unix_seconds).0
    }

    /// UNIX 時刻（秒）のその地の日時（`YYYY-MM-DD HH:MM:SS`、帳票の出力日時）。
    pub fn date_time_at(&self, unix_seconds: i64) -> String {
        let (date, s) = self.local_at(unix_seconds);
        format!("{date} {:02}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 日数の通し番号() {
        let d = |s: &str| Date::parse(s).unwrap().day_number();
        assert_eq!(d("1970-01-01"), 0);
        assert_eq!(d("2026-11-06") - d("2026-11-01"), 5);
        assert_eq!(d("2027-03-01") - d("2027-02-28"), 1);
        assert_eq!(d("2028-03-01") - d("2028-02-28"), 2, "閏年");
        assert_eq!(d("2027-01-01") - d("2026-12-31"), 1);
    }

    #[test]
    fn 日数の通し番号から日付に戻す() {
        for s in [
            "1970-01-01",
            "2000-02-29",
            "2026-11-12",
            "2027-05-31",
            "2028-02-29",
            "1969-12-31",
            "2100-03-01",
        ] {
            let date = Date::parse(s).unwrap();
            assert_eq!(Date::from_day_number(date.day_number()), date, "{s}");
        }
    }

    #[test]
    fn 業務日付はasia_tokyoで決める() {
        let tz = BusinessTimeZone::COMPANY_DEFAULT;
        // 2026-11-30T15:00:00Z は東京で 2026-12-01 00:00:00（UTC の環境でも翌月）。
        let utc = Date::parse("2026-11-30").unwrap().day_number() * 86_400 + 15 * 3600;
        assert_eq!(tz.date_at(utc - 1).to_string(), "2026-11-30");
        assert_eq!(tz.date_at(utc).to_string(), "2026-12-01");
        assert_eq!(tz.date_time_at(utc - 1), "2026-11-30 23:59:59");
        assert_eq!(tz.date_time_at(utc + 9 * 3600 + 61), "2026-12-01 09:01:01");
        // 2026-05-31T15:00:00Z は東京で 2026-06-01 = 第13期の初日（UTC ではまだ第12期）。
        let june = Date::parse("2026-05-31").unwrap().day_number() * 86_400 + 15 * 3600;
        let ym = tz.date_at(june).year_month();
        assert_eq!(FiscalCalendar::COMPANY_DEFAULT.period_of(ym), 13);
    }

    fn ym(s: &str) -> YearMonth {
        YearMonth::parse(s).unwrap()
    }

    #[test]
    fn 第13期は2026年6月から2027年5月() {
        let fc = FiscalCalendar::COMPANY_DEFAULT;
        assert_eq!(fc.period_of(ym("2026-06")), 13);
        assert_eq!(fc.period_of(ym("2027-05")), 13);
        assert_eq!(fc.period_of(ym("2026-05")), 12);
        assert_eq!(fc.period_of(ym("2027-06")), 14);
        assert_eq!(fc.label(13), "第13期（2026年6月〜2027年5月）");
    }

    #[test]
    fn 一月開始の暦年度() {
        let fc = FiscalCalendar {
            start_month: 1,
            base_period: 1,
            base_start_year: 2026,
        };
        assert_eq!(fc.period_range(1), (ym("2026-01"), ym("2026-12")));
    }

    #[test]
    fn 月末日と前の月() {
        assert_eq!(ym("2028-02").last_day().to_string(), "2028-02-29");
        assert_eq!(ym("2026-11").last_day().to_string(), "2026-11-30");
        assert_eq!(ym("2027-01").previous(), ym("2026-12"));
        assert_eq!(ym("2026-11").previous(), ym("2026-10"));
    }

    #[test]
    fn 日付の読み取りと検査() {
        assert_eq!(Date::parse("2026-12-10").unwrap().to_string(), "2026-12-10");
        assert!(Date::parse("2026-02-29").is_none());
        assert!(Date::parse("2028-02-29").is_some());
        assert!(Date::parse("2026-1-01").is_none());
        assert!(Date::parse("2026-01-01") < Date::parse("2026-01-02"));
    }
}
