//! 受注転換・部分受注・受注変更（仕様3.1、5.5、7.5）。
//!
//! - 受注転換は同じ案件の状態を受注済みへ切り替え、確定受注額と売上予定を別に設定する。
//!   見込金額を売上実績へ振り替えない（T23）。
//! - 部分受注は元の案件を受注済み範囲にし、未受注範囲を別の案件（残りの見込）に分ける。
//!   元の見込は未受注の集計から外れ、受注分が未受注見込に残らない（T24）。
//! - 受注変更は差額と根拠を記録する。承認前は「未確定追加売上」として確定受注額に含めず、
//!   承認後に確定受注額へ加える（仕様3.1）。

use std::collections::BTreeSet;

use crate::calendar::YearMonth;
use crate::money::Yen;
use crate::pipeline::RevenuePlanLine;
use crate::project::ProjectStatus;

/// 受注の範囲。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConversionScope {
    /// 見込の全体を受注した。
    Whole,
    /// 一部を受注し、残りは別の案件の見込として続ける。
    Partial,
}

impl ConversionScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Whole => "whole",
            Self::Partial => "partial",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "whole" => Some(Self::Whole),
            "partial" => Some(Self::Partial),
            _ => None,
        }
    }
}

/// 受注転換の入力。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversionInput<'a> {
    /// 転換前の案件の状態。
    pub status: ProjectStatus,
    pub confirmed_amount: Yen,
    /// 受注済みの売上予定（未計上残＝確定受注額を月・時期未定に配分）。
    pub plan: &'a [RevenuePlanLine],
    pub scope: ConversionScope,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConversionIssue {
    /// 受注前の有効な状態（引合・見積中・交渉中・保留）でない。
    NotConvertible,
    /// 確定受注額が0円以下。
    AmountNotPositive,
    /// 売上予定がない（時期未定でも1行は要る）。
    PlanMissing,
    PlanNegative,
    DuplicateMonth,
    /// 売上予定の合計が確定受注額と一致しない。
    PlanMismatch {
        plan_total: Yen,
        confirmed: Yen,
    },
}

/// 受注転換の入力を検査する。売上は自動計上しない（売上予定を作るだけ）。
pub fn check_conversion(input: &ConversionInput<'_>) -> Vec<ConversionIssue> {
    let mut issues = Vec::new();
    if !input.status.convertible() {
        issues.push(ConversionIssue::NotConvertible);
    }
    if input.confirmed_amount <= 0 {
        issues.push(ConversionIssue::AmountNotPositive);
    }
    issues.extend(check_plan_lines(input.plan));
    if input.plan.is_empty() {
        issues.push(ConversionIssue::PlanMissing);
    } else {
        let plan_total: Yen = input.plan.iter().map(|l| l.amount).sum();
        if plan_total != input.confirmed_amount {
            issues.push(ConversionIssue::PlanMismatch {
                plan_total,
                confirmed: input.confirmed_amount,
            });
        }
    }
    issues
}

/// 売上予定の行（負の額・同じ月の重複）を検査する。
pub fn check_plan_lines(plan: &[RevenuePlanLine]) -> Vec<ConversionIssue> {
    let mut issues = Vec::new();
    if plan.iter().any(|l| l.amount < 0) {
        issues.push(ConversionIssue::PlanNegative);
    }
    let mut seen: BTreeSet<Option<YearMonth>> = BTreeSet::new();
    if plan.iter().any(|l| !seen.insert(l.month)) {
        issues.push(ConversionIssue::DuplicateMonth);
    }
    issues
}

/// 受注変更の状態。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeStatus {
    /// 承認前（未確定追加売上）。確定受注額・完了見込利益に含めない。
    Pending,
    Approved,
    Rejected,
}

impl ChangeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Rejected => "rejected",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(Self::Pending),
            "approved" => Some(Self::Approved),
            "rejected" => Some(Self::Rejected),
            _ => None,
        }
    }
}

/// 受注変更の1件。`month` は差額を置く売上予定の月（`None` は時期未定）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OrderChange {
    pub delta: Yen,
    pub month: Option<YearMonth>,
    pub status: ChangeStatus,
}

