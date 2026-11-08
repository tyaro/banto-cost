//! 定期売上（設計案 9.2 の4・9.4 の2・6、受入条件 T38）。
//!
//! 月額契約は1つの案件にまとめ、取り決め（月額・開始月・終了月）から月別の売上予定を作る。
//! 売上は各月の月末を検収日として計上し、その月の売上予定を消し込む。
//!
//! - 取り決めの月額×月数は確定受注額に一致させる。合わなければ予定を作らずに返す
//!   （受注変更で確定受注額を直すか、期間・月額を見直す）。0円に丸めない。
//! - 予定を作り直すのは未計上の分だけで、計上済みの月の消込額は残す。計上済みの額より小さい
//!   月額や、計上済みの月を外す期間にはしない。
//! - 月の計上はその月の売上予定の未消込額で、月に1回だけ（未消込が0円なら計上しない）。
//! - 目標粗利率は最初の検収日（最初の月の計上日）の値を使う（2026-11-08 ユーザー決定。
//!   `funds::rate_date`）。

use std::collections::BTreeMap;

use crate::calendar::YearMonth;
use crate::money::Yen;
use crate::pipeline::RevenuePlanLine;
use crate::revenue::{OrderedRevenue, RevenueIssue};

/// 1つの取り決めの最長の月数（売上予定の行数の上限と同じ）。
pub const MAX_MONTHS: usize = 60;

/// 月の計上の根拠（売上計上の `basis`）。
pub const RECOGNITION_BASIS: &str = "定期売上（月末検収）";

/// 取り決めの期間。開始月から終了月まで（両端を含む）。終了月は必須。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Term {
    pub from: YearMonth,
    pub to: YearMonth,
}

impl Term {
    pub fn covers(&self, month: YearMonth) -> bool {
        self.from <= month && month <= self.to
    }

    /// 期間の各月（古い順）。
    pub fn months(&self) -> Vec<YearMonth> {
        let mut out = Vec::new();
        let mut m = self.from;
        while m <= self.to {
            out.push(m);
            m = m.next();
        }
        out
    }
}

/// 取り決めの入力・予定作成の問題。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgreementIssue {
    /// 月額が未入力か0円以下。
    AmountRequired,
    /// 開始月が未入力・不正。
    FromRequired,
    /// 終了月が未入力・不正。
    ToRequired,
    /// 終了月が開始月より前。
    ToBeforeFrom,
    /// 期間が長すぎる。
    TooLong { max: usize },
    /// 月額×月数が確定受注額と一致しない。
    TotalMismatch {
        contract_total: Yen,
        order_amount: Yen,
    },
    /// 期間内の月に、新しい月額を超える計上済みの額がある。
    RecognizedOverAmount { month: YearMonth, recognized: Yen },
    /// 計上済みの月が期間から外れる（時期未定の計上も含む）。
    RecognizedOutsideTerm { month: Option<YearMonth> },
    /// 予定と計上の整合の検査に通らない（`revenue::OrderedRevenue::check`）。
    Revenue(Vec<RevenueIssue>),
}

/// 取り決めの入力を検査する（月額・期間）。
pub fn validate(
    amount: Option<Yen>,
    from: Option<YearMonth>,
    to: Option<YearMonth>,
) -> Result<(Yen, Term), Vec<AgreementIssue>> {
    let mut issues = Vec::new();
    let amount = amount.filter(|a| *a > 0);
    if amount.is_none() {
        issues.push(AgreementIssue::AmountRequired);
    }
    if from.is_none() {
        issues.push(AgreementIssue::FromRequired);
    }
    if to.is_none() {
        issues.push(AgreementIssue::ToRequired);
    }
    let (Some(amount), Some(from), Some(to)) = (amount, from, to) else {
        return Err(issues);
    };
    if to < from {
        return Err(vec![AgreementIssue::ToBeforeFrom]);
    }
    let term = Term { from, to };
    if term.months().len() > MAX_MONTHS {
        return Err(vec![AgreementIssue::TooLong { max: MAX_MONTHS }]);
    }
    Ok((amount, term))
}

/// 取り決めの総額（月額×月数）。
pub fn contract_total(amount: Yen, term: Term) -> Yen {
    amount * term.months().len() as Yen
}

