//! The company's approval policy (banto-cost, `docs/project/design.md` §2.4).
//!
//! banto-cost is run single-handed in a small company (user decision
//! 2026-11-06), so the person who submitted a record may also approve it -
//! spec §4's small-team exception. Every approval the app has (order
//! changes, time entries, and later direct costs) is authorized with this one
//! policy on both paths (conventions §1), and the wiring layers record
//! `selfApproval: true` in the audit detail when the exception is used. The
//! decision function's default (`Policy::default()`, no self-approval) is
//! unchanged.

use banto_admin_services::authz::Policy;

/// The policy every approval is authorized with.
pub const APPROVAL_POLICY: Policy = Policy {
    allow_self_approval: true,
};
