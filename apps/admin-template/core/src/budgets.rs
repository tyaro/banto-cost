//! Budget versions (予算版, banto-cost P4c, `docs/project/design.md` §3.3,
//! spec §5.3, T09).
//!
//! Service-layer shape (conventions §2): `Clone`, `BantoError`, sqlx, no
//! tauri/axum. The rules live in `cost_domain::budget` (line checks, labor
//! pricing, the approval check, the comparison); this module loads and stores
//! rows. Authorization (`ViewProjectAmounts`, `ManageProject`,
//! `ApproveBudget`, ADR-0028) and audit are the REST/Tauri wiring's.
//!
//! Workflow: a project has at most one draft. A draft starts as a copy of the
//! current approved budget and is edited freely by its manager. Approving it
//! gives it the next version number (1 = 当初予算) and fixes, per labor line,
//! the `budget_rate` calc-basis row in effect on the draft's `created_on`,
//! the rate and the amount; the version is never rewritten afterwards. A
//! change (version 2 on) needs its reason (T09). A calc-basis change later
//! leaves approved versions alone and only reprices drafts (design §10.5).
//!
//! Concurrency (T13): every write to a draft compares `row_version`; a second
//! "create draft" returns the existing draft (one-draft index), so a retried
//! send never makes two. On Postgres the approval locks the project row so
//! the version number is taken once.

use std::collections::BTreeMap;

use banto_core::{BantoError, FieldError};
use banto_server::ServerEvent;
use banto_storage::{Db, Dialect};
use cost_domain::budget::{
    check_approval, compare, next_version, price, total, validate_lines, ApprovalIssue, LineInput,
    LineIssue, LineKey, PricedLine, RATE_ITEM,
};
use cost_domain::calc_basis::{self, CalcValue, Usage, UsageStatus};
use cost_domain::forecast::CostType;
use cost_domain::project::ProjectStatus;
use cost_domain::Date;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::calc_basis::{domain_row, CalcBasisService};
use crate::customers::{clean_optional, field_error, now_expr, stale_version_error};
use crate::orders::{
    execute, fetch_all, fetch_optional, in_tx, on_pool, placeholders, scalar, MAX_TEXT_LEN,
};
use crate::time_entries::row_of;
use crate::work_masters::{MasterKind, WorkMastersService};

pub const RESOURCE: &str = "budgets";
/// Cost types whose actuals are summed today: labor from approved hours
/// (P4b). Direct costs arrive with P4d.
const TRACKED: [CostType; 1] = [CostType::Labor];

/// One line of a budget version.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetLine {
    pub phase_id: Option<i64>,
    pub phase_name: Option<String>,
    /// `labor` | `material` | `outsource` | `travel` | `other`.
    pub cost_type: String,
    pub planned_minutes: Option<i64>,
    /// The budget rate (labor). Fixed on an approved version; on a draft the
    /// rate that applies now (`None` = 未設定).
    pub budget_rate: Option<i64>,
    /// `None` = labor without a rate (未確定, never 0 yen).
    pub amount: Option<i64>,
}

/// One budget version (draft or approved).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetVersion {
    pub id: i64,
    pub project_id: i64,
    /// `None` while a draft.
    pub version_no: Option<i64>,
    /// `draft` | `approved`.
    pub status: String,
    pub reason: Option<String>,
    /// The date the budget rate is resolved for (予算版の作成日).
    pub created_on: String,
    pub created_by_name: Option<String>,
    /// Who last saved the draft: the requester of its approval.
    pub updated_by: Option<i64>,
    pub updated_by_name: Option<String>,
    pub approved_by_name: Option<String>,
    pub approved_at: Option<String>,
    /// Cost budget total; `None` while a labor line has no rate.
    pub total: Option<i64>,
    /// A labor line has no budget rate (draft only).
    pub rate_missing: bool,
    pub lines: Vec<BudgetLine>,
    pub row_version: i64,
    pub updated_at: String,
}

impl BudgetVersion {
    /// What both wiring layers record: no amounts (the audit log is read by
    /// the system administrator, who does not see amounts by default).
    pub fn audit_detail(&self) -> serde_json::Value {
        serde_json::json!({
            "projectId": self.project_id,
            "versionNo": self.version_no,
            "status": self.status,
            "lines": self.lines.len(),
        })
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetLineInput {
    #[serde(default)]
    pub phase_id: Option<i64>,
    pub cost_type: String,
    #[serde(default)]
    pub planned_minutes: Option<i64>,
    #[serde(default)]
    pub amount: Option<i64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetDraftInput {
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub lines: Vec<BudgetLineInput>,
    pub row_version: i64,
}

/// `rowVersion` for delete / approve.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetVersionInput {
    pub row_version: i64,
}

/// A created draft; `replayed` = the project already had one.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftCreated {
    pub draft: BudgetVersion,
    pub replayed: bool,
}

/// One comparison row (phase × cost type).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonRow {
    pub phase_id: Option<i64>,
    pub phase_name: Option<String>,
    pub cost_type: String,
    pub original: Option<i64>,
    pub current: Option<i64>,
    /// `None` = not summed yet for this cost type (直接費は P4d).
    pub actual: Option<i64>,
    /// actual − current; plus = over budget.
    pub variance: Option<i64>,
}

/// Per cost type totals of the comparison.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostTypeTotal {
    pub cost_type: String,
    pub original: Option<i64>,
    pub current: Option<i64>,
    pub actual: Option<i64>,
    pub variance: Option<i64>,
}

