//! Phase and common-activity masters (工程・共通活動, banto-cost P4b,
//! `docs/project/design.md` §3.3, spec §5.2).
//!
//! Service-layer shape (conventions §2): `Clone`, `BantoError`, sqlx, no
//! tauri/axum. Authorization (`ViewMasters` / `EditMasters`, the `admin` role
//! passes too, ADR-0028) and audit are the REST/Tauri wiring's. Rows are
//! never deleted: one that is no longer used is made inactive, so the time
//! entries that refer to it keep their history (spec §10). Inactive rows
//! cannot be chosen for a new entry.

use banto_core::BantoError;
use banto_server::ServerEvent;
use banto_storage::Db;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::customers::{field_error, now_expr, stale_version_error};
use crate::orders::{execute, fetch_all, fetch_optional, on_pool, placeholders, scalar};

pub const MAX_NAME_LEN: usize = 100;

/// Which master. The table name comes from this enum only, never from input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MasterKind {
    Phases,
    Activities,
}

impl MasterKind {
    fn table(self) -> &'static str {
        match self {
            MasterKind::Phases => "phases",
            MasterKind::Activities => "common_activities",
        }
    }

    /// The audit/event resource name.
    pub fn resource(self) -> &'static str {
        match self {
            MasterKind::Phases => "phases",
            MasterKind::Activities => "common_activities",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct WorkMaster {
    pub id: i64,
    pub name: String,
    pub sort_order: i64,
    pub active: bool,
    /// Optimistic-concurrency token (T13).
    pub row_version: i64,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkMasterInput {
    pub name: String,
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default = "default_true")]
    pub active: bool,
    /// Required on update (T13); ignored on create.
    #[serde(default)]
    pub row_version: Option<i64>,
}

fn default_true() -> bool {
    true
}

const COLUMNS: &str = "id, name, sort_order, active, row_version, updated_at";

fn validate(input: &WorkMasterInput) -> Result<String, BantoError> {
    let name = input.name.trim().to_string();
    let message = if name.is_empty() {
        Some("入力してください".to_string())
    } else if name.chars().count() > MAX_NAME_LEN {
        Some(format!("{MAX_NAME_LEN}文字以内で入力してください"))
    } else {
        None
    };
    match message {
        Some(m) => Err(BantoError::Validation {
            field_errors: vec![field_error("name", m)],
        }),
        None => Ok(name),
    }
}

#[derive(Clone)]
pub struct WorkMastersService {
    db: Db,
    events: Option<broadcast::Sender<ServerEvent>>,
}

impl WorkMastersService {
    pub fn new(db: Db) -> Self {
        Self { db, events: None }
    }

    /// Emit `ResourceChanged` (`phases` / `common_activities`) after each
    /// committed write, as the other business services do.
    pub fn with_events(mut self, events: broadcast::Sender<ServerEvent>) -> Self {
        self.events = Some(events);
        self
    }

    fn sql(&self, s: &str) -> String {
        placeholders(self.db.dialect(), s)
    }

    /// Every row (active and inactive) in display order.
    pub async fn list(&self, kind: MasterKind) -> Result<Vec<WorkMaster>, BantoError> {
        let sql = format!(
            "SELECT {COLUMNS} FROM {} ORDER BY sort_order, id",
            kind.table()
        );
        on_pool!(&self.db, pool => fetch_all!(pool, sql))
    }

    pub async fn get(&self, kind: MasterKind, id: i64) -> Result<WorkMaster, BantoError> {
        let sql = self.sql(&format!(
            "SELECT {COLUMNS} FROM {} WHERE id = ?",
            kind.table()
        ));
        let row: Option<WorkMaster> = on_pool!(&self.db, pool => fetch_optional!(pool, sql, id))?;
        row.ok_or_else(|| BantoError::NotFound {
            resource: kind.resource().into(),
            id: id.to_string(),
        })
    }

