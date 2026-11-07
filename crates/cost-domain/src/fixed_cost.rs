//! 月額固定原価（設計案 9.4 の3・5、受入条件 T37）。
//!
//! 社員・外注先とも、人ごとの月額固定の円額を、その人が担う月額契約の案件に毎月計上する
//! （配分なし）。案件ごとの追加作業は工数×単価で別に計上し、同じ作業を両方に入れない。
//!
//! - 取り決め（契約）は人・案件・月額・期間（開始月〜終了月、終了月なしは継続）で持つ。
//! - 計上は月ごとに1回だけで、その月の月末を管理計上日にした承認済みの明細になる。
//!   社員は労務費、外注先は外注費。計上した額は後から契約の月額を変えても変わらない。
//! - 未入力を0円にしない：月額は正の円額が必須で、計上していない月は原価に入らない。

use crate::calendar::YearMonth;
use crate::forecast::CostType;
use crate::money::Yen;

/// 支払先の種類。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PayeeKind {
    /// 社員（労務費）。
    Employee,
    /// 外注先（外注費）。
    Vendor,
}

impl PayeeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Employee => "employee",
            Self::Vendor => "vendor",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "employee" => Some(Self::Employee),
            "vendor" => Some(Self::Vendor),
            _ => None,
        }
    }

    /// 計上する費目。
    pub fn cost_type(self) -> CostType {
        match self {
            Self::Employee => CostType::Labor,
            Self::Vendor => CostType::Outsource,
        }
    }
}

/// 契約の期間。`to` が `None` なら終了月なし（継続中）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Term {
    pub from: YearMonth,
    pub to: Option<YearMonth>,
}

impl Term {
    /// その月が期間に入るか。
    pub fn covers(&self, month: YearMonth) -> bool {
        self.from <= month && self.to.is_none_or(|to| month <= to)
    }
}

/// 契約の入力の問題。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContractIssue {
    /// 月額が未入力か0円以下。
    AmountRequired,
    /// 開始月が未入力・不正。
    FromRequired,
    /// 終了月が不正、または開始月より前。
    ToBeforeFrom,
    /// 計上済みの月が期間から外れる（計上を取り消してから期間を変える）。
    PostedOutsideTerm { month: YearMonth },
}

/// 契約の入力を検査する。`posted` は承認済みで計上している月。
pub fn validate(
    amount: Option<Yen>,
    from: Option<YearMonth>,
    to: Option<Option<YearMonth>>,
    posted: &[YearMonth],
) -> Vec<ContractIssue> {
    let mut issues = Vec::new();
    if !amount.is_some_and(|a| a > 0) {
        issues.push(ContractIssue::AmountRequired);
    }
    let Some(from) = from else {
        issues.push(ContractIssue::FromRequired);
        return issues;
    };
    let to = match to {
        Some(t) => t,
        None => {
            issues.push(ContractIssue::ToBeforeFrom);
            return issues;
        }
    };
    if to.is_some_and(|t| t < from) {
        issues.push(ContractIssue::ToBeforeFrom);
        return issues;
    }
    let term = Term { from, to };
    let mut outside: Vec<YearMonth> = posted
        .iter()
        .copied()
        .filter(|m| !term.covers(*m))
        .collect();
    outside.sort();
    if let Some(month) = outside.first() {
        issues.push(ContractIssue::PostedOutsideTerm { month: *month });
    }
    issues
}

/// 計上の判定に使う契約。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DueContract {
    pub id: i64,
    pub term: Term,
    /// その月を承認済みで計上済みか。
    pub posted: bool,
    /// 案件が月額固定を受け付ける状態か（受注・進行中・作業完了）。
    pub project_open: bool,
}

/// ある月の計上の振り分け。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MonthPlan {
    /// 今回計上する契約。
    pub to_post: Vec<i64>,
    /// 計上済みの契約（二度計上しない）。
    pub already_posted: Vec<i64>,
    /// 期間内だが案件が受け付けない状態の契約（受注前・精算完了・失注など）。
    pub project_closed: Vec<i64>,
}

