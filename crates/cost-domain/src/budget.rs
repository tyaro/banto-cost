//! 予算版（仕様5.3、設計書3.3）。
//!
//! - 予算は工程×費目の明細で持つ。労務費は予定工数 × 予算用単価（計算基準 `budget_rate`）、
//!   材料・外注・旅費・その他は予定金額を登録する。
//! - 下書きは自由に直せる。承認すると版番号が付き、以後は書き換えない。版1が当初予算、
//!   最新の承認版が現在の承認予算。変更（版2以降）は理由を必須にする（T09）。
//! - 労務の金額は承認時に、予算版の作成日に適用される予算用単価で確定する。
//!   単価が未設定なら金額は `None` で、0円にしない。単価のない労務がある予算は承認できない。
//! - 予算と実績・見込は比較するもので、足し合わせない（仕様3.3）。差異はプラスが超過。

use std::collections::BTreeMap;

use crate::forecast::{overrun, CostType};
use crate::money::{labor_cost, Minutes, Yen};
use crate::project::ProjectStatus;

/// 予算の労務費に使う計算基準の項目（予算用単価）。
pub const RATE_ITEM: &str = "budget_rate";
/// 1版の明細の上限。
pub const MAX_LINES: usize = 200;

/// 明細の付け先（工程と費目）。工程 `None` は「工程指定なし（案件全体）」。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct LineKey {
    pub phase: Option<i64>,
    pub cost_type: CostType,
}

/// 入力された明細。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LineInput {
    pub key: LineKey,
    /// 予定工数（労務だけ）。
    pub minutes: Option<Minutes>,
    /// 予定金額（労務以外）。
    pub amount: Option<Yen>,
}

/// 明細の不整合。`index` は入力の並び（0始まり）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LineIssue {
    TooMany,
    /// 労務に予定工数がない、または0分以下。
    MinutesRequired {
        index: usize,
    },
    /// 労務に金額を入れた（労務は工数×予算用単価で求める）。
    LaborWithAmount {
        index: usize,
    },
    /// 労務以外に金額がない。
    AmountRequired {
        index: usize,
    },
    /// 労務以外の金額がマイナス。
    AmountNegative {
        index: usize,
    },
    /// 労務以外に工数を入れた。
    MinutesOnNonLabor {
        index: usize,
    },
    /// 同じ工程・費目の明細が二つある。
    Duplicate {
        index: usize,
    },
}

/// 明細を検査する。空の下書きは許す（承認時に検査する）。
pub fn validate_lines(lines: &[LineInput]) -> Result<(), Vec<LineIssue>> {
    let mut issues = Vec::new();
    if lines.len() > MAX_LINES {
        issues.push(LineIssue::TooMany);
    }
    let mut seen = std::collections::BTreeSet::new();
    for (index, l) in lines.iter().enumerate() {
        if !seen.insert(l.key) {
            issues.push(LineIssue::Duplicate { index });
        }
        if l.key.cost_type == CostType::Labor {
            if !l.minutes.is_some_and(|m| m > 0) {
                issues.push(LineIssue::MinutesRequired { index });
            }
            if l.amount.is_some() {
                issues.push(LineIssue::LaborWithAmount { index });
            }
        } else {
            match l.amount {
                None => issues.push(LineIssue::AmountRequired { index }),
                Some(a) if a < 0 => issues.push(LineIssue::AmountNegative { index }),
                Some(_) => {}
            }
            if l.minutes.is_some() {
                issues.push(LineIssue::MinutesOnNonLabor { index });
            }
        }
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(issues)
    }
}

/// 金額を求めた明細。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PricedLine {
    pub line: LineInput,
    /// 労務に使った予算用単価（円/時）。労務以外と未設定は `None`。
    pub rate: Option<Yen>,
    /// 明細の金額。労務で単価がなければ `None`（未確定、0円にしない）。
    pub amount: Option<Yen>,
}

/// 明細の金額を求める。労務は `ROUND(分 × 単価 / 60)`。
pub fn price(lines: &[LineInput], rate: Option<Yen>) -> Vec<PricedLine> {
    lines
        .iter()
        .map(|l| {
            if l.key.cost_type == CostType::Labor {
                PricedLine {
                    line: *l,
                    rate,
                    amount: labor_cost(l.minutes.unwrap_or(0), rate),
                }
            } else {
                PricedLine {
                    line: *l,
                    rate: None,
                    amount: l.amount,
                }
            }
        })
        .collect()
}

/// 原価予算の合計。金額が未確定の明細があれば `None`。
pub fn total(lines: &[PricedLine]) -> Option<Yen> {
    lines.iter().map(|l| l.amount).sum()
}

/// 承認を拒否する理由。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalIssue {
    /// 明細がない。
    NoLines,
    /// 労務の明細があるのに予算用単価が未設定。
    RateMissing,
    /// 変更予算（版2以降）に理由がない。
    ReasonRequired,
    /// 受注済み（受注・進行中・作業完了）でない案件。精算完了も含めて拒否する。
    ProjectNotOrdered,
}