/// 取り決めから売上予定を作り直す。期間の各月に「月額 − その月の消込済み額」を未消込の
/// 予定として置き、それ以外の未消込の予定（時期未定を含む）は無くす。結果は
/// `OrderedRevenue::replan` の検査を通る。
pub fn regenerate(
    revenue: &OrderedRevenue,
    amount: Yen,
    term: Term,
) -> Result<OrderedRevenue, Vec<AgreementIssue>> {
    let total = contract_total(amount, term);
    if total != revenue.order_amount {
        return Err(vec![AgreementIssue::TotalMismatch {
            contract_total: total,
            order_amount: revenue.order_amount,
        }]);
    }
    let mut cleared: BTreeMap<Option<YearMonth>, Yen> = BTreeMap::new();
    for (id, month, open) in revenue.open_by_line() {
        let planned = revenue
            .plans
            .iter()
            .find(|p| p.id == id)
            .map_or(0, |p| p.amount);
        let c = planned - open;
        if c != 0 {
            *cleared.entry(month).or_default() += c;
        }
    }
    let mut issues = Vec::new();
    for (month, c) in &cleared {
        match month {
            Some(m) if term.covers(*m) => {
                if *c > amount {
                    issues.push(AgreementIssue::RecognizedOverAmount {
                        month: *m,
                        recognized: *c,
                    });
                }
            }
            _ => issues.push(AgreementIssue::RecognizedOutsideTerm { month: *month }),
        }
    }
    if !issues.is_empty() {
        return Err(issues);
    }
    let open: Vec<RevenuePlanLine> = term
        .months()
        .into_iter()
        .map(|m| RevenuePlanLine {
            month: Some(m),
            amount: amount - cleared.get(&Some(m)).copied().unwrap_or(0),
        })
        .collect();
    revenue
        .replan(&open)
        .map_err(|e| vec![AgreementIssue::Revenue(e)])
}

/// ある月の取り決めの状態。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonthState {
    /// 計上する（額はその月の売上予定の未消込額）。
    Due { amount: Yen },
    /// その月の予定は消込済み（計上済み）。
    Recognized,
    /// 案件が受け付けない状態（受注前・精算完了など）。
    ProjectClosed,
    /// その月に未消込の予定がない（予定の組み替えで他の月へ移したなど）。
    NoPlan,
}

/// 月の計上の判定に使う値。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonthFacts {
    pub term: Term,
    /// その月の売上予定の予定額（消込済みを含む）。行がなければ0。
    pub planned: Yen,
    /// その月の売上予定の未消込額。
    pub open: Yen,
    /// 案件が受注・進行中・作業完了か。
    pub project_open: bool,
}

