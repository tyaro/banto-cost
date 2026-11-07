//! 月額固定原価 (monthly fixed costs, banto-cost P7b,
//! `docs/project/design.md` §9.4 items 3 and 5, T37).
//!
//! A contract is one person's fixed monthly amount - an employee (labor) or
//! a vendor (outsourcing) - booked every month to the monthly-contract
//! project the person serves (no split). Posting a month turns every
//! contract covering it into one approved record booked on the month's last
//! day; the records join the direct-cost ledger
//! (`direct_costs::LEDGER_SQL`), so the budget comparison, the completion
//! forecast, the monthly report and the close all count them. The rules are
//! `cost_domain::fixed_cost`.
//!
//! - A month is posted once per contract (a partial unique index; a second
//!   post skips it). A cancelled posting (reason required) counts as
//!   nothing and the month may be posted again.
//! - A closed month refuses posting and cancelling ([`refuse_closed!`]); a
//!   settled project refuses posting. Pre-order, lost or settled projects'
//!   contracts are listed as not posted, never booked.
//! - The posted amount is the contract's amount at posting time and never
//!   changes; changing a contract's amount only affects later postings. The
//!   project and the payee are fixed once a month has been posted, and the
//!   term must keep covering every posted month.
//!
//! Authorization (`Operation::ManageFixedCosts`: `finance.rate` +
//! `amount.view`, every route: the amounts are per person) and audit are the
//! REST/Tauri wiring's.

use banto_core::{BantoError, FieldError};
use banto_server::ServerEvent;
use banto_storage::Db;
use cost_domain::fixed_cost::{plan_month, validate, ContractIssue, DueContract, PayeeKind, Term};
use cost_domain::project::ProjectStatus;
use cost_domain::YearMonth;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::closeouts::{refuse_settled, settled_check_sql};
use crate::closing::{refuse_closed, MonthGate};
use crate::customers::{clean_optional, field_error, now_expr, stale_version_error};
use crate::orders::{
    execute, fetch_all, fetch_optional, in_tx, on_pool, placeholders, scalar, MAX_TEXT_LEN,
};

