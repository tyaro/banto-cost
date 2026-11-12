//! 全体一覧の注意表示（仕様第9章）。
//!
//! 閾値は会社の計算基準（`review_delay_days`・`low_margin_pct`）で、未設定ならその注意は判定しない
//! （勝手な既定値で注意を出したり消したりしない）。画面内の表示だけで、外部へは送らない。
//!
//! - 受注前（引合・見積中・交渉中）：受注予定月超過、営業見込の確認遅れ、確度・時期未設定。
//! - 受注済みで精算前（受注・進行中・作業完了）：完了見込赤字、予算超過見込み、低利益率、
//!   未承認、未確定追加売上、見込更新要、完了見込なし、未精算発注残（作業完了で発注残あり）。
//! - 失注・中止・保留・精算完了は標準の集計から外すので、注意を出さない。

use crate::calendar::{Date, YearMonth};
use crate::forecast::{profit, UpdateReason};
use crate::money::Yen;
use crate::project::ProjectStatus;

/// 確認遅れ日数の計算基準の項目。
pub const REVIEW_DELAY_ITEM: &str = "review_delay_days";
/// 低利益率の閾値の計算基準の項目（整数パーセント、案件で上書きできる）。
pub const LOW_MARGIN_ITEM: &str = "low_margin_pct";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Alert {
    /// 受注予定月を過ぎても受注していない。
    OrderMonthPassed,
    /// 営業見込の最終確認日から確認遅れ日数を超えた（確認日なしを含む）。
    ReviewOverdue,
    /// 金額・確度・受注予定月の未設定、採用版なしなど（案件見込一覧の「不足あり」）。
    PipelineUnset,
    /// 完了見込直接利益がマイナス。
    ForecastLoss,
    /// 完了見込原価が現在の承認原価予算を超える。
    ForecastOverBudget,
    /// 完了見込直接利益率が閾値を下回る（赤字のときは赤字だけを出す）。
    LowMargin,
    /// 未承認（下書き・申請中・差戻し）の工数・直接費がある。
    Unapproved,
    /// 未確定追加売上（承認前の受注変更）がある。
    PendingAddition,
    /// 採用版の基準日より後の実績・過去実績の訂正・単価や受注額の変更がある。
    ForecastUpdateNeeded,
    /// 受注済みなのに採用済みの完了見込がない。
    NoForecast,
    /// 作業完了なのに未実績の発注残がある。
    OpenCommitment,
    /// 直接費の台帳に読めない・不整合の明細があり、直接費を確定できない（T39）。
    LedgerReview,
}

impl Alert {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OrderMonthPassed => "order_month_passed",
            Self::ReviewOverdue => "review_overdue",
            Self::PipelineUnset => "pipeline_unset",
            Self::ForecastLoss => "forecast_loss",
            Self::ForecastOverBudget => "forecast_over_budget",
            Self::LowMargin => "low_margin",
            Self::Unapproved => "unapproved",
            Self::PendingAddition => "pending_addition",
            Self::ForecastUpdateNeeded => "forecast_update_needed",
            Self::NoForecast => "no_forecast",
            Self::OpenCommitment => "open_commitment",
            Self::LedgerReview => "ledger_review",
        }
    }
}

/// 注意表示の閾値。`None` は未設定（その注意は判定しない）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Thresholds {
    pub review_delay_days: Option<i64>,
    /// 整数パーセント。
    pub low_margin_pct: Option<i64>,
}

/// 受注前の案件の状態（最新の採用版から）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreOrderFacts {
    pub expected_order_month: Option<YearMonth>,
    pub confirmed_on: Option<Date>,
    /// 案件見込一覧の「不足あり」が一つでもある。
    pub unset: bool,
}

/// 採用済みの完了見込。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForecastFacts {
    /// 完了見込原価。
    pub cost: Yen,
    pub update_reasons: Vec<UpdateReason>,
}

