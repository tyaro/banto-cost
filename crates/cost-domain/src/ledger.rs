//! 直接費の台帳：費用配分・調整（返品・取消・値引き）・仮計上の確定と、月別・期別・累計の集計。
//!
//! - 調整は元明細を参照する別の記録で表し、通常入力の負数とは区別する（仕様11）。
//! - 仮計上は請求確定の記録で置き換え、両方を原価に数えない（仕様6.3）。
//! - 配分した元費用は配分先だけに計上し、元費用と配分先を二重に集計しない（仕様6.3、6.4）。
//! - 集計の対象日付は各記録の管理計上日に統一する。配分は元費用の管理計上日を使う（T15）。

use std::collections::{BTreeMap, BTreeSet};

use crate::calendar::{Date, FiscalCalendar, YearMonth};
use crate::forecast::{ByCostType, CostType};
use crate::money::Yen;

/// 調整の種類。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdjustmentKind {
    Return,
    Cancel,
    Discount,
}

/// 記録の種類。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntryKind {
    Normal,
    /// 請求未着の見積計上。
    Provisional,
    /// 仮計上を請求確定額で置き換える訂正。
    Confirms {
        provisional_id: String,
    },
    /// 元明細への調整。`amount` は減額分を正の値で持つ。
    Adjustment {
        corrects_id: String,
        kind: AdjustmentKind,
    },
}

/// 直接費の1記録。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CostEntry {
    pub id: String,
    /// 帰属する案件。`None` は配分待ち（複数案件の旅費など）。調整・確定は元明細の案件を引き継ぐ。
    pub project: Option<String>,
    /// 工程（`None` は工程指定なし）。調整・確定は元明細の工程を引き継ぐ。
    pub phase: Option<i64>,
    /// 対応する発注。調整・確定は元明細の発注を引き継ぐ。
    pub purchase_order: Option<String>,
    pub cost_type: CostType,
    /// 管理計上日。
    pub booked_on: Date,
    pub amount: Yen,
    pub kind: EntryKind,
}

/// 費用配分の1行。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Allocation {
    pub source_id: String,
    pub project: String,
    pub amount: Yen,
}

/// 台帳の不整合。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LedgerIssue {
    /// 通常・仮計上・調整の金額は正、確定額は0以上であること。減額は調整で表す。
    InvalidAmount {
        id: String,
    },
    DuplicateId {
        id: String,
    },
    UnknownReference {
        id: String,
        target: String,
    },
    /// 調整・確定の参照先が不適切（調整への調整、確定済みの仮計上への調整など）。
    InvalidTarget {
        id: String,
        target: String,
    },
    ProvisionalConfirmedTwice {
        provisional_id: String,
    },
    /// 調整の合計が元明細を超える。
    AdjustmentExceedsOriginal {
        target: String,
        excess: Yen,
    },
    /// 配分合計が元費用（調整後）と一致しない。
    AllocationMismatch {
        source_id: String,
        allocated: Yen,
        source: Yen,
    },
    /// 配分は「通常」または「確定」の記録にだけ付けられる。
    AllocationOfInvalidSource {
        source_id: String,
    },
    /// 案件が未設定で配分もない。
    Unassigned {
        id: String,
    },
}

/// 集計に使う確定した計上行。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Posting {
    pub project: String,
    pub phase: Option<i64>,
    pub purchase_order: Option<String>,
    pub cost_type: CostType,
    pub booked_on: Date,
    pub amount: Yen,
    /// 由来の記録。
    pub entry_id: String,
}

