//! 月次締め（仕様7章・9章、設計案 3.5、T11）。
//!
//! 月は「未締め」「締め済み」「再開中」のどれか。締め済みの月に業務日付がある工数・直接費・
//! 売上計上は、登録・変更・申請・承認・取消を受け付けない（通常編集不可）。訂正は経理が理由を
//! 付けて月を再開してから行い、もう一度締める。
//!
//! 締めるときは、その月の未承認（下書き・申請中・差戻し）の工数と直接費が残っていないことを
//! 求める。単価未設定の承認済み工数と請求確定していない仮計上は締めを止めず、注意として示す
//! （仮計上は月末の未請求分を計上するための仕組みで、翌月以降の確定で置き換わる）。
//!
//! 締めた時点の案件ごとの月の数値（労務費・単価未設定の件数・直接費・売上計上）を保存し、
//! 今の値との違いを [`compare`] で確かめる（仕様9章「訂正後の最新値との違い」）。

use std::collections::BTreeMap;

use crate::money::Yen;

/// 月の締めの状態。行がない月は未締め。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonthStatus {
    Open,
    Closed,
    Reopened,
}

impl MonthStatus {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "open" => Some(Self::Open),
            "closed" => Some(Self::Closed),
            "reopened" => Some(Self::Reopened),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Closed => "closed",
            Self::Reopened => "reopened",
        }
    }

    /// その月の工数・直接費・売上計上を書き込めるか（締め済みだけが不可）。
    pub fn accepts_writes(self) -> bool {
        self != Self::Closed
    }
}

/// 締めの前に確かめる、その月の記録の状態。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MonthState {
    /// 下書き・申請中・差戻しの工数。
    pub unapproved_time_entries: usize,
    /// 下書き・申請中・差戻しの直接費。
    pub unapproved_costs: usize,
    /// 単価未設定で原価未確定の承認済み工数。
    pub missing_rate_entries: usize,
    /// 請求確定していない仮計上（その月に計上したもの）。
    pub provisional_entries: usize,
    /// その月を期間に含むのに未計上の月額固定の取り決め（受注済みで精算前の案件だけ、T37）。
    pub unposted_fixed_costs: usize,
}

/// 締めを止める理由。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseIssue {
    AlreadyClosed,
    Unapproved { time_entries: usize, costs: usize },
}

/// 締めは止めないが知らせる項目。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseWarning {
    MissingRate {
        entries: usize,
    },
    Provisional {
        entries: usize,
    },
    /// 未計上の月額固定。締めると、その月には再開するまで計上できない。
    FixedUnposted {
        contracts: usize,
    },
}

impl CloseWarning {
    pub fn code(&self) -> &'static str {
        match self {
            Self::MissingRate { .. } => "missing_rate",
            Self::Provisional { .. } => "provisional",
            Self::FixedUnposted { .. } => "fixed_unposted",
        }
    }

    pub fn count(&self) -> usize {
        match self {
            Self::MissingRate { entries } | Self::Provisional { entries } => *entries,
            Self::FixedUnposted { contracts } => *contracts,
        }
    }
}

/// 締めの注意（締めを止めない）。
pub fn warnings(s: &MonthState) -> Vec<CloseWarning> {
    let mut out = Vec::new();
    if s.missing_rate_entries > 0 {
        out.push(CloseWarning::MissingRate {
            entries: s.missing_rate_entries,
        });
    }
    if s.provisional_entries > 0 {
        out.push(CloseWarning::Provisional {
            entries: s.provisional_entries,
        });
    }
    if s.unposted_fixed_costs > 0 {
        out.push(CloseWarning::FixedUnposted {
            contracts: s.unposted_fixed_costs,
        });
    }
    out
}

/// 締めてよいか。成功時は注意を返す。
pub fn check_close(status: MonthStatus, s: &MonthState) -> Result<Vec<CloseWarning>, CloseIssue> {
    if status == MonthStatus::Closed {
        return Err(CloseIssue::AlreadyClosed);
    }
    if s.unapproved_time_entries > 0 || s.unapproved_costs > 0 {
        return Err(CloseIssue::Unapproved {
            time_entries: s.unapproved_time_entries,
            costs: s.unapproved_costs,
        });
    }
    Ok(warnings(s))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReopenIssue {
    NotClosed,
    ReasonRequired,
}

/// 再開してよいか。締め済みの月だけを、理由つきで再開できる。
pub fn check_reopen(status: MonthStatus, reason: &str) -> Result<(), ReopenIssue> {
    if status != MonthStatus::Closed {
        return Err(ReopenIssue::NotClosed);
    }
    if reason.trim().is_empty() {
        return Err(ReopenIssue::ReasonRequired);
    }
    Ok(())
}

/// 案件のある月の数値。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MonthFigures {
    /// 承認済み工数の労務費（単価未設定の分は含まない）。
    pub labor_cost: Yen,
    /// 単価未設定で原価未確定の承認済み工数の件数。
    pub labor_missing: usize,
    /// 直接費（その月末までの台帳 − 前月末までの台帳）。
    pub direct_cost: Yen,
    /// 売上計上（取消していないもの）。
    pub revenue: Yen,
}

/// 締めた時点と今で違う案件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FigureDiff {
    pub project: String,
    pub at_close: MonthFigures,
    pub current: MonthFigures,
}

