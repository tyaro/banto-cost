//! 月次売上見通し（仕様7.5）。
//!
//! 月次売上見通し ＝ 計上済み売上 ＋ 受注済み売上予定 ＋ 未受注の売上予定 × 確度。
//! 三つの内訳は分けて返し、受注予定月の金額とは足さない。

use std::collections::BTreeMap;

use crate::calendar::YearMonth;
use crate::money::{weighted, Yen};
use crate::pipeline::{PipelineEntry, RevenuePlanLine};

/// 集計の行。時期未定は独立した行にする。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum OutlookKey {
    Month(YearMonth),
    Undated,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OutlookCell {
    pub recognized: Yen,
    pub ordered_plan: Yen,
    pub weighted_pipeline: Yen,
}

impl OutlookCell {
    pub fn total(&self) -> Yen {
        self.recognized + self.ordered_plan + self.weighted_pipeline
    }
}

/// 計上済み売上の1件。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Recognition {
    pub month: YearMonth,
    pub amount: Yen,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Outlook {
    pub cells: BTreeMap<OutlookKey, OutlookCell>,
    /// 金額または確度が未設定で、確度加重から除いた案件。
    pub excluded: Vec<String>,
}

impl Outlook {
    pub fn cell(&self, key: OutlookKey) -> OutlookCell {
        self.cells.get(&key).copied().unwrap_or_default()
    }
}

fn key_of(month: Option<YearMonth>) -> OutlookKey {
    month.map_or(OutlookKey::Undated, OutlookKey::Month)
}

/// 月次売上見通しを集計する。
///
/// - `recognized`：経理が承認した売上計上。
/// - `ordered_plans`：確定受注の未計上残を月に配分した売上予定（実績計上分は消し込み済みのもの）。
/// - `pipeline`：未受注案件の最新採用版。受注済み・失注・保留は自動で除く。
pub fn monthly_outlook(
    recognized: &[Recognition],
    ordered_plans: &[RevenuePlanLine],
    pipeline: &[PipelineEntry],
) -> Outlook {
    let mut o = Outlook::default();
    for r in recognized {
        o.cells
            .entry(OutlookKey::Month(r.month))
            .or_default()
            .recognized += r.amount;
    }
    for p in ordered_plans {
        o.cells.entry(key_of(p.month)).or_default().ordered_plan += p.amount;
    }
    for e in pipeline.iter().filter(|e| e.stage.is_active_pipeline()) {
        let (Some(_), Some(prob)) = (e.expected_amount, e.probability_pct) else {
            o.excluded.push(e.id.clone());
            continue;
        };
        for l in &e.revenue_plan {
            o.cells
                .entry(key_of(l.month))
                .or_default()
                .weighted_pipeline += weighted(l.amount, prob);
        }
    }
    o
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::Stage;

    fn ym(s: &str) -> YearMonth {
        YearMonth::parse(s).unwrap()
    }
    fn plan(m: &str, amount: Yen) -> RevenuePlanLine {
        RevenuePlanLine {
            month: Some(ym(m)),
            amount,
        }
    }
    fn case_a(stage: Stage) -> PipelineEntry {
        PipelineEntry {
            id: "A".into(),
            stage,
            expected_amount: Some(3_000_000),
            probability_pct: Some(60),
            expected_order_month: Some(ym("2026-11")),
            revenue_plan: vec![plan("2026-12", 3_000_000)],
        }
    }

    #[test]
    fn t27_受注前の12月見通しは3300000円() {
        let rec = [Recognition {
            month: ym("2026-12"),
            amount: 500_000,
        }];
        let ordered = [plan("2026-12", 1_000_000)];
        let o = monthly_outlook(&rec, &ordered, &[case_a(Stage::Negotiating)]);
        let dec = o.cell(OutlookKey::Month(ym("2026-12")));
        assert_eq!(
            dec,
            OutlookCell {
                recognized: 500_000,
                ordered_plan: 1_000_000,
                weighted_pipeline: 1_800_000
            }
        );
        assert_eq!(dec.total(), 3_300_000);
        // 受注予定月の11月には売上見込を置かない（受注予定月と売上予定月を足さない）。
        assert_eq!(o.cell(OutlookKey::Month(ym("2026-11"))).total(), 0);
    }

    #[test]
    fn t23_t27_受注転換後は4300000円_スナップショットは不変() {
        let rec = [Recognition {
            month: ym("2026-12"),
            amount: 500_000,
        }];
        let before = monthly_outlook(
            &rec,
            &[plan("2026-12", 1_000_000)],
            &[case_a(Stage::Negotiating)],
        );
        let snapshot = before.clone();
        // 2,800,000円で正式受注：未受注側から外れ、受注済み売上予定に一度だけ入る。
        let after = monthly_outlook(
            &rec,
            &[plan("2026-12", 1_000_000), plan("2026-12", 2_800_000)],
            &[case_a(Stage::Ordered)],
        );
        let dec = after.cell(OutlookKey::Month(ym("2026-12")));
        assert_eq!(
            dec,
            OutlookCell {
                recognized: 500_000,
                ordered_plan: 3_800_000,
                weighted_pipeline: 0
            }
        );
        assert_eq!(dec.total(), 4_300_000);
        assert_eq!(
            snapshot.cell(OutlookKey::Month(ym("2026-12"))).total(),
            3_300_000
        );
    }

    #[test]
    fn t25_時期未定は独立した行_未設定は除外() {
        let mut b = case_a(Stage::Quoting);
        b.id = "B".into();
        b.revenue_plan = vec![RevenuePlanLine {
            month: None,
            amount: 3_000_000,
        }];
        let mut c = case_a(Stage::Quoting);
        c.id = "C".into();
        c.probability_pct = None;
        let o = monthly_outlook(&[], &[], &[b, c]);
        assert_eq!(o.cell(OutlookKey::Undated).weighted_pipeline, 1_800_000);
        assert_eq!(o.excluded, vec!["C".to_string()]);
    }
}
