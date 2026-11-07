//! 工数（仕様6.1・6.2、設計書3.3）。
//!
//! - 工数は分の整数で持つ。1件はゼロより大きく、会社の入力単位（計算基準 `time_unit`）の倍数。
//! - 同じ人の1日の合計は24時間まで。所定時間との差や同じ日・案件・工程の重複は警告にとどめる。
//! - 状態は「下書き → 申請 → 承認」または「差戻し」。標準の集計は承認済みだけを実績にする。
//! - 承認時に、作業日に適用される時間原価単価（計算基準 `emp_rate`）と労務原価を確定する。
//!   単価がなければ原価は `None`（原価未確定）で、0円にしない（T04）。

use crate::calc_basis::{resolve, CalcValue, Resolved};
use crate::calendar::Date;
use crate::money::{labor_cost, Minutes, Yen};

/// 労務原価に使う計算基準の項目（社員の時間原価単価）。
pub const RATE_ITEM: &str = "emp_rate";
/// 入力単位の計算基準の項目。
pub const UNIT_ITEM: &str = "time_unit";
/// 1日の上限（24時間）。
pub const DAY_LIMIT: Minutes = 24 * 60;

/// 工数の状態。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeStatus {
    Draft,
    Submitted,
    Approved,
    Returned,
}

impl TimeStatus {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "draft" => Some(Self::Draft),
            "submitted" => Some(Self::Submitted),
            "approved" => Some(Self::Approved),
            "returned" => Some(Self::Returned),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Submitted => "submitted",
            Self::Approved => "approved",
            Self::Returned => "returned",
        }
    }

    /// 本人が直せる・削除できる・申請できる状態（下書きと差戻し）。
    pub fn is_editable(self) -> bool {
        matches!(self, Self::Draft | Self::Returned)
    }

    /// 承認・差戻しを判断できる状態（申請中）。
    pub fn is_decidable(self) -> bool {
        self == Self::Submitted
    }
}

/// 手直し区分（仕様5.2）。`None` は当初作業。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rework {
    /// 社内起因（設計誤り・製作不良など）。
    Internal,
    /// 顧客起因（仕様変更・追加の指示など）。
    Customer,
    Other,
}

impl Rework {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "internal" => Some(Self::Internal),
            "customer" => Some(Self::Customer),
            "other" => Some(Self::Other),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Internal => "internal",
            Self::Customer => "customer",
            Self::Other => "other",
        }
    }
}

/// 工数の付け先。案件か共通活動のどちらか一つ（仕様5.2）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Project(i64),
    Activity(i64),
}

/// 検査する1件（新規または変更後の値）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntryInput {
    pub work_date: Date,
    pub target: Target,
    /// 工程。案件では必須、共通活動では持たない。
    pub phase: Option<i64>,
    pub minutes: Minutes,
    pub rework: Option<Rework>,
}

/// 同じ人の既存の工数（検査対象の行自身は含めない）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DayEntry {
    pub id: i64,
    pub work_date: Date,
    pub target: Target,
    pub phase: Option<i64>,
    pub minutes: Minutes,
}

/// 登録を拒否する不整合。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TimeIssue {
    /// ゼロ以下の作業時間。
    MinutesNotPositive,
    /// 入力単位の倍数でない。
    NotOnUnit { unit: Minutes },
    /// 同じ日の合計が24時間を超える。
    DayOverLimit { total: Minutes },
    /// 案件の工数に工程がない。
    PhaseRequired,
    /// 共通活動に工程・手直し区分を付けた。
    ActivityWithPhase,
}

/// 登録はできるが確認を促す注意。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TimeWarning {
    /// 同じ日・案件（共通活動）・工程の工数がすでにある（複数回の作業自体は許可）。
    DuplicateCandidate { ids: Vec<i64> },
    /// 同じ日の合計が所定時間（計算基準 `day_minutes`）と違う。残業・短時間勤務を拒否しない。
    DayDiffersFromStandard { total: Minutes, standard: Minutes },
}

