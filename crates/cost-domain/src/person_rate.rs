//! 個人別の時間原価単価（設計書 10.2 の1・10.9、2026-11-14 ユーザー決定）。
//!
//! 社員の時間原価単価は、人ごと（全案件）と、人×案件ごとに決められる。工数の単価は次の順で決まる。
//!
//! 1. その人のその案件の単価
//! 2. その人の単価（全案件）
//! 3. 案件の上書き（計算基準 `emp_rate`）
//! 4. 会社標準（計算基準 `emp_rate`）
//!
//! 各範囲の中では、作業日以前で最も新しい適用開始日の行を使う（同じ日なら版の大きい方）。
//! `value: None` の行は「この日からその範囲の単価をやめる」で、次の順位に戻る。
//! 変更は行の追加で表し、承認済みの工数の単価は書き換えない（当て直しの候補として数える）。

use std::collections::BTreeSet;

use crate::calc_basis::{resolve, CalcValue, Impact, Resolved, Source, Usage, UsageStatus};
use crate::calendar::Date;

/// 個人別単価の1行。`project: None` はその人の全案件の単価。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersonRate {
    pub person: i64,
    pub project: Option<i64>,
    pub valid_from: Date,
    /// 円/時。`None` はこの日からこの範囲の単価をやめる。
    pub value: Option<i64>,
    pub version: u32,
}

impl PersonRate {
    fn same_scope(&self, person: i64, project: Option<i64>) -> bool {
        self.person == person && self.project == project
    }
}

/// 範囲（人、人×案件）の中で、対象日以前で最も新しい行。
fn latest(
    rates: &[PersonRate],
    person: i64,
    project: Option<i64>,
    on: Date,
) -> Option<&PersonRate> {
    rates
        .iter()
        .filter(|r| r.same_scope(person, project) && r.valid_from <= on)
        .max_by_key(|r| (r.valid_from, r.version))
}

/// 対象日にその人に効く個人別単価の行（1・2の順）。どちらもなければ `None`
/// （案件の上書き・会社標準に任せる）。
pub fn applicable(
    rates: &[PersonRate],
    person: i64,
    project: Option<i64>,
    on: Date,
) -> Option<&PersonRate> {
    if project.is_some() {
        if let Some(row @ PersonRate { value: Some(_), .. }) = latest(rates, person, project, on) {
            return Some(row);
        }
    }
    match latest(rates, person, None, on) {
        Some(row @ PersonRate { value: Some(_), .. }) => Some(row),
        _ => None,
    }
}

/// 作業日にその人の工数に効く時間原価単価（1〜4の順）。どこにもなければ `None`（単価未設定）。
/// `values` は計算基準 `item` の行。
pub fn resolve_rate(
    values: &[CalcValue],
    rates: &[PersonRate],
    item: &str,
    person: i64,
    project: Option<i64>,
    on: Date,
) -> Option<Resolved> {
    if let Some(row) = applicable(rates, person, project, on) {
        return Some(Resolved {
            value: row.value.expect("applicable rows have a value"),
            source: Source::Person {
                valid_from: row.valid_from,
                project_specific: row.project.is_some(),
            },
        });
    }
    let pid = project.map(|p| p.to_string());
    resolve(values, item, pid.as_deref(), on, None)
}

/// 個人別単価の追加で起きる不整合。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PersonRateError {
    /// 同じ人・同じ範囲・同じ適用開始日の行がすでにある。
    DuplicateValidFrom,
    /// 「やめる」行だが、その日の直前にこの範囲で効いている単価がない。
    NothingToEnd,
}

