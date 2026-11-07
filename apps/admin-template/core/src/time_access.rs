//! Wiring helpers of the time-entry routes and commands (banto-cost P4b),
//! shared by REST (`rest/time.rs`) and Tauri (`src-tauri`) so both paths
//! decide and mask identically (conventions §1). They map an entry to the
//! `Operation` that authorizes it and hide what the caller may not see; the
//! service (`time_entries`) stays free of callers and permissions
//! (conventions §2).

use banto_admin_services::authz::{sees_record_costs, Operation, Subject};

use crate::time_entries::{TimeEntry, TimeEntrySaved};

/// The operation that lets a person enter hours on a target: `EnterTime` on
/// the project, or `EnterCommonTime` (also for an input naming neither, which
/// the service then refuses).
pub fn enter_op(project_id: Option<i64>) -> Operation {
    match project_id {
        Some(project_id) => Operation::EnterTime { project_id },
        None => Operation::EnterCommonTime,
    }
}

/// The operation that decides an entry: `Approve` on its project, or
/// `ApproveCommon` for a common activity.
pub fn approve_op(entry: &TimeEntry) -> Operation {
    match entry.project_id {
        Some(project_id) => Operation::Approve {
            project_id,
            submitted_by: entry.user_id,
        },
        None => Operation::ApproveCommon {
            submitted_by: entry.user_id,
        },
    }
}

/// The entry as `subject` may see it: the rate and cost only for
/// `sees_record_costs` (a record's cost over its minutes is the person's rate,
/// spec §4).
pub fn shown(subject: &Subject, entry: TimeEntry) -> TimeEntry {
    if sees_record_costs(subject) {
        entry
    } else {
        entry.without_costs()
    }
}

pub fn shown_saved(subject: &Subject, saved: TimeEntrySaved) -> TimeEntrySaved {
    TimeEntrySaved {
        entry: shown(subject, saved.entry),
        ..saved
    }
}
