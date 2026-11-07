//! 完了見込・予算差異・利益。
//!
//! 完了見込は「同じ基準日の実績スナップショット ＋ 残原価見込み」で計算し、
//! 最新実績と古い残見込みを混ぜない（仕様6.6、7.1）。

use std::collections::BTreeMap;

use crate::budget::LineKey;
use crate::calendar::Date;
use crate::money::{labor_cost, ratio_permille, Minutes, Yen};
use crate::project::ProjectStatus;

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

// --- 完了見込版（工程×費目の行、仕様6.5・6.6、設計3.4） -------------------------

/// 残工数に掛ける計算基準の項目（見込み用単価）。
pub const RATE_ITEM: &str = "forecast_rate";
/// 1版の残見込みの入力行の上限。
pub const MAX_LINES: usize = 200;

/// 残見込みの入力行。発注済み未実績は発注から求めるので入力しない（同じ費用を両方へ入れない、仕様6.5）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RemainingInput {
    pub key: LineKey,
    /// 残工数（労務だけ）。
    pub minutes: Option<Minutes>,
    /// それ以外に必要な見込み（労務以外）。
    pub amount: Option<Yen>,
}

/// 残見込みの入力の不整合。`index` は入力の並び（0始まり）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemainingIssue {
    TooMany,
    /// 労務の残工数が0分以下。
    MinutesInvalid {
        index: usize,
    },
    /// 労務に金額を入れた（労務は残工数 × 見込み用単価で求める）。
    LaborWithAmount {
        index: usize,
    },
    /// 労務以外に工数を入れた。
    MinutesOnNonLabor {
        index: usize,
    },
    /// 労務以外の金額がマイナス。
    AmountNegative {
        index: usize,
    },
    /// 工数も金額もない行。
    Empty {
        index: usize,
    },
    /// 同じ工程・費目の行が二つ以上ある。
    Duplicate {
        index: usize,
    },
}

/// 残見込みの入力を検査する。
pub fn validate_remaining(lines: &[RemainingInput]) -> Result<(), Vec<RemainingIssue>> {
    let mut issues = Vec::new();
    if lines.len() > MAX_LINES {
        issues.push(RemainingIssue::TooMany);
    }
    let mut seen = std::collections::BTreeSet::new();
    for (index, l) in lines.iter().enumerate() {
        if l.key.cost_type == CostType::Labor {
            match l.minutes {
                Some(m) if m <= 0 => issues.push(RemainingIssue::MinutesInvalid { index }),
                None if l.amount.is_none() => issues.push(RemainingIssue::Empty { index }),
                _ => {}
            }
            if l.amount.is_some() {
                issues.push(RemainingIssue::LaborWithAmount { index });
            }
        } else {
            if l.minutes.is_some() {
                issues.push(RemainingIssue::MinutesOnNonLabor { index });
            }
            match l.amount {
                Some(a) if a < 0 => issues.push(RemainingIssue::AmountNegative { index }),
                None if l.minutes.is_none() => issues.push(RemainingIssue::Empty { index }),
                _ => {}
            }
        }
        if !seen.insert(l.key) {
            issues.push(RemainingIssue::Duplicate { index });
        }
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(issues)
    }
}

/// 完了見込版の1行（工程×費目）。実績と発注残は基準日の組で持つ（仕様6.6）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyedLine {
    pub key: LineKey,
    /// 基準日までの承認済み実績。
    pub actual: Yen,
    /// 基準日の発注済み未実績（残原価の内数）。
    pub committed: Yen,
    /// 残工数（労務だけ）。
    pub remaining_minutes: Minutes,
    /// それ以外に必要な見込み（労務以外）。
    pub other_remaining: Yen,
}