/// 新しい行を追加してよいか検査する（値の範囲は呼び出し側が `ValueKind::Yen` で確かめる）。
pub fn validate_new(rates: &[PersonRate], new: &PersonRate) -> Result<(), PersonRateError> {
    let scope: Vec<&PersonRate> = rates
        .iter()
        .filter(|r| r.same_scope(new.person, new.project))
        .collect();
    if scope.iter().any(|r| r.valid_from == new.valid_from) {
        return Err(PersonRateError::DuplicateValidFrom);
    }
    // やめる行は、その日の直前にこの範囲で効いている単価があるときだけ置ける
    // （未来にだけ単価がある・すでにやめている範囲には置けない）。
    if new.value.is_none() {
        let in_effect = scope
            .iter()
            .filter(|r| r.valid_from < new.valid_from)
            .max_by_key(|r| (r.valid_from, r.version));
        if !matches!(in_effect, Some(PersonRate { value: Some(_), .. })) {
            return Err(PersonRateError::NothingToEnd);
        }
    }
    Ok(())
}

/// 次の版番号（同じ人・同じ範囲の行の最大＋1）。
pub fn next_version(rates: &[PersonRate], person: i64, project: Option<i64>) -> u32 {
    rates
        .iter()
        .filter(|r| r.same_scope(person, project))
        .map(|r| r.version)
        .max()
        .unwrap_or(0)
        + 1
}

/// 工数1件の単価の使い方（誰の工数か）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersonUsage {
    pub person: i64,
    pub usage: Usage,
}

impl PersonUsage {
    fn project(&self) -> Option<i64> {
        self.usage.project.as_deref().and_then(|p| p.parse().ok())
    }
}