/// 案件詳細 → 予算. Amounts: `ViewProjectAmounts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetOverview {
    pub project_id: i64,
    pub project_status: String,
    /// Version 1.
    pub original: Option<BudgetVersion>,
    /// The highest approved version (the comparison's target, T09).
    pub current: Option<BudgetVersion>,
    /// Every approved version, newest first.
    pub history: Vec<BudgetVersion>,
    pub draft: Option<BudgetVersion>,
    pub comparison: Vec<ComparisonRow>,
    pub totals: Vec<CostTypeTotal>,
    /// The labor actuals are final: no approved hour without a rate and no
    /// hour waiting for approval (otherwise 暫定・不足あり, T04).
    pub labor_actual_complete: bool,
}

#[derive(sqlx::FromRow)]
struct VersionRow {
    id: i64,
    project_id: i64,
    version_no: Option<i64>,
    status: String,
    reason: Option<String>,
    created_on: String,
    created_by_name: Option<String>,
    updated_by: Option<i64>,
    updated_by_name: Option<String>,
    approved_by_name: Option<String>,
    approved_at: Option<String>,
    total_amount: Option<i64>,
    row_version: i64,
    updated_at: String,
}

#[derive(sqlx::FromRow)]
struct LineRow {
    budget_version_id: i64,
    phase_id: Option<i64>,
    phase_name: Option<String>,
    cost_type: String,
    planned_minutes: Option<i64>,
    amount: Option<i64>,
    budget_rate: Option<i64>,
}

const SELECT: &str = "SELECT b.id, b.project_id, b.version_no, b.status, b.reason, b.created_on, \
     c.display_name AS created_by_name, b.updated_by, u.display_name AS updated_by_name, \
     a.display_name AS approved_by_name, b.approved_at, b.total_amount, b.row_version, \
     b.updated_at FROM budget_versions b \
     LEFT JOIN users c ON c.id = b.created_by \
     LEFT JOIN users u ON u.id = b.updated_by \
     LEFT JOIN users a ON a.id = b.approved_by";

fn not_found(id: i64) -> BantoError {
    BantoError::NotFound {
        resource: RESOURCE.into(),
        id: id.to_string(),
    }
}

fn validation(errors: Vec<FieldError>) -> Result<(), BantoError> {
    if errors.is_empty() {
        Ok(())
    } else {
        Err(BantoError::Validation {
            field_errors: errors,
        })
    }
}

fn line_error(issue: &LineIssue) -> FieldError {
    let at = |index: &usize, field: &str| format!("lines.{index}.{field}");
    match issue {
        LineIssue::TooMany => field_error(
            "lines",
            format!(
                "明細は{}行までにしてください",
                cost_domain::budget::MAX_LINES
            ),
        ),
        LineIssue::MinutesRequired { index } => field_error(
            &at(index, "plannedMinutes"),
            "労務費は0分より長い予定工数を入力してください",
        ),
        LineIssue::LaborWithAmount { index } => field_error(
            &at(index, "amount"),
            "労務費は予定工数と予算用単価から計算します。金額は入れません",
        ),
        LineIssue::AmountRequired { index } => {
            field_error(&at(index, "amount"), "予定金額を入力してください")
        }
        LineIssue::AmountNegative { index } => {
            field_error(&at(index, "amount"), "0円以上で入力してください")
        }
        LineIssue::MinutesOnNonLabor { index } => field_error(
            &at(index, "plannedMinutes"),
            "工数は労務費の明細だけに入れます",
        ),
        LineIssue::Duplicate { index } => field_error(
            &at(index, "costType"),
            "同じ工程・費目の明細がすでにあります",
        ),
    }
}

fn approval_error(issue: &ApprovalIssue) -> FieldError {
    match issue {
        ApprovalIssue::NoLines => field_error("lines", "明細を1行以上入力してください"),
        ApprovalIssue::RateMissing => field_error(
            "lines",
            "予算用単価が未設定のため労務費を計算できません。計算基準で予算用単価を設定してください",
        ),
        ApprovalIssue::ReasonRequired => {
            field_error("reason", "変更予算には変更理由を入力してください")
        }
        ApprovalIssue::ProjectNotOrdered => field_error(
            "status",
            "受注・進行中・作業完了の案件だけ予算を承認できます",
        ),
    }
}

fn status_error(message: &str) -> BantoError {
    BantoError::Validation {
        field_errors: vec![field_error("status", message)],
    }
}

fn domain_line(l: &BudgetLine) -> Option<LineInput> {
    let cost_type = CostType::parse(&l.cost_type)?;
    Some(LineInput {
        key: LineKey {
            phase: l.phase_id,
            cost_type,
        },
        minutes: l.planned_minutes,
        amount: if cost_type == CostType::Labor {
            None
        } else {
            l.amount
        },
    })
}

#[derive(Clone)]
pub struct BudgetsService {
    db: Db,
    events: Option<broadcast::Sender<ServerEvent>>,
}

impl BudgetsService {
    pub fn new(db: Db) -> Self {
        Self { db, events: None }
    }

    /// Emit `ResourceChanged { resource: "budgets" }` after each committed write.
    pub fn with_events(mut self, events: broadcast::Sender<ServerEvent>) -> Self {
        self.events = Some(events);
        self
    }

    fn notify_changed(&self) {
        crate::events::notify_changed(&self.events, RESOURCE);
    }

    fn sql(&self, s: &str) -> String {
        placeholders(self.db.dialect(), s)
    }

