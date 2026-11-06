//! 受注前の案件見込（仕様5.4、7.5）。確度は受注成立の可能性で、進捗率ではない。

use std::collections::BTreeMap;

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
    /// 案件見込の版に記録できる営業段階（未受注で有効な段階だけ。失注・保留・受注は案件の状態で表す）。
    pub const VERSION_STAGES: [Stage; 4] =
        [Self::Lead, Self::Quoting, Self::Negotiating, Self::Informal];

    /// DB・通信で使う文字列。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lead => "lead",
            Self::Quoting => "quoting",
            Self::Negotiating => "negotiating",
            Self::Informal => "informal",
            Self::Ordered => "ordered",
            Self::Lost => "lost",
            Self::Cancelled => "cancelled",
            Self::OnHold => "on_hold",
        }
    }

    /// 版に記録できる営業段階の文字列だけを受け付ける。
    pub fn parse_version_stage(s: &str) -> Option<Self> {
        Self::VERSION_STAGES
            .into_iter()
            .find(|stage| stage.as_str() == s)
    }

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

/// 案件見込の版の種類。下書きは集計に使わない。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionKind {
    Draft,
    Adopted,
}

/// 版の番号と種類（集計対象の選択に使う部分だけ）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VersionRef {
    pub version_no: u32,
    pub kind: VersionKind,
}

/// 集計対象の版：案件ごとの最新の採用版一つ（T22）。下書きや古い採用版、
/// 代替案は集計に入れない。採用版が無ければ `None`（その案件は見込なし）。
pub fn current_adopted(versions: &[VersionRef]) -> Option<VersionRef> {
    versions
        .iter()
        .filter(|v| v.kind == VersionKind::Adopted)
        .max_by_key(|v| v.version_no)
        .copied()
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

impl PipelineEntry {
    /// この案件の確度加重見込額。金額か確度が未設定なら `None`（0円にしない）。
    pub fn weighted_amount(&self) -> Option<Yen> {
        Some(weighted(self.expected_amount?, self.probability_pct?))
    }
}

/// 受注予定月別の見込（仕様7.5）。`month: None` は受注予定月が未定。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OrderMonthCell {
    /// 未受注見込総額（確度を掛けない）。
    pub total: Yen,
    /// 確度加重見込額（確度未設定の案件は含めない）。
    pub weighted: Yen,
}

/// 受注予定月で未受注見込総額と確度加重見込額を別々に集計する。売上予定月の
/// 集計（`outlook::monthly_outlook`）とは足し合わせない（T25）。金額未設定の
/// 案件は入れず、[`totals`] の `missing_amount` で示す。
pub fn by_order_month(entries: &[PipelineEntry]) -> BTreeMap<Option<YearMonth>, OrderMonthCell> {
    let mut cells: BTreeMap<Option<YearMonth>, OrderMonthCell> = BTreeMap::new();
    for e in entries.iter().filter(|e| e.stage.is_active_pipeline()) {
        let Some(amount) = e.expected_amount else {
            continue;
        };
        let cell = cells.entry(e.expected_order_month).or_default();
        cell.total += amount;
        if let Some(p) = e.probability_pct {
            cell.weighted += weighted(amount, p);
        }
    }
    cells
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
    fn t22_集計対象は最新の採用版一つ_下書きと旧版は使わない() {
        let v = |version_no, kind| VersionRef { version_no, kind };
        let versions = [
            v(1, VersionKind::Adopted),
            v(2, VersionKind::Adopted),
            v(3, VersionKind::Draft),
        ];
        assert_eq!(current_adopted(&versions), Some(v(2, VersionKind::Adopted)));
        assert_eq!(current_adopted(&[v(1, VersionKind::Draft)]), None);
        assert_eq!(current_adopted(&[]), None);
    }

    #[test]
    fn t25_受注予定月と売上予定月は別々に集計し_未定は独立して見える() {
        let mut a = entry(
            "A",
            Stage::Negotiating,
            Some(3_000_000),
            Some(60),
            &[(Some("2027-01"), 1_000_000), (None, 2_000_000)],
        );
        a.expected_order_month = Some(YearMonth::parse("2026-11").unwrap());
        let b = entry(
            "B",
            Stage::Quoting,
            Some(1_000_000),
            None,
            &[(Some("2026-11"), 1_000_000)],
        );
        let lost = entry("L", Stage::Lost, Some(9_000_000), Some(90), &[]);
        let entries = [a.clone(), b, lost];

        let by_order = by_order_month(&entries);
        let nov = Some(YearMonth::parse("2026-11").unwrap());
        assert_eq!(
            by_order.get(&nov),
            Some(&OrderMonthCell {
                total: 3_000_000,
                weighted: 1_800_000
            })
        );
        // B has no order month and no probability: total only, under "undecided".
        assert_eq!(
            by_order.get(&None),
            Some(&OrderMonthCell {
                total: 1_000_000,
                weighted: 0
            })
        );
        assert_eq!(by_order.len(), 2, "lost projects are not aggregated");

        // Revenue months come from the plan, weighted per line; the undecided
        // part stays on its own key and B (no probability) is excluded.
        let revenue = crate::outlook::monthly_outlook(&[], &[], &entries);
        use crate::outlook::OutlookKey;
        assert_eq!(
            revenue
                .cell(OutlookKey::Month(YearMonth::parse("2027-01").unwrap()))
                .weighted_pipeline,
            600_000
        );
        assert_eq!(
            revenue.cell(OutlookKey::Undated).weighted_pipeline,
            1_200_000
        );
        assert_eq!(
            revenue
                .cell(OutlookKey::Month(YearMonth::parse("2026-11").unwrap()))
                .weighted_pipeline,
            0
        );
        assert_eq!(revenue.excluded, vec!["B".to_string()]);

        assert_eq!(a.weighted_amount(), Some(1_800_000));
        assert_eq!(entries[1].weighted_amount(), None);
    }

    #[test]
    fn 版に記録できる段階() {
        for stage in Stage::VERSION_STAGES {
            assert_eq!(Stage::parse_version_stage(stage.as_str()), Some(stage));
        }
        assert_eq!(Stage::parse_version_stage("lost"), None);
        assert_eq!(Stage::parse_version_stage("ordered"), None);
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