/// 実績・発注残・残見込みの入力を工程×費目の行にまとめる（どれかがある行だけ、キーの順）。
pub fn merge_lines(
    actual: &[(LineKey, Yen)],
    committed: &[(LineKey, Yen)],
    remaining: &[RemainingInput],
) -> Vec<KeyedLine> {
    let mut rows: BTreeMap<LineKey, KeyedLine> = BTreeMap::new();
    fn row(rows: &mut BTreeMap<LineKey, KeyedLine>, key: LineKey) -> &mut KeyedLine {
        rows.entry(key).or_insert(KeyedLine {
            key,
            actual: 0,
            committed: 0,
            remaining_minutes: 0,
            other_remaining: 0,
        })
    }
    for (k, v) in actual {
        row(&mut rows, *k).actual += v;
    }
    for (k, v) in committed {
        row(&mut rows, *k).committed += v;
    }
    for r in remaining {
        let l = row(&mut rows, r.key);
        l.remaining_minutes += r.minutes.unwrap_or(0);
        l.other_remaining += r.amount.unwrap_or(0);
    }
    rows.into_values()
        .filter(|l| {
            l.actual != 0 || l.committed != 0 || l.remaining_minutes != 0 || l.other_remaining != 0
        })
        .collect()
}

/// 金額を求めた行。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PricedForecastLine {
    pub line: KeyedLine,
    /// 残工数の金額 ＝ ROUND(残工数 × 見込み用単価 / 60)。単価がなければ `None`（0円にしない）。
    pub labor_remaining: Option<Yen>,
}

impl PricedForecastLine {
    /// 残原価見込み ＝ 発注済み未実績 ＋ それ以外 ＋ 残工数の金額。未確定なら `None`。
    pub fn remaining(&self) -> Option<Yen> {
        self.labor_remaining
            .map(|l| l + self.line.committed + self.line.other_remaining)
    }
    /// 完了見込原価 ＝ 実績 ＋ 残原価見込み。
    pub fn total(&self) -> Option<Yen> {
        self.remaining().map(|r| r + self.line.actual)
    }
}

/// 行ごとに残工数の金額を求める（明細ごとに円単位で四捨五入、仕様7.4）。
pub fn price_lines(lines: &[KeyedLine], rate: Option<Yen>) -> Vec<PricedForecastLine> {
    lines
        .iter()
        .map(|l| PricedForecastLine {
            line: *l,
            labor_remaining: if l.remaining_minutes == 0 {
                Some(0)
            } else {
                labor_cost(l.remaining_minutes, rate)
            },
        })
        .collect()
}

/// 行の合計を費目別にまとめる。単価がない残工数があれば `complete = false`（残の労務は0円として足さず、
/// 画面は「暫定・不足あり」と表示する）。
pub fn summarize(lines: &[PricedForecastLine]) -> ForecastResult {
    let mut actual = ByCostType::default();
    let mut remaining = ByCostType::default();
    let mut committed = 0;
    let mut complete = true;
    for l in lines {
        let t = l.line.key.cost_type;
        actual.add(t, l.line.actual);
        committed += l.line.committed;
        match l.remaining() {
            Some(r) => remaining.add(t, r),
            None => {
                complete = false;
                remaining.add(t, l.line.committed + l.line.other_remaining);
            }
        }
    }
    ForecastResult {
        actual,
        remaining,
        committed,
        complete,
    }
}

/// 採用を拒否する理由。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdoptionIssue {
    /// 受注済み（受注・進行中・作業完了）でない案件。
    ProjectNotOrdered,
    /// 残工数があるのに見込み用単価が未設定。
    RateMissing,
    /// 更新理由がない。
    ReasonRequired,
    /// 基準日が今日より後。
    BaseDateInFuture,
    /// 基準日が前回採用版の基準日より前。
    BaseDateBeforePrevious,
}

