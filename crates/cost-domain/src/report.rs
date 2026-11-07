//! 年度またぎの月別・期別・累計の収支（仕様9章、設計案 10.1、T15）。
//!
//! 月の数値は月次締め（[`crate::closing`]）と同じ基準で集める：労務費と単価未設定の件数は
//! 承認済み工数の作業日、売上は取り消していない売上計上の計上日、直接費は管理計上日の台帳
//! （その月末までの台帳 − 前月末までの台帳。後の月で確定した仮計上は仮計上の月の数値を
//! 変えない）。この集計は月の数値を足すだけで、期の小計・当期累計・案件累計は月の合計に必ず
//! 一致する（明細合計と集計の一致）。
//!
//! 期は会社の年度（[`FiscalCalendar`]、6月開始）で決め、5月と6月は別の期に入る。最初の月から
//! 最後の月までの間に記録のない月は0円の行として埋め、累計が途切れないようにする。

use std::collections::BTreeMap;

use crate::calendar::{FiscalCalendar, YearMonth};
use crate::money::{ratio_permille, Yen};

/// 1か月（または期・累計）の数値。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Amounts {
    /// 売上計上。
    pub revenue: Yen,
    /// 承認済み工数の労務費（単価未設定の工数は含まない）。
    pub labor: Yen,
    /// 単価未設定で原価未確定の承認済み工数の件数。
    pub labor_missing: usize,
    /// 直接費（配分後）。
    pub direct: Yen,
}

impl Amounts {
    /// 原価 ＝ 労務費 ＋ 直接費。
    pub fn cost(&self) -> Yen {
        self.labor + self.direct
    }

    /// 粗利 ＝ 売上 − 原価。
    pub fn profit(&self) -> Yen {
        self.revenue - self.cost()
    }

    /// 粗利率（千分率）。売上0は算出不可（`None`）。
    pub fn ratio_permille(&self) -> Option<i64> {
        ratio_permille(self.profit(), self.revenue)
    }

    /// 単価未設定の工数を含み、原価が確定していない。
    pub fn cost_incomplete(&self) -> bool {
        self.labor_missing > 0
    }

    pub fn add(&mut self, other: &Amounts) {
        self.revenue += other.revenue;
        self.labor += other.labor;
        self.labor_missing += other.labor_missing;
        self.direct += other.direct;
    }

    pub fn is_zero(&self) -> bool {
        *self == Self::default()
    }
}

/// 月の行。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonthLine {
    pub month: YearMonth,
    /// 期番号。
    pub period: i32,
    pub amounts: Amounts,
    /// 期首からこの月まで（当期累計）。
    pub period_to_date: Amounts,
    /// 最初の月からこの月まで（案件累計）。
    pub cumulative: Amounts,
}

/// 期の小計。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeriodTotal {
    pub period: i32,
    /// 集計した月の範囲（記録のある最初と最後の月の間で、その期に入る分）。
    pub first: YearMonth,
    pub last: YearMonth,
    pub amounts: Amounts,
}

/// 月別・期別・累計の収支。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MonthlyReport {
    pub lines: Vec<MonthLine>,
    pub periods: Vec<PeriodTotal>,
    pub total: Amounts,
}

impl MonthlyReport {
    /// 年度をまたぐ（2つ以上の期に数値がある）。
    pub fn spans_periods(&self) -> bool {
        self.periods.len() > 1
    }
}

/// 月ごとの数値から、月別（空いた月を0で埋める）・期の小計・当期累計・案件累計を作る。
pub fn monthly(cal: &FiscalCalendar, months: &BTreeMap<YearMonth, Amounts>) -> MonthlyReport {
    let (Some(first), Some(last)) = (
        months.iter().find(|(_, a)| !a.is_zero()).map(|(m, _)| *m),
        months
            .iter()
            .rev()
            .find(|(_, a)| !a.is_zero())
            .map(|(m, _)| *m),
    ) else {
        return MonthlyReport::default();
    };
    let mut report = MonthlyReport::default();
    let mut cumulative = Amounts::default();
    let mut m = first;
    loop {
        let amounts = months.get(&m).copied().unwrap_or_default();
        let period = cal.period_of(m);
        if report.periods.last().map(|p| p.period) != Some(period) {
            report.periods.push(PeriodTotal {
                period,
                first: m,
                last: m,
                amounts: Amounts::default(),
            });
        }
        let current = report.periods.last_mut().expect("pushed above");
        current.last = m;
        current.amounts.add(&amounts);
        cumulative.add(&amounts);
        report.lines.push(MonthLine {
            month: m,
            period,
            amounts,
            period_to_date: current.amounts,
            cumulative,
        });
        if m == last {
            break;
        }
        m = m.next();
    }
    report.total = cumulative;
    report
}

