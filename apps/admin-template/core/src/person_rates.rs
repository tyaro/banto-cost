//! 個人別の時間原価単価 (banto-cost, `docs/project/design.md` §10.9,
//! 2026-11-14): a person's hourly cost rate for every project, or for one
//! project, with an effective date (版).
//!
//! Service-layer shape (conventions §2): `Clone`, `BantoError`, sqlx, no
//! tauri/axum. The rules live in `cost_domain::person_rate` (resolution order
//! 人×案件 → 人 → 案件の上書き → 会社標準, duplicate / end checks, versions,
//! impact); this module only loads and stores rows. Authorization
//! (`ManagePersonRates`: `finance.rate` + `amount.view`) and audit are the
//! wiring's (`ops::person_rates`).
//!
//! Every change is a new `person_rates` row; nothing is updated or deleted.
//! A row with `value: null` ends the person's own rate (in that scope) from
//! its date on. Approved time entries keep the rate they were costed with:
//! the preview counts them as 当て直しの候補 instead (T44).

use banto_core::{BantoError, FieldError};
use banto_storage::Db;
use cost_domain::calc_basis::{CalcValue, ValueKind};
use cost_domain::person_rate::{
    impact, next_version, resolve_rate, validate_new, PersonRate, PersonRateError,
};
use cost_domain::time::RATE_ITEM;
use cost_domain::Date;
use serde::{Deserialize, Serialize};

use crate::calc_basis::{domain_row, CalcBasisService};
use crate::customers::{clean_optional, field_error};
use crate::orders::{fetch_all, fetch_optional, on_pool, placeholders, scalar, MAX_TEXT_LEN};

/// One saved `person_rates` row, as history.
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PersonRateRow {
    pub id: i64,
    pub user_id: i64,
    /// `null` = the person's rate for every project.
    pub project_id: Option<i64>,
    pub project_code: Option<String>,
    pub project_name: Option<String>,
    pub valid_from: String,
    /// Yen per hour; `null` = the person's own rate ends here.
    pub value: Option<i64>,
    pub version_no: i64,
    pub reason: String,
    pub created_by_name: Option<String>,
    pub created_at: String,
}

/// A person's rate for one project on the date.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRateView {
    pub project_id: i64,
    pub project_code: String,
    pub project_name: String,
    /// The row in effect on the date (`None` = ended or not yet started).
    pub current: Option<PersonRateRow>,
    /// Rows that take effect after the date.
    pub scheduled: Vec<PersonRateRow>,
}

/// One person on the 個人別単価 screen.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonView {
    pub user_id: i64,
    pub display_name: String,
    /// The person's rate for every project in effect on the date.
    pub current: Option<PersonRateRow>,
    pub scheduled: Vec<PersonRateRow>,
    /// Projects with a rate of their own for this person.
    pub projects: Vec<ProjectRateView>,
    /// Every row of the person, newest effective date first.
    pub history: Vec<PersonRateRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonRates {
    pub on: String,
    pub people: Vec<PersonView>,
}

/// A new row. `projectId: null` = every project; `value: null` ends the rate.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonRateInput {
    pub user_id: i64,
    #[serde(default)]
    pub project_id: Option<i64>,
    pub valid_from: String,
    #[serde(default)]
    pub value: Option<i64>,
    #[serde(default)]
    pub reason: Option<String>,
}

/// What adding the row would change (design §10.5, shown before saving).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonRatePreview {
    /// The rate that applies to the person (on the project) on `validFrom`
    /// now, and the one that would (every level, not only personal rates).
    pub before: Option<i64>,
    pub after: Option<i64>,
    pub affected_projects: usize,
    /// Drafts / submissions that will be costed with the new rate when approved.
    pub pending: usize,
    /// Approved entries whose saved rate differs (当て直しの候補, never changed automatically).
    pub correction_candidates: usize,
    pub includes_closed: bool,
}

