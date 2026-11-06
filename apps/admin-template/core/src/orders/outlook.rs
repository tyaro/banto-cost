//! Monthly revenue outlook (spec §7.5, T27) and its saved snapshots.
//!
//! 月次売上見通し = recognized revenue + the ordered plan still open + the
//! pre-order plan × probability (`cost_domain::outlook::monthly_outlook`,
//! computed per project). The three parts are returned separately and never
//! added to the order-month figures of the pipeline overview. Pending order
//! changes (未確定追加売上) are a separate column outside the total.
//!
//! A snapshot stores the per-project rows at the time it was saved, so a
//! report keeps its figures after an order conversion or a recognition
//! changes the live outlook (T27). Both the live view and a snapshot view
//! only show rows of projects in the caller's scope (`amount_projects`).

use std::collections::BTreeMap;

use banto_admin_services::authz::ProjectScope;
use banto_core::BantoError;
use cost_domain::outlook::{monthly_outlook, OutlookKey};
use cost_domain::project::ProjectStatus;
use cost_domain::YearMonth;
use serde::{Deserialize, Serialize};

use super::{
    execute, fetch_all, field_error, in_tx, issue_code, on_pool, scalar, validation, OrdersService,
};
use crate::pipeline::PipelineService;
use banto_storage::Db;