/// 基準日を検査する（下書きの保存と採用の両方）。
pub fn check_base_date(
    base_date: Date,
    today: Date,
    previous: Option<Date>,
) -> Result<(), Vec<AdoptionIssue>> {
    let mut issues = Vec::new();
    if base_date > today {
        issues.push(AdoptionIssue::BaseDateInFuture);
    }
    if previous.is_some_and(|p| base_date < p) {
        issues.push(AdoptionIssue::BaseDateBeforePrevious);
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(issues)
    }
}

/// 採用できるか検査する。実績の未承認・仮計上は採用を止めず、版に「暫定・不足あり」として残す。
pub fn check_adoption(
    lines: &[PricedForecastLine],
    reason: Option<&str>,
    status: ProjectStatus,
    base_date: Date,
    today: Date,
    previous: Option<Date>,
) -> Result<(), Vec<AdoptionIssue>> {
    let mut issues = Vec::new();
    if !status.is_ordered_open() {
        issues.push(AdoptionIssue::ProjectNotOrdered);
    }
    if lines.iter().any(|l| l.labor_remaining.is_none()) {
        issues.push(AdoptionIssue::RateMissing);
    }
    if reason.is_none_or(|r| r.trim().is_empty()) {
        issues.push(AdoptionIssue::ReasonRequired);
    }
    if let Err(more) = check_base_date(base_date, today, previous) {
        issues.extend(more);
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(issues)
    }
}

/// 「見込更新要」の理由（仕様6.6、7.5、T30）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum UpdateReason {
    /// 基準日より後の実績がある（最新実績が版の実績と違う）。
    ActualAfterBase,
    /// 基準日以前の実績が訂正された（今読み直した基準日までの実績が版と違う）。
    ActualCorrected,
    /// 見込み用単価が変わった（設計10.5：採用済みの見込版は変えない）。
    RateChanged,
    /// 確定受注額が変わった（受注変更の承認など）。
    OrderChanged,
}

impl UpdateReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ActualAfterBase => "actual_after_base",
            Self::ActualCorrected => "actual_corrected",
            Self::RateChanged => "rate_changed",
            Self::OrderChanged => "order_changed",
        }
    }
}

/// 採用版と今の状態の比較。採用版の値は変えず、理由だけを返す。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdoptedFacts {
    /// 版に保存した基準日までの実績。
    pub snapshot_actual: Yen,
    /// 今読み直した基準日までの実績。
    pub actual_at_base_now: Yen,
    /// 今の最新実績（日付を限らない）。
    pub latest_actual: Yen,
    pub snapshot_rate: Option<Yen>,
    /// 今の計算基準で基準日に適用される見込み用単価。
    pub rate_now: Option<Yen>,
    /// 残工数があったか（なければ単価の変更は影響しない）。
    pub has_remaining_minutes: bool,
    pub snapshot_order: Option<Yen>,
    pub order_now: Option<Yen>,
}

pub fn update_reasons(f: &AdoptedFacts) -> Vec<UpdateReason> {
    let mut out = Vec::new();
    if f.latest_actual != f.actual_at_base_now {
        out.push(UpdateReason::ActualAfterBase);
    }
    if f.actual_at_base_now != f.snapshot_actual {
        out.push(UpdateReason::ActualCorrected);
    }
    if f.has_remaining_minutes && f.rate_now != f.snapshot_rate {
        out.push(UpdateReason::RateChanged);
    }
    if f.order_now != f.snapshot_order {
        out.push(UpdateReason::OrderChanged);
    }
    out
}