/// 金額を重みで按分する。端数は最大剰余法で配り、合計は必ず元の金額に一致する。
///
/// 重みがすべて0、または負の重みがあれば `None`。
pub fn split_by_weights(amount: Yen, weights: &[i64]) -> Option<Vec<Yen>> {
    if weights.iter().any(|w| *w < 0) {
        return None;
    }
    let total: i128 = weights.iter().map(|w| *w as i128).sum();
    if total == 0 {
        return None;
    }
    let a = amount as i128;
    let mut parts: Vec<i128> = weights.iter().map(|w| a * *w as i128 / total).collect();
    let mut rest = a - parts.iter().sum::<i128>();
    let mut order: Vec<usize> = (0..weights.len()).collect();
    // 余りの大きい順（同じなら先の行）に1円ずつ配る。
    order.sort_by_key(|&i| (std::cmp::Reverse((a * weights[i] as i128 % total).abs()), i));
    let step = rest.signum();
    for &i in order.iter().cycle() {
        if rest == 0 {
            break;
        }
        if weights[i] == 0 {
            continue;
        }
        parts[i] += step;
        rest -= step;
    }
    Some(parts.into_iter().map(|p| p as Yen).collect())
}

/// 元明細とそれを参照する調整・確定の記録を、元明細を先頭に返す（T14の追跡）。
pub fn history<'a>(entries: &'a [CostEntry], id: &str) -> Vec<&'a CostEntry> {
    let mut out: Vec<&CostEntry> = entries.iter().filter(|e| e.id == id).collect();
    out.extend(entries.iter().filter(|e| match &e.kind {
        EntryKind::Confirms { provisional_id } => provisional_id == id,
        EntryKind::Adjustment { corrects_id, .. } => corrects_id == id,
        _ => false,
    }));
    out
}

