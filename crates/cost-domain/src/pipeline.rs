//! 受注前の案件見込（仕様5.4、7.5）。確度は受注成立の可能性で、進捗率ではない。

use crate::calendar::YearMonth;
use crate::money::{weighted, Yen};

/// 営業段階。失注・中止・保留は現時点の見込集計から外す。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Lead,
    Quoting,
    Negotiating,
    Informal,
    Ordered,
    Lost,
    Cancelled,
    OnHold,
}

impl Stage {
    /// 未受注見込として集計する段階か。
    pub fn is_active_pipeline(self) -> bool {
        matches!(
            self,
            Self::Lead | Self::Quoting | Self::Negotiating | Self::Informal
        )
    }
}

/// 売上予定の1行。`month: None` は時期未定（任意の月に配分しない）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RevenuePlanLine {
    pub month: Option<YearMonth>,
    pub amount: Yen,
}

/// 案件ごとの最新採用版。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineEntry {
    pub id: String,
    pub stage: Stage,
    pub expected_amount: Option<Yen>,
    /// 0〜99。受注済みは `Stage::Ordered` で表し、ここで100%にしない。
    pub probability_pct: Option<u8>,
    pub expected_order_month: Option<YearMonth>,
    pub revenue_plan: Vec<RevenuePlanLine>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PipelineIssue {
    ProbabilityOutOfRange,
    /// 売上予定の合計が見込受注額と一致しない。
    PlanMismatch {
        plan_total: Yen,
        expected: Yen,
    },
}

impl PipelineEntry {
    pub fn validate(&self) -> Vec<PipelineIssue> {
        let mut issues = Vec::new();
        if self.probability_pct.is_some_and(|p| p > 99) {
            issues.push(PipelineIssue::ProbabilityOutOfRange);
        }
        if let Some(expected) = self.expected_amount {
            let plan_total: Yen = self.revenue_plan.iter().map(|l| l.amount).sum();
            if !self.revenue_plan.is_empty() && plan_total != expected {
                issues.push(PipelineIssue::PlanMismatch {
                    plan_total,
                    expected,
                });
            }
        }
        issues
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PipelineTotals {
    pub active_count: usize,
    /// 未受注見込総額（確度を掛けない）。
    pub total: Yen,
    /// 確度加重見込額。
    pub weighted: Yen,
    /// 金額未設定で除外した案件。
    pub missing_amount: Vec<String>,
    /// 確度未設定で加重計算から除外した案件（総額には含む）。
    pub missing_probability: Vec<String>,
    /// 失注・保留などで集計外の件数。
    pub excluded_count: usize,
}

pub fn totals(entries: &[PipelineEntry]) -> PipelineTotals {
    let mut t = PipelineTotals::default();
    for e in entries {
        if !e.stage.is_active_pipeline() {
            t.excluded_count += 1;
            continue;
        }
        t.active_count += 1;
        let Some(amount) = e.expected_amount else {
            t.missing_amount.push(e.id.clone());
            continue;
        };
        t.total += amount;
        match e.probability_pct {
            Some(p) => t.weighted += weighted(amount, p),
            None => t.missing_probability.push(e.id.clone()),
        }
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn entry(
        id: &str,
        stage: Stage,
        amount: Option<Yen>,
        prob: Option<u8>,
        plan: &[(Option<&str>, Yen)],
    ) -> PipelineEntry {
        PipelineEntry {
            id: id.into(),
            stage,
            expected_amount: amount,
            probability_pct: prob,
            expected_order_month: None,
            revenue_plan: plan
                .iter()
                .map(|(m, a)| RevenuePlanLine {
                    month: m.map(|s| YearMonth::parse(s).unwrap()),
                    amount: *a,
                })
                .collect(),
        }
    }

    #[test]
    fn t21_見込3000000円確度60パーセント() {
        let t = totals(&[entry(
            "A",
            Stage::Negotiating,
            Some(3_000_000),
            Some(60),
            &[(Some("2026-12"), 3_000_000)],
        )]);
        assert_eq!((t.total, t.weighted), (3_000_000, 1_800_000));
    }

    #[test]
    fn t24_t25_失注保留は集計外_未設定は理由つきで除外() {
        let t = totals(&[
            entry("A", Stage::Negotiating, Some(3_000_000), Some(60), &[]),
            entry("B", Stage::Quoting, Some(2_500_000), None, &[]),
            entry("C", Stage::Lead, None, Some(10), &[]),
            entry("D", Stage::OnHold, Some(5_000_000), Some(50), &[]),
            entry("E", Stage::Lost, Some(900_000), Some(0), &[]),
            entry("F", Stage::Ordered, Some(1_000_000), None, &[]),
        ]);
        assert_eq!(t.active_count, 3);
        assert_eq!(t.total, 5_500_000);
        assert_eq!(t.weighted, 1_800_000);
        assert_eq!(t.missing_probability, vec!["B".to_string()]);
        assert_eq!(t.missing_amount, vec!["C".to_string()]);
        assert_eq!(t.excluded_count, 3);
    }

    #[test]
    fn 売上予定の合計と確度の範囲を検査() {
        let e = entry(
            "A",
            Stage::Quoting,
            Some(1_000_000),
            Some(100),
            &[(Some("2027-01"), 600_000), (None, 300_000)],
        );
        assert_eq!(
            e.validate(),
            vec![
                PipelineIssue::ProbabilityOutOfRange,
                PipelineIssue::PlanMismatch {
                    plan_total: 900_000,
                    expected: 1_000_000
                }
            ]
        );
    }
}