/// 次に採用される版の番号（採用済みの最大＋1）。
pub fn next_version(adopted: &[u32]) -> u32 {
    adopted.iter().copied().max().unwrap_or(0) + 1
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

    fn key(phase: Option<i64>, t: CostType) -> LineKey {
        LineKey {
            phase,
            cost_type: t,
        }
    }

    fn rem(
        phase: Option<i64>,
        t: CostType,
        minutes: Option<Minutes>,
        amount: Option<Yen>,
    ) -> RemainingInput {
        RemainingInput {
            key: key(phase, t),
            minutes,
            amount,
        }
    }

    fn d(s: &str) -> Date {
        Date::parse(s).unwrap()
    }

    /// 仕様12.1の前回採用版を工程×費目の行で作る（材料・外注の発注残400,000円は発注から）。
    fn spec_v1_lines() -> Vec<PricedForecastLine> {
        let actual = [
            (key(Some(1), CostType::Labor), 700_000),
            (key(None, CostType::Material), 800_000),
            (key(None, CostType::Outsource), 300_000),
            (key(None, CostType::Travel), 80_000),
            (key(None, CostType::Other), 20_000),
        ];
        let committed = [
            (key(None, CostType::Material), 200_000),
            (key(None, CostType::Outsource), 200_000),
        ];
        let remaining = [
            rem(Some(1), CostType::Labor, Some(100 * 60), None),
            rem(None, CostType::Travel, None, Some(70_000)),
            rem(None, CostType::Other, None, Some(30_000)),
        ];
        price_lines(&merge_lines(&actual, &committed, &remaining), Some(5_000))
    }

    #[test]
    fn t06_工程と費目の行から完了見込原価と利益() {
        let lines = spec_v1_lines();
        assert_eq!(lines.len(), 5);
        let r = summarize(&lines);
        assert!(r.complete);
        assert_eq!(r.actual_total(), 1_900_000);
        assert_eq!(r.remaining_total(), 1_000_000);
        assert_eq!(r.committed, 400_000, "発注残は残原価の内数で、別に足さない");
        assert_eq!(r.total(), 2_900_000);
        assert_eq!(profit(Some(4_000_000), r.total()).amount, 1_100_000);
        let labor = lines
            .iter()
            .find(|l| l.line.key.cost_type == CostType::Labor)
            .unwrap();
        assert_eq!(labor.labor_remaining, Some(500_000));
    }

    #[test]
    fn t28_新しい版は古い残見込みを足さず_古い版は変わらない() {
        let old = summarize(&spec_v1_lines());
        // 300,000円が実績化（労務150,000・材料100,000・外注50,000）。残を見直し、追加100,000円。
        let actual = [
            (key(Some(1), CostType::Labor), 850_000),
            (key(None, CostType::Material), 900_000),
            (key(None, CostType::Outsource), 350_000),
            (key(None, CostType::Travel), 80_000),
            (key(None, CostType::Other), 20_000),
        ];
        let committed = [
            (key(None, CostType::Material), 100_000),
            (key(None, CostType::Outsource), 150_000),
        ];
        let remaining = [
            rem(Some(1), CostType::Labor, Some(90 * 60), None),
            rem(None, CostType::Travel, None, Some(70_000)),
            rem(None, CostType::Other, None, Some(30_000)),
        ];
        let new = summarize(&price_lines(
            &merge_lines(&actual, &committed, &remaining),
            Some(5_000),
        ));
        assert_eq!(new.actual_total(), 2_200_000);
        assert_eq!(new.remaining_total(), 800_000);
        assert_eq!(new.total(), 3_000_000);
        assert_eq!(profit(Some(4_000_000), new.total()).amount, 1_000_000);
        assert_eq!(overrun(new.total(), 2_600_000), 400_000);
        assert_eq!(new.total() - old.total(), 100_000);
        assert_eq!(old.total(), 2_900_000);
        assert_eq!(next_version(&[1]), 2);
    }

    #[test]
    fn 単価のない残工数は未確定で採用できない() {
        let lines = price_lines(
            &merge_lines(&[], &[], &[rem(None, CostType::Labor, Some(60), None)]),
            None,
        );
        assert_eq!(lines[0].labor_remaining, None);
        assert_eq!(lines[0].remaining(), None);
        let r = summarize(&lines);
        assert!(!r.complete);
        assert_eq!(r.remaining.labor, 0);
        let err = check_adoption(
            &lines,
            Some("初回"),
            ProjectStatus::Ordered,
            d("2026-11-01"),
            d("2026-11-07"),
            None,
        )
        .unwrap_err();
        assert_eq!(err, vec![AdoptionIssue::RateMissing]);
    }

    #[test]
    fn 採用の検査_受注済み_理由_基準日() {
        let lines = spec_v1_lines();
        assert!(check_adoption(
            &lines,
            Some("月次見直し"),
            ProjectStatus::InProgress,
            d("2026-11-01"),
            d("2026-11-07"),
            Some(d("2026-10-01"))
        )
        .is_ok());
        let err = check_adoption(
            &lines,
            Some("  "),
            ProjectStatus::Negotiating,
            d("2026-11-08"),
            d("2026-11-07"),
            Some(d("2026-11-10")),
        )
        .unwrap_err();
        assert_eq!(
            err,
            vec![
                AdoptionIssue::ProjectNotOrdered,
                AdoptionIssue::ReasonRequired,
                AdoptionIssue::BaseDateInFuture,
                AdoptionIssue::BaseDateBeforePrevious,
            ]
        );
        assert!(check_adoption(
            &lines,
            Some("x"),
            ProjectStatus::Settled,
            d("2026-11-01"),
            d("2026-11-07"),
            None
        )
        .is_err());
    }

    #[test]
    fn 残見込みの入力の検査() {
        assert!(validate_remaining(&[
            rem(Some(1), CostType::Labor, Some(60), None),
            rem(None, CostType::Material, None, Some(0)),
        ])
        .is_ok());
        let err = validate_remaining(&[
            rem(Some(1), CostType::Labor, Some(0), Some(1)),
            rem(None, CostType::Material, Some(60), Some(-1)),
            rem(None, CostType::Travel, None, None),
            rem(Some(1), CostType::Labor, Some(60), None),
        ])
        .unwrap_err();
        assert_eq!(
            err,
            vec![
                RemainingIssue::MinutesInvalid { index: 0 },
                RemainingIssue::LaborWithAmount { index: 0 },
                RemainingIssue::MinutesOnNonLabor { index: 1 },
                RemainingIssue::AmountNegative { index: 1 },
                RemainingIssue::Empty { index: 2 },
                RemainingIssue::Duplicate { index: 3 },
            ]
        );
    }

    #[test]
    fn t30_基準日後の実績増加と過去実績の訂正で見込更新要() {
        let base = AdoptedFacts {
            snapshot_actual: 1_900_000,
            actual_at_base_now: 1_900_000,
            latest_actual: 1_900_000,
            snapshot_rate: Some(5_000),
            rate_now: Some(5_000),
            has_remaining_minutes: true,
            snapshot_order: Some(4_000_000),
            order_now: Some(4_000_000),
        };
        assert!(update_reasons(&base).is_empty());
        let later = AdoptedFacts {
            latest_actual: 2_200_000,
            ..base
        };
        assert_eq!(update_reasons(&later), vec![UpdateReason::ActualAfterBase]);
        let corrected = AdoptedFacts {
            actual_at_base_now: 1_850_000,
            latest_actual: 1_850_000,
            ..base
        };
        assert_eq!(
            update_reasons(&corrected),
            vec![UpdateReason::ActualCorrected]
        );
        let rate = AdoptedFacts {
            rate_now: Some(6_000),
            ..base
        };
        assert_eq!(update_reasons(&rate), vec![UpdateReason::RateChanged]);
        let no_minutes = AdoptedFacts {
            rate_now: None,
            has_remaining_minutes: false,
            ..base
        };
        assert!(
            update_reasons(&no_minutes).is_empty(),
            "残工数がなければ単価は影響しない"
        );
        let order = AdoptedFacts {
            order_now: Some(4_300_000),
            ..base
        };
        assert_eq!(update_reasons(&order), vec![UpdateReason::OrderChanged]);
    }
}