const ROW_SELECT: &str = "SELECT r.id, r.user_id, r.project_id, p.code AS project_code, \
     p.name AS project_name, r.valid_from, r.value, r.version_no, r.reason, \
     u.display_name AS created_by_name, r.created_at \
     FROM person_rates r LEFT JOIN projects p ON p.id = r.project_id \
     LEFT JOIN users u ON u.id = r.created_by";

const ORDER: &str = " ORDER BY r.valid_from DESC, r.version_no DESC, r.id DESC";

/// Every saved row, newest effective date first.
pub(crate) async fn load(db: &Db) -> Result<Vec<PersonRateRow>, BantoError> {
    let sql = format!("{ROW_SELECT}{ORDER}");
    on_pool!(db, pool => fetch_all!(pool, sql))
}

pub(crate) fn domain_rate(row: &PersonRateRow) -> Option<PersonRate> {
    Some(PersonRate {
        person: row.user_id,
        project: row.project_id,
        valid_from: Date::parse(&row.valid_from)?,
        value: row.value,
        version: u32::try_from(row.version_no).ok()?,
    })
}

pub(crate) fn domain_rates(rows: &[PersonRateRow]) -> Vec<PersonRate> {
    rows.iter().filter_map(domain_rate).collect()
}

/// The saved row a domain row came from.
pub(crate) fn row_id(rows: &[PersonRateRow], rate: &PersonRate) -> Option<i64> {
    rows.iter()
        .find(|r| {
            r.user_id == rate.person
                && r.project_id == rate.project
                && r.version_no == i64::from(rate.version)
                && r.valid_from == rate.valid_from.to_string()
        })
        .map(|r| r.id)
}

