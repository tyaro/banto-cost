-- PostgreSQL port of migrations-sqlite/0009_authz.sql. Type mapping:
--   INTEGER (i64 in Rust) -> BIGINT (users.id is BIGINT, see 0003).
--   TEXT timestamps: DEFAULT (datetime('now')) -> DEFAULT (now()::text).
--
-- banto-cost P2 (ADR-0028, docs/project/design.md §2): business authorization
-- = capabilities × project scope, on top of Banto's role floor.
--
-- user_capabilities: business capabilities granted to a user (any number).
-- A user with no row here is not a member of the company data (spec §4,
-- T20) whatever their role. The CHECK list MUST match
-- `banto_admin_services::authz::Capability`.
CREATE TABLE user_capabilities (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    capability TEXT NOT NULL CHECK (capability IN ('time.entry','pipeline.edit',
        'project.manage','finance.rate','finance.close','report.all','amount.view')),
    granted_at TEXT NOT NULL DEFAULT (now()::text),
    PRIMARY KEY (user_id, capability)
);

-- project_members: the project scope (project, user, kind). `project_id`
-- has no FK yet: the projects table arrives in P3, which keeps this column's
-- meaning (projects.id). The CHECK list MUST match
-- `banto_admin_services::authz::MemberKind`.
CREATE TABLE project_members (
    project_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('sales','manager','worker')),
    created_at TEXT NOT NULL DEFAULT (now()::text),
    PRIMARY KEY (project_id, user_id, kind)
);

CREATE INDEX project_members_user ON project_members (user_id);
