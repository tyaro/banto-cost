//! 精算完了の検査（仕様5.1、T17）。
//!
//! 未承認実績、単価未設定、未確定の仮計上、未実績発注残、残作業見込み、未処理の売上差額が
//! 残る案件は精算完了にできない。前の三つは処理（承認・単価登録・請求確定）で解消する。
//! 不要になった残額は、理由と承認者を記録した解消として扱える。

use crate::money::{Minutes, Yen};

/// 精算完了を判定する時点の案件の状態。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CloseoutState {
    /// 下書き・申請中・差戻しの工数。
    pub unapproved_time_entries: usize,
    pub unapproved_minutes: Minutes,
    /// 未承認の直接費・売上計上。
    pub unapproved_costs: usize,
    /// 単価未設定で原価未確定の承認済み工数。
    pub missing_rate_entries: usize,
    /// 請求確定していない仮計上。
    pub provisional_entries: usize,
    /// 発注ごとの未実績発注残（発注ID、金額）。
    pub purchase_remaining: Vec<(String, Yen)>,
    /// 最新の採用見込版の残原価見込み。採用版がなければ `None`。
    pub forecast_remaining: Option<Yen>,
    /// 未計上残（確定受注額 − 累計売上計上額）。
    pub unrecognized_revenue: Yen,
}

/// 精算完了を妨げる項目。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Blocker {
    Unapproved {
        time_entries: usize,
        minutes: Minutes,
        costs: usize,
    },
    MissingRate {
        entries: usize,
    },
    Provisional {
        entries: usize,
    },
    PurchaseRemaining {
        purchase_order_id: String,
        amount: Yen,
    },
    ForecastRemaining {
        amount: Yen,
    },
    RevenueDifference {
        amount: Yen,
    },
}

impl Blocker {
    /// 理由と承認つきで解消できる残額か。未承認・単価未設定・仮計上は処理が必要。
    pub fn waivable(&self) -> bool {
        matches!(
            self,
            Self::PurchaseRemaining { .. }
                | Self::ForecastRemaining { .. }
                | Self::RevenueDifference { .. }
        )
    }
}

/// 残額の解消（理由と承認）。対象の金額が変わったら無効になる。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Waiver {
    pub blocker: Blocker,
    pub reason: String,
    pub approved_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseoutError {
    /// 未解消の項目と、理由・承認が欠けた解消。
    Blocked {
        unresolved: Vec<Blocker>,
        invalid_waivers: Vec<Waiver>,
    },
}

/// 精算完了を妨げる項目を列挙する。
pub fn blockers(s: &CloseoutState) -> Vec<Blocker> {
    let mut out = Vec::new();
    if s.unapproved_time_entries > 0 || s.unapproved_costs > 0 {
        out.push(Blocker::Unapproved {
            time_entries: s.unapproved_time_entries,
            minutes: s.unapproved_minutes,
            costs: s.unapproved_costs,
        });
    }
    if s.missing_rate_entries > 0 {
        out.push(Blocker::MissingRate {
            entries: s.missing_rate_entries,
        });
    }
    if s.provisional_entries > 0 {
        out.push(Blocker::Provisional {
            entries: s.provisional_entries,
        });
    }
    for (id, amount) in &s.purchase_remaining {
        if *amount != 0 {
            out.push(Blocker::PurchaseRemaining {
                purchase_order_id: id.clone(),
                amount: *amount,
            });
        }
    }
    if let Some(r) = s.forecast_remaining.filter(|r| *r != 0) {
        out.push(Blocker::ForecastRemaining { amount: r });
    }
    if s.unrecognized_revenue != 0 {
        out.push(Blocker::RevenueDifference {
            amount: s.unrecognized_revenue,
        });
    }
    out
}

