# ADR-0004: Set `eprintln!` as the default for server logging and defer `tracing`

> The Japanese [`0004-server-logging-eprintln.md`](0004-server-logging-eprintln.md) is the source of truth; this English version follows it. If they diverge, the Japanese wins.

- Status: Accepted
- Date: 2026-07-19
- Related: [conventions.md §3](../conventions.en.md), [ADR-0002](0002-minimal-dependencies.en.md),
  improvements.md §9, improvement-plan-2026-07.md P1-5/B

## Context

Troubleshooting `banto-server` (the LAN server) requires some form of logging.
Currently it is `eprintln!` (in `audit.rs`, etc.), with no levels, structured
fields, or filtering. The standard for structured logging is `tracing` +
`tracing-subscriber`, but that is exactly what conventions §3 explicitly lists
as a "dependency not to add" (`tracing` → `eprintln!`), and adopting it falls
under the restraint of dependency minimization (ADR-0002).

## Decision

**Set `eprintln!` (a minimal implementation) as the default for server logging
for now. Defer introducing `tracing`, to be judged once the re-examination
conditions below (the P1-5 criteria) are met.**

## Alternatives considered

- **Option A (adopted): `eprintln!` / minimal logging.** Pros: zero new
  dependencies; does not pass a log-configuration surface on to template users;
  no binary bloat. Cons: no log levels, structured fields, or runtime
  filtering, so it is weak for troubleshooting in field operation.
- **Option B (deferred): `tracing` + `tracing-subscriber`.** Pros: leveled,
  structured, filterable, the ecosystem standard, and easy to trace across
  async contexts. Cons: a dependency addition (overturning the "no" of
  conventions §3), added configuration surface for log levels/format, and every
  template user inheriting that dependency. As long as `eprintln!` suffices, it
  does not justify the total maintenance cost.
- **Option C (rejected): the `log` facade + an arbitrary backend.** Its
  dependency cost is about the same as `tracing`, yet it is inferior in async
  and structured expressiveness. If we are going to add a logging foundation,
  `tracing` is closer to the goal, so `log` is not chosen.

## Consequences

- The conventions §3 table stays as `tracing → eprintln!`.
- **Re-examination conditions (the P1-5 criteria)**: when field deployment or
  multi-client troubleshooting clearly outgrows `eprintln!` (when structured
  logging / level filtering becomes necessary in real operation). If adopted,
  **feature-gate** it so the minimal build keeps zero dependencies (the general
  rule of ADR-0002). The audit log (M14, the `audit_log` table) is a permanent
  record of "who did what," a role distinct from the diagnostic logging (server
  behavior tracing) this ADR concerns — the audit continues to be stored in
  the DB.
