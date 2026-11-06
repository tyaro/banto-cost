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
    /// 同じ月（または時期未定）の売上予定が重複している。
    DuplicatePlanMonth,
    /// 同じIDの売上計上が無い（取消の対象が見つからない）。
    UnknownSale {
        sale_id: String,
    },
}

/// 新しい売上予定行のID（保存前）。`new:` の後に年月か `undated` を付ける。
pub const NEW_PLAN_PREFIX: &str = "new:";

fn month_key(month: Option<YearMonth>) -> String {
    month.map_or_else(|| "undated".to_string(), |m| m.to_string())
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

    /// 売上予定の行ごとの未消込額（ID・月・未消込額）。
    pub fn open_by_line(&self) -> Vec<(String, Option<YearMonth>, Yen)> {
        let cleared = self.cleared();
        self.plans
            .iter()
            .map(|p| {
                (
                    p.id.clone(),
                    p.month,
                    p.amount - cleared.get(p.id.as_str()).copied().unwrap_or(0),
                )
            })
            .collect()
    }

    fn checked(self) -> Result<Self, Vec<RevenueIssue>> {
        let issues = self.check();
        if issues.is_empty() {
            Ok(self)
        } else {
            Err(issues)
        }
    }

    /// 未計上の売上予定を月ごとに置き換える（仕様5.5）。`open` は未消込の予定額。
    ///
    /// 既存の行は同じ月なら ID を保ち、予定額＝消込済み額＋新しい未消込額にする。消し込み
    /// のある行は（未消込が0円でも）消さず、消し込みのない行で月が無くなったか0円のものは消す。
    /// 新しい月は `new:<年月>` の ID で追加する。結果は [`check`](Self::check) を通す
    /// （未消込の合計が未計上残に一致しないと拒否）。
    pub fn replan(&self, open: &[RevenuePlanLine]) -> Result<Self, Vec<RevenueIssue>> {
        let mut seen = std::collections::BTreeSet::new();
        if open.iter().any(|l| !seen.insert(l.month)) {
            return Err(vec![RevenueIssue::DuplicatePlanMonth]);
        }
        let bad: Vec<RevenueIssue> = open
            .iter()
            .filter(|l| l.amount < 0)
            .map(|l| RevenueIssue::InvalidAmount {
                id: format!("{NEW_PLAN_PREFIX}{}", month_key(l.month)),
            })
            .collect();
        if !bad.is_empty() {
            return Err(bad);
        }
        let cleared = self.cleared();
        let mut wanted: BTreeMap<Option<YearMonth>, Yen> =
            open.iter().map(|l| (l.month, l.amount)).collect();
        let mut plans = Vec::new();
        for p in &self.plans {
            let c = cleared.get(p.id.as_str()).copied().unwrap_or(0);
            match wanted.remove(&p.month) {
                Some(0) if c == 0 => {}
                Some(amount) => plans.push(PlanLine {
                    id: p.id.clone(),
                    month: p.month,
                    amount: c + amount,
                }),
                None if c != 0 => plans.push(PlanLine {
                    id: p.id.clone(),
                    month: p.month,
                    amount: c,
                }),
                None => {}
            }
        }
        for (month, amount) in wanted {
            if amount != 0 {
                plans.push(PlanLine {
                    id: format!("{NEW_PLAN_PREFIX}{}", month_key(month)),
                    month,
                    amount,
                });
            }
        }
        Self {
            order_amount: self.order_amount,
            plans,
            sales: self.sales.clone(),
        }
        .checked()
    }

    /// 承認した受注変更の差額を確定受注額と `month` の売上予定へ加える。減額で予定や
    /// 未計上残がマイナスになる場合は拒否する。
    pub fn apply_change(
        &self,
        delta: Yen,
        month: Option<YearMonth>,
    ) -> Result<Self, Vec<RevenueIssue>> {
        let mut open: BTreeMap<Option<YearMonth>, Yen> = BTreeMap::new();
        for (_, m, amount) in self.open_by_line() {
            *open.entry(m).or_default() += amount;
        }
        let target = open.entry(month).or_default();
        *target += delta;
        if *target < 0 {
            return Err(vec![RevenueIssue::InvalidAmount {
                id: format!("{NEW_PLAN_PREFIX}{}", month_key(month)),
            }]);
        }
        let changed = Self {
            order_amount: self.order_amount + delta,
            plans: self.plans.clone(),
            sales: self.sales.clone(),
        };
        let lines: Vec<RevenuePlanLine> = open
            .into_iter()
            .map(|(month, amount)| RevenuePlanLine { month, amount })
            .collect();
        changed.replan(&lines)
    }

    /// 計上額を売上予定へ自動で割り当てる。計上月の予定、それより前の月（古い順）、
    /// 後の月（早い順）、時期未定の順に未消込額を消し込む。割り当てきれない額は残し、
    /// [`with_sale`](Self::with_sale) の検査で不整合として返る。
    pub fn auto_clear(&self, month: YearMonth, amount: Yen) -> Vec<Clearing> {
        let mut lines = self.open_by_line();
        lines.retain(|(_, _, open)| *open > 0);
        let rank = |m: Option<YearMonth>| match m {
            Some(m) if m == month => (0, Some(m)),
            Some(m) if m < month => (1, Some(m)),
            Some(m) => (2, Some(m)),
            None => (3, None),
        };
        lines.sort_by_key(|(_, m, _)| rank(*m));
        let mut rest = amount;
        let mut out = Vec::new();
        for (id, _, open) in lines {
            if rest <= 0 {
                break;
            }
            let take = rest.min(open);
            out.push(Clearing {
                plan_id: id,
                amount: take,
            });
            rest -= take;
        }
        out
    }

    /// 売上計上を加えた状態を返す。計上額は正、消し込みは計上額と同額で、予定と未計上残の
    /// 一致・受注額の超過を検査する（T26）。
    pub fn with_sale(&self, sale: RecognizedSale) -> Result<Self, Vec<RevenueIssue>> {
        if sale.amount <= 0 {
            return Err(vec![RevenueIssue::InvalidAmount { id: sale.id }]);
        }
        let mut next = self.clone();
        next.sales.push(sale);
        next.checked()
    }

    /// 売上計上を取り消した状態を返す（消し込んだ予定は未消込に戻る）。
    pub fn without_sale(&self, sale_id: &str) -> Result<Self, Vec<RevenueIssue>> {
        if !self.sales.iter().any(|s| s.id == sale_id) {
            return Err(vec![RevenueIssue::UnknownSale {
                sale_id: sale_id.to_string(),
            }]);
        }
        let mut next = self.clone();
        next.sales.retain(|s| s.id != sale_id);
        next.checked()
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
    fn t26_自動の消し込みは計上月から順に割り当てる() {
        let o = order();
        let clears = o.auto_clear(ym("2027-01"), 1_000_000);
        // 1月の予定700,000円、前の月の12月から300,000円。
        assert_eq!(
            clears,
            vec![
                Clearing {
                    plan_id: "PL2".into(),
                    amount: 700_000
                },
                Clearing {
                    plan_id: "PL1".into(),
                    amount: 300_000
                },
            ]
        );
        let next = o
            .with_sale(RecognizedSale {
                id: "S1".into(),
                month: ym("2027-01"),
                amount: 1_000_000,
                clears,
            })
            .unwrap();
        assert_eq!(next.unrecognized_remaining(), 2_000_000);
        // 取り消すと予定は元に戻る。
        let back = next.without_sale("S1").unwrap();
        assert_eq!(back.open_plans(), o.open_plans());
        assert!(next.without_sale("S9").is_err());
    }

    #[test]
    fn t26_受注額を超える計上と消し込み不足は拒否() {
        let o = order();
        let over = RecognizedSale {
            id: "S1".into(),
            month: ym("2026-12"),
            amount: 3_100_000,
            clears: o.auto_clear(ym("2026-12"), 3_100_000),
        };
        assert!(o
            .with_sale(over)
            .unwrap_err()
            .contains(&RevenueIssue::OverRecognized { excess: 100_000 }));
        let short = RecognizedSale {
            id: "S1".into(),
            month: ym("2026-12"),
            amount: 500_000,
            clears: vec![],
        };
        assert!(matches!(
            o.with_sale(short).unwrap_err()[..],
            [RevenueIssue::PlanMismatch { .. }]
        ));
        let zero = RecognizedSale {
            id: "S0".into(),
            month: ym("2026-12"),
            amount: 0,
            clears: vec![],
        };
        assert!(o.with_sale(zero).is_err());
    }

    #[test]
    fn 売上予定の組み替えは消込済みを保ち合計を未計上残に合わせる() {
        let o = order()
            .with_sale(sale("S1", "2026-12", 1_200_000, &[("PL1", 1_200_000)]))
            .unwrap();
        // 残り1,800,000円を2月1,500,000円・時期未定300,000円に組み替える。
        let next = o
            .replan(&[
                RevenuePlanLine {
                    month: Some(ym("2027-02")),
                    amount: 1_500_000,
                },
                RevenuePlanLine {
                    month: None,
                    amount: 300_000,
                },
            ])
            .unwrap();
        assert_eq!(
            next.plans,
            vec![
                plan("PL1", Some("2026-12"), 1_200_000),
                plan("PL3", None, 300_000),
                plan("new:2027-02", Some("2027-02"), 1_500_000),
            ],
            "消込済みの12月は残し、消し込みのない1月は消す"
        );
        assert_eq!(next.check(), vec![]);
        // 合計が未計上残と合わない組み替えは拒否。
        assert!(o
            .replan(&[RevenuePlanLine {
                month: None,
                amount: 1
            }])
            .is_err());
        assert_eq!(
            o.replan(&[
                RevenuePlanLine {
                    month: None,
                    amount: 1
                },
                RevenuePlanLine {
                    month: None,
                    amount: 1
                }
            ])
            .unwrap_err(),
            vec![RevenueIssue::DuplicatePlanMonth]
        );
    }

    #[test]
    fn 承認した受注変更は確定受注額と売上予定に一度だけ加える() {
        let o = order();
        let next = o.apply_change(300_000, Some(ym("2027-01"))).unwrap();
        assert_eq!(next.order_amount, 3_300_000);
        assert_eq!(
            next.plans.iter().find(|p| p.id == "PL2").unwrap().amount,
            1_000_000
        );
        assert_eq!(next.check(), vec![]);
        // 新しい月には行を足す。
        let added = o.apply_change(100_000, Some(ym("2027-03"))).unwrap();
        assert!(added
            .plans
            .iter()
            .any(|p| p.id == "new:2027-03" && p.amount == 100_000));
        // 減額で予定がマイナスになるなら拒否。
        assert!(o.apply_change(-800_000, Some(ym("2027-01"))).is_err());
        let reduced = o.apply_change(-700_000, Some(ym("2027-01"))).unwrap();
        assert_eq!(reduced.order_amount, 2_300_000);
        assert!(!reduced.plans.iter().any(|p| p.id == "PL2"));
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