/// その月に計上すべき契約を選ぶ。期間外の契約は含めない。
pub fn plan_month(contracts: &[DueContract], month: YearMonth) -> MonthPlan {
    let mut plan = MonthPlan::default();
    for c in contracts.iter().filter(|c| c.term.covers(month)) {
        if c.posted {
            plan.already_posted.push(c.id);
        } else if !c.project_open {
            plan.project_closed.push(c.id);
        } else {
            plan.to_post.push(c.id);
        }
    }
    plan
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ym(s: &str) -> YearMonth {
        YearMonth::parse(s).unwrap()
    }

    fn due(id: i64, from: &str, to: Option<&str>, posted: bool, open: bool) -> DueContract {
        DueContract {
            id,
            term: Term {
                from: ym(from),
                to: to.map(ym),
            },
            posted,
            project_open: open,
        }
    }

    #[test]
    fn t37_employees_are_labor_and_vendors_are_outsource() {
        assert_eq!(PayeeKind::Employee.cost_type(), CostType::Labor);
        assert_eq!(PayeeKind::Vendor.cost_type(), CostType::Outsource);
        assert_eq!(PayeeKind::parse("vendor"), Some(PayeeKind::Vendor));
        assert_eq!(PayeeKind::parse("x"), None);
    }

    #[test]
    fn t37_the_term_covers_its_months_and_an_open_end_continues() {
        let t = Term {
            from: ym("2026-06"),
            to: Some(ym("2027-05")),
        };
        assert!(!t.covers(ym("2026-05")));
        assert!(t.covers(ym("2026-06")));
        assert!(t.covers(ym("2027-05")));
        assert!(!t.covers(ym("2027-06")));
        let open = Term {
            from: ym("2026-06"),
            to: None,
        };
        assert!(open.covers(ym("2030-01")));
    }

    #[test]
    fn t37_amount_must_be_positive_and_never_defaults_to_zero() {
        let ok = validate(Some(300_000), Some(ym("2026-06")), Some(None), &[]);
        assert!(ok.is_empty());
        for amount in [None, Some(0), Some(-1)] {
            assert_eq!(
                validate(amount, Some(ym("2026-06")), Some(None), &[]),
                vec![ContractIssue::AmountRequired]
            );
        }
    }

    #[test]
    fn t37_the_end_month_is_not_before_the_start() {
        assert_eq!(
            validate(Some(1), Some(ym("2026-06")), Some(Some(ym("2026-05"))), &[]),
            vec![ContractIssue::ToBeforeFrom]
        );
        assert_eq!(
            validate(Some(1), None, Some(None), &[]),
            vec![ContractIssue::FromRequired]
        );
        assert_eq!(
            validate(Some(1), Some(ym("2026-06")), None, &[]),
            vec![ContractIssue::ToBeforeFrom],
            "不正な終了月"
        );
    }

    #[test]
    fn t37_a_posted_month_cannot_fall_outside_the_new_term() {
        let posted = [ym("2026-06"), ym("2026-07")];
        // 7月まで計上済み：終了月を6月にはできない。
        assert_eq!(
            validate(
                Some(1),
                Some(ym("2026-06")),
                Some(Some(ym("2026-06"))),
                &posted
            ),
            vec![ContractIssue::PostedOutsideTerm {
                month: ym("2026-07")
            }]
        );
        // 7月で終えるのはよい（450,000円→300,000円の切り替えは、終了して新しい契約を作る）。
        assert!(validate(
            Some(1),
            Some(ym("2026-06")),
            Some(Some(ym("2026-07"))),
            &posted
        )
        .is_empty());
    }

    #[test]
    fn t37_a_month_is_posted_once_and_only_on_open_projects() {
        let contracts = [
            due(1, "2026-06", None, false, true),
            due(2, "2026-06", None, true, true),
            due(3, "2026-06", Some("2026-11"), false, true),
            due(4, "2027-01", None, false, true),
            due(5, "2026-06", None, false, false),
        ];
        let plan = plan_month(&contracts, ym("2026-12"));
        assert_eq!(plan.to_post, vec![1]);
        assert_eq!(plan.already_posted, vec![2]);
        assert_eq!(plan.project_closed, vec![5]);
    }
}