/// 締めた時点の数値と今の数値を案件ごとに比べ、違う案件だけを返す。どちらかにない案件は
/// すべて0として比べる（0円の行は保存しないことがある）。
pub fn compare(
    at_close: &BTreeMap<String, MonthFigures>,
    current: &BTreeMap<String, MonthFigures>,
) -> Vec<FigureDiff> {
    let mut projects: Vec<&String> = at_close.keys().chain(current.keys()).collect();
    projects.sort();
    projects.dedup();
    projects
        .into_iter()
        .filter_map(|p| {
            let a = at_close.get(p).copied().unwrap_or_default();
            let c = current.get(p).copied().unwrap_or_default();
            (a != c).then(|| FigureDiff {
                project: p.clone(),
                at_close: a,
                current: c,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn t11_締め済みの月だけが書き込みを受け付けない() {
        assert!(MonthStatus::Open.accepts_writes());
        assert!(!MonthStatus::Closed.accepts_writes());
        assert!(MonthStatus::Reopened.accepts_writes());
        for s in ["open", "closed", "reopened"] {
            assert_eq!(MonthStatus::parse(s).unwrap().as_str(), s);
        }
        assert_eq!(MonthStatus::parse("x"), None);
    }

    #[test]
    fn 未承認が残る月は締められない() {
        let s = MonthState {
            unapproved_time_entries: 2,
            unapproved_costs: 1,
            ..Default::default()
        };
        assert_eq!(
            check_close(MonthStatus::Open, &s),
            Err(CloseIssue::Unapproved {
                time_entries: 2,
                costs: 1
            })
        );
    }

    #[test]
    fn 単価未設定と仮計上は注意として締められる() {
        let s = MonthState {
            missing_rate_entries: 3,
            provisional_entries: 1,
            ..Default::default()
        };
        let w = check_close(MonthStatus::Reopened, &s).unwrap();
        assert_eq!(
            w,
            vec![
                CloseWarning::MissingRate { entries: 3 },
                CloseWarning::Provisional { entries: 1 }
            ]
        );
        assert_eq!((w[0].code(), w[0].count()), ("missing_rate", 3));
        assert_eq!(
            check_close(MonthStatus::Open, &MonthState::default()),
            Ok(vec![])
        );
    }

    #[test]
    fn 締め済みの月は二重に締めない() {
        assert_eq!(
            check_close(MonthStatus::Closed, &MonthState::default()),
            Err(CloseIssue::AlreadyClosed)
        );
    }

    #[test]
    fn t11_再開は締め済みの月だけ理由つき() {
        assert_eq!(
            check_reopen(MonthStatus::Closed, "  "),
            Err(ReopenIssue::ReasonRequired)
        );
        assert_eq!(
            check_reopen(MonthStatus::Open, "単価の訂正"),
            Err(ReopenIssue::NotClosed)
        );
        assert_eq!(
            check_reopen(MonthStatus::Reopened, "単価の訂正"),
            Err(ReopenIssue::NotClosed)
        );
        assert_eq!(check_reopen(MonthStatus::Closed, "単価の訂正"), Ok(()));
    }

    fn fig(labor: Yen, direct: Yen, revenue: Yen) -> MonthFigures {
        MonthFigures {
            labor_cost: labor,
            labor_missing: 0,
            direct_cost: direct,
            revenue,
        }
    }

    #[test]
    fn 締め時点と今の違う案件だけを返す() {
        let at: BTreeMap<String, MonthFigures> = [
            ("1".to_string(), fig(10_000, 5_000, 0)),
            ("2".to_string(), fig(3_000, 0, 100_000)),
            ("3".to_string(), fig(1_000, 0, 0)),
        ]
        .into();
        let now: BTreeMap<String, MonthFigures> = [
            ("1".to_string(), fig(10_000, 5_000, 0)),
            ("2".to_string(), fig(4_500, 0, 100_000)),
            ("4".to_string(), fig(0, 0, 0)),
        ]
        .into();
        let d = compare(&at, &now);
        assert_eq!(
            d,
            vec![
                FigureDiff {
                    project: "2".into(),
                    at_close: fig(3_000, 0, 100_000),
                    current: fig(4_500, 0, 100_000),
                },
                FigureDiff {
                    project: "3".into(),
                    at_close: fig(1_000, 0, 0),
                    current: MonthFigures::default(),
                },
            ]
        );
    }

    #[test]
    fn 単価未設定の件数の違いも差として返す() {
        let mut a = fig(0, 0, 0);
        a.labor_missing = 1;
        let at: BTreeMap<String, MonthFigures> = [("1".to_string(), a)].into();
        let now: BTreeMap<String, MonthFigures> = [("1".to_string(), fig(2_000, 0, 0))].into();
        assert_eq!(compare(&at, &now).len(), 1);
    }
    #[test]
    fn t37_unposted_fixed_costs_warn_but_do_not_block_the_close() {
        let s = MonthState {
            unposted_fixed_costs: 2,
            ..Default::default()
        };
        let w = check_close(MonthStatus::Open, &s).unwrap();
        assert_eq!(w, vec![CloseWarning::FixedUnposted { contracts: 2 }]);
        assert_eq!(w[0].code(), "fixed_unposted");
        assert_eq!(w[0].count(), 2);
    }
}
