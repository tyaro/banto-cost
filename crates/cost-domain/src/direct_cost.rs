//! 直接費の明細：入力の検査と承認時の検査（仕様6.3、6.4、11、T05、T10、T14）。
//!
//! - 直接費は材料・外注・旅費・その他だけ。労務は工数から求める（仕様7.1）。
//! - 金額は税抜の整数円。通常・仮計上・調整は正の値、仮計上の確定は0円以上。
//!   減額は通常入力の負数ではなく、元明細を参照する調整で表す（仕様11）。
//! - 複数案件にまたがる費用は案件を付けずに配分で表し、配分合計を元の金額に一致させる（T10）。
//! - 承認は承認済みの台帳に候補を加えて [`crate::ledger::postings`] で検査し、
//!   発注にひもづく実績化が未実績発注残を超えないことを確かめる（T05）。

use crate::forecast::CostType;
use crate::ledger::{postings, AdjustmentKind, Allocation, CostEntry, LedgerIssue, Posting};
use crate::money::Yen;
use crate::purchase::{PurchaseError, PurchaseOrder};

/// 1明細の配分先の上限。
pub const MAX_ALLOCATIONS: usize = 50;

/// 税区分。正式な扱いは経理確認のうえ決める（仕様7.4）。比較は税抜額で行う。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaxKind {
    /// 課税（標準税率）。
    Standard,
    /// 課税（軽減税率）。
    Reduced,
    /// 非課税。
    Exempt,
    /// 不課税（謝礼など）。
    OutOfScope,
}

impl TaxKind {
    pub const ALL: [TaxKind; 4] = [
        Self::Standard,
        Self::Reduced,
        Self::Exempt,
        Self::OutOfScope,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::Reduced => "reduced",
            Self::Exempt => "exempt",
            Self::OutOfScope => "out_of_scope",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == s)
    }
}

impl AdjustmentKind {
    pub const ALL: [AdjustmentKind; 3] = [Self::Return, Self::Cancel, Self::Discount];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Return => "return",
            Self::Cancel => "cancel",
            Self::Discount => "discount",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == s)
    }
}

/// 明細の種類（DB・通信の `entry_kind`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordKind {
    Normal,
    /// 請求未着の見積計上（仕様6.3）。
    Provisional,
    /// 仮計上を請求確定額で置き換える訂正。
    Confirms,
    /// 元明細への返品・取消・値引き。
    Adjustment,
}

impl RecordKind {
    pub const ALL: [RecordKind; 4] = [
        Self::Normal,
        Self::Provisional,
        Self::Confirms,
        Self::Adjustment,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Provisional => "provisional",
            Self::Confirms => "confirms",
            Self::Adjustment => "adjustment",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == s)
    }

    /// 元明細を参照する種類（確定・調整）。
    pub fn refers(self) -> bool {
        matches!(self, Self::Confirms | Self::Adjustment)
    }
}

/// 検査する入力。確定・調整の案件・費目・発注は、呼び出し側が元明細から引き継いで渡す。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CostInput {
    pub kind: RecordKind,
    pub project: Option<i64>,
    pub cost_type: CostType,
    pub amount: Yen,
    pub amount_in_tax: Option<Yen>,
    pub purchase_order: Option<i64>,
    /// 配分先（案件、金額）。
    pub allocations: Vec<(i64, Yen)>,
    /// 確定・調整の理由があるか。
    pub has_reason: bool,
}

/// 入力の不整合。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CostIssue {
    /// 労務費は直接費として入力しない。
    LaborNotDirect,
    /// 通常・仮計上・調整の金額は1円以上。
    AmountNotPositive,
    /// 確定額は0円以上。
    AmountNegative,
    InTaxNegative,
    /// 案件も配分もない。
    TargetRequired,
    /// 案件と配分の両方がある。
    ProjectAndAllocations,
    /// 配分は2案件以上。
    AllocationTooFew,
    TooManyAllocations,
    AllocationNotPositive {
        index: usize,
    },
    AllocationDuplicate {
        index: usize,
    },
    /// 配分合計が金額と一致しない。
    AllocationMismatch {
        allocated: Yen,
        amount: Yen,
    },
    /// 配分できるのは通常の明細だけ（仮計上・確定・調整は元明細の案件に付く）。
    AllocationNotNormal,
    /// 発注にひもづく明細は発注の案件に付けるので配分しない。
    AllocationWithOrder,
    /// 確定・調整には理由が要る（仕様11）。
    ReasonRequired,
}