/// 1件を検査する。`unit` は入力単位（未設定なら単位の検査をしない）、`standard` は所定時間。
pub fn check_entry(
    input: &EntryInput,
    same_user: &[DayEntry],
    unit: Option<Minutes>,
    standard: Option<Minutes>,
) -> Result<Vec<TimeWarning>, Vec<TimeIssue>> {
    let mut issues = Vec::new();
    if input.minutes <= 0 {
        issues.push(TimeIssue::MinutesNotPositive);
    } else if let Some(u) = unit.filter(|u| *u > 0) {
        if input.minutes % u != 0 {
            issues.push(TimeIssue::NotOnUnit { unit: u });
        }
    }
    match input.target {
        Target::Project(_) if input.phase.is_none() => issues.push(TimeIssue::PhaseRequired),
        Target::Activity(_) if input.phase.is_some() || input.rework.is_some() => {
            issues.push(TimeIssue::ActivityWithPhase)
        }
        _ => {}
    }
    let same_day: Vec<&DayEntry> = same_user
        .iter()
        .filter(|e| e.work_date == input.work_date)
        .collect();
    // 極端に大きな入力でも溢れて検査をすり抜けないよう、飽和加算で合計する。
    let total = same_day
        .iter()
        .fold(input.minutes.max(0), |acc, e| acc.saturating_add(e.minutes));
    if total > DAY_LIMIT {
        issues.push(TimeIssue::DayOverLimit { total });
    }
    if !issues.is_empty() {
        return Err(issues);
    }
    let mut warnings = Vec::new();
    let dup: Vec<i64> = same_day
        .iter()
        .filter(|e| e.target == input.target && e.phase == input.phase)
        .map(|e| e.id)
        .collect();
    if !dup.is_empty() {
        warnings.push(TimeWarning::DuplicateCandidate { ids: dup });
    }
    if let Some(std) = standard.filter(|s| *s > 0 && *s != total) {
        warnings.push(TimeWarning::DayDiffersFromStandard {
            total,
            standard: std,
        });
    }
    Ok(warnings)
}

/// 承認時に確定する単価と労務原価。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovedCost {
    /// 作業日に適用された単価と出典。`None` は単価未登録。
    pub rate: Option<Resolved>,
    /// 労務原価（円単位で四捨五入）。単価がなければ `None`（原価未確定、T04）。
    pub cost: Option<Yen>,
}

/// 作業日に適用される時間原価単価で労務原価を求める（T02・T03）。
/// `values` は `emp_rate` の行。後日の単価変更で承認済みの値を変えないよう、呼び出し側は結果を保存する。
pub fn approval_cost(
    values: &[CalcValue],
    project: Option<&str>,
    work_date: Date,
    minutes: Minutes,
) -> ApprovedCost {
    let rate = resolve(values, RATE_ITEM, project, work_date, None);
    let cost = labor_cost(minutes, rate.as_ref().map(|r| r.value));
    ApprovedCost { rate, cost }
}

/// 集計に使う1件。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SummaryEntry {
    pub status: TimeStatus,
    pub minutes: Minutes,
    /// 承認時に保存した労務原価。
    pub labor_cost: Option<Yen>,
}

/// 件数と時間の組。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Tally {
    pub count: usize,
    pub minutes: Minutes,
}

impl Tally {
    fn add(&mut self, minutes: Minutes) {
        self.count += 1;
        self.minutes += minutes;
    }
}

/// 工数の集計（仕様6.1：承認済みだけを実績にし、未申請・未承認を別に示す）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TimeSummary {
    /// 承認済み。
    pub approved: Tally,
    /// 承認済みのうち原価が確定した分の労務原価の合計。
    pub labor_cost: Yen,
    /// 承認済みのうち単価がなく原価未確定のもの（労務原価に含めない）。
    pub missing_rate: Tally,
    /// 申請中（未承認）。
    pub submitted: Tally,
    /// 下書き・差戻し（未申請）。
    pub unsubmitted: Tally,
}

impl TimeSummary {
    /// 原価未確定・未承認・未申請がなく、労務原価をそのまま確定値として読めるか。
    pub fn is_complete(&self) -> bool {
        self.missing_rate.count == 0 && self.submitted.count == 0 && self.unsubmitted.count == 0
    }
}