/// 精算完了にしてよいか判定する。成功時は適用した解消を返す（監査ログに残す）。
pub fn check_closeout(s: &CloseoutState, waivers: &[Waiver]) -> Result<Vec<Waiver>, CloseoutError> {
    let valid = |w: &Waiver| {
        w.blocker.waivable()
            && !w.reason.trim().is_empty()
            && w.approved_by
                .as_deref()
                .is_some_and(|a| !a.trim().is_empty())
    };
    let invalid_waivers: Vec<Waiver> = waivers.iter().filter(|w| !valid(w)).cloned().collect();
    let mut applied = Vec::new();
    let mut unresolved = Vec::new();
    for b in blockers(s) {
        match waivers.iter().find(|w| w.blocker == b && valid(w)) {
            Some(w) => applied.push(w.clone()),
            None => unresolved.push(b),
        }
    }
    if unresolved.is_empty() && invalid_waivers.is_empty() {
        Ok(applied)
    } else {
        Err(CloseoutError::Blocked {
            unresolved,
            invalid_waivers,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> CloseoutState {
        CloseoutState {
            unapproved_time_entries: 2,
            unapproved_minutes: 180,
            unapproved_costs: 1,
            missing_rate_entries: 0,
            provisional_entries: 1,
            purchase_remaining: vec![("PO-1".into(), 200_000), ("PO-2".into(), 0)],
            forecast_remaining: Some(50_000),
            unrecognized_revenue: 0,
        }
    }
    fn waiver(b: Blocker, reason: &str, by: Option<&str>) -> Waiver {
        Waiver {
            blocker: b,
            reason: reason.into(),
            approved_by: by.map(Into::into),
        }
    }

    #[test]
    fn 残りがなければ精算完了できる() {
        assert_eq!(check_closeout(&CloseoutState::default(), &[]), Ok(vec![]));
    }

    #[test]
    fn t17_原価発注残未承認が残る案件は精算完了できない() {
        let s = state();
        let Err(CloseoutError::Blocked { unresolved, .. }) = check_closeout(&s, &[]) else {
            panic!("精算完了できてはいけない");
        };
        assert_eq!(
            unresolved,
            vec![
                Blocker::Unapproved {
                    time_entries: 2,
                    minutes: 180,
                    costs: 1
                },
                Blocker::Provisional { entries: 1 },
                Blocker::PurchaseRemaining {
                    purchase_order_id: "PO-1".into(),
                    amount: 200_000
                },
                Blocker::ForecastRemaining { amount: 50_000 },
            ]
        );
    }

    #[test]
    fn t17_残額は理由と承認つきで解消できる_未承認は解消できない() {
        let mut s = state();
        let po = Blocker::PurchaseRemaining {
            purchase_order_id: "PO-1".into(),
            amount: 200_000,
        };
        let fc = Blocker::ForecastRemaining { amount: 50_000 };
        let unapproved = Blocker::Unapproved {
            time_entries: 2,
            minutes: 180,
            costs: 1,
        };
        let waivers = [
            waiver(po.clone(), "残りの部材が不要になった", Some("accounting")),
            waiver(fc.clone(), "残作業なし", Some("manager")),
            waiver(unapproved.clone(), "急ぎ", Some("manager")),
        ];
        // 未承認は理由があっても解消扱いにできない。
        let Err(CloseoutError::Blocked {
            unresolved,
            invalid_waivers,
        }) = check_closeout(&s, &waivers)
        else {
            panic!();
        };
        assert!(unresolved.contains(&unapproved));
        assert!(unresolved.contains(&Blocker::Provisional { entries: 1 }));
        assert_eq!(invalid_waivers.len(), 1);

        // 承認・請求確定を済ませれば、残額の解消だけで精算完了できる。
        s.unapproved_time_entries = 0;
        s.unapproved_minutes = 0;
        s.unapproved_costs = 0;
        s.provisional_entries = 0;
        let applied = check_closeout(&s, &waivers[..2]).unwrap();
        assert_eq!(applied.len(), 2);
    }

    #[test]
    fn 理由なし承認者なし金額違いの解消は無効() {
        let s = CloseoutState {
            unrecognized_revenue: 100_000,
            ..Default::default()
        };
        let b = Blocker::RevenueDifference { amount: 100_000 };
        for w in [
            waiver(b.clone(), "  ", Some("accounting")),
            waiver(b.clone(), "値引き合意", None),
        ] {
            assert!(check_closeout(&s, &[w]).is_err());
        }
        // 金額が変わった解消は対象と一致しない。
        let stale = waiver(
            Blocker::RevenueDifference { amount: 90_000 },
            "値引き合意",
            Some("accounting"),
        );
        let Err(CloseoutError::Blocked { unresolved, .. }) = check_closeout(&s, &[stale]) else {
            panic!();
        };
        assert_eq!(unresolved, vec![b.clone()]);
        assert!(check_closeout(&s, &[waiver(b, "値引き合意", Some("accounting"))]).is_ok());
    }

    #[test]
    fn 受注超過の計上もマイナスの売上差額として止める() {
        let s = CloseoutState {
            unrecognized_revenue: -100_000,
            missing_rate_entries: 3,
            ..Default::default()
        };
        assert_eq!(
            blockers(&s),
            vec![
                Blocker::MissingRate { entries: 3 },
                Blocker::RevenueDifference { amount: -100_000 }
            ]
        );
    }
}