/// 台帳を検査し、集計用の計上行に変換する。不整合があれば計上行を返さない。
pub fn postings<'a>(
    entries: &'a [CostEntry],
    allocations: &[Allocation],
) -> Result<Vec<Posting>, Vec<LedgerIssue>> {
    let mut issues = Vec::new();
    let mut by_id: BTreeMap<&str, &CostEntry> = BTreeMap::new();
    for e in entries {
        if by_id.insert(&e.id, e).is_some() {
            issues.push(LedgerIssue::DuplicateId { id: e.id.clone() });
        }
        let ok = match e.kind {
            EntryKind::Confirms { .. } => e.amount >= 0,
            _ => e.amount > 0,
        };
        if !ok {
            issues.push(LedgerIssue::InvalidAmount { id: e.id.clone() });
        }
    }

    // 仮計上の確定と、元明細ごとの調整合計。
    let mut confirmed: BTreeSet<&str> = BTreeSet::new();
    let mut adjusted: BTreeMap<&str, Yen> = BTreeMap::new();
    for e in entries {
        let (target, is_confirm) = match &e.kind {
            EntryKind::Confirms { provisional_id } => (provisional_id.as_str(), true),
            EntryKind::Adjustment { corrects_id, .. } => (corrects_id.as_str(), false),
            _ => continue,
        };
        let Some(t) = by_id.get(target) else {
            issues.push(LedgerIssue::UnknownReference {
                id: e.id.clone(),
                target: target.into(),
            });
            continue;
        };
        if is_confirm {
            if t.kind != EntryKind::Provisional {
                issues.push(LedgerIssue::InvalidTarget {
                    id: e.id.clone(),
                    target: target.into(),
                });
            } else if !confirmed.insert(target) {
                issues.push(LedgerIssue::ProvisionalConfirmedTwice {
                    provisional_id: target.into(),
                });
            }
        } else if matches!(t.kind, EntryKind::Adjustment { .. }) {
            issues.push(LedgerIssue::InvalidTarget {
                id: e.id.clone(),
                target: target.into(),
            });
        } else {
            *adjusted.entry(target).or_default() += e.amount;
        }
    }
    for (target, adj) in &adjusted {
        let t = by_id[target];
        if t.kind == EntryKind::Provisional && confirmed.contains(target) {
            // 確定済みの仮計上は原価に残らないため、調整は確定の記録に付ける。
            for e in entries.iter().filter(|e| {
                matches!(&e.kind, EntryKind::Adjustment { corrects_id, .. } if corrects_id == target)
            }) {
                issues.push(LedgerIssue::InvalidTarget {
                    id: e.id.clone(),
                    target: (*target).into(),
                });
            }
        } else if *adj > t.amount {
            issues.push(LedgerIssue::AdjustmentExceedsOriginal {
                target: (*target).into(),
                excess: adj - t.amount,
            });
        }
    }

    // 配分。
    let mut allocated: BTreeMap<&str, Vec<&Allocation>> = BTreeMap::new();
    for a in allocations {
        allocated.entry(&a.source_id).or_default().push(a);
    }
    for (src, lines) in &allocated {
        let Some(s) = by_id.get(src) else {
            issues.push(LedgerIssue::UnknownReference {
                id: format!("allocation:{src}"),
                target: (*src).into(),
            });
            continue;
        };
        if !matches!(s.kind, EntryKind::Normal | EntryKind::Confirms { .. }) {
            issues.push(LedgerIssue::AllocationOfInvalidSource {
                source_id: (*src).into(),
            });
            continue;
        }
        let net = s.amount - adjusted.get(src).copied().unwrap_or(0);
        let sum: Yen = lines.iter().map(|a| a.amount).sum();
        if sum != net || lines.iter().any(|a| a.amount < 0) {
            issues.push(LedgerIssue::AllocationMismatch {
                source_id: (*src).into(),
                allocated: sum,
                source: net,
            });
        }
    }

    // 帰属案件と費目の解決（確定・調整は元明細のものを引き継ぐ）。
    // 不正な参照の循環でも止まるよう、たどる回数を記録数で打ち切る。
    let root = |e: &'a CostEntry| -> Option<&'a CostEntry> {
        let mut cur = e;
        for _ in 0..=entries.len() {
            match &cur.kind {
                EntryKind::Confirms { provisional_id: t }
                | EntryKind::Adjustment { corrects_id: t, .. } => {
                    cur = by_id.get(t.as_str())?;
                }
                _ => return Some(cur),
            }
        }
        None
    };

    let mut out = Vec::new();
    for e in entries {
        if allocated.contains_key(e.id.as_str()) {
            for a in &allocated[e.id.as_str()] {
                out.push(Posting {
                    project: a.project.clone(),
                    phase: e.phase,
                    purchase_order: e.purchase_order.clone(),
                    cost_type: e.cost_type,
                    booked_on: e.booked_on,
                    amount: a.amount,
                    entry_id: e.id.clone(),
                });
            }
            continue;
        }
        let amount = match &e.kind {
            EntryKind::Provisional if confirmed.contains(e.id.as_str()) => continue,
            EntryKind::Adjustment { corrects_id, .. } => {
                // 配分済みの元費用への調整は、配分額（調整後で一致検査済み）に含まれる。
                if allocated.contains_key(corrects_id.as_str()) {
                    continue;
                }
                -e.amount
            }
            _ => e.amount,
        };
        match root(e) {
            Some(r) if r.project.is_some() => out.push(Posting {
                project: r.project.clone().expect("checked"),
                phase: r.phase,
                purchase_order: r.purchase_order.clone(),
                cost_type: r.cost_type,
                booked_on: e.booked_on,
                amount,
                entry_id: e.id.clone(),
            }),
            _ => issues.push(LedgerIssue::Unassigned { id: e.id.clone() }),
        }
    }
    if issues.is_empty() {
        Ok(out)
    } else {
        Err(issues)
    }
}

impl LedgerIssue {
    /// 不整合の原因になった記録（配分の不整合は元費用）。系列ごと外す起点にする（T39）。
    pub fn subject(&self) -> &str {
        match self {
            Self::InvalidAmount { id }
            | Self::DuplicateId { id }
            | Self::InvalidTarget { id, .. }
            | Self::Unassigned { id } => id,
            Self::UnknownReference { id, target } => {
                if id.starts_with("allocation:") {
                    target
                } else {
                    id
                }
            }
            Self::ProvisionalConfirmedTwice { provisional_id } => provisional_id,
            Self::AdjustmentExceedsOriginal { target, .. } => target,
            Self::AllocationMismatch { source_id, .. }
            | Self::AllocationOfInvalidSource { source_id } => source_id,
        }
    }

