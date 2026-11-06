//! 計算基準（時間原価単価など）の適用値の解決。
//!
//! 会社基準を版（適用開始日つき）で持ち、案件ごと・項目ごとに後から上書きできる。
//! 解決順：明細の個別指定 → 案件の上書き → 会社基準（設計書 第10章）。
//! 変更は行の追加で表し、既存の行を書き換えない。

use crate::calendar::Date;

/// 計算基準の値の範囲。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scope {
    Company,
    Project(String),
}

/// 計算基準の1行。`value: None` は「会社基準に戻す」（案件の上書きでのみ使う）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalcValue {
    pub item: String,
    pub scope: Scope,
    pub valid_from: Date,
    pub value: Option<i64>,
    pub version: u32,
}

/// 適用値の出典。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// 明細で個別に指定された値（外注先・契約ごとの単価、個人別単価など）。
    LineSpecific,
    ProjectOverride {
        valid_from: Date,
    },
    Company {
        version: u32,
        valid_from: Date,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub value: i64,
    pub source: Source,
}

/// 同じ範囲の行から、対象日以前で最も新しい行を選ぶ。適用開始日が同じなら版の大きい方。
fn latest<'a>(rows: impl Iterator<Item = &'a CalcValue>, on: Date) -> Option<&'a CalcValue> {
    rows.filter(|r| r.valid_from <= on)
        .max_by_key(|r| (r.valid_from, r.version))
}

/// 対象日における項目の適用値を返す。どこにも値がなければ `None`（未設定）。
pub fn resolve(
    values: &[CalcValue],
    item: &str,
    project: Option<&str>,
    on: Date,
    line_specific: Option<i64>,
) -> Option<Resolved> {
    if let Some(v) = line_specific {
        return Some(Resolved {
            value: v,
            source: Source::LineSpecific,
        });
    }
    if let Some(pid) = project {
        let ov = latest(
            values
                .iter()
                .filter(|r| r.item == item && r.scope == Scope::Project(pid.to_owned())),
            on,
        );
        if let Some(CalcValue {
            value: Some(v),
            valid_from,
            ..
        }) = ov
        {
            return Some(Resolved {
                value: *v,
                source: Source::ProjectOverride {
                    valid_from: *valid_from,
                },
            });
        }
    }
    let c = latest(
        values
            .iter()
            .filter(|r| r.item == item && r.scope == Scope::Company),
        on,
    )?;
    Some(Resolved {
        value: c.value?,
        source: Source::Company {
            version: c.version,
            valid_from: c.valid_from,
        },
    })
}

/// 計算基準の追加で起きる不整合。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CalcBasisError {
    /// 同じ項目・範囲・適用開始日の行がすでにある。
    DuplicateValidFrom,
    /// 会社基準に「未設定（会社基準に戻す）」は置けない。
    CompanyValueMissing,
    /// この項目は案件で上書きできない。
    OverrideNotAllowed,
}