pub const MAX_LABEL_LEN: usize = 100;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookQuery {
    /// First month shown (`YYYY-MM`); omitted = from the earliest month with figures.
    #[serde(default)]
    pub from: Option<String>,
    /// Last month shown (`YYYY-MM`); omitted = up to the latest month with figures.
    #[serde(default)]
    pub to: Option<String>,
    /// A snapshot to compare with (前回差異).
    #[serde(default)]
    pub compare: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookFigures {
    /// 計上済み売上.
    pub recognized: i64,
    /// 受注済み売上予定 (open part only).
    pub ordered_plan: i64,
    /// 未受注の売上見込 (plan × probability).
    pub weighted_pipeline: i64,
    /// 月次売上見通し = the three above.
    pub total: i64,
    /// 未確定追加売上 (pending order changes), NOT part of `total`.
    pub pending_addition: i64,
    /// The compared snapshot's `total` (`None` without `compare`).
    pub previous_total: Option<i64>,
    /// `total - previous_total`.
    pub difference: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookRow {
    /// `None` = 時期未定 (shown on its own row, never spread over months).
    pub month: Option<String>,
    #[serde(flatten)]
    pub figures: OutlookFigures,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRef {
    pub project_id: i64,
    pub code: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIssues {
    pub project_id: i64,
    pub code: String,
    pub name: String,
    /// `cost_domain::revenue::RevenueIssue` codes.
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub id: i64,
    pub label: String,
    pub created_by_name: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookView {
    /// The months in range, then the 時期未定 row when it has figures.
    pub rows: Vec<OutlookRow>,
    /// Sum of the month rows in range (the 時期未定 row is not included).
    pub totals: OutlookFigures,
    /// Pre-order projects left out of the weighted figures (amount or probability unset).
    pub excluded: Vec<ProjectRef>,
    /// Ordered projects whose plan does not match the unrecognized remainder.
    pub revenue_issues: Vec<ProjectIssues>,
    /// The snapshot `compare` named.
    pub compared: Option<SnapshotInfo>,
    /// Set when this view IS a saved snapshot.
    pub snapshot: Option<SnapshotInfo>,
}

/// One project's figures for one month (also a snapshot row).
#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
struct CellRow {
    project_id: i64,
    month: Option<String>,
    recognized: i64,
    ordered_plan: i64,
    weighted_pipeline: i64,
    pending_addition: i64,
}

struct Live {
    cells: Vec<CellRow>,
    excluded: Vec<ProjectRef>,
    issues: Vec<ProjectIssues>,
}

fn key_month(key: OutlookKey) -> Option<String> {
    match key {
        OutlookKey::Month(m) => Some(m.to_string()),
        OutlookKey::Undated => None,
    }
}

/// Sum per month key. `None` (時期未定) sorts last.
fn by_key(cells: &[CellRow]) -> BTreeMap<(bool, Option<String>), OutlookFigures> {
    let mut out: BTreeMap<(bool, Option<String>), OutlookFigures> = BTreeMap::new();
    for c in cells {
        let f = out.entry((c.month.is_none(), c.month.clone())).or_default();
        f.recognized += c.recognized;
        f.ordered_plan += c.ordered_plan;
        f.weighted_pipeline += c.weighted_pipeline;
        f.pending_addition += c.pending_addition;
        f.total = f.recognized + f.ordered_plan + f.weighted_pipeline;
    }
    out
}

fn parse_range(query: &OutlookQuery) -> Result<(Option<String>, Option<String>), BantoError> {
    let mut errors = Vec::new();
    let mut month = |field: &str, v: &Option<String>| {
        let raw = crate::customers::clean_optional(v)?;
        match YearMonth::parse(&raw) {
            Some(m) => Some(m.to_string()),
            None => {
                errors.push(field_error(field, "年月は YYYY-MM で入力してください"));
                None
            }
        }
    };
    let from = month("from", &query.from);
    let to = month("to", &query.to);
    if let (Some(f), Some(t)) = (&from, &to) {
        if t < f {
            errors.push(field_error("to", "終了月は開始月以降にしてください"));
        }
    }
    validation(errors)?;
    Ok((from, to))
}

/// Build the view from per-project cells (live or snapshot).
fn view(
    cells: &[CellRow],
    previous: Option<&[CellRow]>,
    (from, to): (Option<String>, Option<String>),
) -> (Vec<OutlookRow>, OutlookFigures) {
    let current = by_key(cells);
    let before = previous.map(by_key);
    let mut keys: Vec<(bool, Option<String>)> = current.keys().cloned().collect();
    if let Some(b) = &before {
        keys.extend(b.keys().cloned());
    }
    keys.sort();
    keys.dedup();
    let in_range = |m: &Option<String>| match m {
        None => true,
        Some(m) => {
            from.as_deref().is_none_or(|f| m.as_str() >= f)
                && to.as_deref().is_none_or(|t| m.as_str() <= t)
        }
    };
    let mut rows = Vec::new();
    let mut totals = OutlookFigures::default();
    if before.is_some() {
        totals.previous_total = Some(0);
    }
    for key in keys.into_iter().filter(|(_, m)| in_range(m)) {
        let mut f = current.get(&key).cloned().unwrap_or_default();
        if let Some(b) = &before {
            let prev = b.get(&key).map_or(0, |p| p.total);
            f.previous_total = Some(prev);
            f.difference = Some(f.total - prev);
        }
        if key.1.is_some() {
            totals.recognized += f.recognized;
            totals.ordered_plan += f.ordered_plan;
            totals.weighted_pipeline += f.weighted_pipeline;
            totals.total += f.total;
            totals.pending_addition += f.pending_addition;
            if let (Some(t), Some(p)) = (totals.previous_total.as_mut(), f.previous_total) {
                *t += p;
            }
        }
        rows.push(OutlookRow {
            month: key.1,
            figures: f,
        });
    }
    if let Some(p) = totals.previous_total {
        totals.difference = Some(totals.total - p);
    }
    (rows, totals)
}

impl OrdersService {
    /// Per-project outlook cells for the projects in `scope`.
    async fn live(&self, scope: &ProjectScope) -> Result<Live, BantoError> {
        let ids: Option<Vec<i64>> = match scope {
            ProjectScope::All => None,
            ProjectScope::Only(ids) => Some(ids.iter().copied().collect()),
        };
        if ids.as_ref().is_some_and(Vec::is_empty) {
            return Ok(Live {
                cells: Vec::new(),
                excluded: Vec::new(),
                issues: Vec::new(),
            });
        }
        let filter = match &ids {
            None => String::new(),
            Some(ids) => format!(" WHERE id IN ({})", vec!["?"; ids.len()].join(", ")),
        };
        let sql = self.sql(&format!(
            "SELECT id, code, name, status FROM projects{filter} ORDER BY code"
        ));
        let projects: Vec<(i64, String, String, String)> = on_pool!(&self.db, pool => {
            let mut q = sqlx::query_as(sqlx::AssertSqlSafe(sql.as_str()));
            for id in ids.iter().flatten() {
                q = q.bind(*id);
            }
            q.fetch_all(pool).await.map_err(banto_storage::storage_error)
        })?;
        let entries = PipelineService::new(self.db.clone())
            .overview(scope)
            .await?
            .entries;
        let mut out = Live {
            cells: Vec::new(),
            excluded: Vec::new(),
            issues: Vec::new(),
        };
        for (project_id, code, name, status) in projects {
            let ordered = ProjectStatus::parse(&status).is_some_and(ProjectStatus::is_ordered);
            let (recognitions, open, pending, pipeline) = if ordered {
                // Small company: one state load per ordered project is fine.
                let state = self.state(project_id).await?;
                let (Some(revenue), Some(book)) = (state.revenue(), state.book()) else {
                    continue;
                };
                let issues = revenue.check();
                if !issues.is_empty() {
                    out.issues.push(ProjectIssues {
                        project_id,
                        code: code.clone(),
                        name: name.clone(),
                        issues: issues.iter().map(issue_code).collect(),
                    });
                }
                (
                    revenue.recognitions(),
                    revenue.open_plans(),
                    book.pending_lines(),
                    Vec::new(),
                )
            } else {
                let entry: Vec<_> = entries
                    .iter()
                    .filter(|e| e.id == project_id.to_string())
                    .cloned()
                    .collect();
                (Vec::new(), Vec::new(), Vec::new(), entry)
            };
            let o = monthly_outlook(&recognitions, &open, &pipeline);
            if !o.excluded.is_empty() {
                out.excluded.push(ProjectRef {
                    project_id,
                    code: code.clone(),
                    name: name.clone(),
                });
            }
            let mut cells: BTreeMap<OutlookKey, CellRow> = BTreeMap::new();
            let blank = |key: OutlookKey| CellRow {
                project_id,
                month: key_month(key),
                recognized: 0,
                ordered_plan: 0,
                weighted_pipeline: 0,
                pending_addition: 0,
            };
            for (key, cell) in &o.cells {
                let row = cells.entry(*key).or_insert_with(|| blank(*key));
                row.recognized += cell.recognized;
                row.ordered_plan += cell.ordered_plan;
                row.weighted_pipeline += cell.weighted_pipeline;
            }
            for line in pending {
                let key = line.month.map_or(OutlookKey::Undated, OutlookKey::Month);
                cells
                    .entry(key)
                    .or_insert_with(|| blank(key))
                    .pending_addition += line.amount;
            }
            out.cells.extend(cells.into_values().filter(|c| {
                c.recognized != 0
                    || c.ordered_plan != 0
                    || c.weighted_pipeline != 0
                    || c.pending_addition != 0
            }));
        }
        Ok(out)
    }

    async fn snapshot_info(&self, id: i64) -> Result<SnapshotInfo, BantoError> {
        let sql = self.sql(
            "SELECT s.id, s.label, u.display_name AS created_by_name, s.created_at \
             FROM outlook_snapshots s LEFT JOIN users u ON u.id = s.created_by WHERE s.id = ?",
        );
        let row: Option<SnapshotInfo> =
            on_pool!(&self.db, pool => super::fetch_optional!(pool, sql, id))?;
        row.ok_or_else(|| BantoError::NotFound {
            resource: "outlook_snapshots".into(),
            id: id.to_string(),
        })
    }

    /// A snapshot's rows, limited to `scope`.
    async fn snapshot_cells(
        &self,
        id: i64,
        scope: &ProjectScope,
    ) -> Result<Vec<CellRow>, BantoError> {
        let sql = self.sql(
            "SELECT project_id, month, recognized, ordered_plan, weighted_pipeline, \
             pending_addition FROM outlook_snapshot_rows WHERE snapshot_id = ?",
        );
        let rows: Vec<CellRow> = on_pool!(&self.db, pool => fetch_all!(pool, sql, id))?;
        Ok(rows
            .into_iter()
            .filter(|r| scope.contains(r.project_id))
            .collect())
    }

    /// The live monthly outlook of the projects in `scope` (pass
    /// `authz::amount_projects`).
    pub async fn outlook(
        &self,
        scope: &ProjectScope,
        query: OutlookQuery,
    ) -> Result<OutlookView, BantoError> {
        let range = parse_range(&query)?;
        let live = self.live(scope).await?;
        let (compared, previous) = match query.compare {
            None => (None, None),
            Some(id) => (
                Some(self.snapshot_info(id).await?),
                Some(self.snapshot_cells(id, scope).await?),
            ),
        };
        let (rows, totals) = view(&live.cells, previous.as_deref(), range);
        Ok(OutlookView {
            rows,
            totals,
            excluded: live.excluded,
            revenue_issues: live.issues,
            compared,
            snapshot: None,
        })
    }

    /// A saved snapshot, as it was saved (T27), limited to `scope`.
    pub async fn snapshot_view(
        &self,
        id: i64,
        scope: &ProjectScope,
        query: OutlookQuery,
    ) -> Result<OutlookView, BantoError> {
        let range = parse_range(&query)?;
        let info = self.snapshot_info(id).await?;
        let cells = self.snapshot_cells(id, scope).await?;
        let (rows, totals) = view(&cells, None, range);
        Ok(OutlookView {
            rows,
            totals,
            excluded: Vec::new(),
            revenue_issues: Vec::new(),
            compared: None,
            snapshot: Some(info),
        })
    }

    pub async fn snapshots(&self) -> Result<Vec<SnapshotInfo>, BantoError> {
        let sql = "SELECT s.id, s.label, u.display_name AS created_by_name, s.created_at \
             FROM outlook_snapshots s LEFT JOIN users u ON u.id = s.created_by \
             ORDER BY s.id DESC"
            .to_string();
        on_pool!(&self.db, pool => fetch_all!(pool, sql))
    }

    /// Save the outlook of every project as a snapshot (the caller must see
    /// all reports: `ViewAllReports`).
    pub async fn save_snapshot(
        &self,
        label: Option<String>,
        actor_user_id: Option<i64>,
    ) -> Result<SnapshotInfo, BantoError> {
        let label = crate::customers::clean_optional(&label);
        let mut errors = Vec::new();
        match &label {
            None => errors.push(field_error("label", "名前を入力してください")),
            Some(l) if l.chars().count() > MAX_LABEL_LEN => errors.push(field_error(
                "label",
                format!("{MAX_LABEL_LEN}文字以内で入力してください"),
            )),
            Some(_) => {}
        }
        validation(errors)?;
        let live = self.live(&ProjectScope::All).await?;
        let insert = self
            .sql("INSERT INTO outlook_snapshots (label, created_by) VALUES (?, ?) RETURNING id");
        let insert_row = self.sql(
            "INSERT INTO outlook_snapshot_rows (snapshot_id, project_id, month, recognized, \
             ordered_plan, weighted_pipeline, pending_addition) VALUES (?, ?, ?, ?, ?, ?, ?)",
        );
        let id: i64 = in_tx!(&self.db, tx => {
            let id: i64 = scalar!(&mut *tx, insert, &label, actor_user_id)?;
            for c in &live.cells {
                execute!(&mut *tx, insert_row, id, c.project_id, &c.month, c.recognized,
                    c.ordered_plan, c.weighted_pipeline, c.pending_addition)?;
            }
            id
        });
        self.snapshot_info(id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orders::tests::{conversion, line, ordered_project, pipeline_project, row_version};
    use crate::orders::{ChangeRequest, RecognitionInput};
    use crate::projects::tests::fixture;
    use std::collections::BTreeSet;

    fn row<'a>(v: &'a OutlookView, month: Option<&str>) -> &'a OutlookFigures {
        &v.rows
            .iter()
            .find(|r| r.month.as_deref() == month)
            .unwrap_or_else(|| panic!("row {month:?}"))
            .figures
    }

    #[tokio::test]
    async fn t27_outlook_before_and_after_the_order_and_the_snapshot_stays() {
        let db = fixture().await;
        let svc = OrdersService::new(db.clone());
        // 案件A：未受注 3,000,000円・確度60%・12月売上予定。
        let a = pipeline_project(&db, "P-A", 3_000_000, 60, "2026-12").await;
        // 案件B：受注済み。12月に500,000円計上済み、未計上の12月予定1,000,000円。
        let b = ordered_project(&db, "P-B", vec![line(Some("2026-12"), 1_500_000)]).await;
        svc.recognize(
            b,
            RecognitionInput {
                recognized_on: "2026-12-10".into(),
                amount: 500_000,
                basis: None,
                clears: None,
            },
            Some(1),
        )
        .await
        .unwrap();
        let before = svc
            .outlook(&ProjectScope::All, OutlookQuery::default())
            .await
            .unwrap();
        let dec = row(&before, Some("2026-12"));
        assert_eq!(
            (
                dec.recognized,
                dec.ordered_plan,
                dec.weighted_pipeline,
                dec.total
            ),
            (500_000, 1_000_000, 1_800_000, 3_300_000)
        );
        // 受注予定月（11月）には売上見込を置かない。
        assert!(before
            .rows
            .iter()
            .all(|r| r.month.as_deref() != Some("2026-11")));
        let snap = svc
            .save_snapshot(Some("11月報告".into()), Some(1))
            .await
            .unwrap();

        // 案件Aを2,800,000円で受注、全額12月予定。
        let rv = row_version(&db, a).await;
        svc.convert(
            a,
            conversion(rv, 2_800_000, vec![line(Some("2026-12"), 2_800_000)]),
            Some(1),
        )
        .await
        .unwrap();
        let after = svc
            .outlook(
                &ProjectScope::All,
                OutlookQuery {
                    compare: Some(snap.id),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let dec = row(&after, Some("2026-12"));
        assert_eq!(
            (
                dec.recognized,
                dec.ordered_plan,
                dec.weighted_pipeline,
                dec.total
            ),
            (500_000, 3_800_000, 0, 4_300_000)
        );
        assert_eq!(
            (dec.previous_total, dec.difference),
            (Some(3_300_000), Some(1_000_000))
        );
        assert_eq!(
            after.compared.as_ref().map(|s| s.label.as_str()),
            Some("11月報告")
        );
        // The snapshot keeps its figures.
        let saved = svc
            .snapshot_view(snap.id, &ProjectScope::All, OutlookQuery::default())
            .await
            .unwrap();
        assert_eq!(row(&saved, Some("2026-12")).total, 3_300_000);
        assert_eq!(svc.snapshots().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn t25_undated_pending_and_scope_are_kept_apart() {
        let db = fixture().await;
        let svc = OrdersService::new(db.clone());
        let a = ordered_project(
            &db,
            "P-A",
            vec![line(Some("2027-01"), 1_000_000), line(None, 500_000)],
        )
        .await;
        svc.request_change(
            a,
            ChangeRequest {
                delta_amount: 200_000,
                plan_month: Some("2027-02".into()),
                basis: Some("追加".into()),
            },
            Some(1),
        )
        .await
        .unwrap();
        let b = pipeline_project(&db, "P-B", 1_000_000, 50, "2027-01").await;
        let v = svc
            .outlook(&ProjectScope::All, OutlookQuery::default())
            .await
            .unwrap();
        assert_eq!(
            v.rows.iter().map(|r| r.month.clone()).collect::<Vec<_>>(),
            vec![
                Some("2027-01".to_string()),
                Some("2027-02".to_string()),
                None
            ],
            "時期未定 is its own last row"
        );
        assert_eq!(row(&v, Some("2027-01")).total, 1_500_000);
        let feb = row(&v, Some("2027-02"));
        assert_eq!(
            (feb.total, feb.pending_addition),
            (0, 200_000),
            "pending is outside the total"
        );
        assert_eq!(row(&v, None).ordered_plan, 500_000);
        assert_eq!(
            v.totals.total, 1_500_000,
            "the undated row is not in the month totals"
        );
        // Range and scope.
        let jan = svc
            .outlook(
                &ProjectScope::Only(BTreeSet::from([b])),
                OutlookQuery {
                    from: Some("2027-01".into()),
                    to: Some("2027-01".into()),
                    compare: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(jan.rows.len(), 1);
        assert_eq!(jan.rows[0].figures.weighted_pipeline, 500_000);
        let none = svc
            .outlook(
                &ProjectScope::Only(BTreeSet::new()),
                OutlookQuery::default(),
            )
            .await
            .unwrap();
        assert!(none.rows.is_empty());
        assert!(svc
            .outlook(
                &ProjectScope::All,
                OutlookQuery {
                    from: Some("2027/01".into()),
                    ..Default::default()
                }
            )
            .await
            .is_err());
        assert!(svc.save_snapshot(None, None).await.is_err());
    }
}
