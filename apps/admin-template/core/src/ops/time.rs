//! 工数 (P4b, spec §6.1, T08・T11): entering hours on a project is
//! `EnterTime`, on a common activity `EnterCommonTime`; an entry is the
//! caller's own (someone else's reads as not found) and needs a user row.
//! Deciding is `Approve` (project) / `ApproveCommon` (activity) /
//! `ApproveCorrection` (a correction, accounting's) under `APPROVAL_POLICY`
//! (self-approval allowed and audited). The approval list is narrowed to
//! `approval_projects` (activities with `finance.close`); accounting's
//! correction queue is `finance.close` (others: empty). A project's time
//! summary is `ViewProjectAmounts`.
//! 単価の当て直し (T45) is `EditRates` and `FinanceClose` (listing), then per
//! entry `ApproveCorrection` under `APPROVAL_POLICY`: a rerate is a
//! correction approved at once by accounting.
//!
//! An entry's rate and labor cost are shown only to `sees_record_costs`
//! (`time_access::shown`): cost ÷ minutes is the person's rate (spec §4).
//! Audit details carry dates, minutes and targets (`TimeEntry::audit_detail`),
//! never a rate or a correction's reason.

use banto_admin_services::authz::{approval_projects, Capability, Operation, Subject};
use banto_core::BantoError;
use serde_json::json;

use super::Gate;
use crate::approval::APPROVAL_POLICY;
use crate::time_access::{approve_op, enter_op, shown, shown_own, shown_pair, shown_saved};
use crate::time_entries::{
    CorrectionInput, CorrectionPair, DecisionInput, ProjectTimeSummary, RerateInput, RerateList,
    TimeEntriesService, TimeEntry, TimeEntryInput, TimeEntrySaved, VersionInput,
};

const RESOURCE: &str = "time_entries";

/// Decide `op` for an entry operation: the subject and the caller's user
/// row (a session without one is refused).
async fn entry_check(gate: &Gate<'_>, op: Operation) -> Result<(Subject, i64), BantoError> {
    let subject = gate.check(op, RESOURCE).await?;
    Ok((subject, gate.person()?))
}

/// The caller's own entry, as not found when it is someone else's.
async fn own_entry(
    gate: &Gate<'_>,
    entries: &TimeEntriesService,
    id: i64,
) -> Result<TimeEntry, BantoError> {
    let entry = entries.get(id).await?;
    if Some(entry.user_id) != gate.user_id() {
        return Err(BantoError::NotFound {
            resource: RESOURCE.into(),
            id: id.to_string(),
        });
    }
    Ok(entry)
}

fn accounting(subject: &Subject) -> bool {
    subject.is_company_member() && subject.has(Capability::FinanceClose)
}

/// The caller's own entries in `from..=to`; drafts carry `canApprove`.
pub async fn list_own(
    gate: &Gate<'_>,
    entries: &TimeEntriesService,
    from: &str,
    to: &str,
) -> Result<Vec<TimeEntry>, BantoError> {
    let (subject, user_id) = entry_check(gate, Operation::EnterCommonTime).await?;
    let rows = entries.list_own(user_id, from, to).await?;
    Ok(rows.into_iter().map(|e| shown_own(&subject, e)).collect())
}

pub async fn create(
    gate: &Gate<'_>,
    entries: &TimeEntriesService,
    input: TimeEntryInput,
) -> Result<TimeEntrySaved, BantoError> {
    let (subject, user_id) = entry_check(gate, enter_op(input.project_id)).await?;
    let saved = entries.create(user_id, input).await?;
    if !saved.replayed {
        gate.record(
            "create",
            RESOURCE,
            Some(&saved.entry.id.to_string()),
            Some(saved.entry.audit_detail()),
        )
        .await;
    }
    Ok(shown_saved(&subject, saved))
}

pub async fn update(
    gate: &Gate<'_>,
    entries: &TimeEntriesService,
    id: i64,
    input: TimeEntryInput,
) -> Result<TimeEntrySaved, BantoError> {
    own_entry(gate, entries, id).await?;
    let (subject, user_id) = entry_check(gate, enter_op(input.project_id)).await?;
    let saved = entries.update(user_id, id, input).await?;
    gate.record(
        "update",
        RESOURCE,
        Some(&id.to_string()),
        Some(saved.entry.audit_detail()),
    )
    .await;
    Ok(shown_saved(&subject, saved))
}

pub async fn delete(
    gate: &Gate<'_>,
    entries: &TimeEntriesService,
    id: i64,
    row_version: i64,
) -> Result<(), BantoError> {
    let entry = own_entry(gate, entries, id).await?;
    let (_, user_id) = entry_check(gate, enter_op(entry.project_id)).await?;
    entries.delete(user_id, id, row_version).await?;
    gate.record(
        "delete",
        RESOURCE,
        Some(&id.to_string()),
        Some(entry.audit_detail()),
    )
    .await;
    Ok(())
}

pub async fn submit(
    gate: &Gate<'_>,
    entries: &TimeEntriesService,
    id: i64,
    input: VersionInput,
) -> Result<TimeEntry, BantoError> {
    let entry = own_entry(gate, entries, id).await?;
    let (subject, user_id) = entry_check(gate, enter_op(entry.project_id)).await?;
    let entry = entries.submit(user_id, id, input.row_version).await?;
    gate.record(
        "submit",
        RESOURCE,
        Some(&id.to_string()),
        Some(entry.audit_detail()),
    )
    .await;
    Ok(shown(&subject, entry))
}

