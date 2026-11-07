//! 完了見込・予算差異・利益。
//!
//! 完了見込は「同じ基準日の実績スナップショット ＋ 残原価見込み」で計算し、
//! 最新実績と古い残見込みを混ぜない（仕様6.6、7.1）。

use crate::money::{labor_cost, ratio_permille, Minutes, Yen};

/// 費目。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CostType {
    Labor,
    Material,
    Outsource,
    Travel,
    Other,
}

impl CostType {
    pub const ALL: [CostType; 5] = [
        Self::Labor,
        Self::Material,
        Self::Outsource,
        Self::Travel,
        Self::Other,
    ];

    /// DB・通信で使う文字列。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Labor => "labor",
            Self::Material => "material",
            Self::Outsource => "outsource",
            Self::Travel => "travel",
            Self::Other => "other",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|t| t.as_str() == s)
    }
}

/// 費目別の金額。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ByCostType {
    pub labor: Yen,
    pub material: Yen,
    pub outsource: Yen,
    pub travel: Yen,
    pub other: Yen,
}

impl ByCostType {
    pub fn get(&self, t: CostType) -> Yen {
        match t {
            CostType::Labor => self.labor,
            CostType::Material => self.material,
            CostType::Outsource => self.outsource,
            CostType::Travel => self.travel,
            CostType::Other => self.other,
        }
    }
    pub fn total(&self) -> Yen {
        CostType::ALL.iter().map(|t| self.get(*t)).sum()
    }
    /// 費目に金額を加える（調整はマイナスで渡す）。
    pub fn add(&mut self, t: CostType, v: Yen) {
        let cur = self.get(t);
        set(self, t, cur + v);
    }
}

/// 完了見込版の費目別の行。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ForecastLine {
    /// 基準日までの承認済み実績（スナップショット）。
    pub actual: Yen,
    /// 発注済み未実績（残原価の内数）。
    pub committed: Yen,
    /// それ以外に必要な見込み。
    pub other_remaining: Yen,
    /// 残工数（労務のみ）。
    pub remaining_minutes: Minutes,
}

/// 完了見込版。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForecastVersion {
    pub lines: [ForecastLine; 5],
    /// 残工数に掛ける見込み用単価。未設定なら残工数の金額は未確定。
    pub forecast_rate: Option<Yen>,
}