/// 承認できるか検査する。`version` は承認で付く版番号（[`next_version`]）。
pub fn check_approval(
    lines: &[PricedLine],
    version: u32,
    reason: Option<&str>,
    status: ProjectStatus,
) -> Result<(), Vec<ApprovalIssue>> {
    let mut issues = Vec::new();
    if !matches!(
        status,
        ProjectStatus::Ordered | ProjectStatus::InProgress | ProjectStatus::WorkDone
    ) {
        issues.push(ApprovalIssue::ProjectNotOrdered);
    }
    if lines.is_empty() {
        issues.push(ApprovalIssue::NoLines);
    }
    if lines.iter().any(|l| l.amount.is_none()) {
        issues.push(ApprovalIssue::RateMissing);
    }
    if version >= 2 && reason.is_none_or(|r| r.trim().is_empty()) {
        issues.push(ApprovalIssue::ReasonRequired);
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(issues)
    }
}

/// 次に承認される版の番号（承認済みの最大＋1、最初は1＝当初予算）。
pub fn next_version(approved: &[u32]) -> u32 {
    approved.iter().copied().max().unwrap_or(0) + 1
}

/// 比較の1行（工程×費目）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompareRow {
    pub key: LineKey,
    /// 当初予算（版1）の額。当初予算にこの明細がなければ `None`。
    pub original: Option<Yen>,
    /// 現在の承認予算の額。明細がなければ `None`。
    pub current: Option<Yen>,
    /// 実績。実績を集計していない費目は `None`（0円にしない）。
    pub actual: Option<Yen>,
    /// 原価予算差異 ＝ 実績 − 現在の承認予算（明細がなければ0円の予算として扱う）。
    /// 実績を集計していない費目と、承認予算がまだない案件は `None`。
    pub variance: Option<Yen>,
}