/// 個人別単価の行 `new` を追加した場合の影響（設計書 10.5 と同じ数え方）。
/// 承認済みの工数は変えず、保存した単価と新しい適用値が違うものを当て直しの候補に数える。
pub fn impact(
    values: &[CalcValue],
    rates: &[PersonRate],
    new: &PersonRate,
    usages: &[PersonUsage],
) -> Impact {
    let mut after = rates.to_vec();
    after.push(new.clone());
    let mut affected = BTreeSet::new();
    let mut out = Impact::default();
    for u in usages.iter().filter(|u| u.person == new.person) {
        let project = u.project();
        let item = &u.usage.item;
        let before =
            resolve_rate(values, rates, item, u.person, project, u.usage.on).map(|r| r.value);
        let next =
            resolve_rate(values, &after, item, u.person, project, u.usage.on).map(|r| r.value);
        if before == next {
            // 出典だけが変わっても、適用する単価が同じなら金額は変わらない。
            continue;
        }
        if let Some(pid) = &u.usage.project {
            affected.insert(pid.clone());
        }
        out.includes_closed |= u.usage.closed;
        match u.usage.status {
            UsageStatus::Pending => out.pending += 1,
            UsageStatus::Approved => {
                if next != u.usage.applied_value {
                    out.correction_candidates.push(u.usage.id.clone());
                }
            }
        }
    }
    out.affected_projects = affected.into_iter().collect();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calc_basis::Scope;
    use crate::time::RATE_ITEM;

    fn d(s: &str) -> Date {
        Date::parse(s).unwrap()
    }

    fn company(from: &str, value: i64, version: u32) -> CalcValue {
        CalcValue {
            item: RATE_ITEM.into(),
            scope: Scope::Company,
            valid_from: d(from),
            value: Some(value),
            version,
        }
    }

    fn project_override(pid: i64, from: &str, value: Option<i64>) -> CalcValue {
        CalcValue {
            item: RATE_ITEM.into(),
            scope: Scope::Project(pid.to_string()),
            valid_from: d(from),
            value,
            version: 1,
        }
    }

    fn person(
        person: i64,
        project: Option<i64>,
        from: &str,
        value: Option<i64>,
        version: u32,
    ) -> PersonRate {
        PersonRate {
            person,
            project,
            valid_from: d(from),
            value,
            version,
        }
    }

    fn rate_of(
        values: &[CalcValue],
        rates: &[PersonRate],
        who: i64,
        project: Option<i64>,
        on: &str,
    ) -> Option<i64> {
        resolve_rate(values, rates, RATE_ITEM, who, project, d(on)).map(|r| r.value)
    }

    fn usage(id: &str, who: i64, project: i64, on: &str, applied: Option<i64>) -> PersonUsage {
        PersonUsage {
            person: who,
            usage: Usage {
                id: id.into(),
                item: RATE_ITEM.into(),
                project: Some(project.to_string()),
                on: d(on),
                status: if applied.is_some() || id.starts_with('a') {
                    UsageStatus::Approved
                } else {
                    UsageStatus::Pending
                },
                closed: false,
                line_specific: None,
                applied_value: applied,
            },
        }
    }

    #[test]
    fn t43_個人と案件の単価は個人を優先して選ぶ() {
        // 会社標準5,000円、案件1の上書き5,500円。
        let values = [
            company("2026-06-01", 5_000, 1),
            project_override(1, "2026-06-01", Some(5_500)),
        ];
        // 個人別の単価がない人は案件の上書き、案件の上書きのない案件では会社標準。
        assert_eq!(rate_of(&values, &[], 7, Some(1), "2026-11-09"), Some(5_500));
        assert_eq!(rate_of(&values, &[], 7, Some(2), "2026-11-09"), Some(5_000));
        // 個人の単価（全案件）6,000円は案件の上書きより優先する。
        let mut rates = vec![person(7, None, "2026-06-01", Some(6_000), 1)];
        assert_eq!(
            rate_of(&values, &rates, 7, Some(1), "2026-11-09"),
            Some(6_000)
        );
        assert_eq!(
            rate_of(&values, &rates, 7, Some(2), "2026-11-09"),
            Some(6_000)
        );
        // 共通活動（案件なし）にも個人の単価が効く。
        assert_eq!(rate_of(&values, &rates, 7, None, "2026-11-09"), Some(6_000));
        // その人のその案件の単価6,500円が最優先。他の案件は個人の単価のまま。
        rates.push(person(7, Some(1), "2026-06-01", Some(6_500), 1));
        let got = resolve_rate(&values, &rates, RATE_ITEM, 7, Some(1), d("2026-11-09")).unwrap();
        assert_eq!(got.value, 6_500);
        assert_eq!(
            got.source,
            Source::Person {
                valid_from: d("2026-06-01"),
                project_specific: true
            }
        );
        assert_eq!(
            rate_of(&values, &rates, 7, Some(2), "2026-11-09"),
            Some(6_000)
        );
        // 他の人には効かない。
        assert_eq!(
            rate_of(&values, &rates, 8, Some(1), "2026-11-09"),
            Some(5_500)
        );
    }

    #[test]
    fn t43_個人別単価は作業日で版を選びやめると次の順位に戻る() {
        let values = [company("2026-04-01", 5_000, 1)];
        let rates = vec![
            person(7, None, "2026-06-01", Some(6_000), 1),
            person(7, None, "2026-12-01", Some(6_300), 2),
            person(7, Some(1), "2026-06-01", Some(7_000), 1),
            // 案件1の個人の単価は2027年1月でやめる → 個人の単価に戻る。
            person(7, Some(1), "2027-01-01", None, 2),
        ];
        assert_eq!(rate_of(&values, &rates, 7, None, "2026-05-31"), Some(5_000));
        assert_eq!(rate_of(&values, &rates, 7, None, "2026-11-30"), Some(6_000));
        assert_eq!(rate_of(&values, &rates, 7, None, "2026-12-01"), Some(6_300));
        assert_eq!(
            rate_of(&values, &rates, 7, Some(1), "2026-12-31"),
            Some(7_000)
        );
        assert_eq!(
            rate_of(&values, &rates, 7, Some(1), "2027-01-01"),
            Some(6_300)
        );
        // 個人の単価もやめると会社標準に戻る。単価がどこにもなければ未設定（0円にしない）。
        let mut ended = rates.clone();
        ended.push(person(7, None, "2027-02-01", None, 3));
        assert_eq!(
            rate_of(&values, &ended, 7, Some(1), "2027-02-01"),
            Some(5_000)
        );
        assert_eq!(rate_of(&[], &ended, 7, Some(1), "2027-02-01"), None);
    }

    #[test]
    fn t43_同じ日の行とやめる対象のない行は追加できない() {
        let rates = vec![person(7, None, "2026-06-01", Some(6_000), 1)];
        assert_eq!(
            validate_new(&rates, &person(7, None, "2026-06-01", Some(6_100), 2)),
            Err(PersonRateError::DuplicateValidFrom)
        );
        // 別の範囲（人×案件）・別の人なら同じ日でもよい。
        assert_eq!(
            validate_new(&rates, &person(7, Some(1), "2026-06-01", Some(6_100), 1)),
            Ok(())
        );
        assert_eq!(
            validate_new(&rates, &person(8, None, "2026-06-01", Some(6_100), 1)),
            Ok(())
        );
        assert_eq!(
            validate_new(&rates, &person(7, Some(1), "2026-07-01", None, 1)),
            Err(PersonRateError::NothingToEnd)
        );
        assert_eq!(
            validate_new(&rates, &person(7, None, "2026-07-01", None, 2)),
            Ok(())
        );
        // 単価の開始前の日にはやめられない。
        assert_eq!(
            validate_new(&rates, &person(7, None, "2026-05-01", None, 2)),
            Err(PersonRateError::NothingToEnd)
        );
        // 未来にだけ単価がある範囲・すでにやめた範囲にもやめる行は置けない。
        let future = vec![person(7, Some(1), "2026-12-01", Some(6_500), 1)];
        assert_eq!(
            validate_new(&future, &person(7, Some(1), "2026-06-01", None, 2)),
            Err(PersonRateError::NothingToEnd)
        );
        let ended = vec![
            person(7, None, "2026-06-01", Some(6_000), 1),
            person(7, None, "2026-08-01", None, 2),
        ];
        assert_eq!(
            validate_new(&ended, &person(7, None, "2026-09-01", None, 3)),
            Err(PersonRateError::NothingToEnd)
        );
        assert_eq!(
            validate_new(&ended, &person(7, None, "2026-07-01", None, 3)),
            Ok(())
        );
        assert_eq!(next_version(&rates, 7, None), 2);
        assert_eq!(next_version(&rates, 7, Some(1)), 1);
    }

    #[test]
    fn t44_後から個人別単価を決めても承認済みは変えず当て直しの候補に数える() {
        // 単価がどこにもないまま承認した工数（a1）と、会社標準で承認した工数（a2）、下書き（d1）。
        let values = [company("2026-11-01", 5_000, 1)];
        let usages = vec![
            usage("a1", 7, 1, "2026-10-20", None),
            usage("a2", 7, 1, "2026-11-09", Some(5_000)),
            usage("d1", 7, 2, "2026-11-10", None),
            // 他の人の工数は数えない。
            usage("a3", 8, 1, "2026-11-09", Some(5_000)),
        ];
        let new = person(7, None, "2026-10-01", Some(6_000), 1);
        let got = impact(&values, &[], &new, &usages);
        assert_eq!(
            got.correction_candidates,
            vec!["a1".to_string(), "a2".to_string()]
        );
        assert_eq!(got.pending, 1);
        assert_eq!(
            got.affected_projects,
            vec!["1".to_string(), "2".to_string()]
        );
        // 適用開始日より前の作業日は影響しない。
        let later = person(7, None, "2026-11-10", Some(6_000), 1);
        let got = impact(&values, &[], &later, &usages);
        assert!(got.correction_candidates.is_empty());
        assert_eq!(got.pending, 1);
        // 承認済みの値と同じ単価なら候補にしない。
        let same = person(7, Some(1), "2026-11-01", Some(5_000), 1);
        let got = impact(&values, &[], &same, &usages);
        assert!(got.correction_candidates.is_empty());
    }
}
