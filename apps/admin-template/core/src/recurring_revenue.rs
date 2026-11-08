//! 定期売上 (recurring revenue of a monthly contract, banto-cost P7c,
//! `docs/project/design.md` §9.4 items 2 and 6, T38).
//!
//! A monthly contract is one project with one agreement: a monthly amount
//! and a closed term. Saving the agreement regenerates the project's open
//! revenue plan - one line per month of the term, the recognized amounts
//! kept - and the monthly amount × months must equal the confirmed order
//! (`cost_domain::recurring::regenerate`; an order change fixes the order
//! first). Recognizing a month records, for every agreement covering it on
//! an open project, an ordinary revenue recognition on the month's last day
//! (検収日) that clears the month's plan line - through
//! [`OrdersService::recognize`], so the checks of T26, the closed-month
//! gate and the `revenue_version` compare-and-set are the same as a
//! recognition by hand. A month already cleared is skipped, so recognizing
//! twice adds nothing. A recognition is cancelled from the project's order
//! section as usual.
//!
//! 目標粗利率 is read on the first acceptance date, i.e. the first month
//! recognized (2026-11-08 decision; `forecasts::target_margin`).
//!
//! Authorization (`Operation::ManageRecurringRevenue`: `finance.close` +
//! `amount.view`, every route: accounting's, company-wide amounts) and
//! audit are the REST/Tauri wiring's.

use banto_core::{BantoError, FieldError};
use banto_server::ServerEvent;
use banto_storage::Db;
use cost_domain::project::ProjectStatus;
use cost_domain::recurring::{
    contract_total, month_state, regenerate, validate, AgreementIssue, MonthFacts, MonthState,
    Term, RECOGNITION_BASIS,
};
use cost_domain::YearMonth;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::customers::{clean_optional, field_error, now_expr, stale_version_error};
use crate::orders::{
    execute, fetch_all, fetch_optional, in_tx, on_pool, placeholders, revenue_errors, scalar,
    write_plan_rewrite, ClearingInput, OrdersService, PlanOpRef, RecognitionInput, MAX_TEXT_LEN,
};