    fn now(&self) -> &'static str {
        now_expr(self.db.dialect())
    }

    fn today(&self) -> &'static str {
        match self.db.dialect() {
            Dialect::Sqlite => "date('now','localtime')",
            Dialect::Postgres => "CURRENT_DATE::text",
        }
    }

    /// The project's status, or not found.
    async fn project_status(&self, project_id: i64) -> Result<ProjectStatus, BantoError> {
        let sql = self.sql("SELECT status FROM projects WHERE id = ?");
        let row: Option<(String,)> =
            on_pool!(&self.db, pool => fetch_optional!(pool, sql, project_id))?;
        let (status,) = row.ok_or_else(|| BantoError::NotFound {
            resource: "projects".into(),
            id: project_id.to_string(),
        })?;
        ProjectStatus::parse(&status)
            .ok_or_else(|| BantoError::Other(format!("不明な案件の状態です: {status}")))
    }

    /// Drafts can be made and edited unless the project is closed.
    async fn require_open(&self, project_id: i64) -> Result<(), BantoError> {
        match self.project_status(project_id).await? {
            ProjectStatus::Settled | ProjectStatus::Lost | ProjectStatus::Cancelled => Err(
                status_error("精算完了・失注・中止の案件の予算は変更できません"),
            ),
            _ => Ok(()),
        }
    }

    async fn lines_of(&self, ids: &[i64]) -> Result<BTreeMap<i64, Vec<LineRow>>, BantoError> {
        let mut out: BTreeMap<i64, Vec<LineRow>> = BTreeMap::new();
        if ids.is_empty() {
            return Ok(out);
        }
        let marks = vec!["?"; ids.len()].join(",");
        let sql = self.sql(&format!(
            "SELECT l.budget_version_id, l.phase_id, ph.name AS phase_name, l.cost_type, \
             l.planned_minutes, l.amount, l.budget_rate FROM budget_lines l \
             LEFT JOIN phases ph ON ph.id = l.phase_id \
             WHERE l.budget_version_id IN ({marks}) ORDER BY l.budget_version_id, l.line_no"
        ));
        let rows: Vec<LineRow> = match &self.db {
            Db::Sqlite(pool) => {
                let mut q = sqlx::query_as(sqlx::AssertSqlSafe(sql.as_str()));
                for id in ids {
                    q = q.bind(*id);
                }
                q.fetch_all(pool)
                    .await
                    .map_err(banto_storage::storage_error)?
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                let mut q = sqlx::query_as(sqlx::AssertSqlSafe(sql.as_str()));
                for id in ids {
                    q = q.bind(*id);
                }
                q.fetch_all(pool)
                    .await
                    .map_err(banto_storage::storage_error)?
            }
        };
        for r in rows {
            out.entry(r.budget_version_id).or_default().push(r);
        }
        Ok(out)
    }

    /// The budget rate on `on` for the project (value and calc_values row).
    async fn rate(
        &self,
        project_id: i64,
        on: &str,
    ) -> Result<Option<(i64, Option<i64>)>, BantoError> {
        let Some(on) = Date::parse(on) else {
            return Ok(None);
        };
        let rows = CalcBasisService::new(self.db.clone())
            .value_rows(RATE_ITEM)
            .await?;
        let values: Vec<CalcValue> = rows.iter().filter_map(domain_row).collect();
        let pid = project_id.to_string();
        Ok(
            calc_basis::resolve(&values, RATE_ITEM, Some(&pid), on, None).map(|r| {
                let row = row_of(&rows, &r.source, Some(project_id));
                (r.value, row)
            }),
        )
    }

    /// Build the views; a draft's labor lines are priced with today's rate
    /// for its `created_on` (approved versions keep what was fixed).
    async fn views(&self, rows: Vec<VersionRow>) -> Result<Vec<BudgetVersion>, BantoError> {
        let ids: Vec<i64> = rows.iter().map(|r| r.id).collect();
        let mut lines = self.lines_of(&ids).await?;
        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            let mut ls: Vec<BudgetLine> = lines
                .remove(&r.id)
                .unwrap_or_default()
                .into_iter()
                .map(|l| BudgetLine {
                    phase_id: l.phase_id,
                    phase_name: l.phase_name,
                    cost_type: l.cost_type,
                    planned_minutes: l.planned_minutes,
                    budget_rate: l.budget_rate,
                    amount: l.amount,
                })
                .collect();
            let (total_amount, rate_missing) = if r.status == "draft" {
                let rate = self
                    .rate(r.project_id, &r.created_on)
                    .await?
                    .map(|(v, _)| v);
                let inputs: Vec<LineInput> = ls.iter().filter_map(domain_line).collect();
                let priced = price(&inputs, rate);
                for (view, p) in ls.iter_mut().zip(priced.iter()) {
                    view.budget_rate = p.rate;
                    view.amount = p.amount;
                }
                (total(&priced), priced.iter().any(|p| p.amount.is_none()))
            } else {
                (r.total_amount, false)
            };
            out.push(BudgetVersion {
                id: r.id,
                project_id: r.project_id,
                version_no: r.version_no,
                status: r.status,
                reason: r.reason,
                created_on: r.created_on,
                created_by_name: r.created_by_name,
                updated_by: r.updated_by,
                updated_by_name: r.updated_by_name,
                approved_by_name: r.approved_by_name,
                approved_at: r.approved_at,
                total: total_amount,
                rate_missing,
                lines: ls,
                row_version: r.row_version,
                updated_at: r.updated_at,
            });
        }
        Ok(out)
    }

    /// One version (any status). The wiring authorizes against its project.
    pub async fn get(&self, id: i64) -> Result<BudgetVersion, BantoError> {
        let sql = self.sql(&format!("{SELECT} WHERE b.id = ?"));
        let row: Option<VersionRow> = on_pool!(&self.db, pool => fetch_optional!(pool, sql, id))?;
        let row = row.ok_or_else(|| not_found(id))?;
        Ok(self.views(vec![row]).await?.remove(0))
    }

    async fn draft_id(&self, project_id: i64) -> Result<Option<i64>, BantoError> {
        let sql =
            self.sql("SELECT id FROM budget_versions WHERE project_id = ? AND status = 'draft'");
        let row: Option<(i64,)> =
            on_pool!(&self.db, pool => fetch_optional!(pool, sql, project_id))?;
        Ok(row.map(|(id,)| id))
    }

    /// Start a draft as a copy of the current approved budget, or return the
    /// draft the project already has (`replayed`).
    pub async fn create_draft(
        &self,
        project_id: i64,
        actor_user_id: Option<i64>,
    ) -> Result<DraftCreated, BantoError> {
        self.require_open(project_id).await?;
        if let Some(id) = self.draft_id(project_id).await? {
            return Ok(DraftCreated {
                draft: self.get(id).await?,
                replayed: true,
            });
        }
        let insert = self.sql(&format!(
            "INSERT INTO budget_versions (project_id, status, created_on, created_by, updated_by) \
             VALUES (?, 'draft', {}, ?, ?) RETURNING id",
            self.today()
        ));
        let current = self.sql(
            "SELECT id FROM budget_versions WHERE project_id = ? AND status = 'approved' \
             ORDER BY version_no DESC LIMIT 1",
        );
        let copy = self.sql(
            "INSERT INTO budget_lines (budget_version_id, line_no, phase_id, cost_type, \
             planned_minutes, amount) \
             SELECT ?, line_no, phase_id, cost_type, planned_minutes, \
             CASE WHEN cost_type = 'labor' THEN NULL ELSE amount END \
             FROM budget_lines WHERE budget_version_id = ?",
        );
        let result: Result<i64, BantoError> = async {
            Ok(in_tx!(&self.db, tx => {
                let id: i64 = scalar!(&mut *tx, insert, project_id, actor_user_id, actor_user_id)?;
                let base: Option<(i64,)> = fetch_optional!(&mut *tx, current, project_id)?;
                if let Some((base,)) = base {
                    execute!(&mut *tx, copy, id, base)?;
                }
                id
            }))
        }
        .await;
        let id = match result {
            Ok(id) => id,
            // A concurrent create committed the project's one draft first.
            Err(BantoError::Storage(m)) if m.to_lowercase().contains("unique") => {
                if let Some(id) = self.draft_id(project_id).await? {
                    return Ok(DraftCreated {
                        draft: self.get(id).await?,
                        replayed: true,
                    });
                }
                return Err(BantoError::Storage(m));
            }
            Err(e) => return Err(e),
        };
        self.notify_changed();
        Ok(DraftCreated {
            draft: self.get(id).await?,
            replayed: false,
        })
    }

    /// The draft with the version the caller read.
    async fn draft(&self, id: i64, row_version: i64) -> Result<BudgetVersion, BantoError> {
        let v = self.get(id).await?;
        if v.status != "draft" {
            return Err(status_error("承認済みの予算版は変更できません"));
        }
        if v.row_version != row_version {
            return Err(stale_version_error());
        }
        Ok(v)
    }

    /// Phases already on the draft or the current approved version stay
    /// usable after being discontinued; new ones must be active.
    async fn check_phases(
        &self,
        draft: &BudgetVersion,
        lines: &[LineInput],
    ) -> Result<(), BantoError> {
        let mut kept: Vec<i64> = draft.lines.iter().filter_map(|l| l.phase_id).collect();
        let current = self.sql(
            "SELECT l.phase_id FROM budget_lines l JOIN budget_versions b \
             ON b.id = l.budget_version_id WHERE b.project_id = ? AND b.status = 'approved' \
             AND l.phase_id IS NOT NULL",
        );
        let used: Vec<(i64,)> =
            on_pool!(&self.db, pool => fetch_all!(pool, current, draft.project_id))?;
        kept.extend(used.into_iter().map(|(p,)| p));
        let masters = WorkMastersService::new(self.db.clone());
        for (index, l) in lines.iter().enumerate() {
            if let Some(phase) = l.key.phase.filter(|p| !kept.contains(p)) {
                masters
                    .require_active(MasterKind::Phases, phase, &format!("lines.{index}.phaseId"))
                    .await?;
            }
        }
        Ok(())
    }

    /// Replace a draft's reason and lines.
    pub async fn update_draft(
        &self,
        id: i64,
        input: BudgetDraftInput,
        actor_user_id: Option<i64>,
    ) -> Result<BudgetVersion, BantoError> {
        let draft = self.draft(id, input.row_version).await?;
        self.require_open(draft.project_id).await?;
        let mut errors = Vec::new();
        let reason = clean_optional(&input.reason);
        if reason
            .as_deref()
            .is_some_and(|r| r.chars().count() > MAX_TEXT_LEN)
        {
            errors.push(field_error(
                "reason",
                format!("{MAX_TEXT_LEN}文字以内で入力してください"),
            ));
        }
        let mut lines = Vec::with_capacity(input.lines.len());
        for (index, l) in input.lines.iter().enumerate() {
            match CostType::parse(l.cost_type.trim()) {
                Some(cost_type) => lines.push(LineInput {
                    key: LineKey {
                        phase: l.phase_id,
                        cost_type,
                    },
                    minutes: l.planned_minutes,
                    amount: l.amount,
                }),
                None => errors.push(field_error(
                    &format!("lines.{index}.costType"),
                    "不明な費目です",
                )),
            }
        }
        validation(errors)?;
        validate_lines(&lines).map_err(|issues| BantoError::Validation {
            field_errors: issues.iter().map(line_error).collect(),
        })?;
        self.check_phases(&draft, &lines).await?;
        let update = self.sql(&format!(
            "UPDATE budget_versions SET reason = ?, updated_by = ?, \
             row_version = row_version + 1, updated_at = {} \
             WHERE id = ? AND row_version = ? AND status = 'draft'",
            self.now()
        ));
        let clear = self.sql("DELETE FROM budget_lines WHERE budget_version_id = ?");
        let insert = self.sql(
            "INSERT INTO budget_lines (budget_version_id, line_no, phase_id, cost_type, \
             planned_minutes, amount) VALUES (?, ?, ?, ?, ?, ?)",
        );
        let version = draft.row_version;
        in_tx!(&self.db, tx => {
            if execute!(&mut *tx, update, &reason, actor_user_id, id, version)? == 0 {
                return Err(stale_version_error());
            }
            execute!(&mut *tx, clear, id)?;
            for (n, l) in lines.iter().enumerate() {
                execute!(&mut *tx, insert, id, n as i64 + 1, l.key.phase,
                    l.key.cost_type.as_str(), l.minutes, l.amount)?;
            }
        });
        self.notify_changed();
        self.get(id).await
    }

    /// Discard a draft (approved versions are never deleted).
    pub async fn delete_draft(&self, id: i64, row_version: i64) -> Result<(), BantoError> {
        self.draft(id, row_version).await?;
        let lines = self.sql("DELETE FROM budget_lines WHERE budget_version_id = ?");
        let version = self.sql(
            "DELETE FROM budget_versions WHERE id = ? AND row_version = ? AND status = 'draft'",
        );
        in_tx!(&self.db, tx => {
            execute!(&mut *tx, lines, id)?;
            if execute!(&mut *tx, version, id, row_version)? == 0 {
                return Err(stale_version_error());
            }
        });
        self.notify_changed();
        Ok(())
    }

    /// Approve the draft `authorized` (the row the caller was authorized
    /// against): number it, fix the labor rate and amounts, and the total.
    /// A draft changed after authorization is refused as stale.
    pub async fn approve(
        &self,
        authorized: &BudgetVersion,
        row_version: i64,
        actor_user_id: Option<i64>,
    ) -> Result<BudgetVersion, BantoError> {
        if row_version != authorized.row_version {
            return Err(stale_version_error());
        }
        let draft = self.draft(authorized.id, row_version).await?;
        let status = self.project_status(draft.project_id).await?;
        let rate = self.rate(draft.project_id, &draft.created_on).await?;
        let inputs: Vec<LineInput> = draft.lines.iter().filter_map(domain_line).collect();
        let priced: Vec<PricedLine> = price(&inputs, rate.map(|(v, _)| v));
        let approved = self.sql(
            "SELECT version_no FROM budget_versions WHERE project_id = ? AND status = 'approved'",
        );
        let numbers: Vec<(i64,)> =
            on_pool!(&self.db, pool => fetch_all!(pool, approved, draft.project_id))?;
        let numbers: Vec<u32> = numbers
            .into_iter()
            .filter_map(|(n,)| u32::try_from(n).ok())
            .collect();
        let version = next_version(&numbers);
        check_approval(&priced, version, draft.reason.as_deref(), status).map_err(|issues| {
            BantoError::Validation {
                field_errors: issues.iter().map(approval_error).collect(),
            }
        })?;
        let sum = total(&priced).expect("checked: every line has an amount");
        let lock = match self.db.dialect() {
            Dialect::Postgres => Some(self.sql("SELECT id FROM projects WHERE id = ? FOR UPDATE")),
            Dialect::Sqlite => None,
        };
        let max = self.sql(
            "SELECT COALESCE(MAX(version_no), 0) FROM budget_versions \
             WHERE project_id = ? AND status = 'approved'",
        );
        let update = self.sql(&format!(
            "UPDATE budget_versions SET status = 'approved', version_no = ?, total_amount = ?, \
             approved_by = ?, approved_at = {now}, row_version = row_version + 1, \
             updated_at = {now} WHERE id = ? AND row_version = ? AND status = 'draft'",
            now = self.now()
        ));
        let fix = self.sql(
            "UPDATE budget_lines SET amount = ?, budget_rate = ?, applied_calc_value_id = ? \
             WHERE budget_version_id = ? AND cost_type = 'labor' AND COALESCE(phase_id, 0) = ?",
        );
        let (id, project_id) = (draft.id, draft.project_id);
        let value_id = rate.and_then(|(_, row)| row);
        in_tx!(&self.db, tx => {
            if let Some(lock) = &lock {
                let _: Vec<(i64,)> = fetch_all!(&mut *tx, lock, project_id)?;
            }
            let taken: i64 = scalar!(&mut *tx, max, project_id)?;
            if taken + 1 != i64::from(version) {
                return Err(stale_version_error());
            }
            if execute!(&mut *tx, update, i64::from(version), sum, actor_user_id, id,
                row_version)? == 0
            {
                return Err(stale_version_error());
            }
            for p in priced.iter().filter(|p| p.line.key.cost_type == CostType::Labor) {
                execute!(&mut *tx, fix, p.amount, p.rate, value_id, id,
                    p.line.key.phase.unwrap_or(0))?;
            }
        });
        self.notify_changed();
        self.get(id).await
    }

    /// Every version of the project, the comparison and the labor actuals.
    pub async fn overview(&self, project_id: i64) -> Result<BudgetOverview, BantoError> {
        let status = self.project_status(project_id).await?;
        let sql = self.sql(&format!(
            "{SELECT} WHERE b.project_id = ? ORDER BY b.status DESC, b.version_no DESC"
        ));
        let rows: Vec<VersionRow> = on_pool!(&self.db, pool => fetch_all!(pool, sql, project_id))?;
        let mut versions = self.views(rows).await?;
        let draft = versions
            .iter()
            .position(|v| v.status == "draft")
            .map(|i| versions.remove(i));
        let history = versions;
        let original = history.iter().find(|v| v.version_no == Some(1)).cloned();
        let current = history.first().cloned();

        // CAST: Postgres sums BIGINT to NUMERIC.
        let actual_sql = self.sql(
            "SELECT t.phase_id, CAST(COALESCE(SUM(t.labor_cost), 0) AS BIGINT), \
             CAST(SUM(CASE WHEN t.labor_cost IS NULL THEN 1 ELSE 0 END) AS BIGINT) \
             FROM time_entries t WHERE t.project_id = ? AND t.status = 'approved' \
             GROUP BY t.phase_id",
        );
        let actual_rows: Vec<(Option<i64>, i64, i64)> =
            on_pool!(&self.db, pool => fetch_all!(pool, actual_sql, project_id))?;
        let pending_sql = self
            .sql("SELECT COUNT(*) FROM time_entries WHERE project_id = ? AND status <> 'approved'");
        let pending: i64 = on_pool!(&self.db, pool => scalar!(pool, pending_sql, project_id))?;
        let missing: i64 = actual_rows.iter().map(|r| r.2).sum();
        let actual: Vec<(LineKey, i64)> = actual_rows
            .iter()
            .map(|(phase, cost, _)| {
                (
                    LineKey {
                        phase: *phase,
                        cost_type: CostType::Labor,
                    },
                    *cost,
                )
            })
            .collect();

        let keyed = |v: &BudgetVersion| -> Vec<(LineKey, i64)> {
            v.lines
                .iter()
                .filter_map(|l| {
                    Some((
                        LineKey {
                            phase: l.phase_id,
                            cost_type: CostType::parse(&l.cost_type)?,
                        },
                        l.amount?,
                    ))
                })
                .collect()
        };
        let original_lines = original.as_ref().map(keyed);
        let current_lines = current.as_ref().map(keyed);
        let rows = compare(
            original_lines.as_deref(),
            current_lines.as_deref(),
            &actual,
            &TRACKED,
        );

        let mut names: BTreeMap<i64, String> = BTreeMap::new();
        for v in history.iter().chain(draft.iter()) {
            for l in &v.lines {
                if let (Some(id), Some(name)) = (l.phase_id, &l.phase_name) {
                    names.insert(id, name.clone());
                }
            }
        }
        let missing_names: Vec<i64> = rows
            .iter()
            .filter_map(|r| r.key.phase)
            .filter(|p| !names.contains_key(p))
            .collect();
        if !missing_names.is_empty() {
            let phases = WorkMastersService::new(self.db.clone())
                .list(MasterKind::Phases)
                .await?;
            for p in phases {
                names.entry(p.id).or_insert(p.name);
            }
        }
        let comparison = rows
            .iter()
            .map(|r| ComparisonRow {
                phase_id: r.key.phase,
                phase_name: r.key.phase.and_then(|p| names.get(&p).cloned()),
                cost_type: r.key.cost_type.as_str().into(),
                original: r.original,
                current: r.current,
                actual: r.actual,
                variance: r.variance,
            })
            .collect();
        let sum_of = |lines: &Option<Vec<(LineKey, i64)>>, t: CostType| {
            lines.as_ref().map(|ls| {
                ls.iter()
                    .filter(|(k, _)| k.cost_type == t)
                    .map(|(_, v)| *v)
                    .sum::<i64>()
            })
        };
        let totals = CostType::ALL
            .into_iter()
            .map(|t| {
                let current_sum = sum_of(&current_lines, t);
                let actual_sum = TRACKED.contains(&t).then(|| {
                    actual
                        .iter()
                        .filter(|(k, _)| k.cost_type == t)
                        .map(|(_, v)| *v)
                        .sum::<i64>()
                });
                CostTypeTotal {
                    cost_type: t.as_str().into(),
                    original: sum_of(&original_lines, t),
                    current: current_sum,
                    actual: actual_sum,
                    variance: current_sum
                        .zip(actual_sum)
                        .map(|(c, a)| cost_domain::forecast::overrun(a, c)),
                }
            })
            .collect();
        Ok(BudgetOverview {
            project_id,
            project_status: status.as_str().into(),
            original,
            current,
            history,
            draft,
            comparison,
            totals,
            labor_actual_complete: missing == 0 && pending == 0,
        })
    }
}