/// 明細の入力を検査する。
pub fn check_input(input: &CostInput) -> Result<(), Vec<CostIssue>> {
    let mut issues = Vec::new();
    if input.cost_type == CostType::Labor {
        issues.push(CostIssue::LaborNotDirect);
    }
    match input.kind {
        RecordKind::Confirms if input.amount < 0 => issues.push(CostIssue::AmountNegative),
        RecordKind::Confirms => {}
        _ if input.amount <= 0 => issues.push(CostIssue::AmountNotPositive),
        _ => {}
    }
    if input.amount_in_tax.is_some_and(|v| v < 0) {
        issues.push(CostIssue::InTaxNegative);
    }
    if input.kind.refers() && !input.has_reason {
        issues.push(CostIssue::ReasonRequired);
    }
    let allocations = &input.allocations;
    match (input.project.is_some(), allocations.is_empty()) {
        (false, true) => issues.push(CostIssue::TargetRequired),
        (true, false) => issues.push(CostIssue::ProjectAndAllocations),
        _ => {}
    }
    if !allocations.is_empty() {
        if input.kind != RecordKind::Normal {
            issues.push(CostIssue::AllocationNotNormal);
        }
        if input.purchase_order.is_some() {
            issues.push(CostIssue::AllocationWithOrder);
        }
        if allocations.len() < 2 {
            issues.push(CostIssue::AllocationTooFew);
        }
        if allocations.len() > MAX_ALLOCATIONS {
            issues.push(CostIssue::TooManyAllocations);
        }
        for (index, (project, amount)) in allocations.iter().enumerate() {
            if *amount <= 0 {
                issues.push(CostIssue::AllocationNotPositive { index });
            }
            if allocations[..index].iter().any(|(p, _)| p == project) {
                issues.push(CostIssue::AllocationDuplicate { index });
            }
        }
        let allocated: Yen = allocations.iter().map(|(_, a)| *a).sum();
        if allocated != input.amount {
            issues.push(CostIssue::AllocationMismatch {
                allocated,
                amount: input.amount,
            });
        }
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(issues)
    }
}

/// 発注の条件（発注額と取消額）。実績化済み額は台帳から求める。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OrderTerms {
    pub amount: Yen,
    pub cancelled: Yen,
}

/// 承認できない理由。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalIssue {
    Ledger(LedgerIssue),
    /// 実績化の合計が発注額 − 取消額を超える。発注額の見直し（理由つき）が先に要る（仕様6.3）。
    ExceedsOrder {
        excess: Yen,
    },
}

/// 発注の実績化済み額 ＝ その発注にひもづく計上行の合計（確定済みの仮計上は置き換え後の額）。
pub fn order_realized(postings: &[Posting], order: &str) -> Yen {
    postings
        .iter()
        .filter(|p| p.purchase_order.as_deref() == Some(order))
        .map(|p| p.amount)
        .sum()
}

/// 発注の状態（実績化済み額は台帳から）。
pub fn order_state(terms: OrderTerms, postings: &[Posting], order: &str) -> PurchaseOrder {
    PurchaseOrder {
        amount: terms.amount,
        cancelled: terms.cancelled,
        realized: order_realized(postings, order),
    }
}

/// 承認済みの台帳 `approved` に `candidate` を加えて検査し、加えた後の計上行を返す。
///
/// `order` は候補（の元明細）がひもづく発注の条件。発注残を超える実績化は拒否する（T05）。
pub fn check_approval(
    approved: &[CostEntry],
    allocations: &[Allocation],
    candidate: CostEntry,
    candidate_allocations: &[Allocation],
    order: Option<(&str, OrderTerms)>,
) -> Result<Vec<Posting>, Vec<ApprovalIssue>> {
    let mut entries = approved.to_vec();
    entries.push(candidate);
    let mut allocs = allocations.to_vec();
    allocs.extend_from_slice(candidate_allocations);
    let posted = postings(&entries, &allocs).map_err(|issues| {
        issues
            .into_iter()
            .map(ApprovalIssue::Ledger)
            .collect::<Vec<_>>()
    })?;
    if let Some((id, terms)) = order {
        let state = order_state(terms, &posted, id);
        if state.remaining() < 0 {
            return Err(vec![ApprovalIssue::ExceedsOrder {
                excess: -state.remaining(),
            }]);
        }
    }
    Ok(posted)
}

