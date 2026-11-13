//! 工程・共通作業・外注先 (P4b / P4d, spec §6.2): listing a master is
//! `ViewMasters` and writing one `EditMasters`, except that the `admin` role
//! passes without a capability (it maintains masters, spec §4). The audit
//! detail is the row's name and whether it is active.

use banto_admin_services::authz::Operation;
use banto_core::BantoError;
use serde_json::json;

use super::Gate;
use crate::work_masters::{MasterKind, WorkMaster, WorkMasterInput, WorkMastersService};

pub async fn list(
    gate: &Gate<'_>,
    masters: &WorkMastersService,
    kind: MasterKind,
) -> Result<Vec<WorkMaster>, BantoError> {
    gate.check_or_admin(Operation::ViewMasters, kind.resource())
        .await?;
    masters.list(kind).await
}

/// Create (`id: None`) or update a master row.
pub async fn write(
    gate: &Gate<'_>,
    masters: &WorkMastersService,
    kind: MasterKind,
    id: Option<i64>,
    input: WorkMasterInput,
) -> Result<WorkMaster, BantoError> {
    gate.check_or_admin(Operation::EditMasters, kind.resource())
        .await?;
    let (row, action) = match id {
        None => (masters.create(kind, input).await?, "create"),
        Some(id) => (masters.update(kind, id, input).await?, "update"),
    };
    gate.record(
        action,
        kind.resource(),
        Some(&row.id.to_string()),
        Some(json!({ "name": row.name, "active": row.active })),
    )
    .await;
    Ok(row)
}
