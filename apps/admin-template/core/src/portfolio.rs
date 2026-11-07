//! 全体一覧 (the overall project list with 注意表示, banto-cost P5, spec §9,
//! §7.5, design §5).
//!
//! One row per project the caller may view: code, name, customer, manager
//! and status for every row; the amounts (confirmed order, current approved
//! budget, latest actual cost, the latest adopted completion forecast and
//! its profit) and the alerts only on the projects whose amounts the caller
//! may see (`amount_projects`, T12) — an alert such as 完了見込赤字 tells
//! the amounts. The rules are `cost_domain::alerts`; the thresholds are the
//! company calc basis (`review_delay_days`, and `low_margin_pct` with the
//! project's override), unset = not judged.
//!
//! Each forecast keeps its own version and base date; the totals count the
//! projects whose forecast needs an update or is missing instead of mixing
//! new actuals into old remaining costs (spec §7.5).

use std::collections::{BTreeMap, BTreeSet};

use banto_admin_services::authz::ProjectScope;
use banto_core::{BantoError, ListParams, Pagination};
use banto_storage::Db;
use cost_domain::alerts::{
    evaluate, Alert, ForecastFacts, OrderedFacts, PreOrderFacts, Thresholds, LOW_MARGIN_ITEM,
    REVIEW_DELAY_ITEM,
};
use cost_domain::forecast::profit;
use cost_domain::money::ratio_permille;
use cost_domain::project::ProjectStatus;
use cost_domain::{Date, YearMonth};
use serde::Serialize;

use crate::calc_basis::applied_value;
use crate::direct_costs::DirectCostsService;
use crate::forecasts::ForecastsService;
use crate::orders::{fetch_optional, on_pool, placeholders, OrdersService};
use crate::pipeline::PipelineService;
use crate::projects::ProjectsService;

/// One project of the overall list.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioRow {
    pub project_id: i64,
    pub code: String,
    pub name: String,
    pub customer_name: String,
    pub manager_name: String,
    pub status: String,
    /// The caller may see this project's amounts; otherwise every amount
    /// and the alerts are `null` / empty.
    pub amounts_visible: bool,
    /// 現在の確定受注額 (`None` before the order).
    pub order_amount: Option<i64>,
    /// 未確定追加売上.
    pub pending_addition: Option<i64>,
    /// The current approved cost budget.
    pub budget_total: Option<i64>,
    pub budget_version_no: Option<i64>,
    /// Every approved actual (labor + direct), whatever its date.
    pub actual_cost: Option<i64>,
    /// No unapproved record, approved hour without a rate or provisional.
    pub actual_complete: Option<bool>,
    pub forecast_version_no: Option<i64>,
    pub forecast_base_date: Option<String>,
    /// The adopted version's actuals were final at its base date; `false` =
    /// 暫定・不足あり (unapproved, provisional or unpriced records then).
    pub forecast_actual_complete: Option<bool>,
    /// The latest adopted version's 完了見込原価.
    pub forecast_cost: Option<i64>,
    /// 現在の確定受注額 − 完了見込原価.
    pub forecast_profit: Option<i64>,
    pub forecast_ratio_permille: Option<i64>,
    /// 完了見込超過額 against the current approved budget.
    pub forecast_overrun: Option<i64>,
    /// `cost_domain::alerts::Alert` codes.
    pub alerts: Vec<String>,
    /// `cost_domain::forecast::UpdateReason` codes of the latest version.
    pub update_reasons: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertCount {
    pub alert: String,
    pub count: usize,
}

/// Totals over the rows whose amounts are visible.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioTotals {
    pub project_count: usize,
    pub amount_count: usize,
    /// Ordered projects (受注・進行中・作業完了) with a confirmed order.
    pub ordered_count: usize,
    pub order_total: i64,
    /// Ordered projects with an adopted forecast, and their sums.
    pub forecast_count: usize,
    pub forecast_order_total: i64,
    pub forecast_cost_total: i64,
    pub forecast_profit_total: i64,
    /// profit total ÷ order total of the same projects (never an average
    /// of ratios, spec §7.4). `None` = 算出不可.
    pub forecast_ratio_permille: Option<i64>,
    /// Ordered projects whose latest forecast needs an update.
    pub needs_update: Vec<i64>,
    /// Ordered projects without an adopted forecast.
    pub without_forecast: Vec<i64>,
    /// Summed forecasts that were 暫定・不足あり at their base date: the
    /// totals include them and say so.
    pub provisional_forecasts: Vec<i64>,
    /// The oldest base date among the forecasts summed.
    pub oldest_base_date: Option<String>,
    pub alert_counts: Vec<AlertCount>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Portfolio {
    /// The business date the alerts were judged on.
    pub as_of: String,
    /// The company thresholds (`None` = 未設定, the alert is not judged).
    pub review_delay_days: Option<i64>,
    pub low_margin_pct: Option<i64>,
    pub rows: Vec<PortfolioRow>,
    pub totals: PortfolioTotals,
}

