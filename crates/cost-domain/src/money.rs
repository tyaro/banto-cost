//! 金額・工数・率の基本計算。

/// 円（税抜）。マイナスは調整・利益の赤字などに使う。
pub type Yen = i64;
/// 工数（分）。
pub type Minutes = i64;

/// `n / d` を四捨五入（0から遠い方へ丸める）。`d` は正であること。
pub(crate) fn div_round(n: i128, d: i128) -> i128 {
    debug_assert!(d > 0);
    if n >= 0 {
        (2 * n + d) / (2 * d)
    } else {
        -((2 * -n + d) / (2 * d))
    }
}

/// 労務原価 ＝ 作業時間 × 時間単価。明細ごとに円単位で四捨五入する（仕様7.4）。
///
/// 単価が未登録なら `None`（原価未確定）を返し、0円にしない（T04）。
pub fn labor_cost(minutes: Minutes, rate_per_hour: Option<Yen>) -> Option<Yen> {
    let rate = rate_per_hour?;
    Some(div_round(minutes as i128 * rate as i128, 60) as Yen)
}

/// 率を千分率（0.1%単位）で返す。27.5% は `275`。
///
/// 分母が0なら `None`（算出不可）。集計の利益率は「利益合計 ÷ 売上合計」で求め、
/// 案件ごとの率を平均しない（仕様7.4）。
pub fn ratio_permille(numerator: Yen, denominator: Yen) -> Option<i64> {
    if denominator == 0 {
        return None;
    }
    let (n, d) = if denominator < 0 {
        (-(numerator as i128), -(denominator as i128))
    } else {
        (numerator as i128, denominator as i128)
    };
    Some(div_round(n * 1000, d) as i64)
}

/// 金額 × 確度（%）。案件ごとに円単位で四捨五入する。
pub(crate) fn weighted(amount: Yen, probability_pct: u8) -> Yen {
    div_round(amount as i128 * probability_pct as i128, 100) as Yen
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn t02_140時間を5000円で承認すると700000円() {
        assert_eq!(labor_cost(140 * 60, Some(5_000)), Some(700_000));
    }

    #[test]
    fn t04_単価なしは原価未確定() {
        assert_eq!(labor_cost(480, None), None);
    }

    #[test]
    fn 労務原価は円単位で四捨五入() {
        // 10分 × 5,200円/時 = 866.66… → 867
        assert_eq!(labor_cost(10, Some(5_200)), Some(867));
        // 15分 × 4,998円/時 = 1,249.5 → 1,250
        assert_eq!(labor_cost(15, Some(4_998)), Some(1_250));
    }

    #[test]
    fn t08_売上0円の利益率は算出不可() {
        assert_eq!(ratio_permille(-1_900_000, 0), None);
    }

    #[test]
    fn 利益率は小数第1位() {
        assert_eq!(ratio_permille(1_100_000, 4_000_000), Some(275));
        assert_eq!(ratio_permille(1_400_000, 4_300_000), Some(326));
        assert_eq!(ratio_permille(-150_000, 1_800_000), Some(-83));
    }

    #[test]
    fn 確度加重は四捨五入() {
        assert_eq!(weighted(3_000_000, 60), 1_800_000);
        assert_eq!(weighted(333, 50), 167);
    }
}
