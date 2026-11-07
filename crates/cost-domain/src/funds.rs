//! 目標粗利率と原資（設計案 9.4 の4、受入条件 T36）。
//!
//! 目標粗利率は計算基準の項目（[`TARGET_MARGIN_ITEM`]、整数パーセント、案件で上書きできる）。
//! 原資は予算の上限の目安で、承認済み予算を書き換えない。
//!
//! - 目標粗利 ＝ 確定受注額 × 目標粗利率（円未満は切り捨て）
//! - 原資 ＝ 確定受注額 − 目標粗利
//!
//! 受注前（確定受注額なし）と目標粗利率の未設定は `None`（0%・0円で計算しない）。

use crate::money::Yen;

/// 目標粗利率の計算基準の項目。
pub const TARGET_MARGIN_ITEM: &str = "target_margin_pct";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Funds {
    /// 目標粗利（確定受注額 × 目標粗利率、円未満切り捨て）。
    pub target_profit: Yen,
    /// 原資（確定受注額 − 目標粗利）。
    pub funds: Yen,
}

/// 原資。確定受注額か目標粗利率が未設定なら `None`。
pub fn funds(order_amount: Option<Yen>, target_margin_pct: Option<i64>) -> Option<Funds> {
    let order = order_amount?;
    let pct = target_margin_pct?;
    let product = i128::from(order) * i128::from(pct);
    let target_profit = Yen::try_from(product.div_euclid(100)).ok()?;
    Some(Funds {
        target_profit,
        funds: order - target_profit,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn t36_funds_is_the_order_minus_its_target_margin() {
        let f = funds(Some(2_000_000), Some(15)).unwrap();
        assert_eq!(f.target_profit, 300_000);
        assert_eq!(f.funds, 1_700_000);
    }

    #[test]
    fn t36_target_profit_drops_the_fraction_of_a_yen() {
        // 1,234,567 × 15% = 185,185.05 → 185,185円。原資は 1,049,382円。
        let f = funds(Some(1_234_567), Some(15)).unwrap();
        assert_eq!(f.target_profit, 185_185);
        assert_eq!(f.funds, 1_049_382);
    }

    #[test]
    fn t36_unset_rate_or_no_order_is_not_computed_as_zero() {
        assert_eq!(funds(Some(2_000_000), None), None);
        assert_eq!(funds(None, Some(15)), None);
    }

    #[test]
    fn t36_zero_percent_is_a_set_value_and_keeps_the_whole_order() {
        let f = funds(Some(2_000_000), Some(0)).unwrap();
        assert_eq!(f.target_profit, 0);
        assert_eq!(f.funds, 2_000_000);
    }

    #[test]
    fn t36_a_negative_order_change_rounds_toward_the_lower_yen() {
        let f = funds(Some(-101), Some(15)).unwrap();
        // −15.15 → −16、原資 −85。
        assert_eq!(f.target_profit, -16);
        assert_eq!(f.funds, -85);
    }
}