#[derive(Clone)]
pub struct PortfolioService {
    db: Db,
}

impl PortfolioService {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// The current approved budget's version number and total.
    async fn budget(&self, project_id: i64) -> Result<Option<(i64, i64)>, BantoError> {
        let sql = placeholders(
            self.db.dialect(),
            "SELECT version_no, total_amount FROM budget_versions \
             WHERE project_id = ? AND status = 'approved' ORDER BY version_no DESC LIMIT 1",
        );
        on_pool!(&self.db, pool => fetch_optional!(pool, sql, project_id))
    }

    /// Rows for `visible` (code, name, status), amounts and alerts for
    /// `amounts` (a subset the caller may see the amounts of).
    pub async fn overview(
        &self,
        visible: &ProjectScope,
        amounts: &ProjectScope,
    ) -> Result<Portfolio, BantoError> {
        let projects = ProjectsService::new(self.db.clone())
            .list(
                ListParams {
                    pagination: Some(Pagination {
                        offset: 0,
                        limit: 100_000,
                    }),
                    sort: Vec::new(),
                    filters: Vec::new(),
                },
                visible,
            )
            .await?
            .rows;
        let forecasts = ForecastsService::new(self.db.clone());
        let today = forecasts.today().await?;
        let review_delay_days = applied_value(&self.db, REVIEW_DELAY_ITEM, None, today)
            .await?
            .map(|(v, _)| v);
        let company_low_margin = applied_value(&self.db, LOW_MARGIN_ITEM, None, today)
            .await?
            .map(|(v, _)| v);
        let pipeline = PipelineService::new(self.db.clone())
            .overview(amounts)
            .await?;
        let pre: BTreeMap<i64, PreOrderFacts> = pipeline
            .rows
            .iter()
            .filter(|r| r.version_no.is_some())
            .map(|r| {
                (
                    r.project_id,
                    PreOrderFacts {
                        expected_order_month: r
                            .expected_order_month
                            .as_deref()
                            .and_then(YearMonth::parse),
                        confirmed_on: r.confirmed_on.as_deref().and_then(Date::parse),
                        unset: !r.issues.is_empty(),
                    },
                )
            })
            .collect();
        let ledger = DirectCostsService::new(self.db.clone()).ledger().await?;
        let orders = OrdersService::new(self.db.clone());

        let mut rows = Vec::with_capacity(projects.len());
        for p in projects {
            let status = ProjectStatus::parse(&p.status)
                .ok_or_else(|| BantoError::Other(format!("不明な案件の状態です: {}", p.status)))?;
            let mut row = PortfolioRow {
                project_id: p.id,
                code: p.code,
                name: p.name,
                customer_name: p.customer_name,
                manager_name: p.manager_name,
                status: p.status,
                amounts_visible: amounts.contains(p.id),
                order_amount: None,
                pending_addition: None,
                budget_total: None,
                budget_version_no: None,
                actual_cost: None,
                actual_complete: None,
                forecast_version_no: None,
                forecast_base_date: None,
                forecast_actual_complete: None,
                forecast_cost: None,
                forecast_profit: None,
                forecast_ratio_permille: None,
                forecast_overrun: None,
                alerts: Vec::new(),
                update_reasons: Vec::new(),
            };
            if !row.amounts_visible {
                rows.push(row);
                continue;
            }
            let order = orders.summary(p.id).await?;
            let budget = self.budget(p.id).await?;
            let summary = forecasts
                .summary(p.id, &ledger, order.confirmed_amount)
                .await?;
            row.order_amount = order.confirmed_amount;
            row.pending_addition = Some(order.pending_total);
            row.budget_version_no = budget.map(|b| b.0);
            row.budget_total = budget.map(|b| b.1);
            row.actual_cost = Some(summary.latest_actual_total);
            row.actual_complete = Some(summary.latest_actual_complete);
            row.update_reasons = summary
                .update_reasons
                .iter()
                .map(|r| r.as_str().to_string())
                .collect();
            if let Some(f) = &summary.latest {
                let pr = profit(order.confirmed_amount, f.cost_total);
                row.forecast_version_no = Some(f.version_no);
                row.forecast_base_date = Some(f.base_date.clone());
                row.forecast_actual_complete = Some(f.actual_complete);
                row.forecast_cost = Some(f.cost_total);
                row.forecast_profit = order.confirmed_amount.map(|_| pr.amount);
                row.forecast_ratio_permille = pr.ratio_permille;
                row.forecast_overrun = row.budget_total.map(|b| f.cost_total - b);
            }
            let low_margin_pct = if status.is_ordered_open() {
                applied_value(&self.db, LOW_MARGIN_ITEM, Some(p.id), today)
                    .await?
                    .map(|(v, _)| v)
            } else {
                None
            };
            let ordered = OrderedFacts {
                order_amount: order.confirmed_amount,
                budget: row.budget_total,
                forecast: summary.latest.as_ref().map(|f| ForecastFacts {
                    cost: f.cost_total,
                    update_reasons: summary.update_reasons.clone(),
                }),
                unapproved: usize::try_from(summary.unapproved).unwrap_or(0),
                pending_addition: order.pending_total,
                committed: summary.committed,
            };
            row.alerts = evaluate(
                status,
                pre.get(&p.id),
                Some(&ordered),
                today,
                &Thresholds {
                    review_delay_days,
                    low_margin_pct,
                },
            )
            .into_iter()
            .map(|a| a.as_str().to_string())
            .collect();
            rows.push(row);
        }

        let mut alert_counts: BTreeMap<String, usize> = BTreeMap::new();
        let mut needs_update = BTreeSet::new();
        let mut without_forecast = BTreeSet::new();
        for r in rows.iter().filter(|r| r.amounts_visible) {
            for a in &r.alerts {
                *alert_counts.entry(a.clone()).or_default() += 1;
                if a == Alert::ForecastUpdateNeeded.as_str() {
                    needs_update.insert(r.project_id);
                }
                if a == Alert::NoForecast.as_str() {
                    without_forecast.insert(r.project_id);
                }
            }
        }
        let ordered_rows: Vec<&PortfolioRow> = rows
            .iter()
            .filter(|r| {
                r.amounts_visible
                    && ProjectStatus::parse(&r.status).is_some_and(|s| s.is_ordered_open())
            })
            .collect();
        let with_forecast: Vec<&&PortfolioRow> = ordered_rows
            .iter()
            .filter(|r| r.forecast_cost.is_some() && r.order_amount.is_some())
            .collect();
        let forecast_order_total: i64 = with_forecast.iter().filter_map(|r| r.order_amount).sum();
        let forecast_profit_total: i64 =
            with_forecast.iter().filter_map(|r| r.forecast_profit).sum();
        let totals = PortfolioTotals {
            project_count: rows.len(),
            amount_count: rows.iter().filter(|r| r.amounts_visible).count(),
            ordered_count: ordered_rows.len(),
            order_total: ordered_rows.iter().filter_map(|r| r.order_amount).sum(),
            forecast_count: with_forecast.len(),
            forecast_order_total,
            forecast_cost_total: with_forecast.iter().filter_map(|r| r.forecast_cost).sum(),
            forecast_profit_total,
            forecast_ratio_permille: ratio_permille(forecast_profit_total, forecast_order_total),
            needs_update: needs_update.into_iter().collect(),
            without_forecast: without_forecast.into_iter().collect(),
            provisional_forecasts: with_forecast
                .iter()
                .filter(|r| r.forecast_actual_complete == Some(false))
                .map(|r| r.project_id)
                .collect(),
            oldest_base_date: with_forecast
                .iter()
                .filter_map(|r| r.forecast_base_date.clone())
                .min(),
            alert_counts: alert_counts
                .into_iter()
                .map(|(alert, count)| AlertCount { alert, count })
                .collect(),
        };
        Ok(Portfolio {
            as_of: today.to_string(),
            review_delay_days,
            low_margin_pct: company_low_margin,
            rows,
            totals,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calc_basis::tests::value;
    use crate::calc_basis::CalcBasisService;
    use crate::forecasts::tests::{rem, spec_project};
    use crate::forecasts::ForecastDraftInput;
    use crate::orders::tests::{line, ordered_project, pipeline_project};
    use crate::projects::tests::fixture;

    fn row(p: &Portfolio, id: i64) -> &PortfolioRow {
        p.rows.iter().find(|r| r.project_id == id).unwrap()
    }

    #[tokio::test]
    async fn t28_t30_alerts_amounts_and_totals_follow_the_scope() {
        let db = fixture().await;
        let (spec, _, _) = spec_project(&db, "P-L01").await;
        let forecasts = ForecastsService::new(db.clone());
        let d = forecasts.create_draft(spec, Some(2)).await.unwrap().draft;
        let d = forecasts
            .update_draft(
                d.id,
                ForecastDraftInput {
                    base_date: "2026-01-31".into(),
                    planned_end: None,
                    reason: Some("初回".into()),
                    lines: vec![
                        rem(Some(1), "labor", Some(100 * 60), None),
                        rem(None, "travel", None, Some(70_000)),
                        rem(None, "other", None, Some(30_000)),
                    ],
                    row_version: d.row_version,
                },
                Some(2),
            )
            .await
            .unwrap();
        forecasts.adopt(&d, d.row_version, Some(1)).await.unwrap();
        // A second ordered project without a forecast, a pre-order one whose
        // order month (2026-11 in the fixture version) is not past yet.
        let bare = ordered_project(&db, "P-L02", vec![line(None, 1_000_000)]).await;
        let lead = pipeline_project(&db, "P-L03", 2_000_000, 40, "2027-01").await;
        // Thresholds: 30% low margin (the spec project forecasts 27.5%).
        let basis = CalcBasisService::new(db.clone());
        basis
            .add(
                None,
                value(LOW_MARGIN_ITEM, "2020-01-01", Some(30), "初期"),
                Some(1),
            )
            .await
            .unwrap();

        let svc = PortfolioService::new(db.clone());
        let all = svc
            .overview(&ProjectScope::All, &ProjectScope::All)
            .await
            .unwrap();
        assert_eq!(all.low_margin_pct, Some(30));
        assert_eq!(all.review_delay_days, None, "未設定は判定しない");
        let r = row(&all, spec);
        assert_eq!(r.order_amount, Some(4_000_000));
        assert_eq!(r.budget_total, Some(2_600_000));
        assert_eq!(r.actual_cost, Some(1_900_000));
        assert_eq!(r.forecast_cost, Some(2_900_000));
        assert_eq!(r.forecast_profit, Some(1_100_000));
        assert_eq!(r.forecast_overrun, Some(300_000));
        assert_eq!(r.alerts, vec!["forecast_over_budget", "low_margin"]);
        assert_eq!(row(&all, bare).alerts, vec!["no_forecast"]);
        assert!(row(&all, lead).alerts.is_empty());
        assert_eq!(all.totals.forecast_count, 1);
        assert_eq!(all.totals.forecast_profit_total, 1_100_000);
        assert_eq!(all.totals.forecast_ratio_permille, Some(275));
        assert_eq!(all.totals.without_forecast, vec![bare]);
        assert_eq!(all.totals.oldest_base_date.as_deref(), Some("2026-01-31"));
        assert_eq!(r.forecast_actual_complete, Some(true));
        assert!(all.totals.provisional_forecasts.is_empty());

        // T30: an actual after the base date flags 見込更新要 and is counted.
        crate::forecasts::tests::approved_hours(&db, spec, 1, "2026-02-10", 60, 5_000).await;
        let all = svc
            .overview(&ProjectScope::All, &ProjectScope::All)
            .await
            .unwrap();
        assert!(row(&all, spec)
            .alerts
            .contains(&"forecast_update_needed".to_string()));
        assert_eq!(row(&all, spec).update_reasons, vec!["actual_after_base"]);
        assert_eq!(all.totals.needs_update, vec![spec]);
        assert_eq!(row(&all, spec).forecast_cost, Some(2_900_000));

        // T12: rows outside the amount scope show no amount and no alert.
        let some = svc
            .overview(
                &ProjectScope::All,
                &ProjectScope::Only(BTreeSet::from([bare])),
            )
            .await
            .unwrap();
        let hidden = row(&some, spec);
        assert!(!hidden.amounts_visible);
        assert_eq!((hidden.order_amount, hidden.forecast_cost), (None, None));
        assert!(hidden.alerts.is_empty());
        assert_eq!(some.totals.amount_count, 1);
        assert_eq!(some.totals.forecast_count, 0);
        let none = svc
            .overview(
                &ProjectScope::Only(BTreeSet::from([lead])),
                &ProjectScope::Only(BTreeSet::new()),
            )
            .await
            .unwrap();
        assert_eq!(none.rows.len(), 1);
    }
}
