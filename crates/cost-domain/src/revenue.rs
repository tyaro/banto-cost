//! 受注済み案件の売上予定と実績計上の消し込み（仕様5.5、7.5）。
//!
//! 未計上残 ＝ 確定受注額 − 累計売上計上額。売上予定（月別・時期未定）の未消込額の合計は
//! 未計上残に一致させる。計上した売上は対応する予定を消し込み、実績と予定を二重に数えない。
//! 受注額を超える計上やマイナス残は不整合として返し、0円に丸めない。

use std::collections::BTreeMap;

use crate::calendar::YearMonth;
use crate::money::Yen;
use crate::outlook::Recognition;
use crate::pipeline::RevenuePlanLine;

/// 売上予定の1行。`month: None` は時期未定。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanLine {
    pub id: String,
    pub month: Option<YearMonth>,
    pub amount: Yen,
}

/// 売上予定の消し込み。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Clearing {
    pub plan_id: String,
    pub amount: Yen,
}

/// 経理が承認した売上計上。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecognizedSale {
    pub id: String,
    pub month: YearMonth,
    pub amount: Yen,
    pub clears: Vec<Clearing>,
}

/// 受注済み案件の売上の状態。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrderedRevenue {
    /// 現在の確定受注額（受注変更後の最新版）。
    pub order_amount: Yen,
    pub plans: Vec<PlanLine>,
    pub sales: Vec<RecognizedSale>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RevenueIssue {
    /// 累計計上額が受注額を超える。
    OverRecognized {
        excess: Yen,
    },
    /// 予定の未消込合計が未計上残と一致しない。
    PlanMismatch {
        open_total: Yen,
        remaining: Yen,
    },
    /// 予定額を超えて消し込んでいる。
    OverCleared {
        plan_id: String,
        excess: Yen,
    },
    /// 消込額の合計が計上額を超える。
    ClearingExceedsSale {
        sale_id: String,
    },
    UnknownPlan {
        sale_id: String,
        plan_id: String,
    },
    InvalidAmount {
        id: String,
    },
}

impl OrderedRevenue {
    pub fn recognized_total(&self) -> Yen {
        self.sales.iter().map(|s| s.amount).sum()
    }

    /// 未計上残。マイナスでもそのまま返す。
    pub fn unrecognized_remaining(&self) -> Yen {
        self.order_amount - self.recognized_total()
    }

    fn cleared(&self) -> BTreeMap<&str, Yen> {
        let mut m: BTreeMap<&str, Yen> = BTreeMap::new();
        for c in self.sales.iter().flat_map(|s| &s.clears) {
            *m.entry(&c.plan_id).or_default() += c.amount;
        }
        m
    }

    /// 消込後の売上予定（月次売上見通しの「受注済み売上予定」に渡す）。消込済みの行は除く。
    pub fn open_plans(&self) -> Vec<RevenuePlanLine> {
        let cleared = self.cleared();
        self.plans
            .iter()
            .map(|p| RevenuePlanLine {
                month: p.month,
                amount: p.amount - cleared.get(p.id.as_str()).copied().unwrap_or(0),
            })
            .filter(|l| l.amount != 0)
            .collect()
    }

    /// 計上済み売上（月次売上見通しの「計上済み売上」に渡す）。
    pub fn recognitions(&self) -> Vec<Recognition> {
        self.sales
            .iter()
            .map(|s| Recognition {
                month: s.month,
                amount: s.amount,
            })
            .collect()
    }

