//! 月別・期別・累計の収支と CSV 出力 (banto-cost P6c, spec §9, design §10.1,
//! T12・T15).
//!
//! The month figures follow the monthly close's basis (`closing::figures`):
//! labor and the count of hours without a rate from approved hours by work
//! date (a replaced entry no longer counts), revenue from recognitions not
//! cancelled by recognition date, direct costs from the ledger as it stood at
//! each month end less the previous month end (`Ledger::until`), so a
//! provisional confirmed in a later month stays in the month it was booked
//! and the months add up to today's ledger. The rules (gaps, period
//! subtotals, period-to-date and cumulative, ratios) are
//! `cost_domain::report`; the CSV format (header lines, quoting and the
//! formula neutralization) is `cost_domain::csv`.
//!
//! Authorization is the REST/Tauri wiring's: a project's monthly figures
//! need `ViewProjectAmounts`; the overall list CSV shows the rows of
//! `visible_projects` (admin all) and the amounts of `amount_projects` only,
//! like the screen; the period CSV lists `amount_projects` only (T12).

use std::collections::{BTreeMap, BTreeSet};

use banto_admin_services::authz::ProjectScope;
use banto_core::BantoError;
use banto_storage::Db;
use cost_domain::csv::{Cell, CsvTable};
use cost_domain::forecast::CostType;
use cost_domain::report::{deltas, monthly, Amounts, MonthLine, MonthlyReport};
use cost_domain::{FiscalCalendar, YearMonth, Yen};
use serde::{Deserialize, Serialize};

use crate::customers::field_error;
use crate::direct_costs::{DirectCostsService, Ledger};
use crate::orders::{fetch_all, on_pool, placeholders};
use crate::portfolio::PortfolioService;
use crate::time_entries::COUNTS;

pub const RESOURCE: &str = "reports";

const CAL: FiscalCalendar = crate::business_date::FISCAL;

/// What the figures are counted on (shown on the screen and in every CSV).
pub const BASIS_NOTE: &str = "承認済みの記録だけを管理計上日で集計（工数は作業日、直接費は計上日、\
売上は計上日）。直接費は各月末時点の台帳の差分で、後の月で確定した仮計上は確定した月の差額になる。\
金額は税抜・円";

/// A month's (or a period's, or the total's) figures.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AmountsView {
    pub revenue: i64,
    pub labor: i64,
    /// Approved hours without a rate (原価未確定).
    pub labor_missing: usize,
    pub direct: i64,
    pub cost: i64,
    pub profit: i64,
    /// `None` = 算出不可 (no revenue).
    pub ratio_permille: Option<i64>,
}