/// The row of one scope in effect on `on` (`None` when it has ended or not
/// started; an ended scope falls back as `cost_domain::person_rate` says) and
/// the rows that take effect after it.
fn scope_view<'a>(
    rows: &[&'a PersonRateRow],
    project: Option<i64>,
    on: Date,
) -> (Option<&'a PersonRateRow>, Vec<PersonRateRow>) {
    let dated = |r: &&&'a PersonRateRow| r.project_id == project;
    let current = rows
        .iter()
        .filter(dated)
        .filter_map(|r| Some((Date::parse(&r.valid_from)?, *r)))
        .filter(|(d, _)| *d <= on)
        .max_by_key(|(d, r)| (*d, r.version_no))
        .map(|(_, r)| r)
        .filter(|r| r.value.is_some());
    let scheduled = rows
        .iter()
        .filter(dated)
        .filter(|r| Date::parse(&r.valid_from).is_some_and(|d| d > on))
        .map(|r| (*r).clone())
        .collect();
    (current, scheduled)
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

fn duplicate_error() -> BantoError {
    BantoError::Validation {
        field_errors: vec![field_error(
            "validFrom",
            "同じ適用開始日の行がすでにあります。別の日付にしてください",
        )],
    }
}

/// The two unique indexes turn a concurrent save of the same date or version
/// into a refusal instead of a second row (T13).
fn map_insert_error(err: BantoError) -> BantoError {
    match &err {
        BantoError::Storage(message) if message.to_lowercase().contains("unique") => {
            duplicate_error()
        }
        _ => err,
    }
}

/// Validated input, ready to store.
struct Checked {
    row: PersonRate,
    reason: String,
}

#[derive(Clone)]
pub struct PersonRatesService {
    db: Db,
}

impl PersonRatesService {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    fn sql(&self, s: &str) -> String {
        placeholders(self.db.dialect(), s)
    }

    /// Every account with its rates on `on` (`YYYY-MM-DD`).
    pub async fn list(&self, on: &str) -> Result<PersonRates, BantoError> {
        let date = Date::parse(on.trim()).ok_or_else(|| BantoError::Validation {
            field_errors: vec![field_error("on", "日付は YYYY-MM-DD で入力してください")],
        })?;
        let users: Vec<(i64, String)> = on_pool!(&self.db, pool => fetch_all!(pool,
            "SELECT id, display_name FROM users ORDER BY display_name, id".to_string()))?;
        let rows = load(&self.db).await?;
        let mut people = Vec::with_capacity(users.len());
        for (user_id, display_name) in users {
            let mine: Vec<&PersonRateRow> = rows.iter().filter(|r| r.user_id == user_id).collect();
            let (current, scheduled) = scope_view(&mine, None, date);
            let mut project_ids: Vec<i64> = mine.iter().filter_map(|r| r.project_id).collect();
            project_ids.sort_unstable();
            project_ids.dedup();
            let mut projects = Vec::with_capacity(project_ids.len());
            for pid in project_ids {
                let (current, scheduled) = scope_view(&mine, Some(pid), date);
                let any = mine
                    .iter()
                    .find(|r| r.project_id == Some(pid))
                    .expect("a row of the project");
                projects.push(ProjectRateView {
                    project_id: pid,
                    project_code: any.project_code.clone().unwrap_or_default(),
                    project_name: any.project_name.clone().unwrap_or_default(),
                    current: current.cloned(),
                    scheduled,
                });
            }
            projects.sort_by(|a, b| a.project_code.cmp(&b.project_code));
            people.push(PersonView {
                user_id,
                display_name,
                current: current.cloned(),
                scheduled,
                projects,
                history: mine.into_iter().cloned().collect(),
            });
        }
        Ok(PersonRates {
            on: date.to_string(),
            people,
        })
    }

    /// Validate a new row against the saved rows (`cost_domain::person_rate::validate_new`).
    async fn check(
        &self,
        input: &PersonRateInput,
        rates: &[PersonRate],
    ) -> Result<Checked, BantoError> {
        let user: Option<(i64,)> = on_pool!(&self.db, pool => fetch_optional!(pool,
            self.sql("SELECT id FROM users WHERE id = ?"), input.user_id))?;
        let mut errors = Vec::new();
        if user.is_none() {
            errors.push(field_error("userId", "見つかりません"));
        }
        if let Some(pid) = input.project_id {
            let project: Option<(i64,)> = on_pool!(&self.db, pool => fetch_optional!(pool,
                self.sql("SELECT id FROM projects WHERE id = ?"), pid))?;
            if project.is_none() {
                errors.push(field_error("projectId", "見つかりません"));
            }
        }
        let valid_from = Date::parse(input.valid_from.trim());
        if valid_from.is_none() {
            errors.push(field_error(
                "validFrom",
                "日付は YYYY-MM-DD で入力してください",
            ));
        }
        if let Some(v) = input.value {
            if !ValueKind::Yen.accepts(v) {
                let (lo, hi) = ValueKind::Yen.range();
                errors.push(field_error(
                    "value",
                    format!("{lo}〜{hi} の整数で入力してください"),
                ));
            }
        }
        let reason = clean_optional(&input.reason);
        match &reason {
            None => errors.push(field_error("reason", "変更の理由を入力してください")),
            Some(r) if r.chars().count() > MAX_TEXT_LEN => errors.push(field_error(
                "reason",
                format!("{MAX_TEXT_LEN}文字以内で入力してください"),
            )),
            _ => {}
        }
        validation(errors)?;
        let row = PersonRate {
            person: input.user_id,
            project: input.project_id,
            valid_from: valid_from.expect("checked above"),
            value: input.value,
            version: next_version(rates, input.user_id, input.project_id),
        };
        validate_new(rates, &row).map_err(|e| match e {
            PersonRateError::DuplicateValidFrom => duplicate_error(),
            PersonRateError::NothingToEnd => BantoError::Validation {
                field_errors: vec![field_error(
                    "value",
                    "この範囲には個人別の単価がありません（やめる単価がありません）",
                )],
            },
        })?;
        Ok(Checked {
            row,
            reason: reason.expect("checked above"),
        })
    }

    async fn company_values(&self) -> Result<Vec<CalcValue>, BantoError> {
        Ok(CalcBasisService::new(self.db.clone())
            .value_rows(RATE_ITEM)
            .await?
            .iter()
            .filter_map(domain_row)
            .collect())
    }

    /// What adding the row would change, without saving it (design §10.5).
    pub async fn preview(&self, input: PersonRateInput) -> Result<PersonRatePreview, BantoError> {
        let rates = domain_rates(&load(&self.db).await?);
        let checked = self.check(&input, &rates).await?;
        let values = self.company_values().await?;
        let new = &checked.row;
        let at = |rates: &[PersonRate]| {
            resolve_rate(
                &values,
                rates,
                RATE_ITEM,
                new.person,
                new.project,
                new.valid_from,
            )
            .map(|r| r.value)
        };
        let before = at(&rates);
        let mut after_rates = rates.clone();
        after_rates.push(new.clone());
        let after = at(&after_rates);
        let usages = crate::time_entries::person_usages(&self.db, Some(new.person)).await?;
        let found = impact(&values, &rates, new, &usages);
        Ok(PersonRatePreview {
            before,
            after,
            affected_projects: found.affected_projects.len(),
            pending: found.pending,
            correction_candidates: found.correction_candidates.len(),
            includes_closed: found.includes_closed,
        })
    }

    /// Add a row. Returns the saved row.
    pub async fn add(
        &self,
        input: PersonRateInput,
        actor_user_id: Option<i64>,
    ) -> Result<PersonRateRow, BantoError> {
        let rates = domain_rates(&load(&self.db).await?);
        let checked = self.check(&input, &rates).await?;
        let insert = self.sql(
            "INSERT INTO person_rates (user_id, project_id, valid_from, value, version_no, \
             reason, created_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
        );
        let row = &checked.row;
        let valid_from = row.valid_from.to_string();
        let version = i64::from(row.version);
        let id: i64 = on_pool!(&self.db, pool => scalar!(pool, insert, row.person, row.project,
            &valid_from, row.value, version, &checked.reason, actor_user_id))
        .map_err(map_insert_error)?;
        let sql = self.sql(&format!("{ROW_SELECT} WHERE r.id = ?"));
        let saved: Option<PersonRateRow> =
            on_pool!(&self.db, pool => fetch_optional!(pool, sql, id))?;
        saved.ok_or_else(|| BantoError::Other("保存した個人別単価が見つかりません".into()))
    }
}

/// The audit detail of a saved row, shared by both wiring layers. The rate
/// itself is left out: the audit trail is the system administrator's, who
/// does not see amounts or rates (spec §4 / §11).
pub fn audit_detail(row: &PersonRateRow) -> serde_json::Value {
    serde_json::json!({
        "userId": row.user_id,
        "projectId": row.project_id,
        "validFrom": row.valid_from,
        "versionNo": row.version_no,
        "end": row.value.is_none(),
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::projects::tests::{fixture, input as project_input};
    use crate::projects::ProjectsService;

    pub(crate) fn rate(
        user_id: i64,
        project_id: Option<i64>,
        from: &str,
        value: Option<i64>,
    ) -> PersonRateInput {
        PersonRateInput {
            user_id,
            project_id,
            valid_from: from.into(),
            value,
            reason: Some("架空の単価".into()),
        }
    }

    fn field(err: &BantoError) -> String {
        match err {
            BantoError::Validation { field_errors } => field_errors[0].field.clone(),
            other => panic!("expected a validation error, got {other:?}"),
        }
    }

    async fn setup() -> (PersonRatesService, i64) {
        let db = fixture().await;
        let p = ProjectsService::new(db.clone())
            .create(project_input("P-001"), Some(1))
            .await
            .unwrap();
        (PersonRatesService::new(db), p.id)
    }

    #[tokio::test]
    async fn t43_個人と個人の案件の単価を版で登録して一覧に出す() {
        let (svc, pid) = setup().await;
        let listed = svc.list("2026-11-14").await.unwrap();
        assert_eq!(listed.people.len(), 2);
        assert!(listed.people.iter().all(|p| p.current.is_none()));

        svc.add(rate(2, None, "2026-06-01", Some(6_000)), Some(1))
            .await
            .unwrap();
        svc.add(rate(2, None, "2026-12-01", Some(6_300)), Some(1))
            .await
            .unwrap();
        let saved = svc
            .add(rate(2, Some(pid), "2026-06-01", Some(7_000)), Some(1))
            .await
            .unwrap();
        assert_eq!(saved.project_code.as_deref(), Some("P-001"));
        assert_eq!(saved.version_no, 1);

        let listed = svc.list("2026-11-14").await.unwrap();
        let pm = listed.people.iter().find(|p| p.user_id == 2).unwrap();
        assert_eq!(pm.current.as_ref().and_then(|r| r.value), Some(6_000));
        assert_eq!(pm.scheduled.len(), 1);
        assert_eq!(pm.scheduled[0].value, Some(6_300));
        assert_eq!(pm.projects.len(), 1);
        assert_eq!(
            pm.projects[0].current.as_ref().and_then(|r| r.value),
            Some(7_000)
        );
        assert_eq!(pm.history.len(), 3);

        // 案件の単価をやめると、その案件の行は「なし」になり、一覧には履歴が残る。
        svc.add(rate(2, Some(pid), "2026-11-01", None), Some(1))
            .await
            .unwrap();
        let listed = svc.list("2026-11-14").await.unwrap();
        let pm = listed.people.iter().find(|p| p.user_id == 2).unwrap();
        assert!(pm.projects[0].current.is_none());
        assert_eq!(pm.history.len(), 4);
    }

    #[tokio::test]
    async fn t43_入力の誤りと重複とやめる対象のない行は拒否する() {
        let (svc, pid) = setup().await;
        let err = svc
            .add(rate(99, None, "2026-06-01", Some(6_000)), None)
            .await
            .unwrap_err();
        assert_eq!(field(&err), "userId");
        let err = svc
            .add(rate(2, Some(9_999), "2026-06-01", Some(6_000)), None)
            .await
            .unwrap_err();
        assert_eq!(field(&err), "projectId");
        let err = svc
            .add(rate(2, None, "2026-6-1", Some(6_000)), None)
            .await
            .unwrap_err();
        assert_eq!(field(&err), "validFrom");
        // 0円は未設定と区別できないので受け付けない。
        let err = svc
            .add(rate(2, None, "2026-06-01", Some(0)), None)
            .await
            .unwrap_err();
        assert_eq!(field(&err), "value");
        let mut no_reason = rate(2, None, "2026-06-01", Some(6_000));
        no_reason.reason = Some("  ".into());
        assert_eq!(
            field(&svc.add(no_reason, None).await.unwrap_err()),
            "reason"
        );
        let err = svc
            .add(rate(2, Some(pid), "2026-06-01", None), None)
            .await
            .unwrap_err();
        assert_eq!(field(&err), "value");

        svc.add(rate(2, None, "2026-06-01", Some(6_000)), None)
            .await
            .unwrap();
        let err = svc
            .add(rate(2, None, "2026-06-01", Some(6_100)), None)
            .await
            .unwrap_err();
        assert_eq!(field(&err), "validFrom");
        // 同じ日の重複は索引でも止まる（同時保存、T13）。
        let insert =
            "INSERT INTO person_rates (user_id, project_id, valid_from, value, version_no, \
             reason) VALUES (2, NULL, '2026-06-01', 6100, 9, 'x') RETURNING id"
                .to_string();
        let err: BantoError = on_pool!(&svc.db, pool => scalar!(pool, insert))
            .map(|_: i64| ())
            .map_err(map_insert_error)
            .unwrap_err();
        assert_eq!(field(&err), "validFrom");
    }

    #[tokio::test]
    async fn audit_detail_leaves_the_rate_out() {
        let (svc, _) = setup().await;
        let row = svc
            .add(rate(2, None, "2026-06-01", Some(6_000)), Some(1))
            .await
            .unwrap();
        let detail = audit_detail(&row).to_string();
        assert!(!detail.contains("6000"), "{detail}");
        assert!(!detail.contains("架空の単価"), "{detail}");
    }
}
