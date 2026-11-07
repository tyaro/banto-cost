//! Calc basis (計算基準, banto-cost P4a, `docs/project/design.md` §10): hourly
//! cost rates, the day length, thresholds - company values with an effective
//! date (版), overridable per project and per item.
//!
//! Service-layer shape (conventions §2): `Clone`, `BantoError`, sqlx, no
//! tauri/axum. The rules live in `cost_domain::calc_basis` (resolution order,
//! duplicate / override checks, value ranges, version numbers, impact); this
//! module only loads and stores rows. Authorization (`ViewCalcBasis`,
//! `EditCalcBasis`, `OverrideCalcBasis`, `ViewProjectAmounts`, ADR-0028) and
//! audit are the REST/Tauri wiring's.
//!
//! Every change is a new `calc_values` row; nothing is updated or deleted
//! (T31). A project row with `value: null` reverts to the company basis from
//! its date on (T34). Values already used by approved records are never
//! rewritten here: the impact preview lists them as correction candidates
//! instead (T33, design §10.5). Time entries report their usages of
//! `emp_rate` (P4b); direct costs and outlooks will add theirs.

use std::collections::BTreeMap;
use std::str::FromStr;

use banto_admin_services::authz::Capability;
use banto_core::{BantoError, FieldError};
use banto_storage::Db;
use cost_domain::calc_basis::{
    impact, next_version, resolve, shielded_projects, validate_new, CalcBasisError, CalcValue,
    Scope, Source, Usage, ValueKind,
};
use cost_domain::Date;
use serde::{Deserialize, Serialize};

use crate::customers::{clean_optional, field_error};
use crate::orders::{fetch_all, fetch_optional, on_pool, placeholders, scalar, MAX_TEXT_LEN};

/// One `calc_items` row (design §10.3/§10.4).
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct CalcItem {
    pub key: String,
    /// `labor` | `subcontract` | `conversion` | `travel` | `tax_input` | `alert`.
    pub item_group: String,
    /// Japanese label kept in the DB for items added later; the screen
    /// shows its own translated label for the seeded keys.
    pub label: String,
    /// `yen_per_hour` | `yen_per_night` | `yen_per_km` | `minutes` | `percent` | `days`.
    pub unit: String,
    /// `cost_domain::calc_basis::ValueKind` (`yen` | `minutes` | `percent` | `days`).
    pub value_type: String,
    pub project_overridable: bool,
    /// The project's manager may override it too (not only the change right).
    pub managers_may_override: bool,
    /// The capability that changes the company value.
    pub edit_capability: String,
    pub sort_order: i64,
}

impl CalcItem {
    fn kind(&self) -> Result<ValueKind, BantoError> {
        ValueKind::parse(&self.value_type)
            .ok_or_else(|| BantoError::Other(format!("不明な値の種類です: {}", self.value_type)))
    }

    /// The capability that changes the company value (and any project's override).
    pub fn capability(&self) -> Result<Capability, BantoError> {
        Capability::from_str(&self.edit_capability)
    }
}

/// One saved `calc_values` row, as history.
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct CalcValueRow {
    pub id: i64,
    pub item_key: String,
    /// `company` | `project`.
    pub scope: String,
    pub project_id: Option<i64>,
    pub valid_from: String,
    /// `null` on a project row = back to the company basis.
    pub value: Option<i64>,
    pub version_no: i64,
    pub reason: String,
    pub created_by_name: Option<String>,
    pub created_at: String,
}

/// An item's company basis on a date (管理設定 → 計算基準).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyItemView {
    pub item: CalcItem,
    /// The company row in effect on the date (`None` = 未設定).
    pub current: Option<CalcValueRow>,
    /// Company rows that take effect after the date.
    pub scheduled: Vec<CalcValueRow>,
    /// Projects whose own override is in effect on the date.
    pub overriding_projects: usize,
    /// Every company row, newest effective date first.
    pub history: Vec<CalcValueRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyBasis {
    pub on: String,
    pub items: Vec<CompanyItemView>,
}

/// Where a project's applied value comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AppliedSource {
    Company,
    Project,
    /// Neither the project nor the company has a value (未設定).
    Unset,
}