pub const RESOURCE: &str = "fixed_costs";

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractInput {
    pub project_id: Option<i64>,
    /// `employee` | `vendor`.
    #[serde(default)]
    pub payee_kind: String,
    pub user_id: Option<i64>,
    pub vendor_id: Option<i64>,
    pub monthly_amount: Option<i64>,
    /// `YYYY-MM`.
    #[serde(default)]
    pub from_month: String,
    /// `YYYY-MM`, or none for an open end.
    pub to_month: Option<String>,
    pub description: Option<String>,
    /// Required on update.
    #[serde(default)]
    pub row_version: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Contract {
    pub id: i64,
    pub project_id: i64,
    pub project_code: String,
    pub project_name: String,
    pub project_status: String,
    pub payee_kind: String,
    pub user_id: Option<i64>,
    pub vendor_id: Option<i64>,
    pub payee_name: Option<String>,
    /// `labor` | `outsource`.
    pub cost_type: String,
    pub monthly_amount: i64,
    pub from_month: String,
    pub to_month: Option<String>,
    pub description: Option<String>,
    pub row_version: i64,
    /// Months posted (approved) so far.
    pub posted_count: i64,
    pub last_posted_month: Option<String>,
}

/// An approved or cancelled posting.
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PostingView {
    pub id: i64,
    pub contract_id: i64,
    pub month: String,
    pub amount: i64,
    /// `approved` | `cancelled`.
    pub status: String,
    pub posted_by_name: Option<String>,
    pub posted_at: String,
    pub cancel_reason: Option<String>,
    pub cancelled_at: Option<String>,
}

/// One contract covering the month.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthLine {
    pub contract: Contract,
    /// `posted` | `due` | `project_closed`.
    pub state: String,
    /// The month's approved posting.
    pub posting: Option<PostingView>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthView {
    pub month: String,
    /// The month is closed: nothing can be posted or cancelled.
    pub closed: bool,
    pub lines: Vec<MonthLine>,
    pub due_count: usize,
    pub posted_total: i64,
    /// Cancelled postings of the month (history).
    pub cancelled: Vec<PostingView>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostResult {
    /// Contracts posted by this call (0 when everything was posted).
    pub posted: usize,
    pub view: MonthView,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelInput {
    #[serde(default)]
    pub reason: String,
}

const CONTRACT_SELECT: &str = "SELECT c.id, c.project_id, p.code AS project_code, \
     p.name AS project_name, p.status AS project_status, c.payee_kind, c.user_id, c.vendor_id, \
     COALESCE(u.display_name, v.name) AS payee_name, c.cost_type, c.monthly_amount, \
     c.from_month, c.to_month, c.description, c.row_version, \
     CAST((SELECT COUNT(*) FROM fixed_cost_postings f WHERE f.contract_id = c.id \
       AND f.status = 'approved') AS BIGINT) AS posted_count, \
     (SELECT MAX(f.month) FROM fixed_cost_postings f WHERE f.contract_id = c.id \
       AND f.status = 'approved') AS last_posted_month \
     FROM fixed_cost_contracts c JOIN projects p ON p.id = c.project_id \
     LEFT JOIN users u ON u.id = c.user_id LEFT JOIN vendors v ON v.id = c.vendor_id";

const POSTING_SELECT: &str = "SELECT f.id, f.contract_id, f.month, f.amount, f.status, \
     u.display_name AS posted_by_name, f.posted_at, f.cancel_reason, f.cancelled_at \
     FROM fixed_cost_postings f LEFT JOIN users u ON u.id = f.posted_by";

/// What both wiring layers record: the action, the contract or the month,
/// and the project. Amounts (per person) and the reason are not recorded.
pub fn audit_detail(
    action: &str,
    contract_id: Option<i64>,
    month: Option<&str>,
    project_id: Option<i64>,
) -> serde_json::Value {
    serde_json::json!({
        "action": action,
        "contractId": contract_id,
        "month": month,
        "projectId": project_id,
    })
}

fn validation(errors: Vec<FieldError>) -> BantoError {
    BantoError::Validation {
        field_errors: errors,
    }
}

fn one(field: &str, message: impl Into<String>) -> BantoError {
    validation(vec![field_error(field, message)])
}

fn parse_month(field: &str, s: &str) -> Result<YearMonth, BantoError> {
    YearMonth::parse(s.trim()).ok_or_else(|| one(field, "月は YYYY-MM で入力してください"))
}

fn not_found(id: i64) -> BantoError {
    BantoError::NotFound {
        resource: "fixed_cost_contract".into(),
        id: id.to_string(),
    }
}

/// The checked fields of a contract input.
struct Checked {
    project_id: i64,
    payee: PayeeKind,
    user_id: Option<i64>,
    vendor_id: Option<i64>,
    amount: i64,
    from: YearMonth,
    to: Option<YearMonth>,
    description: Option<String>,
}

#[derive(Clone)]
pub struct FixedCostsService {
    db: Db,
    events: Option<broadcast::Sender<ServerEvent>>,
}

impl FixedCostsService {
    pub fn new(db: Db) -> Self {
        Self { db, events: None }
    }

    pub fn with_events(mut self, events: broadcast::Sender<ServerEvent>) -> Self {
        self.events = Some(events);
        self
    }

    fn sql(&self, s: &str) -> String {
        placeholders(self.db.dialect(), s)
    }

    fn notify(&self) {
        crate::events::notify_changed(&self.events, RESOURCE);
        // The ledger the cost screens read changed too.
        crate::events::notify_changed(&self.events, crate::direct_costs::RESOURCE);
    }

    /// Every contract, by project code and start month.
    pub async fn list(&self) -> Result<Vec<Contract>, BantoError> {
        let sql = format!("{CONTRACT_SELECT} ORDER BY p.code, c.from_month, c.id");
        on_pool!(&self.db, pool => fetch_all!(pool, sql))
    }

    pub async fn get(&self, id: i64) -> Result<Contract, BantoError> {
        let sql = self.sql(&format!("{CONTRACT_SELECT} WHERE c.id = ?"));
        let row: Option<Contract> = on_pool!(&self.db, pool => fetch_optional!(pool, sql, id))?;
        row.ok_or_else(|| not_found(id))
    }

    /// The approved months of a contract.
    async fn posted_months(&self, id: i64) -> Result<Vec<YearMonth>, BantoError> {
        let sql = self.sql(
            "SELECT month FROM fixed_cost_postings WHERE contract_id = ? AND status = 'approved'",
        );
        let rows: Vec<(String,)> = on_pool!(&self.db, pool => fetch_all!(pool, sql, id))?;
        Ok(rows
            .into_iter()
            .filter_map(|(m,)| YearMonth::parse(&m))
            .collect())
    }

    /// Check the input and its masters. `posted` are the contract's posted
    /// months (empty for a new one).
    async fn check(
        &self,
        input: &ContractInput,
        posted: &[YearMonth],
    ) -> Result<Checked, BantoError> {
        let mut errors = Vec::new();
        let payee = PayeeKind::parse(input.payee_kind.trim());
        if payee.is_none() {
            errors.push(field_error("payeeKind", "社員か外注先を選んでください"));
        }
        let from = YearMonth::parse(input.from_month.trim());
        let to = match clean_optional(&input.to_month) {
            None => Some(None),
            Some(s) => YearMonth::parse(&s).map(Some),
        };
        for issue in validate(input.monthly_amount, from, to, posted) {
            errors.push(match issue {
                ContractIssue::AmountRequired => {
                    field_error("monthlyAmount", "月額を1円以上の整数で入力してください")
                }
                ContractIssue::FromRequired => {
                    field_error("fromMonth", "開始月を YYYY-MM で入力してください")
                }
                ContractIssue::ToBeforeFrom => field_error(
                    "toMonth",
                    "終了月は開始月以降を YYYY-MM で入力してください（継続中は空欄）",
                ),
                ContractIssue::PostedOutsideTerm { month } => field_error(
                    "toMonth",
                    format!(
                        "{}年{}月は計上済みです。期間から外すには先にその月の計上を取り消してください",
                        month.year, month.month
                    ),
                ),
            });
        }
        let description = clean_optional(&input.description);
        if description
            .as_ref()
            .is_some_and(|d| d.chars().count() > MAX_TEXT_LEN)
        {
            errors.push(field_error(
                "description",
                format!("{MAX_TEXT_LEN}文字以内で入力してください"),
            ));
        }
        let project_id = input.project_id;
        match project_id {
            None => errors.push(field_error("projectId", "案件を選んでください")),
            Some(p) => {
                let sql = self.sql("SELECT status FROM projects WHERE id = ?");
                let row: Option<(String,)> =
                    on_pool!(&self.db, pool => fetch_optional!(pool, sql, p))?;
                if row.is_none() {
                    errors.push(field_error("projectId", "見つかりません"));
                }
            }
        }
        let (mut user_id, mut vendor_id) = (None, None);
        match payee {
            Some(PayeeKind::Employee) => match input.user_id {
                None => errors.push(field_error("userId", "社員を選んでください")),
                Some(u) => {
                    let sql = self.sql("SELECT id FROM users WHERE id = ?");
                    let row: Option<(i64,)> =
                        on_pool!(&self.db, pool => fetch_optional!(pool, sql, u))?;
                    if row.is_none() {
                        errors.push(field_error("userId", "見つかりません"));
                    }
                    user_id = Some(u);
                }
            },
            Some(PayeeKind::Vendor) => match input.vendor_id {
                None => errors.push(field_error("vendorId", "外注先を選んでください")),
                Some(v) => {
                    let sql = self.sql("SELECT id FROM vendors WHERE id = ?");
                    let row: Option<(i64,)> =
                        on_pool!(&self.db, pool => fetch_optional!(pool, sql, v))?;
                    if row.is_none() {
                        errors.push(field_error("vendorId", "見つかりません"));
                    }
                    vendor_id = Some(v);
                }
            },
            None => {}
        }
        if !errors.is_empty() {
            return Err(validation(errors));
        }
        let (Some(project_id), Some(payee), Some(amount), Some(from), Some(to)) =
            (project_id, payee, input.monthly_amount, from, to)
        else {
            return Err(one("monthlyAmount", "入力を確認してください"));
        };
        Ok(Checked {
            project_id,
            payee,
            user_id,
            vendor_id,
            amount,
            from,
            to,
            description,
        })
    }

    /// Register a contract.
    pub async fn create(
        &self,
        input: ContractInput,
        actor_user_id: Option<i64>,
    ) -> Result<Contract, BantoError> {
        let c = self.check(&input, &[]).await?;
        let sql = self.sql(
            "INSERT INTO fixed_cost_contracts (project_id, payee_kind, user_id, vendor_id, \
             cost_type, monthly_amount, from_month, to_month, description, created_by, \
             updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        );
        let to = c.to.map(|m| m.to_string());
        let id: i64 = on_pool!(&self.db, pool => scalar!(pool, sql, c.project_id,
            c.payee.as_str(), c.user_id, c.vendor_id, c.payee.cost_type().as_str(), c.amount,
            c.from.to_string(), &to, &c.description, actor_user_id, actor_user_id))?;
        self.notify();
        self.get(id).await
    }

    /// Change a contract: the amount (later postings only), the term (still
    /// covering every posted month) and the note; the project and the payee
    /// only while nothing is posted.
    pub async fn update(
        &self,
        id: i64,
        input: ContractInput,
        actor_user_id: Option<i64>,
    ) -> Result<Contract, BantoError> {
        let current = self.get(id).await?;
        let posted = self.posted_months(id).await?;
        let c = self.check(&input, &posted).await?;
        if !posted.is_empty() {
            let mut errors = Vec::new();
            if c.project_id != current.project_id {
                errors.push(field_error(
                    "projectId",
                    "計上済みの月がある取り決めは案件を変えられません。終了月を決めて新しい取り決めを登録してください",
                ));
            }
            if c.payee.as_str() != current.payee_kind
                || c.user_id != current.user_id
                || c.vendor_id != current.vendor_id
            {
                errors.push(field_error(
                    "payeeKind",
                    "計上済みの月がある取り決めは支払先を変えられません。終了月を決めて新しい取り決めを登録してください",
                ));
            }
            if !errors.is_empty() {
                return Err(validation(errors));
            }
        }
        let sql = self.sql(&format!(
            "UPDATE fixed_cost_contracts SET project_id = ?, payee_kind = ?, user_id = ?, \
             vendor_id = ?, cost_type = ?, monthly_amount = ?, from_month = ?, to_month = ?, \
             description = ?, updated_by = ?, row_version = row_version + 1, updated_at = {} \
             WHERE id = ? AND row_version = ?",
            now_expr(self.db.dialect())
        ));
        // A posting made between the read above and this write could fall
        // outside the new term: re-check inside the transaction.
        let months = self.sql(
            "SELECT month FROM fixed_cost_postings WHERE contract_id = ? AND status = 'approved'",
        );
        let to = c.to.map(|m| m.to_string());
        let term = Term {
            from: c.from,
            to: c.to,
        };
        in_tx!(&self.db, tx => {
            if execute!(&mut *tx, sql, c.project_id, c.payee.as_str(), c.user_id, c.vendor_id,
                c.payee.cost_type().as_str(), c.amount, c.from.to_string(), &to,
                &c.description, actor_user_id, id, input.row_version)? == 0
            {
                return Err(stale_version_error());
            }
            let rows: Vec<(String,)> = fetch_all!(&mut *tx, months, id)?;
            if rows.len() != posted.len()
                || rows
                    .iter()
                    .any(|(m,)| YearMonth::parse(m).is_none_or(|m| !term.covers(m)))
            {
                return Err(stale_version_error());
            }
        });
        self.notify();
        self.get(id).await
    }

    /// The month as the posting screen sees it: every contract covering it,
    /// posted or not.
    pub async fn month(&self, month: &str) -> Result<MonthView, BantoError> {
        let m = parse_month("month", month)?;
        let key = m.to_string();
        let contracts = self.list().await?;
        let postings_sql = self.sql(&format!("{POSTING_SELECT} WHERE f.month = ? ORDER BY f.id"));
        let closed_sql = self.sql("SELECT status FROM closing_periods WHERE month = ?");
        let (postings, closed): (Vec<PostingView>, Option<(String,)>) = on_pool!(&self.db, pool => (
            fetch_all!(pool, postings_sql, &key)?,
            fetch_optional!(pool, closed_sql, &key)?,
        ));
        let mut lines = Vec::new();
        let mut due_count = 0;
        let mut posted_total = 0;
        for c in contracts {
            let Some(term) = term_of(&c) else { continue };
            if !term.covers(m) {
                continue;
            }
            let posting = postings
                .iter()
                .find(|p| p.contract_id == c.id && p.status == "approved")
                .cloned();
            let state = if let Some(p) = &posting {
                posted_total += p.amount;
                "posted"
            } else if project_accepts(&c.project_status) {
                due_count += 1;
                "due"
            } else {
                "project_closed"
            };
            lines.push(MonthLine {
                contract: c,
                state: state.into(),
                posting,
            });
        }
        Ok(MonthView {
            month: key,
            closed: closed.is_some_and(|(s,)| s == "closed"),
            lines,
            due_count,
            posted_total,
            cancelled: postings
                .into_iter()
                .filter(|p| p.status == "cancelled")
                .collect(),
        })
    }

    /// Post the month (計上): every contract covering it on an open project
    /// and not posted yet becomes an approved record booked on the month's
    /// last day, at the contract's amount now. Posting twice adds nothing.
    pub async fn post_month(
        &self,
        month: &str,
        actor_user_id: Option<i64>,
    ) -> Result<PostResult, BantoError> {
        let m = parse_month("month", month)?;
        let key = m.to_string();
        let booked_on = m.last_day().to_string();
        let gate = MonthGate::new(self.db.dialect());
        let settled = settled_check_sql(self.db.dialect());
        // The contracts are read inside the transaction and, on Postgres,
        // locked (`FOR UPDATE OF c`), so a concurrent `update` waits for the
        // posting and then sees it (its re-check refuses a term that drops
        // the month), or commits first and the posting takes its new term,
        // project and amount (PR #27 review). On SQLite the month gate's
        // write already holds the database's write lock.
        let lock = match self.db.dialect() {
            banto_storage::Dialect::Sqlite => "",
            banto_storage::Dialect::Postgres => " FOR UPDATE OF c",
        };
        let contracts_sql = self.sql(&format!(
            "SELECT c.id, c.project_id, p.status, c.from_month, c.to_month, c.cost_type, \
             c.monthly_amount, \
             CAST((SELECT COUNT(*) FROM fixed_cost_postings f WHERE f.contract_id = c.id \
               AND f.month = ? AND f.status = 'approved') AS BIGINT) \
             FROM fixed_cost_contracts c JOIN projects p ON p.id = c.project_id \
             ORDER BY c.id{lock}"
        ));
        let insert = self.sql(
            "INSERT INTO fixed_cost_postings (contract_id, month, project_id, cost_type, amount, \
             booked_on, status, posted_by) VALUES (?, ?, ?, ?, ?, ?, 'approved', ?) \
             ON CONFLICT (contract_id, month) WHERE status = 'approved' DO NOTHING",
        );
        type Row = (i64, i64, String, String, Option<String>, String, i64, i64);
        let posted: usize = in_tx!(&self.db, tx => {
            refuse_closed!(&mut *tx, gate, &booked_on, "month");
            let rows: Vec<Row> = fetch_all!(&mut *tx, contracts_sql, &key)?;
            let due: Vec<DueContract> = rows
                .iter()
                .filter_map(|r| {
                    Some(DueContract {
                        id: r.0,
                        term: Term {
                            from: YearMonth::parse(&r.3)?,
                            to: match &r.4 {
                                None => None,
                                Some(t) => Some(YearMonth::parse(t)?),
                            },
                        },
                        posted: r.7 > 0,
                        project_open: project_accepts(&r.2),
                    })
                })
                .collect();
            let plan = plan_month(&due, m);
            let mut n = 0usize;
            for id in plan.to_post {
                let Some(r) = rows.iter().find(|r| r.0 == id) else { continue };
                refuse_settled!(&mut *tx, settled, r.1, "month",
                    "精算完了の案件には計上できません");
                n += usize::try_from(execute!(&mut *tx, insert, r.0, &key, r.1, &r.5, r.6,
                    &booked_on, actor_user_id)?).unwrap_or(0);
            }
            n
        });
        if posted > 0 {
            self.notify();
        }
        Ok(PostResult {
            posted,
            view: self.month(&key).await?,
        })
    }

    /// Cancel a posting (取消, reason required). Its month must be open.
    pub async fn cancel(
        &self,
        posting_id: i64,
        input: CancelInput,
        actor_user_id: Option<i64>,
    ) -> Result<MonthView, BantoError> {
        let reason = input.reason.trim().to_string();
        if reason.is_empty() {
            return Err(one("reason", "取消の理由を入力してください"));
        }
        if reason.chars().count() > MAX_TEXT_LEN {
            return Err(one(
                "reason",
                format!("{MAX_TEXT_LEN}文字以内で入力してください"),
            ));
        }
        let read = self.sql(
            "SELECT month, booked_on, status, project_id FROM fixed_cost_postings WHERE id = ?",
        );
        let row: Option<(String, String, String, i64)> =
            on_pool!(&self.db, pool => fetch_optional!(pool, read, posting_id))?;
        let Some((month, booked_on, status, project_id)) = row else {
            return Err(BantoError::NotFound {
                resource: "fixed_cost_posting".into(),
                id: posting_id.to_string(),
            });
        };
        if status != "approved" {
            return Err(one("status", "この計上は取消済みです"));
        }
        let gate = MonthGate::new(self.db.dialect());
        let settled = settled_check_sql(self.db.dialect());
        let set = self.sql(&format!(
            "UPDATE fixed_cost_postings SET status = 'cancelled', cancel_reason = ?, \
             cancelled_by = ?, cancelled_at = {} WHERE id = ? AND status = 'approved'",
            now_expr(self.db.dialect())
        ));
        in_tx!(&self.db, tx => {
            if execute!(&mut *tx, set, &reason, actor_user_id, posting_id)? == 0 {
                return Err(stale_version_error());
            }
            refuse_closed!(&mut *tx, gate, &booked_on, "month");
            // A settled project's costs stay as settled (PR #27 review).
            refuse_settled!(&mut *tx, settled, project_id, "status",
                "精算完了の案件の計上は取り消せません。精算完了を取り消してから行ってください");
        });
        self.notify();
        self.month(&month).await
    }

    /// The project and month of a posting (for the audit record).
    pub async fn posting_scope(&self, posting_id: i64) -> Result<(i64, String), BantoError> {
        let sql = self.sql("SELECT project_id, month FROM fixed_cost_postings WHERE id = ?");
        let row: Option<(i64, String)> =
            on_pool!(&self.db, pool => fetch_optional!(pool, sql, posting_id))?;
        row.ok_or_else(|| BantoError::NotFound {
            resource: "fixed_cost_posting".into(),
            id: posting_id.to_string(),
        })
    }
}

/// Contracts covering `m` on open projects with no posting of the month
/// (the close warns about them, T37).
pub(crate) async fn unposted_count(db: &Db, m: YearMonth) -> Result<usize, BantoError> {
    let svc = FixedCostsService::new(db.clone());
    Ok(svc.month(&m.to_string()).await?.due_count)
}

fn term_of(c: &Contract) -> Option<Term> {
    Some(Term {
        from: YearMonth::parse(&c.from_month)?,
        to: match &c.to_month {
            None => None,
            Some(t) => Some(YearMonth::parse(t)?),
        },
    })
}

/// 受注・進行中・作業完了 accept a fixed cost; pre-order, lost, cancelled,
/// on-hold and settled projects do not.
fn project_accepts(status: &str) -> bool {
    ProjectStatus::parse(status).is_some_and(ProjectStatus::is_ordered_open)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::budgets::BudgetsService;
    use crate::closing::{CloseInput, ClosingService, ReopenInput};
    use crate::orders::tests::{line, ordered_project, pipeline_project};
    use crate::projects::tests::fixture;
    use crate::reports::ReportsService;

    async fn vendor(db: &Db, name: &str) -> i64 {
        let sql = placeholders(
            db.dialect(),
            "INSERT INTO vendors (name) VALUES (?) RETURNING id",
        );
        on_pool!(db, pool => scalar!(pool, sql, name)).unwrap()
    }

    fn vendor_contract(project: i64, vendor: i64, amount: i64, from: &str) -> ContractInput {
        ContractInput {
            project_id: Some(project),
            payee_kind: "vendor".into(),
            vendor_id: Some(vendor),
            monthly_amount: Some(amount),
            from_month: from.into(),
            ..Default::default()
        }
    }

    fn fields(err: BantoError) -> Vec<String> {
        match err {
            BantoError::Validation { field_errors } => {
                field_errors.into_iter().map(|e| e.field).collect()
            }
            other => panic!("validation expected, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn t37_a_vendor_fixed_cost_is_posted_once_a_month_as_outsourcing() {
        let db = fixture().await;
        let p = ordered_project(&db, "P-M01", vec![line(None, 3_600_000)]).await;
        let v = vendor(&db, "架空外注").await;
        let svc = FixedCostsService::new(db.clone());
        let c = svc
            .create(vendor_contract(p, v, 300_000, "2026-06"), Some(1))
            .await
            .unwrap();
        assert_eq!(c.cost_type, "outsource");
        assert_eq!(c.posted_count, 0);

        let view = svc.month("2026-12").await.unwrap();
        assert_eq!(view.due_count, 1);
        assert_eq!(view.lines[0].state, "due");
        let r = svc.post_month("2026-12", Some(1)).await.unwrap();
        assert_eq!(r.posted, 1);
        assert_eq!(r.view.posted_total, 300_000);
        assert_eq!(r.view.due_count, 0);
        // Posting again adds nothing.
        let again = svc.post_month("2026-12", Some(1)).await.unwrap();
        assert_eq!(again.posted, 0);
        assert_eq!(again.view.posted_total, 300_000);
        // Before the start month nothing covers.
        assert!(svc.month("2026-05").await.unwrap().lines.is_empty());

        // The ledger counts it: the budget comparison's outsourcing actual
        // and the monthly report's direct cost of December.
        let budget = BudgetsService::new(db.clone()).overview(p).await.unwrap();
        let outsource = budget
            .totals
            .iter()
            .find(|t| t.cost_type == "outsource")
            .unwrap();
        assert_eq!(outsource.actual, Some(300_000));
        let monthly = ReportsService::new(db.clone())
            .project_monthly(p)
            .await
            .unwrap();
        let dec = monthly.lines.iter().find(|l| l.month == "2026-12").unwrap();
        assert_eq!(dec.amounts.direct, 300_000);
        assert_eq!(dec.amounts.labor, 0);
    }

    #[tokio::test]
    async fn t37_an_employee_fixed_cost_is_labor_in_every_figure() {
        let db = fixture().await;
        let p = ordered_project(&db, "P-M02", vec![line(None, 3_600_000)]).await;
        let svc = FixedCostsService::new(db.clone());
        let c = svc
            .create(
                ContractInput {
                    project_id: Some(p),
                    payee_kind: "employee".into(),
                    user_id: Some(1),
                    monthly_amount: Some(450_000),
                    from_month: "2026-06".into(),
                    ..Default::default()
                },
                Some(1),
            )
            .await
            .unwrap();
        assert_eq!(c.cost_type, "labor");
        svc.post_month("2026-11", Some(1)).await.unwrap();
        let budget = BudgetsService::new(db.clone()).overview(p).await.unwrap();
        let labor = budget
            .totals
            .iter()
            .find(|t| t.cost_type == "labor")
            .unwrap();
        assert_eq!(labor.actual, Some(450_000));
        let monthly = ReportsService::new(db.clone())
            .project_monthly(p)
            .await
            .unwrap();
        let nov = monthly.lines.iter().find(|l| l.month == "2026-11").unwrap();
        assert_eq!((nov.amounts.labor, nov.amounts.direct), (450_000, 0));
        // The completion forecast's latest actuals count it once.
        let f = crate::forecasts::ForecastsService::new(db.clone())
            .overview(p)
            .await
            .unwrap();
        assert_eq!(f.latest_actual_total, 450_000);
        let labor_row = f
            .comparison
            .iter()
            .find(|r| r.cost_type == "labor")
            .unwrap();
        assert_eq!(labor_row.latest_actual, 450_000);
        // The direct-cost section leaves it out (it is labor).
        let costs = crate::direct_costs::DirectCostsService::new(db.clone())
            .project_costs(p)
            .await
            .unwrap();
        assert_eq!(costs.total, 0);
        assert!(costs.months.is_empty());
        // The close's figures put it in labor too.
        let closing = ClosingService::new(db.clone())
            .get("2026-11")
            .await
            .unwrap();
        assert_eq!(closing.total.labor_cost, 450_000);
        assert_eq!(closing.total.direct_cost, 0);
    }

    #[tokio::test]
    async fn t37_a_changed_amount_only_affects_months_not_posted() {
        let db = fixture().await;
        let p = ordered_project(&db, "P-M03", vec![line(None, 3_600_000)]).await;
        let v = vendor(&db, "架空外注").await;
        let svc = FixedCostsService::new(db.clone());
        let c = svc
            .create(vendor_contract(p, v, 450_000, "2026-06"), Some(1))
            .await
            .unwrap();
        svc.post_month("2026-06", Some(1)).await.unwrap();
        let mut input = vendor_contract(p, v, 300_000, "2026-06");
        input.row_version = c.row_version;
        let c = svc.update(c.id, input, Some(1)).await.unwrap();
        assert_eq!(c.monthly_amount, 300_000);
        svc.post_month("2026-07", Some(1)).await.unwrap();
        let june = svc.month("2026-06").await.unwrap();
        let july = svc.month("2026-07").await.unwrap();
        assert_eq!(june.posted_total, 450_000, "計上済みの月は変わらない");
        assert_eq!(july.posted_total, 300_000);

        // The project and the payee are fixed once posted; the term keeps
        // covering the posted months.
        let other = ordered_project(&db, "P-M04", vec![line(None, 1_000_000)]).await;
        let mut moved = vendor_contract(other, v, 300_000, "2026-06");
        moved.row_version = c.row_version;
        assert_eq!(
            fields(svc.update(c.id, moved, Some(1)).await.unwrap_err()),
            vec!["projectId"]
        );
        let mut ended = vendor_contract(p, v, 300_000, "2026-06");
        ended.to_month = Some("2026-06".into());
        ended.row_version = c.row_version;
        assert_eq!(
            fields(svc.update(c.id, ended, Some(1)).await.unwrap_err()),
            vec!["toMonth"]
        );
        // A stale version is refused.
        let mut stale = vendor_contract(p, v, 200_000, "2026-06");
        stale.row_version = c.row_version - 1;
        assert_eq!(
            fields(svc.update(c.id, stale, Some(1)).await.unwrap_err()),
            vec!["rowVersion"]
        );
    }

    #[tokio::test]
    async fn t37_unset_or_zero_amount_is_refused_and_inputs_are_checked() {
        let db = fixture().await;
        let p = ordered_project(&db, "P-M05", vec![line(None, 1_000_000)]).await;
        let svc = FixedCostsService::new(db.clone());
        let err = svc
            .create(
                ContractInput {
                    project_id: Some(p),
                    payee_kind: "vendor".into(),
                    monthly_amount: Some(0),
                    from_month: "2026-6".into(),
                    ..Default::default()
                },
                Some(1),
            )
            .await
            .unwrap_err();
        assert_eq!(fields(err), vec!["monthlyAmount", "fromMonth", "vendorId"]);
        let err = svc
            .create(
                ContractInput {
                    payee_kind: "other".into(),
                    monthly_amount: Some(1),
                    from_month: "2026-06".into(),
                    ..Default::default()
                },
                Some(1),
            )
            .await
            .unwrap_err();
        assert_eq!(fields(err), vec!["payeeKind", "projectId"]);
    }

    #[tokio::test]
    async fn t37_closed_months_and_closed_projects_are_not_posted() {
        let db = fixture().await;
        let p = ordered_project(&db, "P-M06", vec![line(None, 1_000_000)]).await;
        let lead = pipeline_project(&db, "P-M07", 2_000_000, 40, "2027-01").await;
        let v = vendor(&db, "架空外注").await;
        let svc = FixedCostsService::new(db.clone());
        svc.create(vendor_contract(p, v, 100_000, "2026-06"), Some(1))
            .await
            .unwrap();
        svc.create(vendor_contract(lead, v, 100_000, "2026-06"), Some(1))
            .await
            .unwrap();
        // The pre-order project's contract is listed but not posted.
        let r = svc.post_month("2026-08", Some(1)).await.unwrap();
        assert_eq!(r.posted, 1);
        let states: Vec<&str> = r.view.lines.iter().map(|l| l.state.as_str()).collect();
        assert_eq!(states, vec!["posted", "project_closed"]);

        // The close warns about unposted contracts and then refuses posting
        // and cancelling in the closed month.
        let closing = ClosingService::new(db.clone());
        let sept = closing.get("2026-09").await.unwrap();
        assert!(sept
            .warnings
            .iter()
            .any(|w| w.code == "fixed_unposted" && w.count == 1));
        closing
            .close("2026-08", CloseInput { row_version: 1 }, Some(1))
            .await
            .unwrap();
        assert_eq!(
            fields(svc.post_month("2026-08", Some(1)).await.unwrap_err()),
            vec!["month"]
        );
        let posting = svc.month("2026-08").await.unwrap().lines[0]
            .posting
            .clone()
            .unwrap();
        let err = svc
            .cancel(
                posting.id,
                CancelInput {
                    reason: "誤り".into(),
                },
                Some(1),
            )
            .await
            .unwrap_err();
        assert_eq!(fields(err), vec!["month"]);
        assert!(svc.month("2026-08").await.unwrap().closed);

        // Reopened: a cancel needs a reason, then the month may be posted again.
        let m = closing.get("2026-08").await.unwrap();
        closing
            .reopen(
                "2026-08",
                ReopenInput {
                    row_version: m.row_version,
                    reason: "訂正".into(),
                },
                Some(1),
            )
            .await
            .unwrap();
        let err = svc
            .cancel(posting.id, CancelInput { reason: " ".into() }, Some(1))
            .await
            .unwrap_err();
        assert_eq!(fields(err), vec!["reason"]);
        let view = svc
            .cancel(
                posting.id,
                CancelInput {
                    reason: "誤り".into(),
                },
                Some(1),
            )
            .await
            .unwrap();
        assert_eq!(view.posted_total, 0);
        assert_eq!(view.cancelled.len(), 1);
        assert_eq!(view.due_count, 1);
        let again = svc.post_month("2026-08", Some(1)).await.unwrap();
        assert_eq!(again.posted, 1);

        // A settled project's posting cannot be cancelled (its costs stay
        // as settled), even while the month is open.
        let sql = placeholders(
            db.dialect(),
            "UPDATE projects SET status = 'settled' WHERE id = ?",
        );
        on_pool!(&db, pool => execute!(pool, sql, p)).unwrap();
        let posting = again.view.lines[0].posting.clone().unwrap();
        let err = svc
            .cancel(
                posting.id,
                CancelInput {
                    reason: "誤り".into(),
                },
                Some(1),
            )
            .await
            .unwrap_err();
        assert_eq!(fields(err), vec!["status"]);
        assert_eq!(svc.month("2026-08").await.unwrap().posted_total, 100_000);
    }
}