pub const RESOURCE: &str = "recurring_revenues";

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgreementInput {
    pub project_id: Option<i64>,
    pub monthly_amount: Option<i64>,
    /// `YYYY-MM`.
    #[serde(default)]
    pub from_month: String,
    /// `YYYY-MM` (required: the term is closed).
    #[serde(default)]
    pub to_month: String,
    pub description: Option<String>,
    /// Required on update.
    #[serde(default)]
    pub row_version: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Agreement {
    pub id: i64,
    pub project_id: i64,
    pub project_code: String,
    pub project_name: String,
    pub project_status: String,
    pub monthly_amount: i64,
    pub from_month: String,
    pub to_month: String,
    pub description: Option<String>,
    pub row_version: i64,
    /// Months of the term.
    #[sqlx(skip)]
    pub months: i64,
    /// Monthly amount × months.
    #[sqlx(skip)]
    pub contract_total: i64,
    /// The project's recognized revenue (not cancelled).
    pub recognized_total: i64,
}

/// One agreement covering the month.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthLine {
    pub agreement: Agreement,
    /// `due` | `recognized` | `project_closed` | `no_plan`.
    pub state: String,
    /// The month's planned revenue (cleared + open).
    pub planned: i64,
    /// The month's open plan: what recognizing the month books.
    pub open: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthView {
    pub month: String,
    /// The month's acceptance date (its last day).
    pub recognized_on: String,
    /// The month is closed: nothing can be recognized.
    pub closed: bool,
    pub lines: Vec<MonthLine>,
    pub due_count: usize,
    pub due_total: i64,
}

/// A project the month could not be recognized on (the others were).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub project_id: i64,
    pub project_code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecognizeResult {
    /// Agreements recognized by this call (0 when everything was).
    pub recognized: usize,
    /// Project ids recognized by this call (for the audit record).
    pub project_ids: Vec<i64>,
    pub failures: Vec<Failure>,
    pub view: MonthView,
}

const AGREEMENT_SELECT: &str = "SELECT a.id, a.project_id, p.code AS project_code, \
     p.name AS project_name, p.status AS project_status, a.monthly_amount, a.from_month, \
     a.to_month, a.description, a.row_version, \
     CAST(COALESCE((SELECT SUM(r.amount) FROM revenue_recognitions r \
       WHERE r.project_id = a.project_id AND r.cancelled_at IS NULL), 0) AS BIGINT) \
       AS recognized_total \
     FROM recurring_revenues a JOIN projects p ON p.id = a.project_id";

/// What both wiring layers record: the action, the agreement or the month,
/// and the project(s). Amounts are not recorded.
pub fn audit_detail(
    action: &str,
    agreement_id: Option<i64>,
    month: Option<&str>,
    project_ids: &[i64],
) -> serde_json::Value {
    serde_json::json!({
        "action": action,
        "agreementId": agreement_id,
        "month": month,
        "projectIds": project_ids,
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

fn not_found(id: i64) -> BantoError {
    BantoError::NotFound {
        resource: "recurring_revenue".into(),
        id: id.to_string(),
    }
}

/// Yen with thousands separators (`3,600,000`) for messages.
fn yen(v: i64) -> String {
    let digits = v.unsigned_abs().to_string();
    let mut out = String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    if v < 0 {
        format!("-{out}")
    } else {
        out
    }
}

fn ym_label(m: YearMonth) -> String {
    format!("{}年{}月", m.year, m.month)
}

/// Agreement issues as field errors.
fn agreement_errors(issues: Vec<AgreementIssue>) -> BantoError {
    let mut errors = Vec::new();
    for issue in issues {
        match issue {
            AgreementIssue::AmountRequired => errors.push(field_error(
                "monthlyAmount",
                "月額を1円以上の整数で入力してください",
            )),
            AgreementIssue::FromRequired => errors.push(field_error(
                "fromMonth",
                "開始月を YYYY-MM で入力してください",
            )),
            AgreementIssue::ToRequired => errors.push(field_error(
                "toMonth",
                "終了月を YYYY-MM で入力してください",
            )),
            AgreementIssue::ToBeforeFrom => {
                errors.push(field_error("toMonth", "終了月は開始月以降にしてください"))
            }
            AgreementIssue::TooLong { max } => {
                errors.push(field_error("toMonth", format!("期間は{max}か月までです")))
            }
            AgreementIssue::TotalMismatch {
                contract_total,
                order_amount,
            } => errors.push(field_error(
                "monthlyAmount",
                format!(
                    "月額×月数（{}円）が確定受注額（{}円）と一致しません。\
                     月額・期間を見直すか、受注変更で確定受注額を直してください",
                    yen(contract_total),
                    yen(order_amount)
                ),
            )),
            AgreementIssue::RecognizedOverAmount { month, recognized } => errors.push(field_error(
                "monthlyAmount",
                format!(
                    "{}は{}円を計上済みです。それより小さい月額にはできません",
                    ym_label(month),
                    yen(recognized)
                ),
            )),
            AgreementIssue::RecognizedOutsideTerm { month } => errors.push(field_error(
                "fromMonth",
                match month {
                    Some(m) => format!(
                        "{}は計上済みです。期間から外すには先にその計上を取り消してください",
                        ym_label(m)
                    ),
                    None => {
                        "時期未定の予定に計上済みの額があります。先にその計上を取り消してください"
                            .to_string()
                    }
                },
            )),
            AgreementIssue::Revenue(issues) => {
                if let BantoError::Validation { field_errors } =
                    revenue_errors("monthlyAmount", &issues)
                {
                    errors.extend(field_errors);
                }
            }
        }
    }
    validation(errors)
}

fn term_of(a: &Agreement) -> Option<Term> {
    Some(Term {
        from: YearMonth::parse(&a.from_month)?,
        to: YearMonth::parse(&a.to_month)?,
    })
}

fn with_totals(mut a: Agreement) -> Agreement {
    if let Some(term) = term_of(&a) {
        a.months = term.months().len() as i64;
        a.contract_total = contract_total(a.monthly_amount, term);
    }
    a
}

/// The checked fields of an agreement input.
struct Checked {
    project_id: i64,
    amount: i64,
    term: Term,
    description: Option<String>,
}

#[derive(Clone)]
pub struct RecurringRevenueService {
    db: Db,
    events: Option<broadcast::Sender<ServerEvent>>,
}

impl RecurringRevenueService {
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

    fn orders(&self) -> OrdersService {
        let svc = OrdersService::new(self.db.clone());
        match &self.events {
            Some(events) => svc.with_events(events.clone()),
            None => svc,
        }
    }

    fn notify(&self) {
        crate::events::notify_changed(&self.events, RESOURCE);
        // The plan the order section and the outlook read changed too.
        crate::events::notify_changed(&self.events, "projects");
    }

    /// Every agreement, by project code.
    pub async fn list(&self) -> Result<Vec<Agreement>, BantoError> {
        let sql = format!("{AGREEMENT_SELECT} ORDER BY p.code, a.id");
        let rows: Vec<Agreement> = on_pool!(&self.db, pool => fetch_all!(pool, sql))?;
        Ok(rows.into_iter().map(with_totals).collect())
    }

    pub async fn get(&self, id: i64) -> Result<Agreement, BantoError> {
        let sql = self.sql(&format!("{AGREEMENT_SELECT} WHERE a.id = ?"));
        let row: Option<Agreement> = on_pool!(&self.db, pool => fetch_optional!(pool, sql, id))?;
        row.map(with_totals).ok_or_else(|| not_found(id))
    }

    fn check(&self, input: &AgreementInput) -> Result<Checked, BantoError> {
        let from = YearMonth::parse(input.from_month.trim());
        let to = YearMonth::parse(input.to_month.trim());
        let mut errors = Vec::new();
        let checked = match validate(input.monthly_amount, from, to) {
            Ok(v) => Some(v),
            Err(issues) => {
                if let BantoError::Validation { field_errors } = agreement_errors(issues) {
                    errors.extend(field_errors);
                }
                None
            }
        };
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
        if input.project_id.is_none() {
            errors.push(field_error("projectId", "案件を選んでください"));
        }
        if !errors.is_empty() {
            return Err(validation(errors));
        }
        let (Some(project_id), Some((amount, term))) = (input.project_id, checked) else {
            return Err(one("monthlyAmount", "入力を確認してください"));
        };
        Ok(Checked {
            project_id,
            amount,
            term,
            description,
        })
    }

    /// Register a project's agreement and generate its monthly plan.
    pub async fn create(
        &self,
        input: AgreementInput,
        actor_user_id: Option<i64>,
    ) -> Result<Agreement, BantoError> {
        let c = self.check(&input)?;
        let exists = self.sql("SELECT id FROM recurring_revenues WHERE project_id = ?");
        let row: Option<(i64,)> =
            on_pool!(&self.db, pool => fetch_optional!(pool, exists, c.project_id))?;
        if row.is_some() {
            return Err(one(
                "projectId",
                "この案件には定期売上の取り決めがあります。登録済みの取り決めを変更してください",
            ));
        }
        let rewrite = self
            .orders()
            .prepare_plan_rewrite(c.project_id, |revenue| {
                regenerate(revenue, c.amount, c.term).map_err(agreement_errors)
            })
            .await
            .map_err(|e| project_field(e, "projectId"))?;
        let insert = self.sql(
            "INSERT INTO recurring_revenues (project_id, monthly_amount, from_month, to_month, \
             description, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
        );
        let id: i64 = in_tx!(&self.db, tx => {
            write_plan_rewrite!(&mut *tx, rewrite, c.project_id);
            scalar!(&mut *tx, insert, c.project_id, c.amount, c.term.from.to_string(),
                c.term.to.to_string(), &c.description, actor_user_id, actor_user_id)?
        });
        self.notify();
        self.get(id).await
    }

    /// Change an agreement (amount, term, note) and regenerate the open
    /// plan; the recognized months stay. The project cannot change.
    pub async fn update(
        &self,
        id: i64,
        input: AgreementInput,
        actor_user_id: Option<i64>,
    ) -> Result<Agreement, BantoError> {
        let current = self.get(id).await?;
        let c = self.check(&input)?;
        if c.project_id != current.project_id {
            return Err(one(
                "projectId",
                "取り決めの案件は変えられません。別の案件には新しく登録してください",
            ));
        }
        let rewrite = self
            .orders()
            .prepare_plan_rewrite(c.project_id, |revenue| {
                regenerate(revenue, c.amount, c.term).map_err(agreement_errors)
            })
            .await
            .map_err(|e| project_field(e, "projectId"))?;
        let update = self.sql(&format!(
            "UPDATE recurring_revenues SET monthly_amount = ?, from_month = ?, to_month = ?, \
             description = ?, updated_by = ?, row_version = row_version + 1, updated_at = {} \
             WHERE id = ? AND row_version = ?",
            now_expr(self.db.dialect())
        ));
        in_tx!(&self.db, tx => {
            if execute!(&mut *tx, update, c.amount, c.term.from.to_string(),
                c.term.to.to_string(), &c.description, actor_user_id, id,
                input.row_version)? == 0
            {
                return Err(stale_version_error());
            }
            write_plan_rewrite!(&mut *tx, rewrite, c.project_id);
        });
        self.notify();
        self.get(id).await
    }

    /// The month as the recognition screen sees it: every agreement
    /// covering it, with its plan of the month.
    pub async fn month(&self, month: &str) -> Result<MonthView, BantoError> {
        let m = YearMonth::parse(month.trim())
            .ok_or_else(|| one("month", "月は YYYY-MM で入力してください"))?;
        let key = m.to_string();
        let closed_sql = self.sql("SELECT status FROM closing_periods WHERE month = ?");
        let closed: Option<(String,)> =
            on_pool!(&self.db, pool => fetch_optional!(pool, closed_sql, &key))?;
        let orders = self.orders();
        let mut lines = Vec::new();
        let (mut due_count, mut due_total) = (0, 0);
        for a in self.list().await? {
            let Some(term) = term_of(&a) else { continue };
            if !term.covers(m) {
                continue;
            }
            let summary = orders.summary(a.project_id).await?;
            let plan = summary
                .plan
                .iter()
                .find(|p| p.month.as_deref() == Some(key.as_str()));
            let facts = MonthFacts {
                term,
                planned: plan.map_or(0, |p| p.amount),
                open: plan.map_or(0, |p| p.open),
                project_open: ProjectStatus::parse(&a.project_status)
                    .is_some_and(ProjectStatus::is_ordered_open),
            };
            let Some(state) = month_state(&facts, m) else {
                continue;
            };
            let state = match state {
                MonthState::Due { amount } => {
                    due_count += 1;
                    due_total += amount;
                    "due"
                }
                MonthState::Recognized => "recognized",
                MonthState::ProjectClosed => "project_closed",
                MonthState::NoPlan => "no_plan",
            };
            lines.push(MonthLine {
                agreement: a,
                state: state.into(),
                planned: facts.planned,
                open: facts.open,
            });
        }
        Ok(MonthView {
            month: key,
            recognized_on: m.last_day().to_string(),
            closed: closed.is_some_and(|(s,)| s == "closed"),
            lines,
            due_count,
            due_total,
        })
    }

    /// Recognize the month (月末検収): every due agreement gets a recognition
    /// of its month's open plan on the month's last day. A project that
    /// cannot be recognized (a concurrent change) is reported and the
    /// others are still recognized; recognizing again adds nothing.
    pub async fn recognize_month(
        &self,
        month: &str,
        actor_user_id: Option<i64>,
    ) -> Result<RecognizeResult, BantoError> {
        let view = self.month(month).await?;
        if view.closed {
            return Err(one(
                "month",
                "締め済みの月です。計上するには先に月次締めを再開してください",
            ));
        }
        let orders = self.orders();
        let mut project_ids = Vec::new();
        let mut failures = Vec::new();
        for line in view.lines.iter().filter(|l| l.state == "due") {
            let project_id = line.agreement.project_id;
            let summary = orders.summary(project_id).await?;
            let Some(plan) = summary
                .plan
                .iter()
                .find(|p| p.month.as_deref() == Some(view.month.as_str()) && p.open > 0)
            else {
                continue;
            };
            let input = RecognitionInput {
                recognized_on: view.recognized_on.clone(),
                amount: plan.open,
                basis: Some(RECOGNITION_BASIS.to_string()),
                clears: Some(vec![ClearingInput {
                    plan_id: plan.id,
                    amount: plan.open,
                }]),
            };
            match orders.recognize(project_id, input, actor_user_id).await {
                Ok(_) => project_ids.push(project_id),
                Err(BantoError::Validation { field_errors }) => failures.push(Failure {
                    project_id,
                    project_code: line.agreement.project_code.clone(),
                    message: field_errors
                        .into_iter()
                        .map(|e| e.message)
                        .collect::<Vec<_>>()
                        .join("／"),
                }),
                Err(e) => return Err(e),
            }
        }
        if !project_ids.is_empty() {
            self.notify();
        }
        Ok(RecognizeResult {
            recognized: project_ids.len(),
            project_ids,
            failures,
            view: self.month(&view.month).await?,
        })
    }
}

/// The order's "not ordered / settled" refusals come on `status`; on the
/// agreement form they belong to the project field.
fn project_field(err: BantoError, field: &str) -> BantoError {
    match err {
        BantoError::Validation { field_errors } => validation(
            field_errors
                .into_iter()
                .map(|mut e| {
                    if e.field == "status" {
                        e.field = field.to_string();
                    }
                    e
                })
                .collect(),
        ),
        other => other,
    }
}

/// Agreements covering `m` on open projects with the month's plan not
/// recognized (the close warns about them, T38).
pub(crate) async fn unrecognized_count(db: &Db, m: YearMonth) -> Result<usize, BantoError> {
    let svc = RecurringRevenueService::new(db.clone());
    Ok(svc.month(&m.to_string()).await?.due_count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calc_basis::tests::value;
    use crate::calc_basis::CalcBasisService;
    use crate::closing::{CloseInput, ClosingService, ReopenInput};
    use crate::orders::tests::{line, ordered_project, pipeline_project};
    use crate::orders::{CancelInput, ChangeDecision, ChangeRequest};
    use crate::projects::tests::fixture;
    use cost_domain::funds::TARGET_MARGIN_ITEM;
    use cost_domain::Date;

    fn agreement(project: i64, amount: i64, from: &str, to: &str) -> AgreementInput {
        AgreementInput {
            project_id: Some(project),
            monthly_amount: Some(amount),
            from_month: from.into(),
            to_month: to.into(),
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

    #[test]
    fn messages_show_yen_with_separators() {
        assert_eq!(yen(3_600_000), "3,600,000");
        assert_eq!(yen(300), "300");
        assert_eq!(yen(-1_000), "-1,000");
    }

    #[tokio::test]
    async fn t38_an_agreement_generates_the_monthly_plan_and_a_month_is_recognized_once() {
        let db = fixture().await;
        let p = ordered_project(&db, "P-R01", vec![line(None, 3_600_000)]).await;
        let (tx, mut rx) = tokio::sync::broadcast::channel(16);
        let svc = RecurringRevenueService::new(db.clone()).with_events(tx);
        let a = svc
            .create(agreement(p, 300_000, "2026-06", "2027-05"), Some(1))
            .await
            .unwrap();
        assert_eq!(a.months, 12);
        assert_eq!(a.contract_total, 3_600_000);
        assert_eq!(a.recognized_total, 0);
        assert!(rx.try_recv().is_ok());

        // 12 monthly lines of 300,000 replace the undated plan.
        let orders = OrdersService::new(db.clone());
        let s = orders.summary(p).await.unwrap();
        assert_eq!(s.plan.len(), 12);
        assert!(s
            .plan
            .iter()
            .all(|l| l.open == 300_000 && l.month.is_some()));
        assert!(s.issues.is_empty());

        let view = svc.month("2026-12").await.unwrap();
        assert_eq!(view.recognized_on, "2026-12-31");
        assert_eq!(view.due_count, 1);
        assert_eq!(view.due_total, 300_000);
        let r = svc.recognize_month("2026-12", Some(1)).await.unwrap();
        assert_eq!(r.recognized, 1);
        assert_eq!(r.project_ids, vec![p]);
        assert!(r.failures.is_empty());
        assert_eq!(r.view.lines[0].state, "recognized");
        // Recognizing again adds nothing.
        let again = svc.recognize_month("2026-12", Some(1)).await.unwrap();
        assert_eq!(again.recognized, 0);

        // An ordinary recognition on the month end, clearing December.
        let s = orders.summary(p).await.unwrap();
        assert_eq!(s.recognized_total, 300_000);
        assert_eq!(s.remaining, Some(3_300_000));
        let rec = &s.recognitions[0];
        assert_eq!(rec.recognized_on, "2026-12-31");
        assert_eq!(rec.basis.as_deref(), Some(RECOGNITION_BASIS));
        assert_eq!(rec.clears[0].month.as_deref(), Some("2026-12"));
        assert_eq!(svc.get(a.id).await.unwrap().recognized_total, 300_000);
        // Outside the term nothing is listed.
        assert!(svc.month("2027-06").await.unwrap().lines.is_empty());
    }

    #[tokio::test]
    async fn t38_the_contract_total_must_match_the_confirmed_order() {
        let db = fixture().await;
        let p = ordered_project(&db, "P-R02", vec![line(None, 3_000_000)]).await;
        let svc = RecurringRevenueService::new(db.clone());
        let err = svc
            .create(agreement(p, 300_000, "2026-06", "2027-05"), Some(1))
            .await
            .unwrap_err();
        assert_eq!(fields(err), vec!["monthlyAmount"]);
        // Nothing was written: the plan stays undated.
        let s = OrdersService::new(db.clone()).summary(p).await.unwrap();
        assert_eq!(s.plan.len(), 1);
        assert!(svc.list().await.unwrap().is_empty());

        // Inputs: amount, term and the project.
        let err = svc
            .create(
                AgreementInput {
                    monthly_amount: Some(0),
                    from_month: "2026-6".into(),
                    to_month: String::new(),
                    ..Default::default()
                },
                Some(1),
            )
            .await
            .unwrap_err();
        assert_eq!(
            fields(err),
            vec!["monthlyAmount", "fromMonth", "toMonth", "projectId"]
        );
        // A pre-order project has no order to plan.
        let lead = pipeline_project(&db, "P-R03", 1_200_000, 40, "2027-01").await;
        let err = svc
            .create(agreement(lead, 100_000, "2026-06", "2027-05"), Some(1))
            .await
            .unwrap_err();
        assert_eq!(fields(err), vec!["projectId"]);
        // 10 months fit the 3,000,000 order; a second agreement is refused.
        svc.create(agreement(p, 300_000, "2026-06", "2027-03"), Some(1))
            .await
            .unwrap();
        let err = svc
            .create(agreement(p, 300_000, "2026-06", "2027-03"), Some(1))
            .await
            .unwrap_err();
        assert_eq!(fields(err), vec!["projectId"]);
    }

    #[tokio::test]
    async fn t38_a_change_regenerates_only_months_not_recognized() {
        let db = fixture().await;
        let p = ordered_project(&db, "P-R04", vec![line(None, 3_600_000)]).await;
        let svc = RecurringRevenueService::new(db.clone());
        let a = svc
            .create(agreement(p, 300_000, "2026-06", "2027-05"), Some(1))
            .await
            .unwrap();
        svc.recognize_month("2026-06", Some(1)).await.unwrap();

        // The order grows by 600,000 (approved change) and the agreement is
        // extended by two months: June stays recognized, July on is planned.
        let orders = OrdersService::new(db.clone());
        let s = orders
            .request_change(
                p,
                ChangeRequest {
                    delta_amount: 600_000,
                    plan_month: None,
                    basis: Some("2か月延長".into()),
                },
                Some(2),
            )
            .await
            .unwrap();
        orders
            .decide_change(
                p,
                s.changes[0].id,
                ChangeDecision {
                    approve: true,
                    note: None,
                },
                Some(1),
            )
            .await
            .unwrap();
        let mut longer = agreement(p, 300_000, "2026-06", "2027-07");
        longer.row_version = a.row_version;
        let b = svc.update(a.id, longer, Some(1)).await.unwrap();
        assert_eq!(b.months, 14);
        let s = orders.summary(p).await.unwrap();
        let june = s
            .plan
            .iter()
            .find(|l| l.month.as_deref() == Some("2026-06"))
            .unwrap();
        assert_eq!((june.cleared, june.open), (300_000, 0));
        assert_eq!(s.plan.iter().filter(|l| l.open == 300_000).count(), 13);
        assert!(s.plan.iter().all(|l| l.month.is_some()));
        assert!(s.issues.is_empty());

        // A recognized month cannot leave the term; a stale version and a
        // different project are refused.
        let mut later = agreement(p, 300_000, "2026-07", "2027-08");
        later.row_version = b.row_version;
        assert_eq!(
            fields(svc.update(a.id, later, Some(1)).await.unwrap_err()),
            vec!["fromMonth"]
        );
        let mut stale = agreement(p, 300_000, "2026-06", "2027-07");
        stale.row_version = a.row_version;
        assert_eq!(
            fields(svc.update(a.id, stale, Some(1)).await.unwrap_err()),
            vec!["rowVersion"]
        );
        let other = ordered_project(&db, "P-R05", vec![line(None, 4_200_000)]).await;
        let mut moved = agreement(other, 300_000, "2026-06", "2027-07");
        moved.row_version = b.row_version;
        assert_eq!(
            fields(svc.update(a.id, moved, Some(1)).await.unwrap_err()),
            vec!["projectId"]
        );
    }

    #[tokio::test]
    async fn t38_closed_months_and_closed_projects_are_not_recognized() {
        let db = fixture().await;
        let p = ordered_project(&db, "P-R06", vec![line(None, 1_200_000)]).await;
        let q = ordered_project(&db, "P-R07", vec![line(None, 1_200_000)]).await;
        let svc = RecurringRevenueService::new(db.clone());
        svc.create(agreement(p, 100_000, "2026-06", "2027-05"), Some(1))
            .await
            .unwrap();
        svc.create(agreement(q, 100_000, "2026-06", "2027-05"), Some(1))
            .await
            .unwrap();
        // A settled project's agreement is listed and not recognized.
        let sql = placeholders(
            db.dialect(),
            "UPDATE projects SET status = 'settled' WHERE id = ?",
        );
        on_pool!(&db, pool => execute!(pool, sql, q)).unwrap();
        let r = svc.recognize_month("2026-08", Some(1)).await.unwrap();
        assert_eq!(r.recognized, 1);
        let states: Vec<&str> = r.view.lines.iter().map(|l| l.state.as_str()).collect();
        assert_eq!(states, vec!["recognized", "project_closed"]);

        // The close warns about unrecognized agreements, then refuses
        // recognizing in the closed month.
        let closing = ClosingService::new(db.clone());
        let sept = closing.get("2026-09").await.unwrap();
        assert!(sept
            .warnings
            .iter()
            .any(|w| w.code == "recurring_unrecognized" && w.count == 1));
        closing
            .close("2026-09", CloseInput { row_version: 1 }, Some(1))
            .await
            .unwrap();
        assert!(svc.month("2026-09").await.unwrap().closed);
        assert_eq!(
            fields(svc.recognize_month("2026-09", Some(1)).await.unwrap_err()),
            vec!["month"]
        );
        // Reopened, the month is recognized; a cancelled recognition makes
        // it due again.
        let m = closing.get("2026-09").await.unwrap();
        closing
            .reopen(
                "2026-09",
                ReopenInput {
                    row_version: m.row_version,
                    reason: "計上漏れ".into(),
                },
                Some(1),
            )
            .await
            .unwrap();
        assert_eq!(
            svc.recognize_month("2026-09", Some(1))
                .await
                .unwrap()
                .recognized,
            1
        );
        let orders = OrdersService::new(db.clone());
        let s = orders.summary(p).await.unwrap();
        let sept_rec = s
            .recognitions
            .iter()
            .find(|r| r.recognized_on == "2026-09-30")
            .unwrap();
        orders
            .cancel_recognition(
                p,
                sept_rec.id,
                CancelInput {
                    reason: Some("誤り".into()),
                },
                Some(1),
            )
            .await
            .unwrap();
        assert_eq!(svc.month("2026-09").await.unwrap().due_count, 1);
    }

    #[tokio::test]
    async fn t38_the_target_margin_is_read_on_the_first_month_recognized() {
        let db = fixture().await;
        let p = ordered_project(&db, "P-R08", vec![line(None, 1_200_000)]).await;
        let basis = CalcBasisService::new(db.clone());
        basis
            .add(
                None,
                value(TARGET_MARGIN_ITEM, "2020-01-01", Some(15), "初期"),
                Some(1),
            )
            .await
            .unwrap();
        basis
            .add(
                None,
                value(TARGET_MARGIN_ITEM, "2026-07-01", Some(20), "改定"),
                Some(1),
            )
            .await
            .unwrap();
        let svc = RecurringRevenueService::new(db.clone());
        svc.create(agreement(p, 100_000, "2026-06", "2027-05"), Some(1))
            .await
            .unwrap();
        svc.recognize_month("2026-06", Some(1)).await.unwrap();
        svc.recognize_month("2026-12", Some(1)).await.unwrap();
        // The first acceptance (June 30) reads 15%, not the 20% in force at
        // the later months.
        let today = Date::parse("2027-01-15").unwrap();
        let (rate, on) = crate::forecasts::target_margin(&db, p, today)
            .await
            .unwrap();
        assert_eq!(rate, Some(15));
        assert_eq!(on.as_deref(), Some("2026-06-30"));
    }
}
