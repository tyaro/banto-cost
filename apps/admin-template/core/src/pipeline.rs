//! Pre-order pipeline versions and the pipeline overview (banto-cost P3a,
//! spec §5.4 / §7.5, `docs/project/design.md` §3.1).
//!
//! A saved version is never edited: a change is a new version, so who
//! changed amount / probability / timing, why, and in which version stays
//! traceable (T29). A draft becomes the aggregate's input only once it is
//! adopted, and the aggregate uses each project's latest adopted version
//! (T22, `cost_domain::pipeline::current_adopted`). The calculation itself is
//! `cost_domain::pipeline` / `cost_domain::outlook`; this service only loads
//! rows and calls it.
//!
//! Authorization (ADR-0028) is the wiring layer's: `EditPipeline` for writes,
//! `ViewProjectAmounts` for a project's versions, and `amount_projects` as
//! the overview's scope.

use std::collections::{BTreeMap, BTreeSet};

use banto_admin_services::authz::ProjectScope;
use banto_core::BantoError;
use banto_storage::Db;
use cost_domain::outlook::{monthly_outlook, OutlookKey};
use cost_domain::pipeline::{
    by_order_month, current_adopted, totals, PipelineEntry, RevenuePlanLine, Stage, VersionKind,
    VersionRef,
};
use cost_domain::project::ProjectStatus;
use cost_domain::{Date, YearMonth};
use serde::{Deserialize, Serialize};

use crate::customers::{clean_optional, field_error, now_expr};

pub const MAX_TEXT_LEN: usize = 1000;
pub const MAX_PLAN_LINES: usize = 60;