/// The submitted entries the caller may decide (no `Operation`: the scope
/// only narrows).
pub async fn approvals(
    gate: &Gate<'_>,
    entries: &TimeEntriesService,
) -> Result<Vec<TimeEntry>, BantoError> {
    let subject = gate.subject().await?;
    let scope = approval_projects(&subject);
    let rows = entries.approvals(&scope, accounting(&subject)).await?;
    Ok(rows.into_iter().map(|e| shown(&subject, e)).collect())
}

/// Approving or returning an entry: self-approval is allowed
/// (`APPROVAL_POLICY`) and recorded as `selfApproval` in the audit detail.
pub async fn decide(
    gate: &Gate<'_>,
    entries: &TimeEntriesService,
    id: i64,
    input: DecisionInput,
) -> Result<TimeEntry, BantoError> {
    let entry = entries.get(id).await?;
    let (subject, allowed) = gate
        .check_with(approve_op(&entry), APPROVAL_POLICY, RESOURCE)
        .await?;
    let approve = input.approve;
    let entry = entries.decide(&entry, input, gate.user_id()).await?;
    let mut detail = entry.audit_detail();
    detail["selfApproval"] = json!(allowed.self_approval_exception);
    gate.record(
        if approve { "approve" } else { "return" },
        RESOURCE,
        Some(&id.to_string()),
        Some(detail),
    )
    .await;
    Ok(shown(&subject, entry))
}

/// 承認済み工数の訂正申請 (P6b-2, T11): the caller's own approved entry,
/// with `EnterTime` / `EnterCommonTime` on the corrected target. The reason
/// is free text: kept on the row, not in the audit log.
pub async fn correct(
    gate: &Gate<'_>,
    entries: &TimeEntriesService,
    id: i64,
    input: CorrectionInput,
) -> Result<TimeEntrySaved, BantoError> {
    own_entry(gate, entries, id).await?;
    let (subject, user_id) = entry_check(gate, enter_op(input.entry.project_id)).await?;
    let saved = entries.correct(user_id, id, input).await?;
    if !saved.replayed {
        gate.record(
            "correct",
            RESOURCE,
            Some(&saved.entry.id.to_string()),
            Some(saved.entry.audit_detail()),
        )
        .await;
    }
    Ok(shown_saved(&subject, saved))
}

/// The corrections of one of the caller's own entries.
pub async fn corrections_of(
    gate: &Gate<'_>,
    entries: &TimeEntriesService,
    id: i64,
) -> Result<Vec<TimeEntry>, BantoError> {
    own_entry(gate, entries, id).await?;
    let (subject, user_id) = entry_check(gate, Operation::EnterCommonTime).await?;
    let rows = entries.corrections_of(user_id, id).await?;
    Ok(rows.into_iter().map(|e| shown(&subject, e)).collect())
}

/// Accounting's queue of corrections (`finance.close`; others: empty).
pub async fn pending_corrections(
    gate: &Gate<'_>,
    entries: &TimeEntriesService,
) -> Result<Vec<CorrectionPair>, BantoError> {
    let subject = gate.subject().await?;
    if !accounting(&subject) {
        return Ok(Vec::new());
    }
    let rows = entries.pending_corrections().await?;
    Ok(rows.into_iter().map(|p| shown_pair(&subject, p)).collect())
}

pub async fn project_summary(
    gate: &Gate<'_>,
    entries: &TimeEntriesService,
    project_id: i64,
) -> Result<ProjectTimeSummary, BantoError> {
    gate.check(Operation::ViewProjectAmounts { project_id }, RESOURCE)
        .await?;
    entries.project_summary(project_id).await
}

/// 単価の当て直しの候補 (T45): the rates and costs of everyone's approved
/// entries, so `EditRates` (`finance.rate` + `amount.view`) and
/// `FinanceClose` (the rerate is a correction accounting approves).
pub async fn rerate_candidates(
    gate: &Gate<'_>,
    entries: &TimeEntriesService,
) -> Result<RerateList, BantoError> {
    gate.check(Operation::EditRates, RESOURCE).await?;
    let subject = gate.check(Operation::FinanceClose, RESOURCE).await?;
    let mut list = entries.rerate_candidates().await?;
    for c in &mut list.candidates {
        c.entry = shown(&subject, c.entry.clone());
    }
    Ok(list)
}

/// Rerate one approved entry (T45): `EditRates`, then `ApproveCorrection`
/// for the entry's person under `APPROVAL_POLICY` (self-approval allowed and
/// audited). The audit has the dates and minutes, never the rate or reason.
pub async fn rerate(
    gate: &Gate<'_>,
    entries: &TimeEntriesService,
    id: i64,
    input: RerateInput,
) -> Result<TimeEntry, BantoError> {
    gate.check(Operation::EditRates, RESOURCE).await?;
    let entry = entries.get(id).await?;
    let (subject, allowed) = gate
        .check_with(
            Operation::ApproveCorrection {
                submitted_by: entry.user_id,
            },
            APPROVAL_POLICY,
            RESOURCE,
        )
        .await?;
    let rerated = entries.rerate(id, input, gate.user_id()).await?;
    let mut detail = rerated.audit_detail();
    detail["selfApproval"] = json!(allowed.self_approval_exception);
    gate.record(
        "rerate",
        RESOURCE,
        Some(&rerated.id.to_string()),
        Some(detail),
    )
    .await;
    Ok(shown(&subject, rerated))
}