/// Budget drafts as usages of `budget_rate`, for the calc-basis impact
/// preview (design §10.5): a draft is repriced on read, so it is pending.
/// Approved versions keep their rate and are not correction candidates
/// (次の予算案から使う), so they are not reported.
pub(crate) async fn usages(db: &Db, item_key: &str) -> Result<Vec<Usage>, BantoError> {
    if item_key != RATE_ITEM {
        return Ok(Vec::new());
    }
    let sql =
        "SELECT id, project_id, created_on FROM budget_versions WHERE status = 'draft'".to_string();
    let rows: Vec<(i64, i64, String)> = on_pool!(db, pool => fetch_all!(pool, sql))?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, project, on)| {
            Some(Usage {
                id: format!("budget-{id}"),
                item: RATE_ITEM.to_string(),
                project: Some(project.to_string()),
                on: Date::parse(&on)?,
                status: UsageStatus::Pending,
                closed: false,
                line_specific: None,
                applied_value: None,
            })
        })
        .collect())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::calc_basis::tests::value;
    use crate::projects::tests::{fixture, input as project_input};
    use crate::projects::ProjectsService;

    pub(crate) async fn ordered_project(db: &Db, code: &str) -> i64 {
        let p = ProjectsService::new(db.clone())
            .create(project_input(code), Some(1))
            .await
            .unwrap();
        let sql = placeholders(
            db.dialect(),
            "UPDATE projects SET status = 'ordered' WHERE id = ?",
        );
        on_pool!(db, pool => execute!(pool, sql, p.id)).unwrap();
        p.id
    }

    pub(crate) fn labor(phase: i64, minutes: i64) -> BudgetLineInput {
        BudgetLineInput {
            phase_id: Some(phase),
            cost_type: "labor".into(),
            planned_minutes: Some(minutes),
            amount: None,
        }
    }

    pub(crate) fn money(cost_type: &str, amount: i64) -> BudgetLineInput {
        BudgetLineInput {
            phase_id: None,
            cost_type: cost_type.into(),
            planned_minutes: None,
            amount: Some(amount),
        }
    }

    /// Spec 12.1's original budget (labor 200 h × 5,000 yen; total 2,600,000).
    pub(crate) fn spec_lines() -> Vec<BudgetLineInput> {
        vec![
            labor(1, 120 * 60),
            labor(2, 80 * 60),
            money("material", 900_000),
            money("outsource", 500_000),
            money("travel", 150_000),
            money("other", 50_000),
        ]
    }

    pub(crate) async fn set_rate(db: &Db, rate: i64) {
        CalcBasisService::new(db.clone())
            .add(
                None,
                value(RATE_ITEM, "2020-01-01", Some(rate), "初期"),
                Some(1),
            )
            .await
            .unwrap();
    }

    fn field_errors(err: BantoError) -> Vec<String> {
        match err {
            BantoError::Validation { field_errors } => {
                field_errors.into_iter().map(|e| e.field).collect()
            }
            other => panic!("expected a validation error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn t09_original_then_change_keeps_the_original_and_names_the_current() {
        let db = fixture().await;
        let svc = BudgetsService::new(db.clone());
        let pid = ordered_project(&db, "P-B01").await;

        let created = svc.create_draft(pid, Some(2)).await.unwrap();
        assert!(!created.replayed);
        assert!(created.draft.lines.is_empty());
        // A second create returns the same draft (one draft per project, T13).
        let again = svc.create_draft(pid, Some(2)).await.unwrap();
        assert!(again.replayed);
        assert_eq!(again.draft.id, created.draft.id);

        let d = created.draft;
        let saved = svc
            .update_draft(
                d.id,
                BudgetDraftInput {
                    reason: None,
                    lines: spec_lines(),
                    row_version: d.row_version,
                },
                Some(2),
            )
            .await
            .unwrap();
        // No budget rate yet: labor is 未確定, never 0 yen, and approval is refused.
        assert!(saved.rate_missing);
        assert_eq!(saved.total, None);
        assert_eq!(saved.lines[0].amount, None);
        let err = svc
            .approve(&saved, saved.row_version, Some(1))
            .await
            .unwrap_err();
        assert_eq!(field_errors(err), vec!["lines"]);

        set_rate(&db, 5_000).await;
        let saved = svc.get(saved.id).await.unwrap();
        assert_eq!(saved.total, Some(2_600_000));
        assert_eq!(saved.lines[0].budget_rate, Some(5_000));
        let v1 = svc
            .approve(&saved, saved.row_version, Some(1))
            .await
            .unwrap();
        assert_eq!(v1.version_no, Some(1));
        assert_eq!(v1.status, "approved");
        assert_eq!(v1.total, Some(2_600_000));

        // An approved version is never edited or deleted.
        assert!(svc
            .update_draft(
                v1.id,
                BudgetDraftInput {
                    reason: None,
                    lines: vec![],
                    row_version: v1.row_version,
                },
                Some(2),
            )
            .await
            .is_err());
        assert!(svc.delete_draft(v1.id, v1.row_version).await.is_err());

        // A change starts from the current budget and needs its reason.
        let d2 = svc.create_draft(pid, Some(2)).await.unwrap().draft;
        assert_eq!(d2.lines.len(), 6);
        let mut lines = spec_lines();
        lines[0] = labor(1, 140 * 60);
        let d2 = svc
            .update_draft(
                d2.id,
                BudgetDraftInput {
                    reason: None,
                    lines: lines.clone(),
                    row_version: d2.row_version,
                },
                Some(2),
            )
            .await
            .unwrap();
        let err = svc.approve(&d2, d2.row_version, Some(1)).await.unwrap_err();
        assert_eq!(field_errors(err), vec!["reason"]);
        let d2 = svc
            .update_draft(
                d2.id,
                BudgetDraftInput {
                    reason: Some("追加工事の承認".into()),
                    lines,
                    row_version: d2.row_version,
                },
                Some(2),
            )
            .await
            .unwrap();

        // A later rate change reprices the draft but never the approved v1.
        CalcBasisService::new(db.clone())
            .add(
                None,
                value(RATE_ITEM, "2021-01-01", Some(6_000), "改定"),
                Some(1),
            )
            .await
            .unwrap();
        let v2 = svc.approve(&d2, d2.row_version, Some(1)).await.unwrap();
        assert_eq!(v2.version_no, Some(2));
        assert_eq!(v2.lines[0].amount, Some(840_000));

        let o = svc.overview(pid).await.unwrap();
        assert_eq!(o.original.as_ref().unwrap().version_no, Some(1));
        assert_eq!(o.original.as_ref().unwrap().total, Some(2_600_000));
        assert_eq!(o.current.as_ref().unwrap().version_no, Some(2));
        assert_eq!(
            o.current.as_ref().unwrap().reason.as_deref(),
            Some("追加工事の承認")
        );
        assert_eq!(o.history.len(), 2);
        assert!(o.draft.is_none());
        let labor_total = o.totals.iter().find(|t| t.cost_type == "labor").unwrap();
        assert_eq!(labor_total.original, Some(1_000_000));
        assert_eq!(labor_total.current, Some(1_320_000));
        assert_eq!(labor_total.actual, Some(0));
        assert_eq!(labor_total.variance, Some(-1_320_000));
        let material = o.totals.iter().find(|t| t.cost_type == "material").unwrap();
        assert_eq!((material.actual, material.variance), (None, None));
        assert!(o.labor_actual_complete);
    }

    #[tokio::test]
    async fn t09_line_checks_closed_projects_and_stale_versions() {
        let db = fixture().await;
        let svc = BudgetsService::new(db.clone());
        let pid = ordered_project(&db, "P-B02").await;
        let d = svc.create_draft(pid, Some(2)).await.unwrap().draft;
        let err = svc
            .update_draft(
                d.id,
                BudgetDraftInput {
                    reason: None,
                    lines: vec![money("labor", 1), money("material", -1), money("x", 1)],
                    row_version: d.row_version,
                },
                Some(2),
            )
            .await
            .unwrap_err();
        assert_eq!(field_errors(err), vec!["lines.2.costType"]);
        let err = svc
            .update_draft(
                d.id,
                BudgetDraftInput {
                    reason: None,
                    lines: vec![money("labor", 1), money("material", -1)],
                    row_version: d.row_version,
                },
                Some(2),
            )
            .await
            .unwrap_err();
        assert_eq!(
            field_errors(err),
            vec!["lines.0.plannedMinutes", "lines.0.amount", "lines.1.amount"]
        );
        // Stale row_version (T13).
        let err = svc
            .update_draft(
                d.id,
                BudgetDraftInput {
                    reason: None,
                    lines: vec![],
                    row_version: d.row_version + 1,
                },
                Some(2),
            )
            .await
            .unwrap_err();
        assert_eq!(field_errors(err), vec!["rowVersion"]);
        // An unknown phase.
        let err = svc
            .update_draft(
                d.id,
                BudgetDraftInput {
                    reason: None,
                    lines: vec![labor(999, 60)],
                    row_version: d.row_version,
                },
                Some(2),
            )
            .await
            .unwrap_err();
        assert_eq!(field_errors(err), vec!["lines.0.phaseId"]);

        // A pre-order project may draft but not approve.
        let lead = ProjectsService::new(db.clone())
            .create(project_input("P-B03"), Some(1))
            .await
            .unwrap();
        let ld = svc.create_draft(lead.id, Some(2)).await.unwrap().draft;
        let ld = svc
            .update_draft(
                ld.id,
                BudgetDraftInput {
                    reason: None,
                    lines: vec![money("material", 10_000)],
                    row_version: ld.row_version,
                },
                Some(2),
            )
            .await
            .unwrap();
        let err = svc.approve(&ld, ld.row_version, Some(1)).await.unwrap_err();
        assert_eq!(field_errors(err), vec!["status"]);

        // Deleting a draft.
        svc.delete_draft(ld.id, ld.row_version).await.unwrap();
        assert!(matches!(
            svc.get(ld.id).await,
            Err(BantoError::NotFound { .. })
        ));

        // A settled project's budget cannot be drafted.
        let sql = placeholders(
            db.dialect(),
            "UPDATE projects SET status = 'settled' WHERE id = ?",
        );
        on_pool!(&db, pool => execute!(pool, sql, pid)).unwrap();
        let err = svc.create_draft(pid, Some(2)).await.unwrap_err();
        assert_eq!(field_errors(err), vec!["status"]);
    }

    #[tokio::test]
    async fn drafts_are_pending_usages_of_the_budget_rate() {
        let db = fixture().await;
        let svc = BudgetsService::new(db.clone());
        let pid = ordered_project(&db, "P-B04").await;
        svc.create_draft(pid, Some(2)).await.unwrap();
        let found = usages(&db, RATE_ITEM).await.unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].status, UsageStatus::Pending);
        assert!(usages(&db, "emp_rate").await.unwrap().is_empty());
    }
}