/// One line of a version's revenue plan. `month: None` = timing undecided.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanLine {
    #[serde(default)]
    pub month: Option<String>,
    pub amount: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PipelineVersion {
    pub id: i64,
    pub project_id: i64,
    pub version_no: i64,
    /// `draft` | `adopted`.
    pub kind: String,
    /// `lead` | `quoting` | `negotiating` | `informal`.
    pub stage: String,
    /// `None` = 未設定 (never 0).
    pub expected_amount: Option<i64>,
    pub probability_pct: Option<i64>,
    pub expected_order_month: Option<String>,
    pub expected_start_month: Option<String>,
    pub expected_end_month: Option<String>,
    pub est_cost_at_order: Option<i64>,
    pub basis: Option<String>,
    pub next_action: Option<String>,
    pub confirmed_on: Option<String>,
    pub created_by_name: Option<String>,
    pub created_at: String,
    pub adopted_by_name: Option<String>,
    pub adopted_at: Option<String>,
    #[sqlx(skip)]
    pub revenue_plan: Vec<PlanLine>,
    /// Shortfalls shown as 不足あり (spec §5.4): `amount_missing`,
    /// `probability_missing`, `order_month_missing`, `plan_missing`,
    /// `plan_mismatch`.
    #[sqlx(skip)]
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineVersionInput {
    pub stage: String,
    #[serde(default)]
    pub expected_amount: Option<i64>,
    #[serde(default)]
    pub probability_pct: Option<i64>,
    #[serde(default)]
    pub expected_order_month: Option<String>,
    #[serde(default)]
    pub expected_start_month: Option<String>,
    #[serde(default)]
    pub expected_end_month: Option<String>,
    #[serde(default)]
    pub est_cost_at_order: Option<i64>,
    #[serde(default)]
    pub basis: Option<String>,
    #[serde(default)]
    pub next_action: Option<String>,
    #[serde(default)]
    pub confirmed_on: Option<String>,
    #[serde(default)]
    pub revenue_plan: Vec<PlanLine>,
    /// Save as the adopted version directly (the person in charge confirmed it).
    #[serde(default)]
    pub adopt: bool,
}

/// One row of the overview: a pre-order project and its latest adopted version.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewRow {
    pub project_id: i64,
    pub code: String,
    pub name: String,
    pub customer_name: String,
    pub status: String,
    /// The stage the aggregate uses: the version's, unless the project is
    /// lost / cancelled / on hold (T24).
    pub stage: Option<String>,
    pub version_no: Option<i64>,
    pub expected_amount: Option<i64>,
    pub probability_pct: Option<i64>,
    pub weighted_amount: Option<i64>,
    pub expected_order_month: Option<String>,
    pub confirmed_on: Option<String>,
    /// The plan's 時期未定 part.
    pub undated_amount: Option<i64>,
    /// As [`PipelineVersion::issues`], plus `no_adopted_version`.
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewTotals {
    pub active_count: usize,
    /// 未受注見込総額 (probability not applied).
    pub total: i64,
    /// 確度加重見込額.
    pub weighted: i64,
    pub missing_amount: Vec<i64>,
    pub missing_probability: Vec<i64>,
    pub excluded_count: usize,
    pub without_adopted_version: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderMonthRow {
    /// `None` = 受注予定月 undecided.
    pub month: Option<String>,
    pub total: i64,
    pub weighted: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevenueMonthRow {
    /// `None` = 時期未定.
    pub month: Option<String>,
    /// 未受注の売上見込 (plan × probability, spec §7.5).
    pub weighted: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineOverview {
    pub rows: Vec<OverviewRow>,
    pub totals: OverviewTotals,
    pub by_order_month: Vec<OrderMonthRow>,
    pub by_revenue_month: Vec<RevenueMonthRow>,
    /// Projects left out of the revenue-month view (amount or probability unset).
    pub revenue_excluded: Vec<i64>,
    /// Each pre-order project's current entry (the monthly outlook's input;
    /// `id` is the project id). Not sent over the wire.
    #[serde(skip)]
    pub(crate) entries: Vec<PipelineEntry>,
}

pub(crate) struct CleanVersion {
    pub(crate) stage: Stage,
    pub(crate) expected_amount: Option<i64>,
    pub(crate) probability_pct: Option<u8>,
    pub(crate) expected_order_month: Option<String>,
    pub(crate) expected_start_month: Option<String>,
    pub(crate) expected_end_month: Option<String>,
    pub(crate) est_cost_at_order: Option<i64>,
    pub(crate) basis: Option<String>,
    pub(crate) next_action: Option<String>,
    pub(crate) confirmed_on: Option<String>,
    pub(crate) plan: Vec<(Option<String>, i64)>,
}

fn month_field(
    field: &str,
    value: &Option<String>,
    errors: &mut Vec<banto_core::FieldError>,
) -> Option<String> {
    let raw = clean_optional(value)?;
    if YearMonth::parse(&raw).is_some() {
        Some(raw)
    } else {
        errors.push(field_error(field, "年月は YYYY-MM で入力してください"));
        None
    }
}

fn non_negative(field: &str, value: Option<i64>, errors: &mut Vec<banto_core::FieldError>) {
    if value.is_some_and(|v| v < 0) {
        errors.push(field_error(field, "0以上で入力してください"));
    }
}

fn text_field(
    field: &str,
    value: &Option<String>,
    errors: &mut Vec<banto_core::FieldError>,
) -> Option<String> {
    let v = clean_optional(value);
    if v.as_deref()
        .is_some_and(|s| s.chars().count() > MAX_TEXT_LEN)
    {
        errors.push(field_error(
            field,
            format!("{MAX_TEXT_LEN}文字以内で入力してください"),
        ));
    }
    v
}

fn basis_required(errors: &mut Vec<banto_core::FieldError>) {
    errors.push(field_error(
        "basis",
        "採用する版には根拠（変更理由）を入力してください",
    ));
}

pub(crate) fn validate(input: &PipelineVersionInput) -> Result<CleanVersion, BantoError> {
    let mut errors = Vec::new();
    let stage = Stage::parse_version_stage(&input.stage);
    if stage.is_none() {
        errors.push(field_error("stage", "営業段階が正しくありません"));
    }
    non_negative("expectedAmount", input.expected_amount, &mut errors);
    non_negative("estCostAtOrder", input.est_cost_at_order, &mut errors);
    let probability_pct = match input.probability_pct {
        None => None,
        Some(p) if (0..=99).contains(&p) => Some(p as u8),
        Some(_) => {
            // Ordered is a status (order conversion), not 100% here (spec §5.4).
            errors.push(field_error(
                "probabilityPct",
                "確度は0〜99で入力してください",
            ));
            None
        }
    };
    let expected_order_month = month_field(
        "expectedOrderMonth",
        &input.expected_order_month,
        &mut errors,
    );
    let expected_start_month = month_field(
        "expectedStartMonth",
        &input.expected_start_month,
        &mut errors,
    );
    let expected_end_month =
        month_field("expectedEndMonth", &input.expected_end_month, &mut errors);
    let confirmed_on = clean_optional(&input.confirmed_on);
    if confirmed_on
        .as_deref()
        .is_some_and(|d| Date::parse(d).is_none())
    {
        errors.push(field_error(
            "confirmedOn",
            "日付は YYYY-MM-DD で入力してください",
        ));
    }
    let basis = text_field("basis", &input.basis, &mut errors);
    let next_action = text_field("nextAction", &input.next_action, &mut errors);
    if input.adopt && basis.is_none() {
        basis_required(&mut errors);
    }
    if input.revenue_plan.len() > MAX_PLAN_LINES {
        errors.push(field_error(
            "revenuePlan",
            format!("売上予定は{MAX_PLAN_LINES}行までです"),
        ));
    }
    let mut plan = Vec::new();
    let mut seen = BTreeSet::new();
    for line in &input.revenue_plan {
        let month = clean_optional(&line.month);
        if month
            .as_deref()
            .is_some_and(|m| YearMonth::parse(m).is_none())
        {
            errors.push(field_error(
                "revenuePlan",
                "売上予定の年月は YYYY-MM で入力してください",
            ));
            continue;
        }
        if line.amount < 0 {
            errors.push(field_error(
                "revenuePlan",
                "売上予定の金額は0以上で入力してください",
            ));
            continue;
        }
        if !seen.insert(month.clone()) {
            errors.push(field_error(
                "revenuePlan",
                "同じ月の売上予定が重複しています",
            ));
            continue;
        }
        plan.push((month, line.amount));
    }
    if !errors.is_empty() {
        return Err(BantoError::Validation {
            field_errors: errors,
        });
    }
    Ok(CleanVersion {
        stage: stage.expect("checked above"),
        expected_amount: input.expected_amount,
        probability_pct,
        expected_order_month,
        expected_start_month,
        expected_end_month,
        est_cost_at_order: input.est_cost_at_order,
        basis,
        next_action,
        confirmed_on,
        plan,
    })
}

fn to_plan_lines(plan: &[PlanLine]) -> Vec<RevenuePlanLine> {
    plan.iter()
        .map(|l| RevenuePlanLine {
            month: l.month.as_deref().and_then(YearMonth::parse),
            amount: l.amount,
        })
        .collect()
}

fn entry_of(project_id: i64, stage: Stage, v: &PipelineVersion) -> PipelineEntry {
    PipelineEntry {
        id: project_id.to_string(),
        stage,
        expected_amount: v.expected_amount,
        probability_pct: v.probability_pct.map(|p| p as u8),
        expected_order_month: v.expected_order_month.as_deref().and_then(YearMonth::parse),
        revenue_plan: to_plan_lines(&v.revenue_plan),
    }
}

/// The 不足あり signals of a version (spec §5.4: unset values stay visible).
fn issues_of(v: &PipelineVersion) -> Vec<String> {
    let mut issues = Vec::new();
    if v.expected_amount.is_none() {
        issues.push("amount_missing".to_string());
    }
    if v.probability_pct.is_none() {
        issues.push("probability_missing".to_string());
    }
    if v.expected_order_month.is_none() {
        issues.push("order_month_missing".to_string());
    }
    if v.revenue_plan.is_empty() {
        issues.push("plan_missing".to_string());
    }
    let stage = Stage::parse_version_stage(&v.stage).unwrap_or(Stage::Lead);
    for issue in entry_of(v.project_id, stage, v).validate() {
        if let cost_domain::pipeline::PipelineIssue::PlanMismatch { .. } = issue {
            issues.push("plan_mismatch".to_string());
        }
    }
    issues
}

const VERSION_SELECT: &str = "SELECT v.id, v.project_id, v.version_no, v.kind, v.stage, \
     v.expected_amount, v.probability_pct, v.expected_order_month, v.expected_start_month, \
     v.expected_end_month, v.est_cost_at_order, v.basis, v.next_action, v.confirmed_on, \
     cu.display_name AS created_by_name, v.created_at, au.display_name AS adopted_by_name, \
     v.adopted_at FROM pipeline_versions v \
     LEFT JOIN users cu ON cu.id = v.created_by LEFT JOIN users au ON au.id = v.adopted_by";

#[derive(Clone)]
pub struct PipelineService {
    db: Db,
}

impl PipelineService {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    fn ph(&self, n: usize) -> String {
        self.db.dialect().placeholder(n)
    }

    /// The project's status; versions are recorded only before the order.
    async fn pre_order_status(&self, project_id: i64) -> Result<ProjectStatus, BantoError> {
        let sql = format!("SELECT status FROM projects WHERE id = {}", self.ph(1));
        let row: Option<(String,)> = match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(project_id)
                    .fetch_optional(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(project_id)
                    .fetch_optional(pool)
                    .await
            }
        }
        .map_err(banto_storage::storage_error)?;
        let Some((status,)) = row else {
            return Err(BantoError::NotFound {
                resource: "projects".into(),
                id: project_id.to_string(),
            });
        };
        let status = ProjectStatus::parse(&status)
            .ok_or_else(|| BantoError::Other(format!("不明な案件の状態です: {status}")))?;
        if status.is_ordered() {
            return Err(BantoError::Validation {
                field_errors: vec![field_error(
                    "status",
                    "受注済みの案件には案件見込を記録しません（受注変更で扱います）",
                )],
            });
        }
        Ok(status)
    }

    async fn load_plans(
        &self,
        version_ids: &[i64],
    ) -> Result<BTreeMap<i64, Vec<PlanLine>>, BantoError> {
        let mut out: BTreeMap<i64, Vec<PlanLine>> = BTreeMap::new();
        if version_ids.is_empty() {
            return Ok(out);
        }
        let sql = format!(
            "SELECT pipeline_version_id, month, amount FROM pipeline_revenue_plan \
             WHERE pipeline_version_id IN ({}) ORDER BY pipeline_version_id, month IS NULL, month",
            self.db.dialect().placeholders(version_ids.len())
        );
        let rows: Vec<(i64, Option<String>, i64)> = match &self.db {
            Db::Sqlite(pool) => {
                let mut q = sqlx::query_as(sqlx::AssertSqlSafe(sql));
                for id in version_ids {
                    q = q.bind(*id);
                }
                q.fetch_all(pool).await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                let mut q = sqlx::query_as(sqlx::AssertSqlSafe(sql));
                for id in version_ids {
                    q = q.bind(*id);
                }
                q.fetch_all(pool).await
            }
        }
        .map_err(banto_storage::storage_error)?;
        for (version_id, month, amount) in rows {
            out.entry(version_id)
                .or_default()
                .push(PlanLine { month, amount });
        }
        Ok(out)
    }

    async fn finish(
        &self,
        mut versions: Vec<PipelineVersion>,
    ) -> Result<Vec<PipelineVersion>, BantoError> {
        let ids: Vec<i64> = versions.iter().map(|v| v.id).collect();
        let mut plans = self.load_plans(&ids).await?;
        for v in &mut versions {
            v.revenue_plan = plans.remove(&v.id).unwrap_or_default();
            v.issues = issues_of(v);
        }
        Ok(versions)
    }

    /// A project's versions, newest first.
    pub async fn versions(&self, project_id: i64) -> Result<Vec<PipelineVersion>, BantoError> {
        let sql = format!(
            "{VERSION_SELECT} WHERE v.project_id = {} ORDER BY v.version_no DESC",
            self.ph(1)
        );
        let rows: Vec<PipelineVersion> = match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(project_id)
                    .fetch_all(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(project_id)
                    .fetch_all(pool)
                    .await
            }
        }
        .map_err(banto_storage::storage_error)?;
        self.finish(rows).await
    }

    async fn version(
        &self,
        project_id: i64,
        version_id: i64,
    ) -> Result<PipelineVersion, BantoError> {
        let sql = format!(
            "{VERSION_SELECT} WHERE v.project_id = {} AND v.id = {}",
            self.ph(1),
            self.ph(2)
        );
        let row: Option<PipelineVersion> = match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(project_id)
                    .bind(version_id)
                    .fetch_optional(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(project_id)
                    .bind(version_id)
                    .fetch_optional(pool)
                    .await
            }
        }
        .map_err(banto_storage::storage_error)?;
        let row = row.ok_or_else(|| BantoError::NotFound {
            resource: "pipeline_versions".into(),
            id: version_id.to_string(),
        })?;
        Ok(self.finish(vec![row]).await?.remove(0))
    }

    /// Save a new version (draft, or adopted when `input.adopt`). The version
    /// number is the project's next one; earlier versions are kept as they
    /// were (T29).
    pub async fn create_version(
        &self,
        project_id: i64,
        input: PipelineVersionInput,
        actor_user_id: Option<i64>,
    ) -> Result<PipelineVersion, BantoError> {
        let clean = validate(&input)?;
        self.pre_order_status(project_id).await?;
        let kind = if input.adopt { "adopted" } else { "draft" };
        let next_no = format!(
            "SELECT COALESCE(MAX(version_no), 0) + 1 FROM pipeline_versions WHERE project_id = {}",
            self.ph(1)
        );
        let now = now_expr(self.db.dialect());
        let insert = format!(
            "INSERT INTO pipeline_versions (project_id, version_no, kind, stage, expected_amount, \
             probability_pct, expected_order_month, expected_start_month, expected_end_month, \
             est_cost_at_order, basis, next_action, confirmed_on, created_by, adopted_by, adopted_at) \
             VALUES ({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}) RETURNING id",
            self.ph(1),
            self.ph(2),
            self.ph(3),
            self.ph(4),
            self.ph(5),
            self.ph(6),
            self.ph(7),
            self.ph(8),
            self.ph(9),
            self.ph(10),
            self.ph(11),
            self.ph(12),
            self.ph(13),
            self.ph(14),
            self.ph(15),
            if input.adopt { now } else { "NULL" }
        );
        let plan_insert = format!(
            "INSERT INTO pipeline_revenue_plan (pipeline_version_id, month, amount) VALUES ({}, {}, {})",
            self.ph(1),
            self.ph(2),
            self.ph(3)
        );
        let adopted_by = if input.adopt { actor_user_id } else { None };
        let probability = clean.probability_pct.map(i64::from);
        let id: i64 = match &self.db {
            Db::Sqlite(pool) => {
                let mut tx = pool.begin().await.map_err(banto_storage::storage_error)?;
                let version_no: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(next_no))
                    .bind(project_id)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
                let id: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(insert))
                    .bind(project_id)
                    .bind(version_no)
                    .bind(kind)
                    .bind(clean.stage.as_str())
                    .bind(clean.expected_amount)
                    .bind(probability)
                    .bind(&clean.expected_order_month)
                    .bind(&clean.expected_start_month)
                    .bind(&clean.expected_end_month)
                    .bind(clean.est_cost_at_order)
                    .bind(&clean.basis)
                    .bind(&clean.next_action)
                    .bind(&clean.confirmed_on)
                    .bind(actor_user_id)
                    .bind(adopted_by)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
                for (month, amount) in &clean.plan {
                    sqlx::query(sqlx::AssertSqlSafe(plan_insert.clone()))
                        .bind(id)
                        .bind(month)
                        .bind(*amount)
                        .execute(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?;
                }
                tx.commit().await.map_err(banto_storage::storage_error)?;
                id
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                let mut tx = pool.begin().await.map_err(banto_storage::storage_error)?;
                // Serialize version numbering per project.
                sqlx::query("SELECT id FROM projects WHERE id = $1 FOR UPDATE")
                    .bind(project_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
                let version_no: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(next_no))
                    .bind(project_id)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
                let id: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(insert))
                    .bind(project_id)
                    .bind(version_no)
                    .bind(kind)
                    .bind(clean.stage.as_str())
                    .bind(clean.expected_amount)
                    .bind(probability)
                    .bind(&clean.expected_order_month)
                    .bind(&clean.expected_start_month)
                    .bind(&clean.expected_end_month)
                    .bind(clean.est_cost_at_order)
                    .bind(&clean.basis)
                    .bind(&clean.next_action)
                    .bind(&clean.confirmed_on)
                    .bind(actor_user_id)
                    .bind(adopted_by)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
                for (month, amount) in &clean.plan {
                    sqlx::query(sqlx::AssertSqlSafe(plan_insert.clone()))
                        .bind(id)
                        .bind(month)
                        .bind(*amount)
                        .execute(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?;
                }
                tx.commit().await.map_err(banto_storage::storage_error)?;
                id
            }
        };
        self.version(project_id, id).await
    }

    /// Adopt a draft as is. The draft must carry a basis (T29).
    pub async fn adopt(
        &self,
        project_id: i64,
        version_id: i64,
        actor_user_id: Option<i64>,
    ) -> Result<PipelineVersion, BantoError> {
        self.pre_order_status(project_id).await?;
        let current = self.version(project_id, version_id).await?;
        if current.kind != "draft" {
            return Err(BantoError::Validation {
                field_errors: vec![field_error("kind", "この版は既に採用されています")],
            });
        }
        if current.basis.is_none() {
            let mut errors = Vec::new();
            basis_required(&mut errors);
            return Err(BantoError::Validation {
                field_errors: errors,
            });
        }
        let sql = format!(
            "UPDATE pipeline_versions SET kind = 'adopted', adopted_by = {}, adopted_at = {} \
             WHERE id = {} AND project_id = {} AND kind = 'draft'",
            self.ph(1),
            now_expr(self.db.dialect()),
            self.ph(2),
            self.ph(3)
        );
        match &self.db {
            Db::Sqlite(pool) => sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(actor_user_id)
                .bind(version_id)
                .bind(project_id)
                .execute(pool)
                .await
                .map(|_| ()),
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(actor_user_id)
                .bind(version_id)
                .bind(project_id)
                .execute(pool)
                .await
                .map(|_| ()),
        }
        .map_err(banto_storage::storage_error)?;
        self.version(project_id, version_id).await
    }

    /// The overview of pre-order projects in `scope` (pass
    /// `authz::amount_projects`: the overview shows amounts).
    pub async fn overview(&self, scope: &ProjectScope) -> Result<PipelineOverview, BantoError> {
        let ids: Option<Vec<i64>> = match scope {
            ProjectScope::All => None,
            ProjectScope::Only(ids) => Some(ids.iter().copied().collect()),
        };
        if ids.as_ref().is_some_and(Vec::is_empty) {
            return Ok(build_overview(Vec::new(), Vec::new()));
        }
        // `AND <column> IN ($1, ...)` for a scoped caller, nothing for `All`.
        let filter = |column: &str| match &ids {
            None => String::new(),
            Some(ids) => format!(
                " AND {column} IN ({})",
                self.db.dialect().placeholders(ids.len())
            ),
        };
        let projects_sql = format!(
            "SELECT p.id, p.code, p.name, c.name, p.status FROM projects p \
             JOIN customers c ON c.id = p.customer_id WHERE 1 = 1{} ORDER BY p.code",
            filter("p.id")
        );
        let versions_sql = format!(
            "{VERSION_SELECT} WHERE v.kind = 'adopted'{} ORDER BY v.project_id, v.version_no",
            filter("v.project_id")
        );
        type ProjectRow = (i64, String, String, String, String);
        let (projects, versions): (Vec<ProjectRow>, Vec<PipelineVersion>) = match &self.db {
            Db::Sqlite(pool) => {
                let mut pq = sqlx::query_as(sqlx::AssertSqlSafe(projects_sql));
                let mut vq = sqlx::query_as(sqlx::AssertSqlSafe(versions_sql));
                for id in ids.iter().flatten() {
                    pq = pq.bind(*id);
                    vq = vq.bind(*id);
                }
                (
                    pq.fetch_all(pool)
                        .await
                        .map_err(banto_storage::storage_error)?,
                    vq.fetch_all(pool)
                        .await
                        .map_err(banto_storage::storage_error)?,
                )
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                let mut pq = sqlx::query_as(sqlx::AssertSqlSafe(projects_sql));
                let mut vq = sqlx::query_as(sqlx::AssertSqlSafe(versions_sql));
                for id in ids.iter().flatten() {
                    pq = pq.bind(*id);
                    vq = vq.bind(*id);
                }
                (
                    pq.fetch_all(pool)
                        .await
                        .map_err(banto_storage::storage_error)?,
                    vq.fetch_all(pool)
                        .await
                        .map_err(banto_storage::storage_error)?,
                )
            }
        };
        let versions = self.finish(versions).await?;
        Ok(build_overview(projects, versions))
    }
}