/// 月の状態を決める。期間外なら `None`。
pub fn month_state(facts: &MonthFacts, month: YearMonth) -> Option<MonthState> {
    if !facts.term.covers(month) {
        return None;
    }
    Some(if facts.open > 0 {
        if facts.project_open {
            MonthState::Due { amount: facts.open }
        } else {
            MonthState::ProjectClosed
        }
    } else if facts.planned > 0 {
        MonthState::Recognized
    } else {
        MonthState::NoPlan
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::revenue::{Clearing, PlanLine, RecognizedSale};

    fn ym(s: &str) -> YearMonth {
        YearMonth::parse(s).unwrap()
    }

    fn term(from: &str, to: &str) -> Term {
        Term {
            from: ym(from),
            to: ym(to),
        }
    }

    fn ordered(amount: Yen, plans: Vec<(&str, Option<&str>, Yen)>) -> OrderedRevenue {
        OrderedRevenue {
            order_amount: amount,
            plans: plans
                .into_iter()
                .map(|(id, m, a)| PlanLine {
                    id: id.into(),
                    month: m.map(ym),
                    amount: a,
                })
                .collect(),
            sales: vec![],
        }
    }

    fn open_months(r: &OrderedRevenue) -> Vec<(Option<YearMonth>, Yen)> {
        r.open_plans().iter().map(|l| (l.month, l.amount)).collect()
    }

    #[test]
    fn t38_the_input_needs_a_positive_amount_and_a_closed_term() {
        assert_eq!(
            validate(Some(300_000), Some(ym("2026-06")), Some(ym("2027-05"))),
            Ok((300_000, term("2026-06", "2027-05")))
        );
        assert_eq!(
            validate(Some(0), None, None),
            Err(vec![
                AgreementIssue::AmountRequired,
                AgreementIssue::FromRequired,
                AgreementIssue::ToRequired
            ])
        );
        assert_eq!(
            validate(Some(1), Some(ym("2026-06")), Some(ym("2026-05"))),
            Err(vec![AgreementIssue::ToBeforeFrom])
        );
        assert_eq!(
            validate(Some(1), Some(ym("2026-01")), Some(ym("2031-01"))),
            Err(vec![AgreementIssue::TooLong { max: MAX_MONTHS }])
        );
        assert_eq!(term("2026-06", "2027-05").months().len(), 12);
    }

    #[test]
    fn t38_twelve_monthly_plans_are_generated_from_the_agreement() {
        // 受注時の予定は時期未定に全額。
        let r = ordered(3_600_000, vec![("1", None, 3_600_000)]);
        let next = regenerate(&r, 300_000, term("2026-06", "2027-05")).unwrap();
        let open = open_months(&next);
        assert_eq!(open.len(), 12);
        assert!(open.iter().all(|(m, a)| m.is_some() && *a == 300_000));
        assert_eq!(open[0].0, Some(ym("2026-06")));
        assert_eq!(open[11].0, Some(ym("2027-05")));
        assert!(next.check().is_empty());
    }

    #[test]
    fn t38_the_contract_total_must_equal_the_confirmed_order() {
        let r = ordered(3_000_000, vec![("1", None, 3_000_000)]);
        assert_eq!(
            regenerate(&r, 300_000, term("2026-06", "2027-05")).unwrap_err(),
            vec![AgreementIssue::TotalMismatch {
                contract_total: 3_600_000,
                order_amount: 3_000_000
            }]
        );
    }

    #[test]
    fn t38_recognized_months_are_kept_when_regenerating() {
        // 6月を計上済み。期間を変えずに作り直しても6月は消込のまま、未消込は7月〜。
        let mut r = ordered(
            3_600_000,
            vec![("1", Some("2026-06"), 300_000), ("2", None, 3_300_000)],
        );
        r.sales.push(RecognizedSale {
            id: "s1".into(),
            month: ym("2026-06"),
            amount: 300_000,
            clears: vec![Clearing {
                plan_id: "1".into(),
                amount: 300_000,
            }],
        });
        let next = regenerate(&r, 300_000, term("2026-06", "2027-05")).unwrap();
        let open = open_months(&next);
        assert_eq!(open.len(), 11);
        assert_eq!(open[0], (Some(ym("2026-07")), 300_000));
        assert_eq!(next.unrecognized_remaining(), 3_300_000);

        // 計上済みの月を期間から外すことはできない。
        let r2 = OrderedRevenue {
            order_amount: 3_300_000,
            ..r.clone()
        };
        assert_eq!(
            regenerate(&r2, 300_000, term("2026-07", "2027-05")).unwrap_err(),
            vec![AgreementIssue::RecognizedOutsideTerm {
                month: Some(ym("2026-06"))
            }]
        );
        // 計上済みの額より小さい月額にはできない。
        let r3 = OrderedRevenue {
            order_amount: 2_400_000,
            ..r
        };
        assert_eq!(
            regenerate(&r3, 200_000, term("2026-06", "2027-05")).unwrap_err(),
            vec![AgreementIssue::RecognizedOverAmount {
                month: ym("2026-06"),
                recognized: 300_000
            }]
        );
    }

    #[test]
    fn t38_a_month_is_recognized_once_at_its_open_plan() {
        let t = term("2026-06", "2027-05");
        let facts = |planned, open, project_open| MonthFacts {
            term: t,
            planned,
            open,
            project_open,
        };
        let dec = ym("2026-12");
        assert_eq!(
            month_state(&facts(300_000, 300_000, true), dec),
            Some(MonthState::Due { amount: 300_000 })
        );
        assert_eq!(
            month_state(&facts(300_000, 0, true), dec),
            Some(MonthState::Recognized)
        );
        assert_eq!(
            month_state(&facts(300_000, 300_000, false), dec),
            Some(MonthState::ProjectClosed)
        );
        assert_eq!(
            month_state(&facts(0, 0, true), dec),
            Some(MonthState::NoPlan)
        );
        // 期間外は対象にしない。
        assert_eq!(month_state(&facts(0, 0, true), ym("2027-06")), None);
        // 一部だけ消込済みなら残りを計上する。
        assert_eq!(
            month_state(&facts(300_000, 100_000, true), dec),
            Some(MonthState::Due { amount: 100_000 })
        );
    }
}