/// 受注転換額と受注変更から確定受注額を求める。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrderBook {
    pub converted_amount: Yen,
    pub changes: Vec<OrderChange>,
}

impl OrderBook {
    /// 確定受注額 ＝ 受注転換額 ＋ 承認済み受注変更の合計。
    pub fn confirmed_amount(&self) -> Yen {
        self.converted_amount
            + self
                .changes
                .iter()
                .filter(|c| c.status == ChangeStatus::Approved)
                .map(|c| c.delta)
                .sum::<Yen>()
    }

    /// 未確定追加売上（承認前の差額の合計）。確定受注額へ足さず別に示す。
    pub fn pending_total(&self) -> Yen {
        self.changes
            .iter()
            .filter(|c| c.status == ChangeStatus::Pending)
            .map(|c| c.delta)
            .sum()
    }

    /// 承認前の差額を売上予定の月ごとに返す（月次見通しの別枠）。
    pub fn pending_lines(&self) -> Vec<RevenuePlanLine> {
        self.changes
            .iter()
            .filter(|c| c.status == ChangeStatus::Pending)
            .map(|c| RevenuePlanLine {
                month: c.month,
                amount: c.delta,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outlook::{monthly_outlook, OutlookKey};
    use crate::pipeline::{totals, PipelineEntry, Stage};

    fn ym(s: &str) -> YearMonth {
        YearMonth::parse(s).unwrap()
    }
    fn line(m: Option<&str>, amount: Yen) -> RevenuePlanLine {
        RevenuePlanLine {
            month: m.map(ym),
            amount,
        }
    }
    fn entry(
        id: &str,
        stage: Stage,
        amount: Yen,
        prob: u8,
        plan: Vec<RevenuePlanLine>,
    ) -> PipelineEntry {
        PipelineEntry {
            id: id.into(),
            stage,
            expected_amount: Some(amount),
            probability_pct: Some(prob),
            expected_order_month: Some(ym("2026-11")),
            revenue_plan: plan,
        }
    }

    #[test]
    fn t23_2800000円の受注転換は売上予定の合計を確定受注額に合わせる() {
        let plan = [line(Some("2026-12"), 2_800_000)];
        let ok = ConversionInput {
            status: ProjectStatus::Negotiating,
            confirmed_amount: 2_800_000,
            plan: &plan,
            scope: ConversionScope::Whole,
        };
        assert_eq!(check_conversion(&ok), vec![]);

        // 見込額（3,000,000円）のままの売上予定は確定受注額と一致しない。
        let stale = [line(Some("2026-12"), 3_000_000)];
        assert_eq!(
            check_conversion(&ConversionInput {
                plan: &stale,
                ..ok.clone()
            }),
            vec![ConversionIssue::PlanMismatch {
                plan_total: 3_000_000,
                confirmed: 2_800_000
            }]
        );
    }

    #[test]
    fn t23_受注転換で未受注見込から外れ確定側に一度だけ入る_売上は自動計上しない() {
        let before = [entry(
            "A",
            Stage::Negotiating,
            3_000_000,
            60,
            vec![line(Some("2026-12"), 3_000_000)],
        )];
        assert_eq!(totals(&before).weighted, 1_800_000);
        // 転換後：案件の状態が受注済みになり、売上予定は受注済みの側に置く。
        let after = [entry(
            "A",
            Stage::Ordered,
            3_000_000,
            60,
            vec![line(Some("2026-12"), 3_000_000)],
        )];
        let t = totals(&after);
        assert_eq!((t.total, t.weighted, t.excluded_count), (0, 0, 1));
        let ordered = [line(Some("2026-12"), 2_800_000)];
        let out = monthly_outlook(&[], &ordered, &after);
        let dec = out.cell(OutlookKey::Month(ym("2026-12")));
        assert_eq!(
            (dec.recognized, dec.ordered_plan, dec.weighted_pipeline),
            (0, 2_800_000, 0)
        );
    }

    #[test]
    fn t24_一部受注は受注分と残りの見込が重ならない() {
        // 元の見込5,000,000円（確度50%）のうち3,000,000円を受注、残り2,000,000円は別案件の見込。
        let plan = [line(Some("2027-01"), 3_000_000)];
        assert_eq!(
            check_conversion(&ConversionInput {
                status: ProjectStatus::Negotiating,
                confirmed_amount: 3_000_000,
                plan: &plan,
                scope: ConversionScope::Partial,
            }),
            vec![]
        );
        let entries = [
            // 元の案件は受注済み：未受注の集計から外れる。
            entry(
                "A",
                Stage::Ordered,
                5_000_000,
                50,
                vec![line(Some("2027-01"), 5_000_000)],
            ),
            // 残りの範囲は新しい案件の見込。
            entry(
                "A-2",
                Stage::Negotiating,
                2_000_000,
                50,
                vec![line(Some("2027-03"), 2_000_000)],
            ),
        ];
        let t = totals(&entries);
        assert_eq!((t.total, t.weighted), (2_000_000, 1_000_000));
        let out = monthly_outlook(&[], &plan, &entries);
        assert_eq!(
            out.cell(OutlookKey::Month(ym("2027-01"))).total(),
            3_000_000
        );
        assert_eq!(
            out.cell(OutlookKey::Month(ym("2027-03"))).total(),
            1_000_000
        );
        let all: Yen = out.cells.values().map(|c| c.total()).sum();
        assert_eq!(all, 4_000_000, "受注分を未受注見込にも数えない");
    }

    #[test]
    fn t24_失注中止と受注済みからは転換しない() {
        let plan = [line(None, 1)];
        for status in [
            ProjectStatus::Lost,
            ProjectStatus::Cancelled,
            ProjectStatus::Ordered,
            ProjectStatus::InProgress,
        ] {
            let issues = check_conversion(&ConversionInput {
                status,
                confirmed_amount: 1,
                plan: &plan,
                scope: ConversionScope::Whole,
            });
            assert_eq!(issues, vec![ConversionIssue::NotConvertible], "{status:?}");
        }
        assert!(ProjectStatus::OnHold.convertible());
    }

    #[test]
    fn 転換の入力不足と重複() {
        let plan = [line(Some("2026-12"), -1), line(Some("2026-12"), 1)];
        assert_eq!(
            check_conversion(&ConversionInput {
                status: ProjectStatus::Lead,
                confirmed_amount: 0,
                plan: &plan,
                scope: ConversionScope::Whole,
            }),
            vec![
                ConversionIssue::AmountNotPositive,
                ConversionIssue::PlanNegative,
                ConversionIssue::DuplicateMonth,
            ]
        );
        assert_eq!(
            check_conversion(&ConversionInput {
                status: ProjectStatus::Lead,
                confirmed_amount: 1,
                plan: &[],
                scope: ConversionScope::Whole,
            }),
            vec![ConversionIssue::PlanMissing]
        );
    }

    #[test]
    fn t24_追加受注は承認まで確定受注額に含めず別枠に示す() {
        let mut book = OrderBook {
            converted_amount: 4_000_000,
            changes: vec![OrderChange {
                delta: 300_000,
                month: Some(ym("2027-02")),
                status: ChangeStatus::Pending,
            }],
        };
        // 仕様12.1：未確定の追加300,000円があっても標準の受注額は4,000,000円のまま。
        assert_eq!(book.confirmed_amount(), 4_000_000);
        assert_eq!(book.pending_total(), 300_000);
        assert_eq!(book.pending_lines(), vec![line(Some("2027-02"), 300_000)]);
        book.changes[0].status = ChangeStatus::Approved;
        assert_eq!(book.confirmed_amount(), 4_300_000);
        assert_eq!(book.pending_total(), 0);
        // 却下した変更はどちらにも入らない（履歴として残す）。
        book.changes.push(OrderChange {
            delta: 100_000,
            month: None,
            status: ChangeStatus::Rejected,
        });
        assert_eq!(
            (book.confirmed_amount(), book.pending_total()),
            (4_300_000, 0)
        );
    }

    #[test]
    fn 状態の文字列は往復する() {
        for s in [
            ChangeStatus::Pending,
            ChangeStatus::Approved,
            ChangeStatus::Rejected,
        ] {
            assert_eq!(ChangeStatus::parse(s.as_str()), Some(s));
        }
        for s in [ConversionScope::Whole, ConversionScope::Partial] {
            assert_eq!(ConversionScope::parse(s.as_str()), Some(s));
        }
    }
}