/// 月末時点の累計（例：その月末までの台帳の合計）の列から、月ごとの増分を求める。
///
/// 最初の月の前は0とする。増分を足すと最後の月末の累計に戻る（途中の月の値を置き換える
/// 確定・調整は、置き換えた月の増分に入る）。
pub fn deltas(at_month_end: &BTreeMap<YearMonth, Yen>) -> BTreeMap<YearMonth, Yen> {
    let mut prev = 0;
    at_month_end
        .iter()
        .map(|(m, v)| {
            let d = v - prev;
            prev = *v;
            (*m, d)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ym(s: &str) -> YearMonth {
        YearMonth::parse(s).unwrap()
    }
    fn a(revenue: Yen, labor: Yen, direct: Yen) -> Amounts {
        Amounts {
            revenue,
            labor,
            labor_missing: 0,
            direct,
        }
    }
    const CAL: FiscalCalendar = FiscalCalendar::COMPANY_DEFAULT;

    #[test]
    fn t15_年度またぎの案件は5月と6月が別の期に入り期の小計と累計が月の合計に一致する() {
        let months: BTreeMap<_, _> = [
            (ym("2027-04"), a(0, 120_000, 30_000)),
            (ym("2027-05"), a(500_000, 80_000, 0)),
            (ym("2027-06"), a(0, 40_000, 10_000)),
            (ym("2027-07"), a(300_000, 0, -5_000)),
        ]
        .into_iter()
        .collect();
        let r = monthly(&CAL, &months);
        assert!(r.spans_periods());
        assert_eq!(
            r.periods.iter().map(|p| p.period).collect::<Vec<_>>(),
            [13, 14]
        );
        assert_eq!(r.periods[0].amounts, a(500_000, 200_000, 30_000));
        assert_eq!(r.periods[1].amounts, a(300_000, 40_000, 5_000));
        // 期の小計の合計 ＝ 月の合計 ＝ 累計。
        let mut sum = Amounts::default();
        for p in &r.periods {
            sum.add(&p.amounts);
        }
        assert_eq!(sum, r.total);
        let mut by_month = Amounts::default();
        for l in &r.lines {
            by_month.add(&l.amounts);
        }
        assert_eq!(by_month, r.total);
        assert_eq!(r.total, a(800_000, 240_000, 35_000));
        assert_eq!(r.total.profit(), 525_000);
        // 当期累計は期首で振り出しに戻り、案件累計は続く。
        let june = &r.lines[2];
        assert_eq!(june.month, ym("2027-06"));
        assert_eq!(june.period, 14);
        assert_eq!(june.period_to_date, a(0, 40_000, 10_000));
        assert_eq!(june.cumulative, a(500_000, 240_000, 40_000));
        assert_eq!(r.lines.last().unwrap().cumulative, r.total);
    }

    #[test]
    fn t15_記録のない月は0円の行で埋め累計を途切れさせない() {
        let months: BTreeMap<_, _> = [
            (ym("2026-11"), a(100_000, 0, 0)),
            (ym("2027-02"), a(0, 0, 20_000)),
        ]
        .into_iter()
        .collect();
        let r = monthly(&CAL, &months);
        assert_eq!(
            r.lines
                .iter()
                .map(|l| l.month.to_string())
                .collect::<Vec<_>>(),
            ["2026-11", "2026-12", "2027-01", "2027-02"]
        );
        assert!(r.lines[1].amounts.is_zero());
        assert_eq!(r.lines[2].cumulative, a(100_000, 0, 0));
        assert!(!r.spans_periods());
        assert_eq!(r.periods[0].first, ym("2026-11"));
        assert_eq!(r.periods[0].last, ym("2027-02"));
    }

    #[test]
    fn t15_前後の0円の月は範囲に含めず記録がなければ空() {
        let months: BTreeMap<_, _> = [
            (ym("2026-06"), Amounts::default()),
            (ym("2026-07"), a(0, 10_000, 0)),
            (ym("2026-08"), Amounts::default()),
        ]
        .into_iter()
        .collect();
        let r = monthly(&CAL, &months);
        assert_eq!(r.lines.len(), 1);
        assert_eq!(monthly(&CAL, &BTreeMap::new()), MonthlyReport::default());
    }

    #[test]
    fn t15_売上0の月の粗利率は算出不可で単価未設定は原価未確定() {
        let mut x = a(0, 10_000, 0);
        assert_eq!(x.ratio_permille(), None);
        x.labor_missing = 2;
        assert!(x.cost_incomplete());
        let months: BTreeMap<_, _> = [(ym("2026-07"), x), (ym("2026-08"), a(40_000, 0, 0))]
            .into_iter()
            .collect();
        let r = monthly(&CAL, &months);
        assert_eq!(r.total.labor_missing, 2);
        assert!(r.total.cost_incomplete());
        assert_eq!(r.total.ratio_permille(), Some(750));
    }

    #[test]
    fn t15_月末時点の累計の増分は最後の累計に戻る() {
        // 5月に仮計上 100,000、6月に請求確定 110,000（仮計上を置き換える）。
        let at_end: BTreeMap<_, _> = [(ym("2027-05"), 100_000), (ym("2027-06"), 110_000)]
            .into_iter()
            .collect();
        let d = deltas(&at_end);
        assert_eq!(d[&ym("2027-05")], 100_000);
        assert_eq!(d[&ym("2027-06")], 10_000);
        assert_eq!(d.values().sum::<Yen>(), 110_000);
    }
}