/// An item on a project's 計算基準 tab.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectItemView {
    pub item: CalcItem,
    pub company: Option<CalcValueRow>,
    pub applied_value: Option<i64>,
    pub source: AppliedSource,
    /// The project row in effect when `source` is `project`.
    pub override_row: Option<CalcValueRow>,
    /// This project's rows for the item (overrides and reverts), newest first.
    pub history: Vec<CalcValueRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBasis {
    pub project_id: i64,
    pub on: String,
    pub items: Vec<ProjectItemView>,
}

/// A new row. On a project, `value: None` reverts to the company basis.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalcValueInput {
    pub item_key: String,
    pub valid_from: String,
    #[serde(default)]
    pub value: Option<i64>,
    #[serde(default)]
    pub reason: Option<String>,
}

/// A project shielded from a company change by its own override.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRef {
    pub id: i64,
    pub code: String,
}

/// What adding a row would change (design §10.5, shown before saving).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImpactPreview {
    /// The value that applies on `validFrom` now, and the one that would.
    pub before: Option<i64>,
    pub after: Option<i64>,
    /// Projects whose records change value.
    pub affected_projects: usize,
    /// Company change only: projects whose own override keeps their value.
    pub shielded_projects: Vec<ProjectRef>,
    /// Drafts / submissions that will be costed with the new value when approved.
    pub pending: usize,
    /// Approved records whose saved value differs (never changed automatically, T33).
    pub correction_candidates: usize,
    pub includes_closed: bool,
}

/// Validated input, ready to store.
struct Checked {
    item: CalcItem,
    row: CalcValue,
    reason: String,
    project_id: Option<i64>,
}

const ROW_SELECT: &str = "SELECT v.id, v.item_key, v.scope, v.project_id, v.valid_from, v.value, \
     v.version_no, v.reason, u.display_name AS created_by_name, v.created_at \
     FROM calc_values v LEFT JOIN users u ON u.id = v.created_by";

const ITEM_SELECT: &str = "SELECT key, item_group, label, unit, value_type, project_overridable, \
     managers_may_override, edit_capability, sort_order FROM calc_items";

/// The value of `item` that applies to the project (or the company, with
/// `project_id: None`) on `on`, with the `calc_values` row it came from
/// (design §10.2). `None` = 未設定 (never 0).
pub(crate) async fn applied_value(
    db: &Db,
    item: &str,
    project_id: Option<i64>,
    on: Date,
) -> Result<Option<(i64, Option<i64>)>, BantoError> {
    let rows = CalcBasisService::new(db.clone()).value_rows(item).await?;
    let values: Vec<CalcValue> = rows.iter().filter_map(domain_row).collect();
    let pid = project_id.map(|p| p.to_string());
    Ok(resolve(&values, item, pid.as_deref(), on, None).map(|r| {
        let row = crate::time_entries::row_of(&rows, &r.source, project_id);
        (r.value, row)
    }))
}

pub(crate) fn domain_row(row: &CalcValueRow) -> Option<CalcValue> {
    Some(CalcValue {
        item: row.item_key.clone(),
        scope: match row.project_id {
            Some(pid) if row.scope == "project" => Scope::Project(pid.to_string()),
            _ => Scope::Company,
        },
        valid_from: Date::parse(&row.valid_from)?,
        value: row.value,
        version: u32::try_from(row.version_no).ok()?,
    })
}