/// 受注済みの案件の状態。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OrderedFacts {
    /// 現在の確定受注額。
    pub order_amount: Option<Yen>,
    /// 現在の承認原価予算。予算がなければ `None`（予算超過見込みは判定しない）。
    pub budget: Option<Yen>,
    pub forecast: Option<ForecastFacts>,
    /// 未承認の工数・直接費の件数。
    pub unapproved: usize,
    /// 未確定追加売上の合計（0円は「なし」）。
    pub pending_addition: Yen,
    /// 未実績発注残の合計。
    pub committed: Yen,
}

/// 案件の注意表示を判定する。結果は [`Alert`] の順に並ぶ。
pub fn evaluate(
    status: ProjectStatus,
    pre: Option<&PreOrderFacts>,
    ordered: Option<&OrderedFacts>,
    today: Date,
    t: &Thresholds,
) -> Vec<Alert> {
    let mut out = Vec::new();
    match status {
        ProjectStatus::Lead | ProjectStatus::Quoting | ProjectStatus::Negotiating => {
            let Some(p) = pre else {
                out.push(Alert::PipelineUnset);
                return out;
            };
            if p.expected_order_month
                .is_some_and(|m| m < today.year_month())
            {
                out.push(Alert::OrderMonthPassed);
            }
            if let Some(days) = t.review_delay_days {
                let late = match p.confirmed_on {
                    Some(on) => today.day_number() - on.day_number() > days,
                    None => true,
                };
                if late {
                    out.push(Alert::ReviewOverdue);
                }
            }
            if p.unset {
                out.push(Alert::PipelineUnset);
            }
        }
        ProjectStatus::Ordered | ProjectStatus::InProgress | ProjectStatus::WorkDone => {
            let o = ordered.cloned().unwrap_or_default();
            if let Some(f) = &o.forecast {
                let pr = profit(o.order_amount, f.cost);
                if pr.amount < 0 {
                    out.push(Alert::ForecastLoss);
                }
                if o.budget.is_some_and(|b| f.cost > b) {
                    out.push(Alert::ForecastOverBudget);
                }
                if pr.amount >= 0 {
                    if let (Some(pct), Some(r)) = (t.low_margin_pct, pr.ratio_permille) {
                        if r < pct * 10 {
                            out.push(Alert::LowMargin);
                        }
                    }
                }
            }
            if o.unapproved > 0 {
                out.push(Alert::Unapproved);
            }
            if o.pending_addition != 0 {
                out.push(Alert::PendingAddition);
            }
            match &o.forecast {
                Some(f) if !f.update_reasons.is_empty() => out.push(Alert::ForecastUpdateNeeded),
                Some(_) => {}
                None => out.push(Alert::NoForecast),
            }
            if status == ProjectStatus::WorkDone && o.committed > 0 {
                out.push(Alert::OpenCommitment);
            }
        }
        ProjectStatus::Settled
        | ProjectStatus::Lost
        | ProjectStatus::Cancelled
        | ProjectStatus::OnHold => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> Date {
        Date::parse(s).unwrap()
    }

    const TODAY: &str = "2026-11-07";

    #[test]
    fn 受注前_受注予定月超過_確認遅れ_未設定() {
        let t = Thresholds {
            review_delay_days: Some(30),
            low_margin_pct: None,
        };
        let ok = PreOrderFacts {
            expected_order_month: YearMonth::parse("2026-11"),
            confirmed_on: Some(d("2026-10-20")),
            unset: false,
        };
        assert!(evaluate(ProjectStatus::Quoting, Some(&ok), None, d(TODAY), &t).is_empty());
        let late = PreOrderFacts {
            expected_order_month: YearMonth::parse("2026-10"),
            confirmed_on: Some(d("2026-10-07")),
            unset: true,
        };
        assert_eq!(
            evaluate(ProjectStatus::Lead, Some(&late), None, d(TODAY), &t),
            vec![
                Alert::OrderMonthPassed,
                Alert::ReviewOverdue,
                Alert::PipelineUnset
            ]
        );
        // 確認日なしは確認遅れ。閾値が未設定なら判定しない。
        let never = PreOrderFacts {
            confirmed_on: None,
            ..ok
        };
        assert_eq!(
            evaluate(ProjectStatus::Negotiating, Some(&never), None, d(TODAY), &t),
            vec![Alert::ReviewOverdue]
        );
        assert!(evaluate(
            ProjectStatus::Negotiating,
            Some(&never),
            None,
            d(TODAY),
            &Thresholds::default()
        )
        .is_empty());
        // 採用版なし。
        assert_eq!(
            evaluate(ProjectStatus::Lead, None, None, d(TODAY), &t),
            vec![Alert::PipelineUnset]
        );
    }

    fn spec_ordered(cost: Yen) -> OrderedFacts {
        OrderedFacts {
            order_amount: Some(4_000_000),
            budget: Some(2_600_000),
            forecast: Some(ForecastFacts {
                cost,
                update_reasons: vec![],
            }),
            unapproved: 0,
            pending_addition: 0,
            committed: 400_000,
        }
    }

    #[test]
    fn t28_予算超過見込みと低利益率() {
        let t = Thresholds {
            review_delay_days: None,
            low_margin_pct: Some(30),
        };
        // 仕様12.5：完了見込原価3,000,000円、利益率25.0% < 30%、予算2,600,000円を超過。
        assert_eq!(
            evaluate(
                ProjectStatus::InProgress,
                None,
                Some(&spec_ordered(3_000_000)),
                d(TODAY),
                &t
            ),
            vec![Alert::ForecastOverBudget, Alert::LowMargin]
        );
        // 予算内・閾値以上なら注意なし。
        assert!(evaluate(
            ProjectStatus::Ordered,
            None,
            Some(&spec_ordered(2_500_000)),
            d(TODAY),
            &t
        )
        .is_empty());
        // 赤字は赤字だけ（低利益率は重ねない）。
        assert_eq!(
            evaluate(
                ProjectStatus::Ordered,
                None,
                Some(&spec_ordered(4_100_000)),
                d(TODAY),
                &t
            ),
            vec![Alert::ForecastLoss, Alert::ForecastOverBudget]
        );
    }

    #[test]
    fn t30_見込更新要と見込なし_未承認_未確定追加_発注残() {
        let t = Thresholds::default();
        let mut o = spec_ordered(2_900_000);
        o.forecast.as_mut().unwrap().update_reasons = vec![UpdateReason::ActualAfterBase];
        o.unapproved = 2;
        o.pending_addition = 300_000;
        assert_eq!(
            evaluate(ProjectStatus::WorkDone, None, Some(&o), d(TODAY), &t),
            vec![
                Alert::ForecastOverBudget,
                Alert::Unapproved,
                Alert::PendingAddition,
                Alert::ForecastUpdateNeeded,
                Alert::OpenCommitment
            ]
        );
        let none = OrderedFacts {
            forecast: None,
            committed: 0,
            ..spec_ordered(0)
        };
        assert_eq!(
            evaluate(ProjectStatus::Ordered, None, Some(&none), d(TODAY), &t),
            vec![Alert::NoForecast]
        );
        // 進行中の発注残は通常の状態。
        assert!(evaluate(
            ProjectStatus::InProgress,
            None,
            Some(&spec_ordered(2_500_000)),
            d(TODAY),
            &t
        )
        .is_empty());
    }

    #[test]
    fn 除外状態と精算完了は注意を出さない() {
        for s in [
            ProjectStatus::Lost,
            ProjectStatus::Cancelled,
            ProjectStatus::OnHold,
            ProjectStatus::Settled,
        ] {
            assert!(evaluate(s, None, None, d(TODAY), &Thresholds::default()).is_empty());
        }
    }
}