impl From<Amounts> for AmountsView {
    fn from(a: Amounts) -> Self {
        Self {
            revenue: a.revenue,
            labor: a.labor,
            labor_missing: a.labor_missing,
            direct: a.direct,
            cost: a.cost(),
            profit: a.profit(),
            ratio_permille: a.ratio_permille(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthLineView {
    /// `YYYY-MM`.
    pub month: String,
    pub period: i32,
    pub amounts: AmountsView,
    /// 当期累計 (from the period's first month).
    pub period_to_date: AmountsView,
    /// 案件累計.
    pub cumulative: AmountsView,
}

impl From<&MonthLine> for MonthLineView {
    fn from(l: &MonthLine) -> Self {
        Self {
            month: l.month.to_string(),
            period: l.period,
            amounts: l.amounts.into(),
            period_to_date: l.period_to_date.into(),
            cumulative: l.cumulative.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeriodView {
    pub period: i32,
    /// e.g. `第13期（2026年6月〜2027年5月）`.
    pub label: String,
    pub first: String,
    pub last: String,
    pub amounts: AmountsView,
}

/// 案件詳細 → 月別収支.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMonthly {
    pub project_id: i64,
    pub lines: Vec<MonthLineView>,
    pub periods: Vec<PeriodView>,
    pub total: AmountsView,
    /// Two or more fiscal periods have figures.
    pub spans_periods: bool,
    pub basis: String,
}

/// A CSV file to save.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvExport {
    pub file_name: String,
    /// UTF-8 with a BOM, CRLF.
    pub content: String,
    pub row_count: usize,
}

impl CsvExport {
    /// Audit detail: the kind of report, its key and the row count — never
    /// amounts or names.
    pub fn audit_detail(&self, kind: &str, key: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "kind": kind, "key": key, "rows": self.row_count })
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeriodQuery {
    pub period: i32,
}

/// Every project's figures by month.
type Figures = BTreeMap<i64, BTreeMap<YearMonth, Amounts>>;

fn project_status_label(code: &str) -> &str {
    match code {
        "lead" => "引合",
        "quoting" => "見積中",
        "negotiating" => "交渉中",
        "ordered" => "受注",
        "in_progress" => "進行中",
        "work_done" => "作業完了",
        "settled" => "精算完了",
        "lost" => "失注",
        "cancelled" => "中止",
        "on_hold" => "保留",
        other => other,
    }
}

fn alert_label(code: &str) -> &str {
    match code {
        "order_month_passed" => "受注予定月超過",
        "review_overdue" => "営業見込の確認遅れ",
        "pipeline_unset" => "確度・時期未設定",
        "forecast_loss" => "完了見込赤字",
        "forecast_over_budget" => "予算超過見込み",
        "low_margin" => "低利益率",
        "unapproved" => "未承認あり",
        "pending_addition" => "未確定追加売上",
        "forecast_update_needed" => "見込更新要",
        "no_forecast" => "完了見込なし",
        "open_commitment" => "未精算発注残",
        "ledger_review" => "直接費要確認",
        other => other,
    }
}

/// 27.5 for 275‰; empty when 算出不可.
fn percent(permille: Option<i64>) -> Cell {
    permille.map_or(Cell::Empty, Cell::Permille)
}

fn file_stamp(generated_at: &str) -> String {
    generated_at
        .chars()
        .filter(char::is_ascii_digit)
        .take(12)
        .collect()
}

#[derive(Clone)]
pub struct ReportsService {
    db: Db,
}

impl ReportsService {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    fn sql(&self, s: &str) -> String {
        placeholders(self.db.dialect(), s)
    }

    /// The local date and time of the output (`YYYY-MM-DD HH:MM:SS`, in the
    /// company's time zone).
    fn generated_at(&self) -> String {
        crate::business_date::now_local()
    }

    /// Each project's figures by month (`project` = one project only)
    /// without the projects whose direct costs wait for review (T39; for
    /// one project, that is an error instead), and the ledger read.
    async fn figures(&self, project: Option<i64>) -> Result<(Figures, Ledger), BantoError> {
        let filter = if project.is_some() {
            " AND project_id = ?"
        } else {
            ""
        };
        // CAST: Postgres sums BIGINT to NUMERIC. A replaced entry no longer
        // counts (T11).
        let labor = self.sql(&format!(
            "SELECT t.project_id, SUBSTR(t.work_date, 1, 7), \
             CAST(COALESCE(SUM(t.labor_cost), 0) AS BIGINT), \
             CAST(SUM(CASE WHEN t.labor_cost IS NULL THEN 1 ELSE 0 END) AS BIGINT) \
             FROM time_entries t WHERE t.status = 'approved' AND t.project_id IS NOT NULL \
             AND {COUNTS}{} GROUP BY t.project_id, SUBSTR(t.work_date, 1, 7)",
            filter.replace("project_id", "t.project_id")
        ));
        let revenue = self.sql(&format!(
            "SELECT project_id, SUBSTR(recognized_on, 1, 7), \
             CAST(COALESCE(SUM(amount), 0) AS BIGINT) FROM revenue_recognitions \
             WHERE cancelled_at IS NULL{filter} GROUP BY project_id, SUBSTR(recognized_on, 1, 7)"
        ));
        type Labor = Vec<(i64, String, i64, i64)>;
        type Revenue = Vec<(i64, String, i64)>;
        let (labor, revenue): (Labor, Revenue) = match project {
            Some(id) => on_pool!(&self.db, pool => (
                fetch_all!(pool, labor, id)?,
                fetch_all!(pool, revenue, id)?,
            )),
            None => on_pool!(&self.db, pool => (
                fetch_all!(pool, labor)?,
                fetch_all!(pool, revenue)?,
            )),
        };
        let mut out: Figures = BTreeMap::new();
        for (p, month, cost, missing) in labor {
            if let Some(m) = YearMonth::parse(&month) {
                let a = out.entry(p).or_default().entry(m).or_default();
                a.labor += cost;
                a.labor_missing += usize::try_from(missing).unwrap_or(0);
            }
        }
        for (p, month, amount) in revenue {
            if let Some(m) = YearMonth::parse(&month) {
                out.entry(p).or_default().entry(m).or_default().revenue += amount;
            }
        }
        // Direct costs: each project's ledger total at every month end of
        // the ledger, then the month-to-month differences. A monthly fixed
        // cost of an employee is labor (P7b, T37), kept in its own series.
        let ledger = DirectCostsService::new(self.db.clone()).ledger().await?;
        if let Some(id) = project {
            ledger.check(id)?;
        }
        let mut series: BTreeMap<(i64, bool), BTreeMap<YearMonth, Yen>> = BTreeMap::new();
        let mut seen: BTreeSet<(i64, bool)> = BTreeSet::new();
        for m in ledger.months() {
            let mut at_end: BTreeMap<(i64, bool), Yen> = BTreeMap::new();
            for p in ledger.until(m.last_day())? {
                if let Ok(id) = p.project.parse::<i64>() {
                    if project.is_none_or(|only| only == id) {
                        let labor = p.cost_type == CostType::Labor;
                        *at_end.entry((id, labor)).or_default() += p.amount;
                    }
                }
            }
            seen.extend(at_end.keys().copied());
            for key in &seen {
                series
                    .entry(*key)
                    .or_default()
                    .insert(m, at_end.get(key).copied().unwrap_or(0));
            }
        }
        for ((id, labor), s) in series {
            for (m, d) in deltas(&s) {
                if d != 0 {
                    let a = out.entry(id).or_default().entry(m).or_default();
                    if labor {
                        a.labor += d;
                    } else {
                        a.direct += d;
                    }
                }
            }
        }
        // A project whose direct costs cannot be settled is left out, never
        // shown short (T39).
        out.retain(|id, _| ledger.is_clean(*id));
        Ok((out, ledger))
    }

    fn view(project_id: i64, report: &MonthlyReport) -> ProjectMonthly {
        ProjectMonthly {
            project_id,
            lines: report.lines.iter().map(MonthLineView::from).collect(),
            periods: report
                .periods
                .iter()
                .map(|p| PeriodView {
                    period: p.period,
                    label: CAL.label(p.period),
                    first: p.first.to_string(),
                    last: p.last.to_string(),
                    amounts: p.amounts.into(),
                })
                .collect(),
            total: report.total.into(),
            spans_periods: report.spans_periods(),
            basis: BASIS_NOTE.to_string(),
        }
    }

    async fn report(&self, project_id: i64) -> Result<MonthlyReport, BantoError> {
        let (figures, _) = self.figures(Some(project_id)).await?;
        Ok(monthly(
            &CAL,
            &figures.get(&project_id).cloned().unwrap_or_default(),
        ))
    }

    async fn project_label(&self, project_id: i64) -> Result<(String, String), BantoError> {
        let sql = self.sql("SELECT code, name FROM projects WHERE id = ?");
        let row: Option<(String, String)> =
            on_pool!(&self.db, pool => crate::orders::fetch_optional!(pool, sql, project_id))?;
        row.ok_or_else(|| BantoError::NotFound {
            resource: "projects".into(),
            id: project_id.to_string(),
        })
    }

    /// 案件の月別収支 (T15).
    pub async fn project_monthly(&self, project_id: i64) -> Result<ProjectMonthly, BantoError> {
        self.project_label(project_id).await?;
        let report = self.report(project_id).await?;
        Ok(Self::view(project_id, &report))
    }

    /// 案件の月別収支の CSV.
    pub async fn project_monthly_csv(&self, project_id: i64) -> Result<CsvExport, BantoError> {
        let (code, name) = self.project_label(project_id).await?;
        let report = self.report(project_id).await?;
        let generated_at = self.generated_at();
        let mut t = CsvTable::new(&generated_at, &MONTHLY_HEADER);
        t.condition("帳票", "案件の月別収支")
            .condition("案件", format!("{code} {name}"))
            .condition("年度", "6月開始（期番号表示）")
            .condition("集計基準", BASIS_NOTE);
        if let (Some(a), Some(b)) = (report.lines.first(), report.lines.last()) {
            t.condition("対象月", format!("{}〜{}", a.month, b.month));
        }
        if report.total.cost_incomplete() {
            t.condition(
                "原価未確定",
                format!(
                    "単価未設定の承認済み工数 {}件を含む（労務費に含めていない）",
                    report.total.labor_missing
                ),
            );
        }
        for l in &report.lines {
            t.push(month_cells(None, l));
        }
        Ok(CsvExport {
            file_name: format!(
                "project-{project_id}-monthly-{}.csv",
                file_stamp(&generated_at)
            ),
            row_count: t.rows.len(),
            content: t.render(),
        })
    }

    /// 期の月別収支（案件×月）の CSV: the projects of `amounts` with figures
    /// in the period, with the period-to-date and the project's cumulative
    /// (from before the period, 年度またぎ).
    pub async fn period_monthly_csv(
        &self,
        period: i32,
        amounts: &ProjectScope,
    ) -> Result<CsvExport, BantoError> {
        if !(1..=999).contains(&period) {
            return Err(BantoError::Validation {
                field_errors: vec![field_error("period", "期番号は1〜999で指定してください")],
            });
        }
        let (figures, ledger) = self.figures(None).await?;
        let labels_sql = "SELECT p.id, p.code, p.name, c.name FROM projects p \
                          JOIN customers c ON c.id = p.customer_id ORDER BY p.code, p.id"
            .to_string();
        let labels: Vec<(i64, String, String, String)> =
            on_pool!(&self.db, pool => fetch_all!(pool, labels_sql))?;
        let generated_at = self.generated_at();
        let mut header = vec!["案件コード", "案件名", "顧客"];
        header.extend(MONTHLY_HEADER);
        let mut t = CsvTable::new(&generated_at, &header);
        let mut projects = 0;
        let mut left_out = Vec::new();
        for (id, code, name, customer) in labels {
            if !amounts.contains(id) {
                continue;
            }
            if !ledger.is_clean(id) {
                left_out.push(code);
                continue;
            }
            let Some(months) = figures.get(&id) else {
                continue;
            };
            let report = monthly(&CAL, months);
            let lines: Vec<&MonthLine> =
                report.lines.iter().filter(|l| l.period == period).collect();
            if lines.is_empty() {
                continue;
            }
            projects += 1;
            for l in lines {
                t.push(month_cells(
                    Some([code.clone(), name.clone(), customer.clone()]),
                    l,
                ));
            }
        }
        t.condition("帳票", "期の月別収支（案件×月）")
            .condition("期", CAL.label(period))
            .condition("集計基準", BASIS_NOTE)
            .condition(
                "対象",
                format!("金額を閲覧できる案件のうち、この期に数値がある {projects}件"),
            )
            .condition("累計", "案件累計は期をまたいで最初の月から数える");
        if !left_out.is_empty() {
            t.condition(
                "除いた案件",
                format!(
                    "直接費の台帳に要確認の明細があるため除いた {}件（{}）",
                    left_out.len(),
                    left_out.join("、")
                ),
            );
        }
        Ok(CsvExport {
            file_name: format!("period-{period}-monthly-{}.csv", file_stamp(&generated_at)),
            row_count: t.rows.len(),
            content: t.render(),
        })
    }

    /// 全体一覧の CSV: the rows of `visible`, the amounts and alerts of
    /// `amounts` only (empty cells otherwise, never 0), like the screen.
    pub async fn portfolio_csv(
        &self,
        visible: &ProjectScope,
        amounts: &ProjectScope,
    ) -> Result<CsvExport, BantoError> {
        let p = PortfolioService::new(self.db.clone())
            .overview(visible, amounts)
            .await?;
        let generated_at = self.generated_at();
        let mut t = CsvTable::new(&generated_at, &PORTFOLIO_HEADER);
        t.condition("帳票", "全体一覧")
            .condition("注意表示の判定日", p.as_of.clone())
            .condition(
                "対象",
                format!(
                    "閲覧できる案件 {}件（うち金額を表示 {}件。ほかは金額欄を空欄）",
                    p.totals.project_count, p.totals.amount_count
                ),
            )
            .condition(
                "金額",
                "税抜・共通費配賦前。完了見込は各案件の採用版の基準日のまま",
            );
        for r in &p.rows {
            let alerts: Vec<&str> = r.alerts.iter().map(|a| alert_label(a)).collect();
            t.push(vec![
                Cell::text(r.code.clone()),
                Cell::text(r.name.clone()),
                Cell::text(r.customer_name.clone()),
                Cell::text(r.manager_name.clone()),
                Cell::text(project_status_label(&r.status)),
                Cell::opt_int(r.order_amount),
                Cell::opt_int(r.pending_addition),
                Cell::opt_int(r.budget_total),
                Cell::opt_int(r.budget_version_no),
                Cell::opt_int(r.target_margin_pct),
                Cell::opt_int(r.funds),
                Cell::opt_int(r.actual_cost),
                Cell::opt_text(r.actual_complete.map(|c| if c { "確定" } else { "暫定" })),
                Cell::opt_int(r.forecast_version_no),
                Cell::opt_text(r.forecast_base_date.clone()),
                Cell::opt_int(r.forecast_cost),
                Cell::opt_int(r.forecast_profit),
                percent(r.forecast_ratio_permille),
                Cell::opt_int(r.forecast_overrun),
                if r.amounts_visible {
                    Cell::text(alerts.join("・"))
                } else {
                    Cell::Empty
                },
            ]);
        }
        Ok(CsvExport {
            file_name: format!("portfolio-{}.csv", file_stamp(&generated_at)),
            row_count: t.rows.len(),
            content: t.render(),
        })
    }
}

const MONTHLY_HEADER: [&str; 17] = [
    "期",
    "月",
    "売上",
    "労務費",
    "直接費",
    "原価計",
    "粗利",
    "粗利率(%)",
    "単価未設定の工数(件)",
    "当期累計売上",
    "当期累計原価",
    "当期累計粗利",
    "当期累計粗利率(%)",
    "案件累計売上",
    "案件累計原価",
    "案件累計粗利",
    "案件累計粗利率(%)",
];

const PORTFOLIO_HEADER: [&str; 20] = [
    "案件コード",
    "案件名",
    "顧客",
    "責任者",
    "状態",
    "確定受注額",
    "未確定追加売上",
    "原価予算",
    "予算版",
    "目標粗利率(%)",
    "原資",
    "実績原価",
    "実績",
    "完了見込版",
    "見込基準日",
    "完了見込原価",
    "完了見込利益",
    "見込利益率(%)",
    "予算超過見込",
    "注意表示",
];

fn month_cells(prefix: Option<[String; 3]>, l: &MonthLine) -> Vec<Cell> {
    let mut cells: Vec<Cell> = prefix
        .map(|p| p.into_iter().map(Cell::Text).collect())
        .unwrap_or_default();
    let a = &l.amounts;
    cells.extend([
        Cell::text(format!("第{}期", l.period)),
        Cell::text(format!("{}年{}月", l.month.year, l.month.month)),
        Cell::Int(a.revenue),
        Cell::Int(a.labor),
        Cell::Int(a.direct),
        Cell::Int(a.cost()),
        Cell::Int(a.profit()),
        percent(a.ratio_permille()),
        Cell::Int(i64::try_from(a.labor_missing).unwrap_or(i64::MAX)),
    ]);
    for s in [&l.period_to_date, &l.cumulative] {
        cells.extend([
            Cell::Int(s.revenue),
            Cell::Int(s.cost()),
            Cell::Int(s.profit()),
            percent(s.ratio_permille()),
        ]);
    }
    cells
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::closing::ClosingService;
    use crate::direct_costs::DirectCostInput;
    use crate::orders::tests::{line, ordered_project};
    use crate::orders::{execute, OrdersService, RecognitionInput};
    use crate::projects::tests::fixture;

    async fn approved_hours(db: &Db, date: &str, project: i64, cost: Option<i64>) {
        let sql = placeholders(
            db.dialect(),
            "INSERT INTO time_entries (work_date, user_id, project_id, phase_id, minutes, \
             status, applied_rate, labor_cost) VALUES (?, 1, ?, 1, 60, 'approved', ?, ?)",
        );
        on_pool!(db, pool => execute!(pool, sql, date, project, cost, cost)).unwrap();
    }

    async fn sale(db: &Db, project: i64, on: &str, amount: i64) {
        OrdersService::new(db.clone())
            .recognize(
                project,
                RecognitionInput {
                    recognized_on: on.into(),
                    amount,
                    basis: Some("検収".into()),
                    clears: None,
                },
                Some(1),
            )
            .await
            .unwrap();
    }

    /// A project from 2027-04 to 2027-07 (第13期 → 第14期): hours, a
    /// provisional booked in May and confirmed in June, two sales.
    async fn spanning(db: &Db, code: &str) -> i64 {
        let p = ordered_project(db, code, vec![line(Some("2027-05"), 1_000_000)]).await;
        approved_hours(db, "2027-04-10", p, Some(120_000)).await;
        approved_hours(db, "2027-05-20", p, Some(80_000)).await;
        approved_hours(db, "2027-05-21", p, None).await;
        approved_hours(db, "2027-06-03", p, Some(40_000)).await;
        let costs = DirectCostsService::new(db.clone());
        let prov = crate::direct_costs::tests::approved(
            &costs,
            DirectCostInput {
                entry_kind: Some("provisional".into()),
                project_id: Some(p),
                cost_type: Some("outsource".into()),
                booked_on: "2027-05-31".into(),
                amount: 300_000,
                ..Default::default()
            },
        )
        .await;
        crate::direct_costs::tests::approved(
            &costs,
            DirectCostInput {
                entry_kind: Some("confirms".into()),
                ref_id: Some(prov.id),
                booked_on: "2027-06-10".into(),
                amount: 320_000,
                reason: Some("請求書到着".into()),
                ..Default::default()
            },
        )
        .await;
        sale(db, p, "2027-05-31", 600_000).await;
        sale(db, p, "2027-07-31", 400_000).await;
        p
    }

    fn csv_lines(csv: &CsvExport) -> Vec<String> {
        assert!(csv.content.starts_with('\u{feff}'));
        csv.content
            .trim_start_matches('\u{feff}')
            .split("\r\n")
            .map(str::to_string)
            .collect()
    }

    #[tokio::test]
    async fn t15_a_project_across_two_periods_shows_months_period_subtotals_and_the_cumulative() {
        let db = fixture().await;
        let p = spanning(&db, "P-R01").await;
        // Another project's figures stay out.
        let other = ordered_project(&db, "P-R02", vec![line(Some("2027-05"), 500_000)]).await;
        approved_hours(&db, "2027-05-02", other, Some(9_999)).await;

        let svc = ReportsService::new(db.clone());
        let r = svc.project_monthly(p).await.unwrap();
        assert!(r.spans_periods);
        let months: Vec<&str> = r.lines.iter().map(|l| l.month.as_str()).collect();
        assert_eq!(months, ["2027-04", "2027-05", "2027-06", "2027-07"]);
        assert_eq!(
            r.periods.iter().map(|p| p.period).collect::<Vec<_>>(),
            [13, 14]
        );
        assert_eq!(r.periods[0].label, "第13期（2026年6月〜2027年5月）");
        // May keeps the provisional; June carries the invoice's difference.
        assert_eq!(r.lines[1].amounts.direct, 300_000);
        assert_eq!(r.lines[2].amounts.direct, 20_000);
        assert_eq!(r.lines[1].amounts.labor_missing, 1);
        // 当期累計 restarts in June; the cumulative carries on.
        assert_eq!(r.lines[2].period_to_date.labor, 40_000);
        assert_eq!(r.lines[2].cumulative.labor, 240_000);
        assert_eq!(r.periods[0].amounts.revenue, 600_000);
        assert_eq!(r.periods[1].amounts.revenue, 400_000);

        // The figures add up to the details: labor to the approved hours,
        // direct costs to today's ledger, revenue to the recognitions.
        assert_eq!(r.total.labor, 240_000);
        assert_eq!(r.total.labor_missing, 1);
        let ledger = DirectCostsService::new(db.clone()).ledger().await.unwrap();
        let ledger_total: i64 = ledger
            .all()
            .iter()
            .filter(|x| x.project == p.to_string())
            .map(|x| x.amount)
            .sum();
        assert_eq!(r.total.direct, ledger_total);
        assert_eq!(r.total.direct, 320_000);
        assert_eq!(r.total.revenue, 1_000_000);
        assert_eq!(r.total.profit, 1_000_000 - 240_000 - 320_000);
        assert_eq!(r.lines.last().unwrap().cumulative, r.total);

        // The direct-cost section's months use the same basis.
        let costs = DirectCostsService::new(db.clone())
            .project_costs(p)
            .await
            .unwrap();
        let by_month: Vec<(&str, i64)> = costs
            .months
            .iter()
            .map(|m| (m.month.as_str(), m.total))
            .collect();
        assert_eq!(by_month, [("2027-05", 300_000), ("2027-06", 20_000)]);
        assert_eq!(costs.total, r.total.direct);

        // Same date basis as the monthly close (対象日付基準が一貫).
        let closing = ClosingService::new(db.clone());
        for line in &r.lines {
            let m = closing.get(&line.month).await.unwrap();
            // The close totals every project: take out the other project's
            // May hours.
            let other_labor = if line.month == "2027-05" { 9_999 } else { 0 };
            assert_eq!(
                m.total.unwrap().labor_cost - other_labor,
                line.amounts.labor
            );
            assert_eq!(m.total.unwrap().labor_missing, line.amounts.labor_missing);
            assert_eq!(m.total.unwrap().direct_cost, line.amounts.direct);
            assert_eq!(m.total.unwrap().revenue, line.amounts.revenue);
        }
    }

    #[tokio::test]
    async fn t15_a_project_without_records_has_no_lines_and_an_unknown_one_is_not_found() {
        let db = fixture().await;
        let p = ordered_project(&db, "P-R03", vec![line(Some("2027-05"), 500_000)]).await;
        let svc = ReportsService::new(db.clone());
        let r = svc.project_monthly(p).await.unwrap();
        assert!(r.lines.is_empty() && r.periods.is_empty());
        assert_eq!(r.total.ratio_permille, None);
        assert!(matches!(
            svc.project_monthly(9_999).await.unwrap_err(),
            BantoError::NotFound { .. }
        ));
    }

    #[tokio::test]
    async fn t12_t15_the_project_csv_carries_the_conditions_and_neutralizes_formulas() {
        let db = fixture().await;
        let p = spanning(&db, "P-R04").await;
        let rename = placeholders(db.dialect(), "UPDATE projects SET name = ? WHERE id = ?");
        on_pool!(&db, pool => execute!(pool, rename, "=HYPERLINK(\"x\")", p)).unwrap();
        let csv = ReportsService::new(db.clone())
            .project_monthly_csv(p)
            .await
            .unwrap();
        assert!(csv.file_name.starts_with(&format!("project-{p}-monthly-")));
        assert!(csv.file_name.ends_with(".csv"));
        assert_eq!(csv.row_count, 4);
        let lines = csv_lines(&csv);
        assert!(lines[0].starts_with("出力日時,20"));
        assert!(lines.contains(&"集計条件,帳票,案件の月別収支".to_string()));
        assert!(
            lines.contains(&"集計条件,案件,\"P-R04 =HYPERLINK(\"\"x\"\")\"".to_string()),
            "{lines:?}"
        );
        assert!(lines.contains(&"集計条件,対象月,2027-04〜2027-07".to_string()));
        assert!(lines.iter().any(|l| l.starts_with("集計条件,原価未確定,")));
        let header = lines.iter().position(|l| l.starts_with("期,月,")).unwrap();
        assert_eq!(lines[header - 1], "");
        // 2027-06: no revenue → the ratio is empty, the loss is a number.
        assert_eq!(
            lines[header + 3],
            "第14期,2027年6月,0,40000,20000,60000,-60000,,0,0,60000,-60000,,600000,560000,40000,6.7"
        );
        assert!(!csv.content.contains(",=HYPERLINK"));
    }

    #[tokio::test]
    async fn t12_t15_the_period_csv_lists_only_the_amount_scope_and_counts_from_before_the_period()
    {
        let db = fixture().await;
        let a = spanning(&db, "P-R05").await;
        let b = spanning(&db, "P-R06").await;
        let svc = ReportsService::new(db.clone());
        let only_a = ProjectScope::Only([a].into_iter().collect());
        let csv = svc.period_monthly_csv(14, &only_a).await.unwrap();
        let lines = csv_lines(&csv);
        assert!(lines.contains(&"集計条件,期,第14期（2027年6月〜2028年5月）".to_string()));
        assert!(!csv.content.contains("P-R06"), "{b} is out of scope");
        // June and July of 第14期; the cumulative includes 第13期.
        assert_eq!(csv.row_count, 2);
        let june = lines.iter().find(|l| l.contains(",2027年6月,")).unwrap();
        assert!(june.starts_with("P-R05,"), "{june}");
        assert!(june.ends_with(",600000,560000,40000,6.7"), "{june}");
        let all = svc
            .period_monthly_csv(14, &ProjectScope::All)
            .await
            .unwrap();
        assert_eq!(all.row_count, 4);
        // 第12期 has nothing; a period out of range is refused.
        assert_eq!(
            svc.period_monthly_csv(12, &ProjectScope::All)
                .await
                .unwrap()
                .row_count,
            0
        );
        assert!(matches!(
            svc.period_monthly_csv(0, &ProjectScope::All)
                .await
                .unwrap_err(),
            BantoError::Validation { .. }
        ));
    }

    #[tokio::test]
    async fn t12_the_portfolio_csv_leaves_the_amounts_of_projects_out_of_scope_empty() {
        let db = fixture().await;
        let a = spanning(&db, "P-R07").await;
        let b = ordered_project(&db, "P-R08", vec![line(Some("2027-05"), 700_000)]).await;
        let svc = ReportsService::new(db.clone());
        let csv = svc
            .portfolio_csv(
                &ProjectScope::All,
                &ProjectScope::Only([a].into_iter().collect()),
            )
            .await
            .unwrap();
        assert_eq!(csv.row_count, 2);
        let lines = csv_lines(&csv);
        assert!(lines.iter().any(|l| l.contains("うち金額を表示 1件")));
        let row_a = lines.iter().find(|l| l.starts_with("P-R07,")).unwrap();
        assert!(row_a.contains(",1000000,"), "{row_a}");
        let row_b = lines.iter().find(|l| l.starts_with("P-R08,")).unwrap();
        // Code, name, customer, manager, status; every amount cell empty.
        let cells: Vec<&str> = row_b.split(',').collect();
        assert_eq!(cells.len(), PORTFOLIO_HEADER.len());
        assert!(cells[5..].iter().all(|c| c.is_empty()), "{row_b} ({b})");
    }
}