/// 当初予算・現在の承認予算・実績を工程×費目で並べる（仕様5.3、7.1）。
///
/// `current` が `None` なら承認予算がまだない。`tracked` は実績を集計している費目で、
/// それ以外の費目の実績・差異は `None` にする（未集計を0円の実績にしない）。
pub fn compare(
    original: Option<&[(LineKey, Yen)]>,
    current: Option<&[(LineKey, Yen)]>,
    actual: &[(LineKey, Yen)],
    tracked: &[CostType],
) -> Vec<CompareRow> {
    let mut rows: BTreeMap<LineKey, CompareRow> = BTreeMap::new();
    let mut row = |key: LineKey| {
        *rows.entry(key).or_insert(CompareRow {
            key,
            original: None,
            current: None,
            actual: None,
            variance: None,
        })
    };
    let keys: Vec<LineKey> = original
        .unwrap_or(&[])
        .iter()
        .chain(current.unwrap_or(&[]))
        .chain(actual)
        .map(|(k, _)| *k)
        .collect();
    for k in keys {
        row(k);
    }
    let get = |list: Option<&[(LineKey, Yen)]>, key: LineKey| -> Option<Yen> {
        list.and_then(|l| {
            let found: Vec<Yen> = l
                .iter()
                .filter(|(k, _)| *k == key)
                .map(|(_, v)| *v)
                .collect();
            (!found.is_empty()).then(|| found.iter().sum())
        })
    };
    for (key, r) in rows.iter_mut() {
        r.original = get(original, *key);
        r.current = get(current, *key);
        if tracked.contains(&key.cost_type) {
            let a = get(Some(actual), *key).unwrap_or(0);
            r.actual = Some(a);
            r.variance = current.map(|_| overrun(a, r.current.unwrap_or(0)));
        }
    }
    rows.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(phase: Option<i64>, t: CostType) -> LineKey {
        LineKey {
            phase,
            cost_type: t,
        }
    }

    fn labor(phase: i64, minutes: Minutes) -> LineInput {
        LineInput {
            key: key(Some(phase), CostType::Labor),
            minutes: Some(minutes),
            amount: None,
        }
    }

    fn money(t: CostType, amount: Yen) -> LineInput {
        LineInput {
            key: key(None, t),
            minutes: None,
            amount: Some(amount),
        }
    }

    /// 仕様12.1の当初予算（労務200時間×5,000円＝1,000,000円、合計2,600,000円）。
    fn spec_12_1() -> Vec<LineInput> {
        vec![
            labor(1, 120 * 60),
            labor(2, 80 * 60),
            money(CostType::Material, 900_000),
            money(CostType::Outsource, 500_000),
            money(CostType::Travel, 150_000),
            money(CostType::Other, 50_000),
        ]
    }

    #[test]
    fn t09_当初予算は工数と予算用単価から2600000円() {
        let priced = price(&spec_12_1(), Some(5_000));
        assert_eq!(priced[0].amount, Some(600_000));
        assert_eq!(priced[1].amount, Some(400_000));
        assert_eq!(priced[0].rate, Some(5_000));
        assert_eq!(priced[2].rate, None);
        assert_eq!(total(&priced), Some(2_600_000));
        assert_eq!(
            check_approval(&priced, 1, None, ProjectStatus::Ordered),
            Ok(())
        );
    }

    #[test]
    fn t09_予算用単価がなければ労務は未確定で承認できない() {
        let priced = price(&spec_12_1(), None);
        assert_eq!(priced[0].amount, None);
        assert_eq!(priced[2].amount, Some(900_000));
        assert_eq!(total(&priced), None);
        assert_eq!(
            check_approval(&priced, 1, None, ProjectStatus::Ordered),
            Err(vec![ApprovalIssue::RateMissing])
        );
        // 労務がなければ単価なしでも承認できる。
        let no_labor = price(&[money(CostType::Material, 10_000)], None);
        assert_eq!(
            check_approval(&no_labor, 1, None, ProjectStatus::InProgress),
            Ok(())
        );
    }

    #[test]
    fn t09_変更予算は理由が必須で当初版は版1() {
        assert_eq!(next_version(&[]), 1);
        assert_eq!(next_version(&[1, 2]), 3);
        let priced = price(&spec_12_1(), Some(5_000));
        assert_eq!(
            check_approval(&priced, 2, Some("  "), ProjectStatus::InProgress),
            Err(vec![ApprovalIssue::ReasonRequired])
        );
        assert_eq!(
            check_approval(&priced, 2, Some("追加工事"), ProjectStatus::InProgress),
            Ok(())
        );
    }

    #[test]
    fn t09_受注前と精算完了の案件は承認できない() {
        let priced = price(&spec_12_1(), Some(5_000));
        for status in [
            ProjectStatus::Negotiating,
            ProjectStatus::Settled,
            ProjectStatus::Cancelled,
        ] {
            assert_eq!(
                check_approval(&priced, 1, None, status),
                Err(vec![ApprovalIssue::ProjectNotOrdered])
            );
        }
        assert_eq!(
            check_approval(&[], 1, None, ProjectStatus::WorkDone),
            Err(vec![ApprovalIssue::NoLines])
        );
    }

    #[test]
    fn 明細の検査() {
        assert_eq!(validate_lines(&[]), Ok(()));
        assert_eq!(validate_lines(&spec_12_1()), Ok(()));
        let bad = [
            LineInput {
                key: key(Some(1), CostType::Labor),
                minutes: Some(0),
                amount: Some(1),
            },
            LineInput {
                key: key(None, CostType::Material),
                minutes: Some(60),
                amount: None,
            },
            money(CostType::Travel, -1),
            money(CostType::Travel, 5),
        ];
        assert_eq!(
            validate_lines(&bad),
            Err(vec![
                LineIssue::MinutesRequired { index: 0 },
                LineIssue::LaborWithAmount { index: 0 },
                LineIssue::AmountRequired { index: 1 },
                LineIssue::MinutesOnNonLabor { index: 1 },
                LineIssue::AmountNegative { index: 2 },
                LineIssue::Duplicate { index: 3 },
            ])
        );
        // 0円の明細は「予定なし」ではなく0円の予定として認める。
        assert_eq!(validate_lines(&[money(CostType::Other, 0)]), Ok(()));
    }

    #[test]
    fn t09_比較は当初と現在を並べ実績を集計した費目だけ差異を出す() {
        let original = [
            (key(Some(1), CostType::Labor), 600_000),
            (key(None, CostType::Material), 900_000),
        ];
        let current = [
            (key(Some(1), CostType::Labor), 700_000),
            (key(Some(2), CostType::Labor), 100_000),
            (key(None, CostType::Material), 900_000),
        ];
        let actual = [
            (key(Some(1), CostType::Labor), 650_000),
            (key(Some(3), CostType::Labor), 20_000),
        ];
        let rows = compare(Some(&original), Some(&current), &actual, &[CostType::Labor]);
        let find = |k: LineKey| rows.iter().find(|r| r.key == k).copied().unwrap();
        let l1 = find(key(Some(1), CostType::Labor));
        assert_eq!(
            (l1.original, l1.current, l1.actual, l1.variance),
            (Some(600_000), Some(700_000), Some(650_000), Some(-50_000))
        );
        let l2 = find(key(Some(2), CostType::Labor));
        assert_eq!(
            (l2.original, l2.actual, l2.variance),
            (None, Some(0), Some(-100_000))
        );
        // 予算にない工程の実績はそのまま超過になる。
        let l3 = find(key(Some(3), CostType::Labor));
        assert_eq!((l3.current, l3.variance), (None, Some(20_000)));
        // 材料費の実績はまだ集計していないので0円にしない。
        let mat = find(key(None, CostType::Material));
        assert_eq!((mat.actual, mat.variance), (None, None));
    }

    #[test]
    fn t09_承認予算がなければ差異は出さない() {
        let actual = [(key(Some(1), CostType::Labor), 10_000)];
        let rows = compare(None, None, &actual, &[CostType::Labor]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].actual, Some(10_000));
        assert_eq!(rows[0].variance, None);
    }
}