impl ForecastVersion {
    pub fn line(&self, t: CostType) -> &ForecastLine {
        &self.lines[t as usize]
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForecastResult {
    pub actual: ByCostType,
    pub remaining: ByCostType,
    pub committed: Yen,
    /// 単価未設定などで残原価を確定できない場合 `false`（「暫定・不足あり」）。
    pub complete: bool,
}

impl ForecastResult {
    pub fn actual_total(&self) -> Yen {
        self.actual.total()
    }
    pub fn remaining_total(&self) -> Yen {
        self.remaining.total()
    }
    /// 完了見込原価 ＝ 実績直接原価 ＋ 残原価見込み。
    pub fn total(&self) -> Yen {
        self.actual_total() + self.remaining_total()
    }
}

fn set(b: &mut ByCostType, t: CostType, v: Yen) {
    match t {
        CostType::Labor => b.labor = v,
        CostType::Material => b.material = v,
        CostType::Outsource => b.outsource = v,
        CostType::Travel => b.travel = v,
        CostType::Other => b.other = v,
    }
}

/// 完了見込原価を計算する。残原価 ＝ 発注済み未実績 ＋ それ以外 ＋ 残工数 × 見込み用単価。
pub fn forecast(v: &ForecastVersion) -> ForecastResult {
    let mut actual = ByCostType::default();
    let mut remaining = ByCostType::default();
    let mut committed = 0;
    let mut complete = true;
    for t in CostType::ALL {
        let l = v.line(t);
        set(&mut actual, t, l.actual);
        let labor = if l.remaining_minutes == 0 {
            0
        } else {
            labor_cost(l.remaining_minutes, v.forecast_rate).unwrap_or_else(|| {
                complete = false;
                0
            })
        };
        set(&mut remaining, t, l.committed + l.other_remaining + labor);
        committed += l.committed;
    }
    ForecastResult {
        actual,
        remaining,
        committed,
        complete,
    }
}

/// 利益と利益率。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Profit {
    pub amount: Yen,
    /// 千分率。売上・受注が0なら `None`（算出不可）。
    pub ratio_permille: Option<i64>,
}

/// 完了見込直接利益 ＝ 確定受注額 − 完了見込原価。受注額が未確定なら利益率は算出不可。
pub fn profit(sales: Option<Yen>, cost: Yen) -> Profit {
    match sales {
        Some(s) => Profit {
            amount: s - cost,
            ratio_permille: ratio_permille(s - cost, s),
        },
        None => Profit {
            amount: -cost,
            ratio_permille: None,
        },
    }
}

/// 予算に対する差異。プラスが超過（仕様7.1）。
pub fn overrun(cost: Yen, budget: Yen) -> Yen {
    cost - budget
}

/// 採用版の基準日より後に実績が増えた（または訂正された）とき `true`（「見込更新要」）。
pub fn needs_update(latest_actual_total: Yen, version_actual_total: Yen) -> bool {
    latest_actual_total != version_actual_total
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(actual: Yen, committed: Yen, other: Yen, minutes: Minutes) -> ForecastLine {
        ForecastLine {
            actual,
            committed,
            other_remaining: other,
            remaining_minutes: minutes,
        }
    }

    /// 仕様12.1の前回採用版（基準日の実績1,900,000円、残1,000,000円）。
    fn v1() -> ForecastVersion {
        ForecastVersion {
            lines: [
                line(700_000, 0, 0, 100 * 60),
                line(800_000, 200_000, 0, 0),
                line(300_000, 200_000, 0, 0),
                line(80_000, 0, 70_000, 0),
                line(20_000, 0, 30_000, 0),
            ],
            forecast_rate: Some(5_000),
        }
    }

    #[test]
    fn t06_完了見込原価と利益() {
        let r = forecast(&v1());
        assert_eq!(r.actual_total(), 1_900_000);
        assert_eq!(r.remaining_total(), 1_000_000);
        assert_eq!(r.total(), 2_900_000);
        assert_eq!(r.committed, 400_000, "発注残は残原価の内数");
        assert!(r.complete);
        let p = profit(Some(4_000_000), r.total());
        assert_eq!(
            p,
            Profit {
                amount: 1_100_000,
                ratio_permille: Some(275)
            }
        );
        assert_eq!(overrun(r.total(), 2_600_000), 300_000);
    }

    #[test]
    fn t07_未確定追加売上は標準の利益に含めない_確定後は含める() {
        let cost = forecast(&v1()).total();
        assert_eq!(profit(Some(4_000_000), cost).amount, 1_100_000);
        assert_eq!(
            profit(Some(4_300_000), cost),
            Profit {
                amount: 1_400_000,
                ratio_permille: Some(326)
            }
        );
    }

    #[test]
    fn t28_実績増加後に残見込みを再見積りした新版() {
        let old = v1();
        // 最新実績2,200,000円。古い残見込みを足した3,200,000円にはしない。
        assert!(needs_update(2_200_000, forecast(&old).actual_total()));
        let new = ForecastVersion {
            lines: [
                line(850_000, 0, 0, 90 * 60),
                line(900_000, 100_000, 0, 0),
                line(350_000, 150_000, 0, 0),
                line(80_000, 0, 70_000, 0),
                line(20_000, 0, 30_000, 0),
            ],
            forecast_rate: Some(5_000),
        };
        let r = forecast(&new);
        assert_eq!(r.actual_total(), 2_200_000);
        assert_eq!(r.remaining_total(), 800_000);
        assert_eq!(r.total(), 3_000_000);
        assert_eq!(
            profit(Some(4_000_000), r.total()),
            Profit {
                amount: 1_000_000,
                ratio_permille: Some(250)
            }
        );
        assert_eq!(overrun(r.total(), 2_600_000), 400_000);
        assert_eq!(
            r.total() - forecast(&old).total(),
            100_000,
            "前回見込との差"
        );
        assert_eq!(forecast(&old).total(), 2_900_000, "古い版は変わらない");
        assert!(!needs_update(2_200_000, r.actual_total()));
    }

    #[test]
    fn 見込み用単価が未設定なら暫定() {
        let mut v = v1();
        v.forecast_rate = None;
        let r = forecast(&v);
        assert!(!r.complete);
        assert_eq!(r.remaining.labor, 0);
    }

    #[test]
    fn t08_受注額未確定や0円の利益率は算出不可() {
        assert_eq!(profit(None, 100).ratio_permille, None);
        assert_eq!(
            profit(Some(0), 1_900_000),
            Profit {
                amount: -1_900_000,
                ratio_permille: None
            }
        );
    }
}