    /// 未計上残と売上予定の一致、消し込みの整合を検査する。
    pub fn check(&self) -> Vec<RevenueIssue> {
        let mut issues = Vec::new();
        for p in &self.plans {
            if p.amount < 0 {
                issues.push(RevenueIssue::InvalidAmount { id: p.id.clone() });
            }
        }
        for s in &self.sales {
            if s.amount < 0 || s.clears.iter().any(|c| c.amount < 0) {
                issues.push(RevenueIssue::InvalidAmount { id: s.id.clone() });
            }
            if s.clears.iter().map(|c| c.amount).sum::<Yen>() > s.amount {
                issues.push(RevenueIssue::ClearingExceedsSale {
                    sale_id: s.id.clone(),
                });
            }
            for c in &s.clears {
                if !self.plans.iter().any(|p| p.id == c.plan_id) {
                    issues.push(RevenueIssue::UnknownPlan {
                        sale_id: s.id.clone(),
                        plan_id: c.plan_id.clone(),
                    });
                }
            }
        }
        let cleared = self.cleared();
        for p in &self.plans {
            let c = cleared.get(p.id.as_str()).copied().unwrap_or(0);
            if c > p.amount {
                issues.push(RevenueIssue::OverCleared {
                    plan_id: p.id.clone(),
                    excess: c - p.amount,
                });
            }
        }
        let remaining = self.unrecognized_remaining();
        if remaining < 0 {
            issues.push(RevenueIssue::OverRecognized { excess: -remaining });
        }
        let open_total: Yen = self.open_plans().iter().map(|l| l.amount).sum();
        if open_total != remaining {
            issues.push(RevenueIssue::PlanMismatch {
                open_total,
                remaining,
            });
        }
        issues
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outlook::{monthly_outlook, OutlookKey};

    fn ym(s: &str) -> YearMonth {
        YearMonth::parse(s).unwrap()
    }
    fn plan(id: &str, m: Option<&str>, amount: Yen) -> PlanLine {
        PlanLine {
            id: id.into(),
            month: m.map(ym),
            amount,
        }
    }
    fn sale(id: &str, m: &str, amount: Yen, clears: &[(&str, Yen)]) -> RecognizedSale {
        RecognizedSale {
            id: id.into(),
            month: ym(m),
            amount,
            clears: clears
                .iter()
                .map(|(p, a)| Clearing {
                    plan_id: (*p).into(),
                    amount: *a,
                })
                .collect(),
        }
    }
    fn order() -> OrderedRevenue {
        OrderedRevenue {
            order_amount: 3_000_000,
            plans: vec![
                plan("PL1", Some("2026-12"), 2_000_000),
                plan("PL2", Some("2027-01"), 700_000),
                plan("PL3", None, 300_000),
            ],
            sales: vec![],
        }
    }

    #[test]
    fn 受注直後は売上予定と未計上残が一致() {
        let o = order();
        assert_eq!(o.unrecognized_remaining(), 3_000_000);
        assert_eq!(o.check(), vec![]);
    }

    #[test]
    fn t26_売上予定の一部を実績計上すると予定を消し込む() {
        let mut o = order();
        o.sales
            .push(sale("S1", "2026-12", 1_200_000, &[("PL1", 1_200_000)]));
        assert_eq!(o.check(), vec![]);
        assert_eq!(o.unrecognized_remaining(), 1_800_000);
        assert_eq!(
            o.open_plans(),
            vec![
                RevenuePlanLine {
                    month: Some(ym("2026-12")),
                    amount: 800_000
                },
                RevenuePlanLine {
                    month: Some(ym("2027-01")),
                    amount: 700_000
                },
                RevenuePlanLine {
                    month: None,
                    amount: 300_000
                },
            ]
        );
        // 12月の見通しは実績1,200,000円＋残予定800,000円で2,000,000円（3,200,000円にしない）。
        let out = monthly_outlook(&o.recognitions(), &o.open_plans(), &[]);
        let dec = out.cell(OutlookKey::Month(ym("2026-12")));
        assert_eq!((dec.recognized, dec.ordered_plan), (1_200_000, 800_000));
        assert_eq!(dec.total(), 2_000_000);
        let all: Yen = out.cells.values().map(|c| c.total()).sum();
        assert_eq!(all, 3_000_000, "全期間の合計は受注額を超えない");
    }

    #[test]
    fn t26_時期違いの計上も対応予定から消し込む() {
        let mut o = order();
        // 1月予定分が12月に前倒しで計上された。
        o.sales
            .push(sale("S1", "2026-12", 700_000, &[("PL2", 700_000)]));
        assert_eq!(o.check(), vec![]);
        let out = monthly_outlook(&o.recognitions(), &o.open_plans(), &[]);
        assert_eq!(
            out.cell(OutlookKey::Month(ym("2026-12"))).total(),
            2_700_000
        );
        assert_eq!(out.cell(OutlookKey::Month(ym("2027-01"))).total(), 0);
    }

    #[test]
    fn 消し込み漏れは未計上残との不一致で検出() {
        let mut o = order();
        o.sales.push(sale("S1", "2026-12", 1_200_000, &[]));
        assert_eq!(
            o.check(),
            vec![RevenueIssue::PlanMismatch {
                open_total: 3_000_000,
                remaining: 1_800_000
            }]
        );
    }

    #[test]
    fn 受注額を超える計上は0円に丸めず不整合() {
        let mut o = order();
        o.sales.push(sale(
            "S1",
            "2026-12",
            3_100_000,
            &[("PL1", 2_000_000), ("PL2", 700_000), ("PL3", 300_000)],
        ));
        assert_eq!(o.unrecognized_remaining(), -100_000);
        assert_eq!(
            o.check(),
            vec![
                RevenueIssue::OverRecognized { excess: 100_000 },
                RevenueIssue::PlanMismatch {
                    open_total: 0,
                    remaining: -100_000
                }
            ]
        );
    }

    #[test]
    fn 予定を超える消し込みと不明な予定を検出() {
        let mut o = order();
        o.sales.push(sale(
            "S1",
            "2026-12",
            2_100_000,
            &[("PL1", 2_100_000), ("PL9", 1)],
        ));
        let issues = o.check();
        assert!(issues.contains(&RevenueIssue::OverCleared {
            plan_id: "PL1".into(),
            excess: 100_000
        }));
        assert!(issues.contains(&RevenueIssue::ClearingExceedsSale {
            sale_id: "S1".into()
        }));
        assert!(issues.contains(&RevenueIssue::UnknownPlan {
            sale_id: "S1".into(),
            plan_id: "PL9".into()
        }));
    }
}