/// 工数を集計する。単価不足・未承認を0円の確定実績にしない（T04）。
pub fn summarize(entries: &[SummaryEntry]) -> TimeSummary {
    let mut s = TimeSummary::default();
    for e in entries {
        match e.status {
            TimeStatus::Approved => {
                s.approved.add(e.minutes);
                match e.labor_cost {
                    Some(c) => s.labor_cost += c,
                    None => s.missing_rate.add(e.minutes),
                }
            }
            TimeStatus::Submitted => s.submitted.add(e.minutes),
            TimeStatus::Draft | TimeStatus::Returned => s.unsubmitted.add(e.minutes),
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calc_basis::{Scope, Source};

    fn d(s: &str) -> Date {
        Date::parse(s).unwrap()
    }

    fn rate(from: &str, value: i64, version: u32) -> CalcValue {
        CalcValue {
            item: RATE_ITEM.into(),
            scope: Scope::Company,
            valid_from: d(from),
            value: Some(value),
            version,
        }
    }

    fn input(minutes: Minutes) -> EntryInput {
        EntryInput {
            work_date: d("2026-11-09"),
            target: Target::Project(1),
            phase: Some(1),
            minutes,
            rework: None,
        }
    }

    fn day(id: i64, minutes: Minutes, phase: i64) -> DayEntry {
        DayEntry {
            id,
            work_date: d("2026-11-09"),
            target: Target::Project(1),
            phase: Some(phase),
            minutes,
        }
    }

    #[test]
    fn t02_140時間を5000円で承認すると労務原価700000円() {
        let values = [rate("2026-06-01", 5_000, 1)];
        let got = approval_cost(&values, Some("1"), d("2026-11-09"), 140 * 60);
        assert_eq!(got.cost, Some(700_000));
        assert_eq!(got.rate.unwrap().value, 5_000);
        // 140時間を承認済み工数として集計しても同じ。
        let entries: Vec<SummaryEntry> = (0..20)
            .map(|_| SummaryEntry {
                status: TimeStatus::Approved,
                minutes: 7 * 60,
                labor_cost: approval_cost(&values, Some("1"), d("2026-11-09"), 7 * 60).cost,
            })
            .collect();
        let s = summarize(&entries);
        assert_eq!(s.approved.minutes, 140 * 60);
        assert_eq!(s.labor_cost, 700_000);
        assert!(s.is_complete());
    }

    #[test]
    fn t03_作業日で単価が選ばれ過去の承認値は変わらない() {
        let mut values = vec![rate("2026-06-01", 5_000, 1)];
        let before = approval_cost(&values, None, d("2026-11-30"), 60);
        assert_eq!(before.cost, Some(5_000));
        // 12月からの新しい版を追加しても、11月の作業日は旧版のまま。
        values.push(rate("2026-12-01", 5_400, 2));
        let nov = approval_cost(&values, None, d("2026-11-30"), 60);
        let dec = approval_cost(&values, None, d("2026-12-01"), 60);
        assert_eq!(nov.cost, Some(5_000));
        assert_eq!(dec.cost, Some(5_400));
        assert_eq!(
            dec.rate.unwrap().source,
            Source::Company {
                version: 2,
                valid_from: d("2026-12-01")
            }
        );
        // 承認時に保存した値（before）はそのまま。集計は保存値を足すだけ。
        let s = summarize(&[SummaryEntry {
            status: TimeStatus::Approved,
            minutes: 60,
            labor_cost: before.cost,
        }]);
        assert_eq!(s.labor_cost, 5_000);
    }

    #[test]
    fn t03_案件の上書き単価は作業日から使う() {
        let values = vec![
            rate("2026-06-01", 5_000, 1),
            CalcValue {
                item: RATE_ITEM.into(),
                scope: Scope::Project("7".into()),
                valid_from: d("2026-11-15"),
                value: Some(6_000),
                version: 1,
            },
        ];
        assert_eq!(
            approval_cost(&values, Some("7"), d("2026-11-14"), 60).cost,
            Some(5_000)
        );
        assert_eq!(
            approval_cost(&values, Some("7"), d("2026-11-15"), 60).cost,
            Some(6_000)
        );
        assert_eq!(
            approval_cost(&values, Some("8"), d("2026-11-15"), 60).cost,
            Some(5_000)
        );
    }

    #[test]
    fn t04_単価なしと未承認は0円の確定実績にしない() {
        let none = approval_cost(&[], Some("1"), d("2026-11-09"), 480);
        assert_eq!(none.rate, None);
        assert_eq!(none.cost, None);
        let s = summarize(&[
            SummaryEntry {
                status: TimeStatus::Approved,
                minutes: 480,
                labor_cost: None,
            },
            SummaryEntry {
                status: TimeStatus::Approved,
                minutes: 60,
                labor_cost: Some(5_000),
            },
            SummaryEntry {
                status: TimeStatus::Submitted,
                minutes: 120,
                labor_cost: None,
            },
            SummaryEntry {
                status: TimeStatus::Draft,
                minutes: 30,
                labor_cost: None,
            },
            SummaryEntry {
                status: TimeStatus::Returned,
                minutes: 45,
                labor_cost: None,
            },
        ]);
        assert_eq!(
            s.approved,
            Tally {
                count: 2,
                minutes: 540
            }
        );
        assert_eq!(s.labor_cost, 5_000, "原価未確定分は0円として足さない");
        assert_eq!(
            s.missing_rate,
            Tally {
                count: 1,
                minutes: 480
            }
        );
        assert_eq!(
            s.submitted,
            Tally {
                count: 1,
                minutes: 120
            }
        );
        assert_eq!(
            s.unsubmitted,
            Tally {
                count: 2,
                minutes: 75
            }
        );
        assert!(!s.is_complete());
    }

    #[test]
    fn ゼロ以下と入力単位外は拒否() {
        assert_eq!(
            check_entry(&input(0), &[], Some(15), None),
            Err(vec![TimeIssue::MinutesNotPositive])
        );
        assert_eq!(
            check_entry(&input(-30), &[], Some(15), None),
            Err(vec![TimeIssue::MinutesNotPositive])
        );
        assert_eq!(
            check_entry(&input(20), &[], Some(15), None),
            Err(vec![TimeIssue::NotOnUnit { unit: 15 }])
        );
        assert_eq!(check_entry(&input(20), &[], None, None), Ok(vec![]));
    }

    #[test]
    fn 一日の合計が24時間を超えると拒否() {
        let others = [day(1, 20 * 60, 2), day(2, 3 * 60, 3)];
        assert_eq!(
            check_entry(&input(60), &others, Some(15), None),
            Ok(vec![]),
            "ちょうど24時間は可"
        );
        assert_eq!(
            check_entry(&input(75), &others, Some(15), None),
            Err(vec![TimeIssue::DayOverLimit { total: 1_455 }])
        );
        // 別の日は数えない。
        let other_day = [DayEntry {
            work_date: d("2026-11-10"),
            ..day(3, 23 * 60, 2)
        }];
        assert_eq!(
            check_entry(&input(120), &other_day, Some(15), None),
            Ok(vec![])
        );
    }

    #[test]
    fn 極端に大きな作業時間でも合計が溢れず拒否() {
        let others = [day(1, 60, 2)];
        assert_eq!(
            check_entry(&input(Minutes::MAX), &others, None, None),
            Err(vec![TimeIssue::DayOverLimit {
                total: Minutes::MAX
            }])
        );
    }

    #[test]
    fn 工程と共通活動の組み合わせ() {
        let mut no_phase = input(60);
        no_phase.phase = None;
        assert_eq!(
            check_entry(&no_phase, &[], None, None),
            Err(vec![TimeIssue::PhaseRequired])
        );
        let activity = EntryInput {
            target: Target::Activity(1),
            phase: None,
            ..input(60)
        };
        assert_eq!(check_entry(&activity, &[], None, None), Ok(vec![]));
        let with_rework = EntryInput {
            rework: Some(Rework::Internal),
            ..activity.clone()
        };
        assert_eq!(
            check_entry(&with_rework, &[], None, None),
            Err(vec![TimeIssue::ActivityWithPhase])
        );
    }

    #[test]
    fn 重複候補と所定時間との差は警告だけ() {
        let others = [day(1, 120, 1), day(2, 60, 2)];
        let got = check_entry(&input(300), &others, Some(15), Some(480)).unwrap();
        // 合計480分＝所定時間なので、注意は重複候補だけ。
        assert_eq!(got, vec![TimeWarning::DuplicateCandidate { ids: vec![1] }]);
        // 残業（所定より長い）も拒否しない。
        let got = check_entry(&input(600), &others, Some(15), Some(480)).unwrap();
        assert!(got.contains(&TimeWarning::DayDiffersFromStandard {
            total: 780,
            standard: 480
        }));
    }

    #[test]
    fn 状態ごとにできる操作() {
        assert!(TimeStatus::Draft.is_editable());
        assert!(TimeStatus::Returned.is_editable());
        assert!(!TimeStatus::Submitted.is_editable());
        assert!(!TimeStatus::Approved.is_editable());
        assert!(TimeStatus::Submitted.is_decidable());
        assert!(!TimeStatus::Approved.is_decidable());
        for s in ["draft", "submitted", "approved", "returned"] {
            assert_eq!(TimeStatus::parse(s).unwrap().as_str(), s);
        }
        for r in ["internal", "customer", "other"] {
            assert_eq!(Rework::parse(r).unwrap().as_str(), r);
        }
        assert_eq!(TimeStatus::parse("x"), None);
    }
}