fn parse_on(on: &str) -> Result<Date, BantoError> {
    Date::parse(on.trim()).ok_or_else(|| BantoError::Validation {
        field_errors: vec![field_error("on", "日付は YYYY-MM-DD で入力してください")],
    })
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

/// The two unique indexes of `calc_values` turn a concurrent save of the
/// same date or version into a refusal instead of a second row (T13).
fn map_insert_error(err: BantoError) -> BantoError {
    match &err {
        BantoError::Storage(message) if message.to_lowercase().contains("unique") => {
            duplicate_error()
        }
        _ => err,
    }
}

#[derive(Clone)]
pub struct CalcBasisService {
    db: Db,
}

impl CalcBasisService {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    fn sql(&self, s: &str) -> String {
        placeholders(self.db.dialect(), s)
    }

    /// Active items in display order.
    pub async fn items(&self) -> Result<Vec<CalcItem>, BantoError> {
        let sql = format!(
            "{ITEM_SELECT} WHERE active = {} ORDER BY sort_order, key",
            self.true_lit()
        );
        on_pool!(&self.db, pool => fetch_all!(pool, sql))
    }

    fn true_lit(&self) -> &'static str {
        match self.db.dialect() {
            banto_storage::Dialect::Sqlite => "1",
            banto_storage::Dialect::Postgres => "TRUE",
        }
    }

    /// One active item (validation error on `itemKey` when unknown).
    pub async fn item(&self, key: &str) -> Result<CalcItem, BantoError> {
        let sql = self.sql(&format!(
            "{ITEM_SELECT} WHERE key = ? AND active = {}",
            self.true_lit()
        ));
        let item: Option<CalcItem> = on_pool!(&self.db, pool => fetch_optional!(pool, sql, key))?;
        item.ok_or_else(|| BantoError::Validation {
            field_errors: vec![field_error("itemKey", "不明な計算基準の項目です")],
        })
    }

    async fn rows_of(&self, item_key: Option<&str>) -> Result<Vec<CalcValueRow>, BantoError> {
        let order = " ORDER BY v.valid_from DESC, v.version_no DESC, v.id DESC";
        match item_key {
            Some(key) => {
                let sql = self.sql(&format!("{ROW_SELECT} WHERE v.item_key = ?{order}"));
                on_pool!(&self.db, pool => fetch_all!(pool, sql, key))
            }
            None => {
                let sql = format!("{ROW_SELECT}{order}");
                on_pool!(&self.db, pool => fetch_all!(pool, sql))
            }
        }
    }

    async fn project_code(&self, project_id: i64) -> Result<String, BantoError> {
        let sql = self.sql("SELECT code FROM projects WHERE id = ?");
        let code: Option<(String,)> =
            on_pool!(&self.db, pool => fetch_optional!(pool, sql, project_id))?;
        code.map(|(c,)| c).ok_or_else(|| BantoError::NotFound {
            resource: "projects".into(),
            id: project_id.to_string(),
        })
    }

    /// The company basis on `on` (`YYYY-MM-DD`).
    pub async fn company(&self, on: &str) -> Result<CompanyBasis, BantoError> {
        let date = parse_on(on)?;
        let items = self.items().await?;
        let rows = self.rows_of(None).await?;
        let values: Vec<CalcValue> = rows.iter().filter_map(domain_row).collect();
        let mut out = Vec::with_capacity(items.len());
        for item in items {
            let mine: Vec<&CalcValueRow> = rows.iter().filter(|r| r.item_key == item.key).collect();
            let history: Vec<CalcValueRow> = mine
                .iter()
                .filter(|r| r.scope == "company")
                .map(|r| (*r).clone())
                .collect();
            let current = current_company(&values, &history, &item.key, date);
            let scheduled = history
                .iter()
                .filter(|r| Date::parse(&r.valid_from).is_some_and(|d| d > date))
                .cloned()
                .collect();
            let probe = CalcValue {
                item: item.key.clone(),
                scope: Scope::Company,
                valid_from: date,
                value: Some(0),
                version: 0,
            };
            let overriding_projects = shielded_projects(&values, &probe).len();
            out.push(CompanyItemView {
                item,
                current,
                scheduled,
                overriding_projects,
                history,
            });
        }
        Ok(CompanyBasis {
            on: date.to_string(),
            items: out,
        })
    }

    /// A project's applied values on `on` and its override history.
    pub async fn project(&self, project_id: i64, on: &str) -> Result<ProjectBasis, BantoError> {
        let date = parse_on(on)?;
        self.project_code(project_id).await?;
        let items = self.items().await?;
        let rows = self.rows_of(None).await?;
        let values: Vec<CalcValue> = rows.iter().filter_map(domain_row).collect();
        let pid = project_id.to_string();
        let mut out = Vec::with_capacity(items.len());
        for item in items {
            let company_rows: Vec<CalcValueRow> = rows
                .iter()
                .filter(|r| r.item_key == item.key && r.scope == "company")
                .cloned()
                .collect();
            let history: Vec<CalcValueRow> = rows
                .iter()
                .filter(|r| {
                    r.item_key == item.key
                        && r.scope == "project"
                        && r.project_id == Some(project_id)
                })
                .cloned()
                .collect();
            let company = current_company(&values, &company_rows, &item.key, date);
            let resolved = resolve(&values, &item.key, Some(&pid), date, None);
            let (applied_value, source, override_row) = match resolved {
                None => (None, AppliedSource::Unset, None),
                Some(r) => match r.source {
                    Source::ProjectOverride { valid_from } => (
                        Some(r.value),
                        AppliedSource::Project,
                        history
                            .iter()
                            .find(|h| h.value.is_some() && h.valid_from == valid_from.to_string())
                            .cloned(),
                    ),
                    _ => (Some(r.value), AppliedSource::Company, None),
                },
            };
            out.push(ProjectItemView {
                item,
                company,
                applied_value,
                source,
                override_row,
                history,
            });
        }
        Ok(ProjectBasis {
            project_id,
            on: date.to_string(),
            items: out,
        })
    }

    /// Validate a new row for `project_id` (`None` = company) against the
    /// item and the saved rows (`cost_domain::calc_basis::validate_new`).
    async fn check(
        &self,
        project_id: Option<i64>,
        input: &CalcValueInput,
        values: &[CalcValue],
    ) -> Result<Checked, BantoError> {
        let item = self.item(input.item_key.trim()).await?;
        if let Some(pid) = project_id {
            self.project_code(pid).await?;
        }
        let kind = item.kind()?;
        let mut errors = Vec::new();
        let valid_from = Date::parse(input.valid_from.trim());
        if valid_from.is_none() {
            errors.push(field_error(
                "validFrom",
                "日付は YYYY-MM-DD で入力してください",
            ));
        }
        match input.value {
            None if project_id.is_none() => {
                errors.push(field_error("value", "値を入力してください"));
            }
            Some(v) if !kind.accepts(v) => {
                let (lo, hi) = kind.range();
                errors.push(field_error(
                    "value",
                    format!("{lo}〜{hi} の整数で入力してください"),
                ));
            }
            _ => {}
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
        let scope = match project_id {
            Some(pid) => Scope::Project(pid.to_string()),
            None => Scope::Company,
        };
        if project_id.is_some()
            && input.value.is_none()
            && !values
                .iter()
                .any(|r| r.item == item.key && r.scope == scope && r.value.is_some())
        {
            return Err(BantoError::Validation {
                field_errors: vec![field_error(
                    "value",
                    "この案件はこの項目を上書きしていません（会社基準のままです）",
                )],
            });
        }
        let row = CalcValue {
            item: item.key.clone(),
            version: next_version(values, &item.key, &scope),
            scope,
            valid_from: valid_from.expect("checked above"),
            value: input.value,
        };
        validate_new(values, &row, item.project_overridable).map_err(|e| match e {
            CalcBasisError::DuplicateValidFrom => duplicate_error(),
            CalcBasisError::CompanyValueMissing => BantoError::Validation {
                field_errors: vec![field_error("value", "値を入力してください")],
            },
            CalcBasisError::OverrideNotAllowed => BantoError::Validation {
                field_errors: vec![field_error(
                    "itemKey",
                    "この項目は案件ごとに上書きできません",
                )],
            },
        })?;
        Ok(Checked {
            item,
            row,
            reason: reason.expect("checked above"),
            project_id,
        })
    }

    async fn domain_values(&self, item_key: &str) -> Result<Vec<CalcValue>, BantoError> {
        Ok(self
            .rows_of(Some(item_key.trim()))
            .await?
            .iter()
            .filter_map(domain_row)
            .collect())
    }

    /// Every saved row of an item (newest effective date first), for the
    /// ledgers that fix an applied value at approval (time entries, P4b).
    pub(crate) async fn value_rows(&self, item_key: &str) -> Result<Vec<CalcValueRow>, BantoError> {
        self.rows_of(Some(item_key)).await
    }

    /// Records that use the item, so the preview counts them (design §10.5).
    /// Time entries use `emp_rate` (P4b), budget drafts `budget_rate` (P4c);
    /// costs and outlooks add theirs later.
    async fn usages(&self, item_key: &str) -> Result<Vec<Usage>, BantoError> {
        let mut found = crate::time_entries::usages(&self.db, item_key).await?;
        found.extend(crate::budgets::usages(&self.db, item_key).await?);
        found.extend(crate::forecasts::usages(&self.db, item_key).await?);
        Ok(found)
    }

    /// The item a request names, for the wiring layer's authorization.
    pub async fn item_for(&self, input: &CalcValueInput) -> Result<CalcItem, BantoError> {
        self.item(input.item_key.trim()).await
    }

    /// What adding the row would change, without saving it (design §10.5).
    pub async fn preview(
        &self,
        project_id: Option<i64>,
        input: CalcValueInput,
    ) -> Result<ImpactPreview, BantoError> {
        let values = self.domain_values(&input.item_key).await?;
        let checked = self.check(project_id, &input, &values).await?;
        let pid = project_id.map(|p| p.to_string());
        let on = checked.row.valid_from;
        let before = resolve(&values, &checked.item.key, pid.as_deref(), on, None).map(|r| r.value);
        let mut after_values = values.clone();
        after_values.push(checked.row.clone());
        let after =
            resolve(&after_values, &checked.item.key, pid.as_deref(), on, None).map(|r| r.value);
        let usages = self.usages(&checked.item.key).await?;
        let found = impact(&values, &checked.row, &usages);
        let mut shielded = Vec::new();
        for id in shielded_projects(&values, &checked.row) {
            if let Ok(id) = id.parse::<i64>() {
                shielded.push(ProjectRef {
                    id,
                    code: self.project_code(id).await?,
                });
            }
        }
        Ok(ImpactPreview {
            before,
            after,
            affected_projects: found.affected_projects.len(),
            shielded_projects: shielded,
            pending: found.pending,
            correction_candidates: found.correction_candidates.len(),
            includes_closed: found.includes_closed,
        })
    }

    /// Add a row (company when `project_id` is `None`). Returns the saved row.
    pub async fn add(
        &self,
        project_id: Option<i64>,
        input: CalcValueInput,
        actor_user_id: Option<i64>,
    ) -> Result<CalcValueRow, BantoError> {
        let values = self.domain_values(&input.item_key).await?;
        let checked = self.check(project_id, &input, &values).await?;
        let insert = self.sql(
            "INSERT INTO calc_values (item_key, scope, project_id, valid_from, value, version_no, \
             reason, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        );
        let scope = if checked.project_id.is_some() {
            "project"
        } else {
            "company"
        };
        let valid_from = checked.row.valid_from.to_string();
        let version = i64::from(checked.row.version);
        let id: i64 = on_pool!(&self.db, pool => scalar!(pool, insert, &checked.item.key, scope,
            checked.project_id, &valid_from, checked.row.value, version, &checked.reason,
            actor_user_id))
        .map_err(map_insert_error)?;
        let sql = self.sql(&format!("{ROW_SELECT} WHERE v.id = ?"));
        let row: Option<CalcValueRow> = on_pool!(&self.db, pool => fetch_optional!(pool, sql, id))?;
        row.ok_or_else(|| BantoError::Other("保存した計算基準が見つかりません".into()))
    }

    /// Count of rows, for tests that check nothing was rewritten.
    #[cfg(test)]
    async fn count(&self) -> i64 {
        let sql = "SELECT COUNT(*) FROM calc_values".to_string();
        on_pool!(&self.db, pool => scalar!(pool, sql)).unwrap()
    }
}

/// The audit detail of a saved row, shared by both wiring layers. The value
/// itself is left out: the audit trail is the system administrator's, who
/// does not see amounts or rates (spec §4 / §11).
pub fn audit_detail(row: &CalcValueRow) -> serde_json::Value {
    serde_json::json!({
        "itemKey": row.item_key,
        "scope": row.scope,
        "projectId": row.project_id,
        "validFrom": row.valid_from,
        "versionNo": row.version_no,
        "revert": row.scope == "project" && row.value.is_none(),
    })
}

/// The company row in effect on `on`, picked by the domain's resolution.
fn current_company(
    values: &[CalcValue],
    company_rows: &[CalcValueRow],
    item: &str,
    on: Date,
) -> Option<CalcValueRow> {
    let resolved = resolve(values, item, None, on, None)?;
    let Source::Company {
        version,
        valid_from,
    } = resolved.source
    else {
        return None;
    };
    let by_key: BTreeMap<(String, i64), &CalcValueRow> = company_rows
        .iter()
        .map(|r| ((r.valid_from.clone(), r.version_no), r))
        .collect();
    by_key
        .get(&(valid_from.to_string(), i64::from(version)))
        .map(|r| (*r).clone())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::projects::tests::{fixture, input as project_input};
    use crate::projects::ProjectsService;

    pub(crate) fn value(
        item: &str,
        from: &str,
        value: Option<i64>,
        reason: &str,
    ) -> CalcValueInput {
        CalcValueInput {
            item_key: item.into(),
            valid_from: from.into(),
            value,
            reason: Some(reason.into()),
        }
    }

    async fn setup() -> (CalcBasisService, i64, i64) {
        let db = fixture().await;
        let projects = ProjectsService::new(db.clone());
        let p1 = projects
            .create(project_input("P-001"), Some(1))
            .await
            .unwrap();
        let p2 = projects
            .create(project_input("P-002"), Some(1))
            .await
            .unwrap();
        (CalcBasisService::new(db), p1.id, p2.id)
    }

    fn field(err: &BantoError) -> String {
        match err {
            BantoError::Validation { field_errors } => field_errors[0].field.clone(),
            other => panic!("expected a validation error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn items_are_seeded_without_values() {
        let (svc, _, _) = setup().await;
        let items = svc.items().await.unwrap();
        assert_eq!(items.len(), 12);
        assert_eq!(items[0].key, "emp_rate");
        let basis = svc.company("2026-11-06").await.unwrap();
        assert!(
            basis.items.iter().all(|i| i.current.is_none()),
            "nothing is preset: an unset item is 未設定, not 0"
        );
        let tax = items.iter().find(|i| i.key == "tax_rate").unwrap();
        assert!(!tax.project_overridable);
        assert_eq!(tax.capability().unwrap(), Capability::FinanceClose);
    }

    #[tokio::test]
    async fn t31_a_new_company_version_keeps_the_old_one_for_earlier_dates() {
        let (svc, _, _) = setup().await;
        let v1 = svc
            .add(
                None,
                value("emp_rate", "2025-06-01", Some(4_800), "第12期の単価"),
                Some(1),
            )
            .await
            .unwrap();
        assert_eq!(v1.version_no, 1);
        assert_eq!(v1.created_by_name.as_deref(), Some("管理者"));
        let v2 = svc
            .add(
                None,
                value("emp_rate", "2026-06-01", Some(5_000), "第13期の単価"),
                Some(1),
            )
            .await
            .unwrap();
        assert_eq!(v2.version_no, 2);

        let before = svc.company("2026-05-31").await.unwrap();
        let emp = &before.items[0];
        assert_eq!(emp.current.as_ref().unwrap().value, Some(4_800));
        assert_eq!(
            emp.scheduled.len(),
            1,
            "the 2026-06-01 version is scheduled"
        );
        let after = svc.company("2026-06-01").await.unwrap();
        let emp = &after.items[0];
        assert_eq!(emp.current.as_ref().unwrap().version_no, 2);
        assert_eq!(emp.history.len(), 2, "history keeps both versions");
        assert!(emp.scheduled.is_empty());
    }

    #[tokio::test]
    async fn t32_t34_project_override_and_revert() {
        let (svc, p1, p2) = setup().await;
        svc.add(
            None,
            value("forecast_rate", "2026-06-01", Some(5_000), "標準"),
            Some(1),
        )
        .await
        .unwrap();
        svc.add(
            Some(p1),
            value("forecast_rate", "2026-12-10", Some(5_500), "外注比率が高い"),
            Some(2),
        )
        .await
        .unwrap();

        let item = |b: &ProjectBasis| {
            b.items
                .iter()
                .find(|i| i.item.key == "forecast_rate")
                .unwrap()
                .clone()
        };
        let on = item(&svc.project(p1, "2026-12-10").await.unwrap());
        assert_eq!(on.applied_value, Some(5_500));
        assert_eq!(on.source, AppliedSource::Project);
        assert_eq!(on.override_row.unwrap().valid_from, "2026-12-10");
        assert_eq!(on.company.unwrap().value, Some(5_000));
        let before = item(&svc.project(p1, "2026-12-09").await.unwrap());
        assert_eq!(before.applied_value, Some(5_000));
        assert_eq!(before.source, AppliedSource::Company);
        let other = item(&svc.project(p2, "2026-12-10").await.unwrap());
        assert_eq!(
            other.applied_value,
            Some(5_000),
            "other projects keep the company basis"
        );

        let company = svc.company("2026-12-10").await.unwrap();
        let fc = company
            .items
            .iter()
            .find(|i| i.item.key == "forecast_rate")
            .unwrap();
        assert_eq!(fc.overriding_projects, 1);

        // T34: back to the company basis; the override stays as history.
        svc.add(
            Some(p1),
            value("forecast_rate", "2027-01-01", None, "会社基準に戻す"),
            Some(2),
        )
        .await
        .unwrap();
        let reverted = item(&svc.project(p1, "2027-01-01").await.unwrap());
        assert_eq!(reverted.applied_value, Some(5_000));
        assert_eq!(reverted.source, AppliedSource::Company);
        assert_eq!(reverted.history.len(), 2);
        assert_eq!(
            item(&svc.project(p1, "2026-12-31").await.unwrap()).applied_value,
            Some(5_500)
        );
    }

    #[tokio::test]
    async fn preview_counts_shielded_projects_and_saves_nothing() {
        let (svc, p1, _) = setup().await;
        svc.add(
            None,
            value("budget_rate", "2026-06-01", Some(5_000), "標準"),
            Some(1),
        )
        .await
        .unwrap();
        svc.add(
            Some(p1),
            value("budget_rate", "2026-07-01", Some(6_000), "特殊作業"),
            Some(1),
        )
        .await
        .unwrap();
        let rows = svc.count().await;
        let preview = svc
            .preview(
                None,
                value("budget_rate", "2026-12-01", Some(5_200), "改定"),
            )
            .await
            .unwrap();
        assert_eq!(preview.before, Some(5_000));
        assert_eq!(preview.after, Some(5_200));
        assert_eq!(
            preview.shielded_projects,
            vec![ProjectRef {
                id: p1,
                code: "P-001".into()
            }]
        );
        assert_eq!(preview.pending, 0);
        assert_eq!(preview.correction_candidates, 0);
        assert_eq!(svc.count().await, rows, "a preview stores nothing");

        let project = svc
            .preview(Some(p1), value("budget_rate", "2026-12-01", None, "戻す"))
            .await
            .unwrap();
        assert_eq!(project.before, Some(6_000));
        assert_eq!(project.after, Some(5_000));
        assert!(project.shielded_projects.is_empty());
    }

    #[tokio::test]
    async fn rejects_bad_rows_without_storing_them() {
        let (svc, p1, _) = setup().await;
        svc.add(
            None,
            value("emp_rate", "2026-06-01", Some(5_000), "標準"),
            Some(1),
        )
        .await
        .unwrap();
        let cases = [
            (
                None,
                value("emp_rate", "2026-06-01", Some(5_100), "重複"),
                "validFrom",
            ),
            (
                None,
                value("emp_rate", "2026-13-01", Some(5_100), "日付"),
                "validFrom",
            ),
            (
                None,
                value("emp_rate", "2027-06-01", None, "未設定"),
                "value",
            ),
            (
                None,
                value("emp_rate", "2027-06-01", Some(0), "0円"),
                "value",
            ),
            (
                None,
                value("tax_rate", "2027-06-01", Some(101), "範囲外"),
                "value",
            ),
            (
                None,
                value("emp_rate", "2027-06-01", Some(5_100), "  "),
                "reason",
            ),
            (
                None,
                value("no_such", "2027-06-01", Some(1), "不明"),
                "itemKey",
            ),
            (
                Some(p1),
                value("tax_rate", "2027-06-01", Some(8), "上書き不可"),
                "itemKey",
            ),
            (
                Some(p1),
                value("emp_rate", "2027-06-01", None, "上書きなし"),
                "value",
            ),
        ];
        for (pid, input, expected) in cases {
            let err = svc.add(pid, input, Some(1)).await.unwrap_err();
            assert_eq!(field(&err), expected);
        }
        assert_eq!(svc.count().await, 1);
        assert!(matches!(
            svc.add(
                Some(999),
                value("emp_rate", "2027-06-01", Some(5_000), "x"),
                Some(1)
            )
            .await,
            Err(BantoError::NotFound { .. })
        ));
        assert!(matches!(
            svc.company("2026/11/06").await,
            Err(BantoError::Validation { .. })
        ));
    }

    #[tokio::test]
    async fn t13_the_unique_index_refuses_a_concurrent_duplicate() {
        let (svc, _, _) = setup().await;
        svc.add(
            None,
            value("day_minutes", "2026-06-01", Some(480), "8時間"),
            Some(1),
        )
        .await
        .unwrap();
        // Simulate a second save that passed its check before the first committed.
        let insert = svc.sql(
            "INSERT INTO calc_values (item_key, scope, project_id, valid_from, value, version_no, \
             reason) VALUES ('day_minutes', 'company', NULL, '2026-06-01', 450, 2, 'x') RETURNING id",
        );
        let err: BantoError = on_pool!(&svc.db, pool => scalar!(pool, insert))
            .map(|_: i64| ())
            .map_err(map_insert_error)
            .unwrap_err();
        assert_eq!(field(&err), "validFrom");
        assert_eq!(svc.count().await, 1);
    }
}