/// 発注の取消を検査する（実績化済み額は承認済みの台帳から）。
pub fn check_cancel(
    terms: OrderTerms,
    postings: &[Posting],
    order: &str,
    amount: Yen,
) -> Result<OrderTerms, PurchaseError> {
    let mut state = order_state(terms, postings, order);
    state.cancel(amount)?;
    Ok(OrderTerms {
        amount: state.amount,
        cancelled: state.cancelled,
    })
}

/// 発注額の見直しを検査する。
pub fn check_amount_change(
    terms: OrderTerms,
    postings: &[Posting],
    order: &str,
    amount: Yen,
) -> Result<OrderTerms, PurchaseError> {
    let mut state = order_state(terms, postings, order);
    state.change_amount(amount)?;
    Ok(OrderTerms {
        amount: state.amount,
        cancelled: state.cancelled,
    })
}

/// 案件の実績を工程×費目で合計する（予算との比較用）。
pub fn project_actuals(postings: &[Posting], project: &str) -> Vec<(Option<i64>, CostType, Yen)> {
    let mut out: Vec<(Option<i64>, CostType, Yen)> = Vec::new();
    for p in postings.iter().filter(|p| p.project == project) {
        match out
            .iter_mut()
            .find(|(ph, t, _)| *ph == p.phase && *t == p.cost_type)
        {
            Some(row) => row.2 += p.amount,
            None => out.push((p.phase, p.cost_type, p.amount)),
        }
    }
    out.sort_by_key(|(ph, t, _)| (*ph, *t));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::Date;
    use crate::ledger::EntryKind;

    fn input(kind: RecordKind, amount: Yen) -> CostInput {
        CostInput {
            kind,
            project: Some(1),
            cost_type: CostType::Outsource,
            amount,
            amount_in_tax: None,
            purchase_order: None,
            allocations: vec![],
            has_reason: false,
        }
    }

    fn entry(id: &str, amount: Yen, kind: EntryKind, order: Option<&str>) -> CostEntry {
        CostEntry {
            id: id.into(),
            project: Some("1".into()),
            phase: Some(3),
            purchase_order: order.map(Into::into),
            cost_type: CostType::Outsource,
            booked_on: Date::parse("2026-11-30").unwrap(),
            amount,
            kind,
        }
    }

    const PO: OrderTerms = OrderTerms {
        amount: 500_000,
        cancelled: 0,
    };

    #[test]
    fn t05_外注500000円のうち300000円を検収し請求到着でも二重加算しない() {
        // 検収時に仮計上300,000円を承認。
        let prov = entry("1", 300_000, EntryKind::Provisional, Some("PO1"));
        let p = check_approval(&[], &[], prov.clone(), &[], Some(("PO1", PO))).unwrap();
        assert_eq!(order_realized(&p, "PO1"), 300_000);
        assert_eq!(order_state(PO, &p, "PO1").remaining(), 200_000);
        // 同額の請求書は仮計上の確定（置き換え）で、実績は600,000円にならない。
        let conf = CostEntry {
            purchase_order: None,
            ..entry(
                "2",
                300_000,
                EntryKind::Confirms {
                    provisional_id: "1".into(),
                },
                None,
            )
        };
        let p = check_approval(&[prov], &[], conf, &[], Some(("PO1", PO))).unwrap();
        assert_eq!(p.iter().map(|x| x.amount).sum::<Yen>(), 300_000);
        assert_eq!(order_state(PO, &p, "PO1").remaining(), 200_000);
        assert_eq!(
            project_actuals(&p, "1"),
            vec![(Some(3), CostType::Outsource, 300_000)]
        );
    }

    #[test]
    fn t05_発注残を超える実績化は承認できない() {
        let first = entry("1", 450_000, EntryKind::Normal, Some("PO1"));
        let second = entry("2", 100_000, EntryKind::Normal, Some("PO1"));
        assert_eq!(
            check_approval(&[first], &[], second, &[], Some(("PO1", PO))),
            Err(vec![ApprovalIssue::ExceedsOrder { excess: 50_000 }])
        );
    }

    #[test]
    fn t05_取消と発注額の見直しは実績化済み額を下回らない() {
        let first = entry("1", 300_000, EntryKind::Normal, Some("PO1"));
        let p = check_approval(&[], &[], first, &[], Some(("PO1", PO))).unwrap();
        assert_eq!(
            check_cancel(PO, &p, "PO1", 250_000),
            Err(PurchaseError::ExceedsOrder { excess: 50_000 })
        );
        assert_eq!(
            check_cancel(PO, &p, "PO1", 200_000),
            Ok(OrderTerms {
                amount: 500_000,
                cancelled: 200_000
            })
        );
        assert_eq!(
            check_amount_change(PO, &p, "PO1", 299_999),
            Err(PurchaseError::BelowUsed { used: 300_000 })
        );
    }

    #[test]
    fn t14_返品は元明細から減額し発注の実績化済み額も減る() {
        let first = entry("1", 300_000, EntryKind::Normal, Some("PO1"));
        let ret = CostEntry {
            purchase_order: None,
            ..entry(
                "2",
                50_000,
                EntryKind::Adjustment {
                    corrects_id: "1".into(),
                    kind: AdjustmentKind::Return,
                },
                None,
            )
        };
        let p = check_approval(&[first], &[], ret, &[], Some(("PO1", PO))).unwrap();
        assert_eq!(order_realized(&p, "PO1"), 250_000);
        assert_eq!(project_actuals(&p, "1")[0].2, 250_000);
    }

    #[test]
    fn t10_配分の入力検査() {
        let mut i = input(RecordKind::Normal, 30_000);
        i.project = None;
        i.cost_type = CostType::Travel;
        i.allocations = vec![(1, 18_000), (2, 12_000)];
        assert_eq!(check_input(&i), Ok(()));
        i.allocations = vec![(1, 18_000), (1, 13_000)];
        assert_eq!(
            check_input(&i),
            Err(vec![
                CostIssue::AllocationDuplicate { index: 1 },
                CostIssue::AllocationMismatch {
                    allocated: 31_000,
                    amount: 30_000
                }
            ])
        );
        i.allocations = vec![(1, 30_000)];
        i.purchase_order = Some(9);
        assert_eq!(
            check_input(&i),
            Err(vec![
                CostIssue::AllocationWithOrder,
                CostIssue::AllocationTooFew
            ])
        );
        i.allocations.clear();
        assert_eq!(check_input(&i), Err(vec![CostIssue::TargetRequired]));
    }

    #[test]
    fn t14_減額は調整で表し理由が要る() {
        assert_eq!(
            check_input(&input(RecordKind::Normal, -1)),
            Err(vec![CostIssue::AmountNotPositive])
        );
        assert_eq!(
            check_input(&input(RecordKind::Adjustment, 1_000)),
            Err(vec![CostIssue::ReasonRequired])
        );
        let mut confirm = input(RecordKind::Confirms, 0);
        confirm.has_reason = true;
        assert_eq!(check_input(&confirm), Ok(()));
        let mut labor = input(RecordKind::Normal, 1);
        labor.cost_type = CostType::Labor;
        assert_eq!(check_input(&labor), Err(vec![CostIssue::LaborNotDirect]));
    }

    #[test]
    fn 区分の文字列() {
        for k in TaxKind::ALL {
            assert_eq!(TaxKind::parse(k.as_str()), Some(k));
        }
        for k in RecordKind::ALL {
            assert_eq!(RecordKind::parse(k.as_str()), Some(k));
        }
        for k in AdjustmentKind::ALL {
            assert_eq!(AdjustmentKind::parse(k.as_str()), Some(k));
        }
        assert_eq!(TaxKind::parse("x"), None);
    }
}