    /// 画面・API で使う不整合の種類。
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidAmount { .. } => "invalid_amount",
            Self::DuplicateId { .. } => "duplicate_id",
            Self::UnknownReference { .. } => "unknown_reference",
            Self::InvalidTarget { .. } => "invalid_target",
            Self::ProvisionalConfirmedTwice { .. } => "confirmed_twice",
            Self::AdjustmentExceedsOriginal { .. } => "adjustment_exceeds_original",
            Self::AllocationMismatch { .. } => "allocation_mismatch",
            Self::AllocationOfInvalidSource { .. } => "allocation_of_invalid_source",
            Self::Unassigned { .. } => "unassigned",
        }
    }
}

/// 台帳に渡せなかった記録（種別・費目・管理計上日などが読めない行）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unreadable {
    pub id: String,
    /// 行に書かれた案件（読めれば）。
    pub project: Option<String>,
    /// 行に書かれた参照先（確定・調整の元明細。読めれば）。
    pub refers_to: Option<String>,
}

/// 要確認の記録を系列ごと外して解決した台帳（T39）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Resolved {
    /// 外した記録を除いた計上行。
    pub postings: Vec<Posting>,
    /// 見つかった不整合（読めない行は含まない）。
    pub issues: Vec<LedgerIssue>,
    /// 外した記録：読めない行・不整合の記録と、参照（確定・調整）でつながる同じ系列の記録。
    pub excluded: BTreeSet<String>,
    /// 外した記録が帰属・配分される案件。これらの案件の直接費は確定できない（要確認）。
    pub review_projects: BTreeSet<String>,
}

impl Resolved {
    /// 案件の直接費を確定できるか（外した記録が帰属・配分されていない）。
    pub fn is_clean(&self, project: &str) -> bool {
        !self.review_projects.contains(project)
    }
}

/// 台帳を解決する。[`postings`] と違い、不整合や読めない行があっても全体を止めない：
/// その記録を参照でつながる系列ごと外して残りを計上し、外した記録の案件を要確認として返す。
/// 読めない行を黙って落とさない（T39）。
pub fn resolve(
    entries: &[CostEntry],
    allocations: &[Allocation],
    unreadable: &[Unreadable],
) -> Resolved {
    // 参照（確定・調整 → 元明細）を無向の辺にする。系列は連結成分。
    let mut links: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    let refs = entries
        .iter()
        .filter_map(|e| match &e.kind {
            EntryKind::Confirms { provisional_id: t }
            | EntryKind::Adjustment { corrects_id: t, .. } => Some((e.id.as_str(), t.as_str())),
            _ => None,
        })
        .chain(
            unreadable
                .iter()
                .filter_map(|u| u.refers_to.as_deref().map(|t| (u.id.as_str(), t))),
        );
    for (a, b) in refs {
        links.entry(a).or_default().push(b);
        links.entry(b).or_default().push(a);
    }
    let close = |excluded: &mut BTreeSet<String>| {
        let mut stack: Vec<String> = excluded.iter().cloned().collect();
        while let Some(id) = stack.pop() {
            for next in links.get(id.as_str()).into_iter().flatten() {
                if excluded.insert((*next).to_string()) {
                    stack.push((*next).to_string());
                }
            }
        }
    };

    let mut excluded: BTreeSet<String> = unreadable.iter().map(|u| u.id.clone()).collect();
    let mut issues = Vec::new();
    let mut out = Vec::new();
    // 1回ごとに少なくとも1件外れるので、記録数＋配分元の数で必ず終わる。
    for _ in 0..=entries.len() + allocations.len() + 1 {
        close(&mut excluded);
        let kept: Vec<CostEntry> = entries
            .iter()
            .filter(|e| !excluded.contains(&e.id))
            .cloned()
            .collect();
        let kept_allocs: Vec<Allocation> = allocations
            .iter()
            .filter(|a| !excluded.contains(&a.source_id))
            .cloned()
            .collect();
        match postings(&kept, &kept_allocs) {
            Ok(p) => {
                out = p;
                break;
            }
            Err(found) => {
                let before = excluded.len();
                excluded.extend(found.iter().map(|i| i.subject().to_string()));
                issues.extend(found);
                if excluded.len() == before {
                    // 起点が増えない不整合（想定外）は、台帳全体を要確認にする。
                    excluded.extend(entries.iter().map(|e| e.id.clone()));
                    excluded.extend(allocations.iter().map(|a| a.source_id.clone()));
                }
            }
        }
    }

    let mut review_projects = BTreeSet::new();
    for e in entries.iter().filter(|e| excluded.contains(&e.id)) {
        review_projects.extend(e.project.clone());
    }
    for u in unreadable {
        review_projects.extend(u.project.clone());
    }
    for a in allocations
        .iter()
        .filter(|a| excluded.contains(&a.source_id))
    {
        review_projects.insert(a.project.clone());
    }
    Resolved {
        postings: out,
        issues,
        excluded,
        review_projects,
    }
}