fn build_overview(
    projects: Vec<(i64, String, String, String, String)>,
    versions: Vec<PipelineVersion>,
) -> PipelineOverview {
    let mut by_project: BTreeMap<i64, Vec<PipelineVersion>> = BTreeMap::new();
    for v in versions {
        by_project.entry(v.project_id).or_default().push(v);
    }
    let mut rows = Vec::new();
    let mut entries = Vec::new();
    let mut without_adopted_version = Vec::new();
    for (project_id, code, name, customer_name, status) in projects {
        let Some(project_status) = ProjectStatus::parse(&status) else {
            continue;
        };
        // Ordered projects belong to ordered revenue (P3b), not the pipeline.
        if project_status.is_ordered() {
            continue;
        }
        let mut row = OverviewRow {
            project_id,
            code,
            name,
            customer_name,
            status,
            stage: None,
            version_no: None,
            expected_amount: None,
            probability_pct: None,
            weighted_amount: None,
            expected_order_month: None,
            confirmed_on: None,
            undated_amount: None,
            issues: Vec::new(),
        };
        let versions = by_project.remove(&project_id).unwrap_or_default();
        let refs: Vec<VersionRef> = versions
            .iter()
            .map(|v| VersionRef {
                version_no: v.version_no as u32,
                kind: if v.kind == "adopted" {
                    VersionKind::Adopted
                } else {
                    VersionKind::Draft
                },
            })
            .collect();
        let current = current_adopted(&refs).and_then(|r| {
            versions
                .iter()
                .find(|v| v.version_no as u32 == r.version_no)
        });
        match current {
            None => {
                row.issues.push("no_adopted_version".to_string());
                without_adopted_version.push(project_id);
            }
            Some(v) => {
                let version_stage = Stage::parse_version_stage(&v.stage).unwrap_or(Stage::Lead);
                let stage = project_status.pipeline_stage(version_stage);
                let entry = entry_of(project_id, stage, v);
                row.stage = Some(stage.as_str().to_string());
                row.version_no = Some(v.version_no);
                row.expected_amount = v.expected_amount;
                row.probability_pct = v.probability_pct;
                row.weighted_amount = entry.weighted_amount();
                row.expected_order_month = v.expected_order_month.clone();
                row.confirmed_on = v.confirmed_on.clone();
                let undated: i64 = v
                    .revenue_plan
                    .iter()
                    .filter(|l| l.month.is_none())
                    .map(|l| l.amount)
                    .sum();
                row.undated_amount = v
                    .revenue_plan
                    .iter()
                    .any(|l| l.month.is_none())
                    .then_some(undated);
                row.issues = v.issues.clone();
                entries.push(entry);
            }
        }
        rows.push(row);
    }
    let ids =
        |list: Vec<String>| -> Vec<i64> { list.iter().filter_map(|s| s.parse().ok()).collect() };
    let t = totals(&entries);
    let by_order = by_order_month(&entries)
        .into_iter()
        .map(|(month, cell)| OrderMonthRow {
            month: month.map(|m| m.to_string()),
            total: cell.total,
            weighted: cell.weighted,
        })
        .collect();
    // 未受注の売上見込: the outlook with no recognized or ordered revenue.
    let outlook = monthly_outlook(&[], &[], &entries);
    let by_revenue = outlook
        .cells
        .iter()
        .filter(|(_, cell)| cell.weighted_pipeline != 0)
        .map(|(key, cell)| RevenueMonthRow {
            month: match key {
                OutlookKey::Month(m) => Some(m.to_string()),
                OutlookKey::Undated => None,
            },
            weighted: cell.weighted_pipeline,
        })
        .collect();
    PipelineOverview {
        rows,
        totals: OverviewTotals {
            active_count: t.active_count,
            total: t.total,
            weighted: t.weighted,
            missing_amount: ids(t.missing_amount),
            missing_probability: ids(t.missing_probability),
            excluded_count: t.excluded_count,
            without_adopted_version,
        },
        by_order_month: by_order,
        by_revenue_month: by_revenue,
        revenue_excluded: ids(outlook.excluded),
        entries,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projects::tests::{fixture, input as project_input};
    use crate::projects::{ProjectInput, ProjectsService};

    fn version(stage: &str, amount: Option<i64>, prob: Option<i64>) -> PipelineVersionInput {
        PipelineVersionInput {
            stage: stage.into(),
            expected_amount: amount,
            probability_pct: prob,
            expected_order_month: Some("2026-11".into()),
            expected_start_month: None,
            expected_end_month: None,
            est_cost_at_order: None,
            basis: Some("見積提出済み".into()),
            next_action: None,
            confirmed_on: Some("2026-11-02".into()),
            revenue_plan: amount
                .map(|a| {
                    vec![PlanLine {
                        month: Some("2026-12".into()),
                        amount: a,
                    }]
                })
                .unwrap_or_default(),
            adopt: true,
        }
    }

    async fn project(db: &Db, code: &str) -> i64 {
        ProjectsService::new(db.clone())
            .create(project_input(code), None)
            .await
            .unwrap()
            .id
    }

    #[tokio::test]
    async fn t21_overview_of_3000000_at_60_percent() {
        let db = fixture().await;
        let a = project(&db, "P-001").await;
        let svc = PipelineService::new(db);
        svc.create_version(
            a,
            version("negotiating", Some(3_000_000), Some(60)),
            Some(2),
        )
        .await
        .unwrap();
        let o = svc.overview(&ProjectScope::All).await.unwrap();
        assert_eq!((o.totals.total, o.totals.weighted), (3_000_000, 1_800_000));
        assert_eq!(o.rows[0].weighted_amount, Some(1_800_000));
        assert!(o.rows[0].issues.is_empty());
        assert_eq!(
            o.by_order_month,
            vec![OrderMonthRow {
                month: Some("2026-11".into()),
                total: 3_000_000,
                weighted: 1_800_000
            }]
        );
        assert_eq!(
            o.by_revenue_month,
            vec![RevenueMonthRow {
                month: Some("2026-12".into()),
                weighted: 1_800_000
            }]
        );
    }

    #[tokio::test]
    async fn t22_only_the_latest_adopted_version_counts() {
        let db = fixture().await;
        let a = project(&db, "P-001").await;
        let svc = PipelineService::new(db);
        svc.create_version(a, version("quoting", Some(2_000_000), Some(30)), Some(2))
            .await
            .unwrap();
        svc.create_version(
            a,
            version("negotiating", Some(2_500_000), Some(50)),
            Some(2),
        )
        .await
        .unwrap();
        // An alternative still in draft does not replace the adopted one.
        let mut alt = version("negotiating", Some(9_000_000), Some(90));
        alt.adopt = false;
        let draft = svc.create_version(a, alt, Some(2)).await.unwrap();
        assert_eq!(draft.version_no, 3);
        assert_eq!(draft.kind, "draft");
        let o = svc.overview(&ProjectScope::All).await.unwrap();
        assert_eq!(o.rows[0].version_no, Some(2));
        assert_eq!(o.totals.total, 2_500_000);
        // Adopting the draft makes it the current version; older ones stay.
        svc.adopt(a, draft.id, Some(2)).await.unwrap();
        let o = svc.overview(&ProjectScope::All).await.unwrap();
        assert_eq!(o.rows[0].version_no, Some(3));
        let all = svc.versions(a).await.unwrap();
        assert_eq!(
            all.iter().map(|v| v.version_no).collect::<Vec<_>>(),
            vec![3, 2, 1]
        );
        assert_eq!(
            all[2].expected_amount,
            Some(2_000_000),
            "old versions are kept as they were"
        );
        assert_eq!(all[0].adopted_by_name.as_deref(), Some("案件責任者A"));
    }

    #[tokio::test]
    async fn t25_unset_values_stay_visible_and_out_of_the_weighted_figures() {
        let db = fixture().await;
        let a = project(&db, "P-001").await;
        let b = project(&db, "P-002").await;
        let c = project(&db, "P-003").await;
        let svc = PipelineService::new(db.clone());
        let mut no_prob = version("quoting", Some(1_000_000), None);
        no_prob.expected_order_month = None;
        no_prob.revenue_plan = vec![
            PlanLine {
                month: Some("2027-01".into()),
                amount: 400_000,
            },
            PlanLine {
                month: None,
                amount: 500_000,
            },
        ];
        svc.create_version(a, no_prob, Some(2)).await.unwrap();
        svc.create_version(b, version("lead", None, Some(10)), Some(2))
            .await
            .unwrap();
        let o = svc.overview(&ProjectScope::All).await.unwrap();
        let row_a = o.rows.iter().find(|r| r.project_id == a).unwrap();
        assert_eq!(
            row_a.issues,
            vec![
                "probability_missing",
                "order_month_missing",
                "plan_mismatch"
            ]
        );
        assert_eq!(row_a.undated_amount, Some(500_000));
        assert_eq!(row_a.weighted_amount, None, "unset probability is not 0%");
        let row_b = o.rows.iter().find(|r| r.project_id == b).unwrap();
        assert_eq!(row_b.issues, vec!["amount_missing", "plan_missing"]);
        let row_c = o.rows.iter().find(|r| r.project_id == c).unwrap();
        assert_eq!(row_c.issues, vec!["no_adopted_version"]);
        assert_eq!(o.totals.total, 1_000_000);
        assert_eq!(o.totals.weighted, 0);
        assert_eq!(o.totals.missing_probability, vec![a]);
        assert_eq!(o.totals.missing_amount, vec![b]);
        assert_eq!(o.totals.without_adopted_version, vec![c]);
        assert_eq!(
            o.by_order_month,
            vec![OrderMonthRow {
                month: None,
                total: 1_000_000,
                weighted: 0
            }]
        );
        assert!(o.by_revenue_month.is_empty());
        assert_eq!(o.revenue_excluded, vec![a, b]);
    }

    #[tokio::test]
    async fn t24_lost_and_on_hold_projects_leave_the_aggregate_but_keep_history() {
        let db = fixture().await;
        let a = project(&db, "P-001").await;
        let svc = PipelineService::new(db.clone());
        svc.create_version(
            a,
            version("negotiating", Some(3_000_000), Some(60)),
            Some(2),
        )
        .await
        .unwrap();
        let projects = ProjectsService::new(db.clone());
        let p = projects.get(a).await.unwrap();
        let mut lost: ProjectInput = project_input("P-001");
        lost.status = "lost".into();
        lost.row_version = Some(p.row_version);
        projects.update(a, lost).await.unwrap();
        let o = svc.overview(&ProjectScope::All).await.unwrap();
        assert_eq!(o.rows[0].stage.as_deref(), Some("lost"));
        assert_eq!(o.totals.total, 0);
        assert_eq!(o.totals.excluded_count, 1);
        assert_eq!(svc.versions(a).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn t12_overview_scope_and_validation() {
        let db = fixture().await;
        let a = project(&db, "P-001").await;
        let b = project(&db, "P-002").await;
        let svc = PipelineService::new(db);
        svc.create_version(a, version("quoting", Some(1), Some(1)), None)
            .await
            .unwrap();
        svc.create_version(b, version("quoting", Some(2), Some(1)), None)
            .await
            .unwrap();
        let o = svc
            .overview(&ProjectScope::Only(BTreeSet::from([b])))
            .await
            .unwrap();
        assert_eq!(o.rows.len(), 1);
        assert_eq!(o.rows[0].project_id, b);
        let empty = svc
            .overview(&ProjectScope::Only(BTreeSet::new()))
            .await
            .unwrap();
        assert!(empty.rows.is_empty());

        let mut bad = version("ordered", Some(-1), Some(100));
        bad.basis = None;
        bad.expected_order_month = Some("2026/11".into());
        bad.revenue_plan = vec![
            PlanLine {
                month: Some("2026-12".into()),
                amount: 1,
            },
            PlanLine {
                month: Some("2026-12".into()),
                amount: 1,
            },
        ];
        let BantoError::Validation { field_errors } =
            svc.create_version(a, bad, None).await.unwrap_err()
        else {
            panic!("validation expected");
        };
        let fields: Vec<_> = field_errors.iter().map(|e| e.field.as_str()).collect();
        assert_eq!(
            fields,
            vec![
                "stage",
                "expectedAmount",
                "probabilityPct",
                "expectedOrderMonth",
                "basis",
                "revenuePlan"
            ]
        );

        // A draft without a basis cannot be adopted (T29).
        let mut draft = version("lead", None, None);
        draft.adopt = false;
        draft.basis = None;
        let d = svc.create_version(a, draft, None).await.unwrap();
        assert!(matches!(
            svc.adopt(a, d.id, None).await,
            Err(BantoError::Validation { .. })
        ));
        // A version of another project is not reachable through this one.
        assert!(matches!(
            svc.adopt(b, d.id, None).await,
            Err(BantoError::NotFound { .. })
        ));
    }
}