    pub async fn create(
        &self,
        kind: MasterKind,
        input: WorkMasterInput,
    ) -> Result<WorkMaster, BantoError> {
        let name = validate(&input)?;
        let sql = self.sql(&format!(
            "INSERT INTO {} (name, sort_order, active) VALUES (?, ?, ?) RETURNING id",
            kind.table()
        ));
        let id: i64 = on_pool!(&self.db, pool =>
            scalar!(pool, sql, &name, input.sort_order, input.active))?;
        crate::events::notify_changed(&self.events, kind.resource());
        self.get(kind, id).await
    }

    pub async fn update(
        &self,
        kind: MasterKind,
        id: i64,
        input: WorkMasterInput,
    ) -> Result<WorkMaster, BantoError> {
        let name = validate(&input)?;
        let Some(version) = input.row_version else {
            return Err(stale_version_error());
        };
        self.get(kind, id).await?;
        let sql = self.sql(&format!(
            "UPDATE {} SET name = ?, sort_order = ?, active = ?, \
             row_version = row_version + 1, updated_at = {} WHERE id = ? AND row_version = ?",
            kind.table(),
            now_expr(self.db.dialect())
        ));
        let changed = on_pool!(&self.db, pool =>
            execute!(pool, sql, &name, input.sort_order, input.active, id, version))?;
        if changed == 0 {
            return Err(stale_version_error());
        }
        crate::events::notify_changed(&self.events, kind.resource());
        self.get(kind, id).await
    }

    /// An active row, for a new or edited time entry (`field` names the input).
    pub(crate) async fn require_active(
        &self,
        kind: MasterKind,
        id: i64,
        field: &str,
    ) -> Result<WorkMaster, BantoError> {
        match self.get(kind, id).await {
            Ok(row) if row.active => Ok(row),
            Ok(_) => Err(BantoError::Validation {
                field_errors: vec![field_error(field, "使用中止のため選べません")],
            }),
            Err(BantoError::NotFound { .. }) => Err(BantoError::Validation {
                field_errors: vec![field_error(field, "見つかりません")],
            }),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate_memory;

    fn input(name: &str, active: bool, row_version: Option<i64>) -> WorkMasterInput {
        WorkMasterInput {
            name: name.into(),
            sort_order: 70,
            active,
            row_version,
        }
    }

    #[tokio::test]
    async fn seeded_masters_and_inactive_rows_stay() {
        let svc = WorkMastersService::new(migrate_memory().await.unwrap());
        let phases = svc.list(MasterKind::Phases).await.unwrap();
        assert_eq!(phases.len(), 6);
        assert_eq!(phases[0].name, "設計");
        assert_eq!(svc.list(MasterKind::Activities).await.unwrap().len(), 4);

        let added = svc
            .create(MasterKind::Phases, input("  据付 ", true, None))
            .await
            .unwrap();
        assert_eq!(added.name, "据付");
        let off = svc
            .update(
                MasterKind::Phases,
                added.id,
                input("据付", false, Some(added.row_version)),
            )
            .await
            .unwrap();
        assert!(!off.active);
        assert_eq!(svc.list(MasterKind::Phases).await.unwrap().len(), 7);
        assert!(matches!(
            svc.require_active(MasterKind::Phases, added.id, "phaseId")
                .await,
            Err(BantoError::Validation { .. })
        ));
    }

    #[tokio::test]
    async fn t13_stale_version_and_blank_name_are_refused() {
        let svc = WorkMastersService::new(migrate_memory().await.unwrap());
        let row = svc.get(MasterKind::Activities, 1).await.unwrap();
        svc.update(
            MasterKind::Activities,
            1,
            input("全体会議", true, Some(row.row_version)),
        )
        .await
        .unwrap();
        let stale = svc
            .update(
                MasterKind::Activities,
                1,
                input("朝会", true, Some(row.row_version)),
            )
            .await
            .unwrap_err();
        assert!(matches!(stale, BantoError::Validation { .. }));
        assert_eq!(
            svc.get(MasterKind::Activities, 1).await.unwrap().name,
            "全体会議"
        );
        assert!(svc
            .create(MasterKind::Phases, input(" ", true, None))
            .await
            .is_err());
    }
}
