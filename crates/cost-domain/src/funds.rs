//! 目標粗利率と原資（設計案 9.4 の4、受入条件 T36）。
//!
//! 目標粗利率は計算基準の項目（[`TARGET_MARGIN_ITEM`]、整数パーセント、案件で上書きできる）。
//! 原資は予算の上限の目安で、承認済み予算を書き換えない。
//!
//! - 目標粗利 ＝ 確定受注額 × 目標粗利率（円未満は切り捨て）
//! - 原資 ＝ 確定受注額 − 目標粗利
//!
//! 受注前（確定受注額なし）と目標粗利率の未設定は `None`（0%・0円で計算しない）。
//!
//! 原資との差（T42）は「原資 − 金額」で、承認済み予算と完了見込原価のそれぞれについて出す。
//! 負は原資を超えていることを表す。原資か金額のどちらかがなければ `None`（0円で比べない）。
//!
//! 率は案件ごとに検収日の時点の値を使う（2026-11-07 ユーザー決定）。検収日は案件の最初の
//! 売上計上日（取消を除く）で、まだ検収していない案件は業務日付の値を使う（[`rate_date`]）。

use crate::calendar::Date;
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

/// 目標粗利率を読む日。検収日（最初の売上計上日）があればその日、なければ業務日付。
pub fn rate_date(first_acceptance: Option<Date>, today: Date) -> Date {
    first_acceptance.unwrap_or(today)
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

/// 原資との差（原資 − 金額）。負は原資超過。原資か金額がなければ `None`（T42）。
pub fn funds_left(funds: Option<Yen>, amount: Option<Yen>) -> Option<Yen> {
    Some(funds? - amount?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn t42_funds_left_is_the_funds_minus_the_amount() {
        // 原資1,700,000円：予算1,500,000円なら200,000円の余り、完了見込1,800,000円なら100,000円の超過。
        assert_eq!(funds_left(Some(1_700_000), Some(1_500_000)), Some(200_000));
        assert_eq!(funds_left(Some(1_700_000), Some(1_800_000)), Some(-100_000));
        assert_eq!(funds_left(Some(1_700_000), Some(1_700_000)), Some(0));
    }

    #[test]
    fn t42_no_funds_or_no_amount_is_not_compared_as_zero() {
        assert_eq!(funds_left(None, Some(1_500_000)), None);
        assert_eq!(funds_left(Some(1_700_000), None), None);
    }

    #[test]
    fn t36_the_rate_is_read_on_the_acceptance_date_or_today() {
        let today = Date::parse("2026-11-07").unwrap();
        let accepted = Date::parse("2026-08-31").unwrap();
        assert_eq!(rate_date(Some(accepted), today), accepted);
        assert_eq!(rate_date(None, today), today);
    }

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