/// 案件の原価集計（当月・当期・案件累計）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CostSummary {
    pub by_month: BTreeMap<YearMonth, ByCostType>,
    /// 期番号ごと。
    pub by_period: BTreeMap<i32, ByCostType>,
    pub cumulative: ByCostType,
}

/// 1案件の計上行を、管理計上日で月別・期別・累計に集計する。
pub fn summarize(postings: &[Posting], project: &str, cal: &FiscalCalendar) -> CostSummary {
    let mut s = CostSummary::default();
    for p in postings.iter().filter(|p| p.project == project) {
        let ym = p.booked_on.year_month();
        s.by_month.entry(ym).or_default().add(p.cost_type, p.amount);
        s.by_period
            .entry(cal.period_of(ym))
            .or_default()
            .add(p.cost_type, p.amount);
        s.cumulative.add(p.cost_type, p.amount);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> Date {
        Date::parse(s).unwrap()
    }
    fn entry(id: &str, project: Option<&str>, t: CostType, on: &str, amount: Yen) -> CostEntry {
        CostEntry {
            id: id.into(),
            project: project.map(Into::into),
            phase: None,
            purchase_order: None,
            cost_type: t,
            booked_on: d(on),
            amount,
            kind: EntryKind::Normal,
        }
    }
    fn adjust(id: &str, target: &str, on: &str, amount: Yen, kind: AdjustmentKind) -> CostEntry {
        CostEntry {
            id: id.into(),
            project: None,
            phase: None,
            purchase_order: None,
            cost_type: CostType::Material,
            booked_on: d(on),
            amount,
            kind: EntryKind::Adjustment {
                corrects_id: target.into(),
                kind,
            },
        }
    }
    fn alloc(src: &str, project: &str, amount: Yen) -> Allocation {
        Allocation {
            source_id: src.into(),
            project: project.into(),
            amount,
        }
    }
    fn total_of(p: &[Posting], project: &str) -> Yen {
        p.iter()
            .filter(|x| x.project == project)
            .map(|x| x.amount)
            .sum()
    }

    #[test]
    fn t10_旅費30000円を2案件に配分しても合計は30000円() {
        let entries = [entry("E1", None, CostType::Travel, "2026-12-10", 30_000)];
        let parts = split_by_weights(30_000, &[3, 2]).unwrap();
        assert_eq!(parts, vec![18_000, 12_000]);
        let allocs = [alloc("E1", "P-A", parts[0]), alloc("E1", "P-B", parts[1])];
        let p = postings(&entries, &allocs).unwrap();
        assert_eq!(total_of(&p, "P-A"), 18_000);
        assert_eq!(total_of(&p, "P-B"), 12_000);
        // 元費用は配分先にだけ計上され、二重に数えない。
        assert_eq!(p.iter().map(|x| x.amount).sum::<Yen>(), 30_000);
        assert_eq!(p.len(), 2);
    }

    #[test]
    fn t10_案件のある元費用を配分しても元案件に残らない() {
        let entries = [entry(
            "E1",
            Some("P-A"),
            CostType::Travel,
            "2026-12-10",
            30_000,
        )];
        let allocs = [alloc("E1", "P-A", 15_000), alloc("E1", "P-B", 15_000)];
        let p = postings(&entries, &allocs).unwrap();
        assert_eq!((total_of(&p, "P-A"), total_of(&p, "P-B")), (15_000, 15_000));
    }

    #[test]
    fn t10_配分合計が元費用と違えば不整合() {
        let entries = [entry("E1", None, CostType::Travel, "2026-12-10", 30_000)];
        let allocs = [alloc("E1", "P-A", 20_000), alloc("E1", "P-B", 20_000)];
        assert_eq!(
            postings(&entries, &allocs),
            Err(vec![LedgerIssue::AllocationMismatch {
                source_id: "E1".into(),
                allocated: 40_000,
                source: 30_000
            }])
        );
        // 配分のない案件未設定の費用も検出する。
        assert_eq!(
            postings(&entries, &[]),
            Err(vec![LedgerIssue::Unassigned { id: "E1".into() }])
        );
    }

    #[test]
    fn 按分の端数は合計に一致させる() {
        assert_eq!(
            split_by_weights(30_001, &[1, 1]).unwrap(),
            vec![15_001, 15_000]
        );
        assert_eq!(split_by_weights(100, &[1, 1, 1]).unwrap(), vec![34, 33, 33]);
        assert_eq!(split_by_weights(100, &[0, 2, 1]).unwrap(), vec![0, 67, 33]);
        assert_eq!(split_by_weights(100, &[0, 0]), None);
        assert_eq!(split_by_weights(100, &[1, -1]), None);
    }

    #[test]
    fn t14_返品と費用取消は元明細から減額し追跡できる() {
        let entries = [
            entry("M1", Some("P-A"), CostType::Material, "2026-11-05", 100_000),
            adjust("M1-R", "M1", "2026-11-20", 20_000, AdjustmentKind::Return),
            entry("O1", Some("P-A"), CostType::Outsource, "2026-11-10", 50_000),
            adjust("O1-C", "O1", "2026-12-01", 50_000, AdjustmentKind::Cancel),
        ];
        let p = postings(&entries, &[]).unwrap();
        let s = summarize(&p, "P-A", &FiscalCalendar::COMPANY_DEFAULT);
        assert_eq!(s.cumulative.material, 80_000);
        assert_eq!(s.cumulative.outsource, 0);
        // 調整は自分の管理計上日の月に入る。
        let dec = s.by_month[&YearMonth::parse("2026-12").unwrap()];
        assert_eq!(dec.outsource, -50_000);
        let h: Vec<&str> = history(&entries, "M1")
            .iter()
            .map(|e| e.id.as_str())
            .collect();
        assert_eq!(h, vec!["M1", "M1-R"]);
    }

    #[test]
    fn t14_仮計上の確定は置き換えで原価を二重にしない() {
        let mut prov = entry(
            "V1",
            Some("P-A"),
            CostType::Outsource,
            "2026-11-30",
            300_000,
        );
        prov.kind = EntryKind::Provisional;
        let mut conf = entry("V1-F", None, CostType::Outsource, "2026-11-30", 320_000);
        conf.kind = EntryKind::Confirms {
            provisional_id: "V1".into(),
        };
        let p = postings(&[prov.clone()], &[]).unwrap();
        assert_eq!(total_of(&p, "P-A"), 300_000);
        let entries = [prov, conf];
        let p = postings(&entries, &[]).unwrap();
        assert_eq!(total_of(&p, "P-A"), 320_000);
        assert_eq!(p.len(), 1);
        let h: Vec<&str> = history(&entries, "V1")
            .iter()
            .map(|e| e.id.as_str())
            .collect();
        assert_eq!(h, vec!["V1", "V1-F"]);
    }

    #[test]
    fn t14_不正な調整と負数入力を拒否() {
        let mut prov = entry(
            "V1",
            Some("P-A"),
            CostType::Outsource,
            "2026-11-30",
            300_000,
        );
        prov.kind = EntryKind::Provisional;
        let mut conf1 = entry("F1", None, CostType::Outsource, "2026-11-30", 300_000);
        conf1.kind = EntryKind::Confirms {
            provisional_id: "V1".into(),
        };
        let mut conf2 = conf1.clone();
        conf2.id = "F2".into();
        let entries = [
            entry("M1", Some("P-A"), CostType::Material, "2026-11-05", 100_000),
            adjust("R1", "M1", "2026-11-20", 120_000, AdjustmentKind::Return),
            adjust("R2", "R1", "2026-11-21", 1_000, AdjustmentKind::Discount),
            entry("N1", Some("P-A"), CostType::Material, "2026-11-05", -5_000),
            adjust("R3", "NOPE", "2026-11-21", 1_000, AdjustmentKind::Discount),
            prov,
            conf1,
            conf2,
            adjust("R4", "V1", "2026-12-01", 1_000, AdjustmentKind::Discount),
        ];
        let issues = postings(&entries, &[]).unwrap_err();
        for expected in [
            LedgerIssue::AdjustmentExceedsOriginal {
                target: "M1".into(),
                excess: 20_000,
            },
            LedgerIssue::InvalidTarget {
                id: "R2".into(),
                target: "R1".into(),
            },
            LedgerIssue::InvalidAmount { id: "N1".into() },
            LedgerIssue::UnknownReference {
                id: "R3".into(),
                target: "NOPE".into(),
            },
            LedgerIssue::ProvisionalConfirmedTwice {
                provisional_id: "V1".into(),
            },
            LedgerIssue::InvalidTarget {
                id: "R4".into(),
                target: "V1".into(),
            },
        ] {
            assert!(
                issues.contains(&expected),
                "{expected:?} が無い: {issues:?}"
            );
        }
    }

    #[test]
    fn 配分済み元費用への調整は配分額で一致させる() {
        let entries = [
            entry("E1", None, CostType::Travel, "2026-12-10", 30_000),
            adjust("E1-D", "E1", "2026-12-15", 2_000, AdjustmentKind::Discount),
        ];
        // 調整後28,000円に対して30,000円を配分していれば不整合。
        assert!(postings(
            &entries,
            &[alloc("E1", "P-A", 15_000), alloc("E1", "P-B", 15_000)]
        )
        .is_err());
        let p = postings(
            &entries,
            &[alloc("E1", "P-A", 14_000), alloc("E1", "P-B", 14_000)],
        )
        .unwrap();
        assert_eq!(p.iter().map(|x| x.amount).sum::<Yen>(), 28_000);
    }

    #[test]
    fn t15_年度またぎ案件の月別期別累計が明細合計と一致() {
        let entries = [
            entry("A1", Some("P-A"), CostType::Material, "2027-04-15", 200_000),
            entry(
                "A2",
                Some("P-A"),
                CostType::Outsource,
                "2027-05-31",
                300_000,
            ),
            entry(
                "A3",
                Some("P-A"),
                CostType::Outsource,
                "2027-06-01",
                150_000,
            ),
            entry("A4", Some("P-A"), CostType::Travel, "2027-07-20", 40_000),
            adjust("A1-R", "A1", "2027-06-10", 10_000, AdjustmentKind::Return),
            entry("B1", Some("P-B"), CostType::Material, "2027-05-01", 999_999),
        ];
        let p = postings(&entries, &[]).unwrap();
        let s = summarize(&p, "P-A", &FiscalCalendar::COMPANY_DEFAULT);
        let ym = |x: &str| YearMonth::parse(x).unwrap();
        assert_eq!(s.by_month[&ym("2027-05")].total(), 300_000);
        assert_eq!(s.by_month[&ym("2027-06")].total(), 140_000);
        // 5月末は第13期、6月1日は第14期（管理計上日で判定）。
        assert_eq!(s.by_period[&13].total(), 500_000);
        assert_eq!(s.by_period[&14].total(), 180_000);
        let line_total: Yen = p
            .iter()
            .filter(|x| x.project == "P-A")
            .map(|x| x.amount)
            .sum();
        let month_total: Yen = s.by_month.values().map(|c| c.total()).sum();
        let period_total: Yen = s.by_period.values().map(|c| c.total()).sum();
        assert_eq!(line_total, 680_000);
        assert_eq!(month_total, line_total);
        assert_eq!(period_total, line_total);
        assert_eq!(s.cumulative.total(), line_total);
        assert_eq!(s.cumulative.material, 190_000);
    }

    #[test]
    fn t39_問題がなければ台帳の計上行と同じで要確認なし() {
        let entries = [
            entry("M1", Some("P-A"), CostType::Material, "2026-11-05", 100_000),
            adjust("R1", "M1", "2026-11-20", 10_000, AdjustmentKind::Return),
        ];
        let r = resolve(&entries, &[], &[]);
        assert_eq!(r.postings, postings(&entries, &[]).unwrap());
        assert!(r.excluded.is_empty() && r.review_projects.is_empty() && r.issues.is_empty());
        assert!(r.is_clean("P-A"));
    }

    #[test]
    fn t39_読めない行は落とさず系列ごと外してその案件だけ要確認にする() {
        let entries = [
            entry("M1", Some("P-A"), CostType::Material, "2026-11-05", 100_000),
            // 読めない調整 X9 が M1 を参照している。
            entry("M2", Some("P-B"), CostType::Material, "2026-11-05", 50_000),
        ];
        let unreadable = [Unreadable {
            id: "X9".into(),
            project: None,
            refers_to: Some("M1".into()),
        }];
        let r = resolve(&entries, &[], &unreadable);
        // M1 は X9 と同じ系列なので外し、P-A は要確認。P-B はそのまま計上する。
        assert_eq!(
            r.excluded,
            ["M1", "X9"].into_iter().map(String::from).collect()
        );
        assert!(!r.is_clean("P-A"));
        assert!(r.is_clean("P-B"));
        assert_eq!(total_of(&r.postings, "P-B"), 50_000);
        assert_eq!(total_of(&r.postings, "P-A"), 0);
    }

    #[test]
    fn t39_不整合は全体を止めず配分先の案件も要確認にする() {
        let entries = [
            entry("E1", None, CostType::Travel, "2026-12-10", 30_000),
            entry("M1", Some("P-C"), CostType::Material, "2026-11-05", 100_000),
            adjust("R1", "M1", "2026-11-20", 120_000, AdjustmentKind::Return),
            entry("M2", Some("P-D"), CostType::Material, "2026-11-05", 70_000),
        ];
        // 配分の合計が元費用と合わない。
        let allocs = [alloc("E1", "P-A", 18_000), alloc("E1", "P-B", 10_000)];
        assert!(postings(&entries, &allocs).is_err());
        let r = resolve(&entries, &allocs, &[]);
        assert_eq!(
            r.review_projects,
            ["P-A", "P-B", "P-C"]
                .into_iter()
                .map(String::from)
                .collect()
        );
        assert_eq!(
            r.excluded,
            ["E1", "M1", "R1"].into_iter().map(String::from).collect()
        );
        assert_eq!(total_of(&r.postings, "P-D"), 70_000);
        assert_eq!(r.postings.len(), 1);
        assert!(r.issues.iter().any(|i| i.code() == "allocation_mismatch"));
        assert!(r
            .issues
            .iter()
            .any(|i| i.code() == "adjustment_exceeds_original"));
    }

    #[test]
    fn t39_外した結果で参照先を失う記録も同じ系列として外す() {
        let mut prov = entry(
            "V1",
            Some("P-A"),
            CostType::Outsource,
            "2026-11-30",
            300_000,
        );
        prov.kind = EntryKind::Provisional;
        let mut conf = entry("F1", None, CostType::Outsource, "2026-12-05", 280_000);
        conf.kind = EntryKind::Confirms {
            provisional_id: "V1".into(),
        };
        // 確定 F1 への調整が元明細を超える → V1・F1・R1 の系列ごと外す。
        let entries = [
            prov,
            conf,
            adjust("R1", "F1", "2026-12-10", 300_000, AdjustmentKind::Discount),
            entry("N1", None, CostType::Material, "2026-12-01", 1_000),
        ];
        let r = resolve(&entries, &[], &[]);
        assert!(r.excluded.contains("V1") && r.excluded.contains("F1"));
        assert!(r.excluded.contains("R1"));
        // 案件のない N1 は外すが、どの案件も要確認にはならない（一覧で報告する）。
        assert!(r.excluded.contains("N1"));
        assert_eq!(
            r.review_projects,
            ["P-A"].into_iter().map(String::from).collect()
        );
        assert!(r.postings.is_empty());
    }
}