/// 新しい行を追加してよいか検査する。履歴は削除・上書きしない。
pub fn validate_new(
    values: &[CalcValue],
    new: &CalcValue,
    project_overridable: bool,
) -> Result<(), CalcBasisError> {
    match new.scope {
        Scope::Company if new.value.is_none() => return Err(CalcBasisError::CompanyValueMissing),
        Scope::Project(_) if !project_overridable => {
            return Err(CalcBasisError::OverrideNotAllowed)
        }
        _ => {}
    }
    if values
        .iter()
        .any(|r| r.item == new.item && r.scope == new.scope && r.valid_from == new.valid_from)
    {
        return Err(CalcBasisError::DuplicateValidFrom);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> Date {
        Date::parse(s).unwrap()
    }
    fn company(item: &str, from: &str, value: i64, version: u32) -> CalcValue {
        CalcValue {
            item: item.into(),
            scope: Scope::Company,
            valid_from: d(from),
            value: Some(value),
            version,
        }
    }
    fn project(pid: &str, item: &str, from: &str, value: Option<i64>) -> CalcValue {
        CalcValue {
            item: item.into(),
            scope: Scope::Project(pid.into()),
            valid_from: d(from),
            value,
            version: 1,
        }
    }
    fn sample() -> Vec<CalcValue> {
        vec![
            company("emp_rate", "2025-06-01", 4_800, 1),
            company("emp_rate", "2026-06-01", 5_000, 2),
            company("fc_rate", "2026-06-01", 5_000, 1),
        ]
    }

    #[test]
    fn t03_t31_作業日で会社基準の版を選ぶ() {
        let v = sample();
        assert_eq!(
            resolve(&v, "emp_rate", None, d("2026-05-31"), None)
                .unwrap()
                .value,
            4_800
        );
        let r = resolve(&v, "emp_rate", None, d("2026-06-01"), None).unwrap();
        assert_eq!(r.value, 5_000);
        assert_eq!(
            r.source,
            Source::Company {
                version: 2,
                valid_from: d("2026-06-01")
            }
        );
    }

    #[test]
    fn t32_案件の上書きはその案件だけに効く() {
        let mut v = sample();
        v.push(project("P-031", "fc_rate", "2026-12-10", Some(5_500)));
        assert_eq!(
            resolve(&v, "fc_rate", Some("P-031"), d("2026-12-10"), None)
                .unwrap()
                .value,
            5_500
        );
        assert_eq!(
            resolve(&v, "fc_rate", Some("P-031"), d("2026-12-09"), None)
                .unwrap()
                .value,
            5_000
        );
        assert_eq!(
            resolve(&v, "fc_rate", Some("P-027"), d("2026-12-10"), None)
                .unwrap()
                .value,
            5_000
        );
    }

    #[test]
    fn t34_会社基準に戻すと以後は会社基準() {
        let mut v = sample();
        v.push(project("P-031", "fc_rate", "2026-07-01", Some(5_500)));
        v.push(project("P-031", "fc_rate", "2026-12-01", None));
        assert_eq!(
            resolve(&v, "fc_rate", Some("P-031"), d("2026-11-30"), None)
                .unwrap()
                .value,
            5_500
        );
        let r = resolve(&v, "fc_rate", Some("P-031"), d("2026-12-01"), None).unwrap();
        assert_eq!(r.value, 5_000);
        assert!(matches!(r.source, Source::Company { .. }));
        assert_eq!(v.len(), 5, "履歴は残る");
    }

    #[test]
    fn 明細の個別指定が最優先() {
        let v = sample();
        let r = resolve(&v, "emp_rate", Some("P-031"), d("2026-12-10"), Some(5_200)).unwrap();
        assert_eq!(
            r,
            Resolved {
                value: 5_200,
                source: Source::LineSpecific
            }
        );
    }

    #[test]
    fn 未登録の項目は未設定() {
        assert_eq!(
            resolve(&sample(), "lodging", None, d("2026-12-10"), None),
            None
        );
        assert_eq!(
            resolve(&sample(), "emp_rate", None, d("2025-05-31"), None),
            None
        );
    }

    #[test]
    fn 追加時の検査() {
        let v = sample();
        assert_eq!(
            validate_new(&v, &company("emp_rate", "2026-06-01", 5_100, 3), true),
            Err(CalcBasisError::DuplicateValidFrom)
        );
        let mut missing = company("emp_rate", "2027-06-01", 0, 3);
        missing.value = None;
        assert_eq!(
            validate_new(&v, &missing, true),
            Err(CalcBasisError::CompanyValueMissing)
        );
        assert_eq!(
            validate_new(
                &v,
                &project("P-031", "tax_rate", "2026-12-01", Some(8)),
                false
            ),
            Err(CalcBasisError::OverrideNotAllowed)
        );
        assert_eq!(
            validate_new(&v, &company("emp_rate", "2027-06-01", 5_200, 3), true),
            Ok(())
        );
    }
}
