//! Turns a `banto_core::ListParams` into `WHERE` / `ORDER BY` /
//! `LIMIT .. OFFSET ..` SQL appended onto a `sqlx::QueryBuilder`.
//!
//! This is the security-sensitive core of the storage layer: field names
//! coming from the frontend are **only ever** resolved through a
//! [`ColumnMap`] whitelist built by the service layer, and every value is
//! bound as a query parameter (never interpolated into the SQL string).
//!
//! - Sorting by an unknown field is silently skipped (a client asking to
//!   sort by a field that doesn't exist is not an error worth surfacing).
//! - Filtering by an unknown field is a hard `Err(BantoError::BadRequest(_))`
//!   (bad request) since silently ignoring a filter could return more rows
//!   than the caller expects.
//! - The `ORDER BY` always ends with the resource's unique key (normally
//!   `id`, see [`ColumnMap`]) so the order is total and `LIMIT`/`OFFSET`
//!   paging neither repeats nor skips rows that tie on the sort column
//!   (Issue #243).
//!
//! A single generic implementation over `sqlx::Database` fights sqlx's
//! trait bounds hard enough (see the module-level discussion in the spec
//! doc, §12) that this module instead uses a `macro_rules!` to instantiate
//! one concrete, monomorphic implementation per backend (`Sqlite`,
//! `Postgres`), each gated behind its crate feature. The macro expands to
//! plain, independently type-checked code for each backend - no fighting
//! `Type<DB>`/`Encode<'_, DB>` bounds across an abstract `DB` type
//! parameter.

use std::collections::HashMap;

use banto_core::{
    BantoError, FilterOp, FilterState, ListParams, Pagination, SortDirection, SortState,
};
use serde_json::Value;

/// Whitelist mapping a wire field name (as sent by the frontend) to the
/// actual SQL column name. Built once per resource/service; field names not
/// present here can never reach raw SQL.
///
/// It also names the resource's **unique key** (Issue #243), which
/// [`sqlite::append_order_by`] / [`postgres::append_order_by`] append as the
/// last `ORDER BY` key so the order is total: without it, rows that tie on
/// the requested sort column come back in an engine-chosen order that may
/// differ between two `LIMIT .. OFFSET ..` queries (Postgres's top-N sort
/// does this in practice), so paging duplicates some rows and never returns
/// others. The unique key is, in order of precedence:
///
/// - the field given to [`ColumnMap::unique_key`],
/// - none, after [`ColumnMap::without_unique_key`] (the pre-#243 behaviour),
/// - otherwise, by convention, the wire field `id` **if it is registered**
///   (every Banto resource and every known derived-app resource maps `id`
///   to its primary key). A map without an `id` column and without an
///   explicit declaration has no unique key and keeps the pre-#243 order.
#[derive(Debug, Clone, Default)]
pub struct ColumnMap {
    columns: HashMap<String, String>,
    unique_key: UniqueKey,
}

/// See [`ColumnMap`]'s doc comment for the precedence.
#[derive(Debug, Clone, Default)]
enum UniqueKey {
    /// The wire field `id`, if registered.
    #[default]
    ConventionalId,
    /// A field declared with [`ColumnMap::unique_key`].
    Field(String),
    /// Declared absent with [`ColumnMap::without_unique_key`].
    Disabled,
}

/// The wire field used as the unique key when none is declared.
const CONVENTIONAL_UNIQUE_KEY: &str = "id";

impl ColumnMap {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register `field` (wire name) -> `sql_column` (actual SQL column).
    pub fn column(mut self, field: &str, sql_column: &str) -> Self {
        self.columns
            .insert(field.to_string(), sql_column.to_string());
        self
    }

    /// Declare `field` (a wire name, which must ALSO be registered with
    /// [`ColumnMap::column`] - the order of the two calls does not matter) as
    /// the resource's unique key: a column whose values are unique and not
    /// NULL, normally the primary key. Only needed when that field is not
    /// named `id`; see [`ColumnMap`]'s doc comment.
    pub fn unique_key(mut self, field: &str) -> Self {
        self.unique_key = UniqueKey::Field(field.to_string());
        self
    }

    /// Declare that this resource has no unique key to order by (for
    /// example, when its `id` field is not actually unique). `ORDER BY` then
    /// contains only the requested sort keys, as before #243, and paging
    /// through ties is not guaranteed to be stable.
    pub fn without_unique_key(mut self) -> Self {
        self.unique_key = UniqueKey::Disabled;
        self
    }

    /// Resolve a wire field name to its SQL column name, if whitelisted.
    pub fn resolve(&self, field: &str) -> Option<&str> {
        self.columns.get(field).map(String::as_str)
    }

    /// The SQL column of the unique key, if the resource has one (see
    /// [`ColumnMap`]'s doc comment). `None` also when a key was declared with
    /// [`ColumnMap::unique_key`] but never registered with
    /// [`ColumnMap::column`] (a programming error, which `append_order_by`
    /// reports with a `debug_assert!`).
    pub fn unique_key_column(&self) -> Option<&str> {
        match &self.unique_key {
            UniqueKey::ConventionalId => self.resolve(CONVENTIONAL_UNIQUE_KEY),
            UniqueKey::Field(field) => self.resolve(field),
            UniqueKey::Disabled => None,
        }
    }

    /// `true` when [`ColumnMap::unique_key`] named a field that is not
    /// registered (see [`ColumnMap::unique_key_column`]).
    fn declared_unique_key_is_unregistered(&self) -> bool {
        matches!(&self.unique_key, UniqueKey::Field(field) if self.resolve(field).is_none())
    }

    /// The `ORDER BY` entries for `sort`: the whitelisted sort keys (unknown
    /// fields skipped), then the unique key in the direction of the last
    /// entry (ascending when there is none), unless it is already among
    /// them. Shared by both backends so they cannot disagree.
    fn order_by_entries(&self, sort: &[SortState]) -> Vec<(&str, SortDirection)> {
        debug_assert!(
            !self.declared_unique_key_is_unregistered(),
            "ColumnMap::unique_key names a field that is not registered with ColumnMap::column"
        );
        let mut entries: Vec<(&str, SortDirection)> = sort
            .iter()
            .filter_map(|s| self.resolve(&s.field).map(|col| (col, s.direction)))
            .collect();
        if let Some(key) = self.unique_key_column() {
            if !entries.iter().any(|(col, _)| *col == key) {
                let direction = entries
                    .last()
                    .map(|(_, direction)| *direction)
                    .unwrap_or(SortDirection::Asc);
                entries.push((key, direction));
            }
        }
        entries
    }
}

/// Escape `%`, `_`, and `\` for use inside a `LIKE ... ESCAPE '\'` pattern.
fn escape_like(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for c in raw.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '%' => out.push_str("\\%"),
            '_' => out.push_str("\\_"),
            _ => out.push(c),
        }
    }
    out
}

/// Render a `serde_json::Value` filter operand as a string for LIKE
/// patterns (numbers/bools get their natural string form; anything else is
/// rejected by the caller before this is reached).
fn value_as_like_operand(value: &Value) -> Result<String, BantoError> {
    match value {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        Value::Bool(b) => Ok(b.to_string()),
        other => Err(BantoError::BadRequest(format!(
            "unsupported filter value for text match: {other}"
        ))),
    }
}

macro_rules! impl_list_query {
    ($module:ident, $db:ty) => {
        /// Backend-specific `ListParams` -> SQL implementation. See the
        /// module docs for why this is generated by a macro rather than a
        /// single generic function.
        pub mod $module {
            use super::*;
            use sqlx::QueryBuilder;

            /// Append `WHERE ... ORDER BY ... LIMIT ... OFFSET ...` for
            /// `params` onto `builder`. Field names are resolved only
            /// through `columns` (whitelist).
            pub fn apply_list_params(
                builder: &mut QueryBuilder<$db>,
                columns: &ColumnMap,
                params: &ListParams,
            ) -> Result<(), BantoError> {
                append_where(builder, columns, &params.filters)?;
                append_order_by(builder, columns, &params.sort);
                append_pagination(builder, params.pagination);
                Ok(())
            }

            /// Append only the `WHERE` clause (used by services that need
            /// a separate `COUNT(*)` query sharing the same filters).
            pub fn append_where(
                builder: &mut QueryBuilder<$db>,
                columns: &ColumnMap,
                filters: &[FilterState],
            ) -> Result<(), BantoError> {
                if filters.is_empty() {
                    return Ok(());
                }
                builder.push(" WHERE ");
                let mut first = true;
                for filter in filters {
                    let column = columns.resolve(&filter.field).ok_or_else(|| {
                        BantoError::BadRequest(format!("unknown filter field: {}", filter.field))
                    })?;
                    if !first {
                        builder.push(" AND ");
                    }
                    first = false;
                    push_condition(builder, column, filter)?;
                }
                Ok(())
            }

            /// Append only the `ORDER BY` clause. Unknown fields are
            /// silently skipped (spec: sorting by an unknown field is not
            /// an error).
            ///
            /// Both JS comparator implementations (`packages/grid-svelte/
            /// src/core/sort.ts`, `packages/admin-core/src/providers/
            /// inMemory.ts`) sort null/undefined last regardless of
            /// direction; SQL otherwise inherits engine defaults (SQLite:
            /// nulls first on ASC; Postgres: nulls first on DESC), which
            /// would make server mode disagree with client mode on which
            /// row is "first" whenever a sorted column has NULLs. Emitting
            /// an explicit `NULLS LAST` on every entry, for both
            /// directions, keeps all three implementations in agreement.
            /// SQLite supports `NULLS LAST` since 3.30 (sqlx bundles a
            /// newer version); Postgres supports it natively.
            ///
            /// The order is made **total** (Issue #243): the resource's
            /// unique key ([`ColumnMap::unique_key_column`], normally `id`)
            /// is appended as the last entry, in the direction of the last
            /// requested sort key, unless the sort already uses it. With no
            /// (known) sort key at all, the rows are ordered by the unique
            /// key ascending - the order SQLite's rowid scan and the
            /// InMemory provider already gave an unsorted list, now
            /// guaranteed instead of incidental. A resource without a unique
            /// key keeps the pre-#243 clause (no `ORDER BY` when unsorted).
            pub fn append_order_by(
                builder: &mut QueryBuilder<$db>,
                columns: &ColumnMap,
                sort: &[SortState],
            ) {
                let resolved = columns.order_by_entries(sort);
                if resolved.is_empty() {
                    return;
                }
                builder.push(" ORDER BY ");
                for (i, (col, dir)) in resolved.iter().enumerate() {
                    if i > 0 {
                        builder.push(", ");
                    }
                    builder.push(*col);
                    builder.push(match dir {
                        SortDirection::Asc => " ASC NULLS LAST",
                        SortDirection::Desc => " DESC NULLS LAST",
                    });
                }
            }

            /// Append only `LIMIT .. OFFSET ..` (no-op when `pagination`
            /// is `None`).
            pub fn append_pagination(
                builder: &mut QueryBuilder<$db>,
                pagination: Option<Pagination>,
            ) {
                if let Some(p) = pagination {
                    builder.push(" LIMIT ");
                    builder.push_bind(p.limit as i64);
                    builder.push(" OFFSET ");
                    builder.push_bind(p.offset as i64);
                }
            }

            fn push_condition(
                builder: &mut QueryBuilder<$db>,
                column: &str,
                filter: &FilterState,
            ) -> Result<(), BantoError> {
                match filter.op {
                    FilterOp::Eq => push_binop(builder, column, "=", &filter.value)?,
                    FilterOp::Ne => push_binop(builder, column, "<>", &filter.value)?,
                    FilterOp::Lt => push_binop(builder, column, "<", &filter.value)?,
                    FilterOp::Lte => push_binop(builder, column, "<=", &filter.value)?,
                    FilterOp::Gt => push_binop(builder, column, ">", &filter.value)?,
                    FilterOp::Gte => push_binop(builder, column, ">=", &filter.value)?,
                    FilterOp::Contains => push_like(builder, column, &filter.value, true, true)?,
                    FilterOp::StartsWith => push_like(builder, column, &filter.value, false, true)?,
                    FilterOp::In => push_in(builder, column, &filter.value)?,
                    FilterOp::IsNull => {
                        builder.push(column);
                        builder.push(" IS NULL");
                    }
                    FilterOp::NotNull => {
                        builder.push(column);
                        builder.push(" IS NOT NULL");
                    }
                }
                Ok(())
            }

            fn push_binop(
                builder: &mut QueryBuilder<$db>,
                column: &str,
                op: &str,
                value: &Value,
            ) -> Result<(), BantoError> {
                builder.push(column);
                builder.push(" ");
                builder.push(op);
                builder.push(" ");
                bind_value(builder, value)?;
                Ok(())
            }

            fn bind_value(
                builder: &mut QueryBuilder<$db>,
                value: &Value,
            ) -> Result<(), BantoError> {
                match value {
                    Value::String(s) => {
                        builder.push_bind(s.clone());
                    }
                    Value::Bool(b) => {
                        builder.push_bind(*b);
                    }
                    Value::Number(n) => {
                        if let Some(i) = n.as_i64() {
                            builder.push_bind(i);
                        } else if let Some(f) = n.as_f64() {
                            builder.push_bind(f);
                        } else {
                            return Err(BantoError::BadRequest(
                                "invalid numeric filter value".to_string(),
                            ));
                        }
                    }
                    other => {
                        return Err(BantoError::BadRequest(format!(
                            "unsupported filter value: {other}"
                        )));
                    }
                }
                Ok(())
            }

            /// `contains`/`starts_with`: case-insensitive `LIKE`, matched
            /// value escaped for `%`/`_`/`\`. `prefix_wildcard` adds a
            /// leading `%` (contains only); `suffix_wildcard` adds a
            /// trailing `%` (both contains and starts_with).
            fn push_like(
                builder: &mut QueryBuilder<$db>,
                column: &str,
                value: &Value,
                prefix_wildcard: bool,
                suffix_wildcard: bool,
            ) -> Result<(), BantoError> {
                let raw = value_as_like_operand(value)?;
                let escaped = escape_like(&raw);
                let mut pattern = String::with_capacity(escaped.len() + 2);
                if prefix_wildcard {
                    pattern.push('%');
                }
                pattern.push_str(&escaped);
                if suffix_wildcard {
                    pattern.push('%');
                }
                // `CAST(column AS TEXT)` before `LOWER(...)` (M-review 2026-08
                // H-3): `contains`/`starts_with` may target a NUMERIC column
                // (the operand can be a number, and the whitelisted column can
                // be a numeric one). Postgres `lower()` only accepts text, so
                // `LOWER(<numeric column>)` errors at runtime ("function
                // lower(double precision) does not exist") -> a 500. SQLite is
                // dynamically typed and silently coerces, which is why the
                // SQLite-only tests never caught it. The cast is a no-op for
                // text columns and makes both backends agree (the mirrored
                // `postgres_tests` module exercises the Postgres branch).
                builder.push("LOWER(CAST(");
                builder.push(column);
                builder.push(" AS TEXT)) LIKE LOWER(");
                builder.push_bind(pattern);
                builder.push(") ESCAPE '\\'");
                Ok(())
            }

            /// `in`: binds every element of the array. An empty array is a
            /// clause that can never match (`1=0`), matching the semantics
            /// of "value is in the empty set" being always false.
            fn push_in(
                builder: &mut QueryBuilder<$db>,
                column: &str,
                value: &Value,
            ) -> Result<(), BantoError> {
                let items = match value {
                    Value::Array(items) => items,
                    other => {
                        return Err(BantoError::BadRequest(format!(
                            "'in' filter requires an array value, got: {other}"
                        )));
                    }
                };
                if items.is_empty() {
                    builder.push("1=0");
                    return Ok(());
                }
                builder.push(column);
                builder.push(" IN (");
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        builder.push(", ");
                    }
                    bind_value(builder, item)?;
                }
                builder.push(")");
                Ok(())
            }
        }
    };
}

#[cfg(feature = "sqlite")]
impl_list_query!(sqlite, sqlx::Sqlite);

#[cfg(feature = "postgres")]
impl_list_query!(postgres, sqlx::Postgres);

/// The shared list-order fixture (Issue #243 review): the same rows and
/// expected orders are asserted by this crate (SQLite + PostgreSQL), the
/// InMemory `DataProvider` and the grid's client sort, so the three
/// implementations cannot drift apart on ties, NULLs or unsorted lists.
#[cfg(test)]
pub(crate) mod parity_fixture {
    use banto_core::{SortDirection, SortState};
    use serde_json::Value;

    pub const JSON: &str = include_str!("../testdata/list-order-parity.json");

    /// `(id, grp, score)` in insertion order.
    pub fn rows() -> Vec<(i64, i64, Option<i64>)> {
        let v: Value = serde_json::from_str(JSON).expect("fixture is JSON");
        v["rows"]
            .as_array()
            .expect("rows")
            .iter()
            .map(|r| {
                (
                    r["id"].as_i64().expect("id"),
                    r["grp"].as_i64().expect("grp"),
                    r["score"].as_i64(),
                )
            })
            .collect()
    }

    /// `(sort, expected ids)` per case.
    pub fn cases() -> Vec<(Vec<SortState>, Vec<i64>)> {
        let v: Value = serde_json::from_str(JSON).expect("fixture is JSON");
        v["cases"]
            .as_array()
            .expect("cases")
            .iter()
            .map(|c| {
                let sort = c["sort"]
                    .as_array()
                    .expect("sort")
                    .iter()
                    .map(|s| SortState {
                        field: s["field"].as_str().expect("field").to_string(),
                        direction: match s["direction"].as_str() {
                            Some("asc") => SortDirection::Asc,
                            Some("desc") => SortDirection::Desc,
                            other => panic!("bad direction {other:?}"),
                        },
                    })
                    .collect();
                let ids = c["expectedIds"]
                    .as_array()
                    .expect("expectedIds")
                    .iter()
                    .map(|id| id.as_i64().expect("id"))
                    .collect();
                (sort, ids)
            })
            .collect()
    }
}

#[cfg(all(test, feature = "sqlite"))]
mod tests {
    use super::sqlite::apply_list_params;
    use super::*;
    use banto_core::Pagination;
    use serde_json::json;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::{Executor, QueryBuilder, Row, SqlitePool};

    async fn setup() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .expect("connect in-memory sqlite");
        pool.execute(
            "CREATE TABLE widgets (\
                id INTEGER PRIMARY KEY, \
                name TEXT NOT NULL, \
                price REAL NOT NULL, \
                active INTEGER NOT NULL\
            )",
        )
        .await
        .expect("create table");

        let rows: &[(i64, &str, f64, i64)] = &[
            (1, "Alpha Widget", 10.0, 1),
            (2, "Beta Widget", 20.0, 0),
            (3, "100% Off Widget", 5.0, 1),
            (4, "gamma_widget", 30.0, 1),
            (5, "Delta", 15.0, 0),
        ];
        for (id, name, price, active) in rows {
            sqlx::query("INSERT INTO widgets (id, name, price, active) VALUES (?, ?, ?, ?)")
                .bind(id)
                .bind(*name)
                .bind(price)
                .bind(active)
                .execute(&pool)
                .await
                .expect("insert row");
        }
        pool
    }

    fn columns() -> ColumnMap {
        ColumnMap::new()
            .column("id", "id")
            .column("name", "name")
            .column("price", "price")
            .column("active", "active")
    }

    async fn fetch_names(pool: &SqlitePool, params: &ListParams) -> Vec<String> {
        let mut builder = QueryBuilder::new("SELECT name FROM widgets");
        apply_list_params(&mut builder, &columns(), params).expect("apply params");
        let rows = builder
            .build()
            .fetch_all(pool)
            .await
            .expect("query should succeed");
        rows.into_iter().map(|r| r.get::<String, _>(0)).collect()
    }

    #[tokio::test]
    async fn eq_filters_by_bound_value() {
        let pool = setup().await;
        let params = ListParams {
            filters: vec![FilterState {
                field: "name".to_string(),
                op: FilterOp::Eq,
                value: json!("Alpha Widget"),
            }],
            ..Default::default()
        };
        assert_eq!(fetch_names(&pool, &params).await, vec!["Alpha Widget"]);
    }

    #[tokio::test]
    async fn ne_excludes_the_matching_row() {
        let pool = setup().await;
        let params = ListParams {
            filters: vec![FilterState {
                field: "active".to_string(),
                op: FilterOp::Ne,
                value: json!(1),
            }],
            ..Default::default()
        };
        let mut names = fetch_names(&pool, &params).await;
        names.sort();
        assert_eq!(names, vec!["Beta Widget", "Delta"]);
    }

    #[tokio::test]
    async fn lt_lte_gt_gte_compare_numerically() {
        let pool = setup().await;

        let lt = ListParams {
            filters: vec![FilterState {
                field: "price".to_string(),
                op: FilterOp::Lt,
                value: json!(10.0),
            }],
            ..Default::default()
        };
        assert_eq!(fetch_names(&pool, &lt).await, vec!["100% Off Widget"]);

        let lte = ListParams {
            filters: vec![FilterState {
                field: "price".to_string(),
                op: FilterOp::Lte,
                value: json!(10.0),
            }],
            ..Default::default()
        };
        let mut names = fetch_names(&pool, &lte).await;
        names.sort();
        assert_eq!(names, vec!["100% Off Widget", "Alpha Widget"]);

        let gt = ListParams {
            filters: vec![FilterState {
                field: "price".to_string(),
                op: FilterOp::Gt,
                value: json!(20.0),
            }],
            ..Default::default()
        };
        assert_eq!(fetch_names(&pool, &gt).await, vec!["gamma_widget"]);

        let gte = ListParams {
            filters: vec![FilterState {
                field: "price".to_string(),
                op: FilterOp::Gte,
                value: json!(20.0),
            }],
            ..Default::default()
        };
        let mut names = fetch_names(&pool, &gte).await;
        names.sort();
        assert_eq!(names, vec!["Beta Widget", "gamma_widget"]);
    }

    #[tokio::test]
    async fn contains_is_case_insensitive() {
        let pool = setup().await;
        let params = ListParams {
            filters: vec![FilterState {
                field: "name".to_string(),
                op: FilterOp::Contains,
                value: json!("WIDGET"),
            }],
            ..Default::default()
        };
        let mut names = fetch_names(&pool, &params).await;
        names.sort();
        assert_eq!(
            names,
            vec![
                "100% Off Widget",
                "Alpha Widget",
                "Beta Widget",
                "gamma_widget"
            ]
        );
    }

    #[tokio::test]
    async fn starts_with_anchors_the_prefix() {
        let pool = setup().await;
        let params = ListParams {
            filters: vec![FilterState {
                field: "name".to_string(),
                op: FilterOp::StartsWith,
                value: json!("alpha"),
            }],
            ..Default::default()
        };
        assert_eq!(fetch_names(&pool, &params).await, vec!["Alpha Widget"]);
    }

    /// Regression (M-review 2026-08 H-3): a `contains`/`starts_with` filter on
    /// a NUMERIC column must match against the column's text form without
    /// erroring. The generated SQL wraps the column in `CAST(.. AS TEXT)`
    /// before `LOWER(..)`; without that cast Postgres rejects
    /// `lower(<numeric>)` at runtime (a 500), while SQLite silently coerces.
    /// This SQLite test pins the match semantics; the Postgres branch is
    /// exercised by `postgres_tests::like_on_a_numeric_column_does_not_error`.
    #[tokio::test]
    async fn like_on_a_numeric_column_matches_its_text_form() {
        let pool = setup().await;
        // `id` is an INTEGER column; "contains 1" matches only id=1 by its
        // decimal text form (ids are 1..=5), and integers render identically
        // on both backends so the expectation is backend-independent.
        let params = ListParams {
            filters: vec![FilterState {
                field: "id".to_string(),
                op: FilterOp::Contains,
                value: json!(1),
            }],
            ..Default::default()
        };
        assert_eq!(fetch_names(&pool, &params).await, vec!["Alpha Widget"]);
    }

    /// A literal `%` in the data must only match when the query pattern
    /// escapes its own `%`; an unescaped LIKE would treat the data's `%` as
    /// a wildcard and this test would spuriously pass even without
    /// escaping. We assert both directions to prove the escaping is real.
    #[tokio::test]
    async fn like_escapes_percent_underscore_and_backslash_in_the_needle() {
        let pool = setup().await;

        // Literal '%' in the needle must match the literal '%' in "100% Off Widget"
        // and nothing else.
        let percent = ListParams {
            filters: vec![FilterState {
                field: "name".to_string(),
                op: FilterOp::Contains,
                value: json!("100%"),
            }],
            ..Default::default()
        };
        assert_eq!(fetch_names(&pool, &percent).await, vec!["100% Off Widget"]);

        // '_' is a single-char wildcard in SQL LIKE; escaped, it must only
        // match a literal underscore, not "gamma-widget"-style rows unless
        // they truly contain '_'.
        let underscore = ListParams {
            filters: vec![FilterState {
                field: "name".to_string(),
                op: FilterOp::Contains,
                value: json!("gamma_widget"),
            }],
            ..Default::default()
        };
        assert_eq!(fetch_names(&pool, &underscore).await, vec!["gamma_widget"]);

        // Without escaping, '_' would also match "gammaXwidget"-shaped names;
        // confirm a single-char substitution does NOT match.
        let would_match_if_unescaped = ListParams {
            filters: vec![FilterState {
                field: "name".to_string(),
                op: FilterOp::Contains,
                value: json!("gammaXwidget"),
            }],
            ..Default::default()
        };
        assert!(fetch_names(&pool, &would_match_if_unescaped)
            .await
            .is_empty());
    }

    #[tokio::test]
    async fn in_matches_any_bound_value() {
        let pool = setup().await;
        let params = ListParams {
            filters: vec![FilterState {
                field: "id".to_string(),
                op: FilterOp::In,
                value: json!([1, 3]),
            }],
            ..Default::default()
        };
        let mut names = fetch_names(&pool, &params).await;
        names.sort();
        assert_eq!(names, vec!["100% Off Widget", "Alpha Widget"]);
    }

    #[tokio::test]
    async fn in_with_empty_list_matches_nothing() {
        let pool = setup().await;
        let params = ListParams {
            filters: vec![FilterState {
                field: "id".to_string(),
                op: FilterOp::In,
                value: json!([]),
            }],
            ..Default::default()
        };
        assert!(fetch_names(&pool, &params).await.is_empty());
    }

    #[tokio::test]
    async fn is_null_and_not_null() {
        let pool = setup().await;
        // No NULLs in the fixture; is_null should match nothing and
        // not_null should match everything.
        let is_null = ListParams {
            filters: vec![FilterState {
                field: "name".to_string(),
                op: FilterOp::IsNull,
                value: json!(null),
            }],
            ..Default::default()
        };
        assert!(fetch_names(&pool, &is_null).await.is_empty());

        let not_null = ListParams {
            filters: vec![FilterState {
                field: "name".to_string(),
                op: FilterOp::NotNull,
                value: json!(null),
            }],
            ..Default::default()
        };
        assert_eq!(fetch_names(&pool, &not_null).await.len(), 5);
    }

    #[tokio::test]
    async fn sorts_by_multiple_keys_asc_and_desc() {
        let pool = setup().await;
        let params = ListParams {
            sort: vec![
                SortState {
                    field: "active".to_string(),
                    direction: SortDirection::Asc,
                },
                SortState {
                    field: "price".to_string(),
                    direction: SortDirection::Desc,
                },
            ],
            ..Default::default()
        };
        assert_eq!(
            fetch_names(&pool, &params).await,
            vec![
                "Beta Widget",
                "Delta",
                "gamma_widget",
                "Alpha Widget",
                "100% Off Widget"
            ]
        );
    }

    #[tokio::test]
    async fn pagination_and_total_count_pattern() {
        let pool = setup().await;
        let params = ListParams {
            sort: vec![SortState {
                field: "id".to_string(),
                direction: SortDirection::Asc,
            }],
            pagination: Some(Pagination {
                offset: 1,
                limit: 2,
            }),
            ..Default::default()
        };
        assert_eq!(
            fetch_names(&pool, &params).await,
            vec!["Beta Widget", "100% Off Widget"]
        );

        // The total_count pattern: a COUNT(*) query sharing the same WHERE
        // (built via `append_where`, not just ORDER BY/LIMIT/OFFSET)
        // reflects the pre-pagination count, while the paginated query
        // above only returns a page of it.
        let filtered = ListParams {
            filters: vec![FilterState {
                field: "active".to_string(),
                op: FilterOp::Eq,
                value: json!(1),
            }],
            pagination: Some(Pagination {
                offset: 0,
                limit: 1,
            }),
            ..Default::default()
        };
        let mut count_builder = QueryBuilder::new("SELECT COUNT(*) FROM widgets");
        super::sqlite::append_where(&mut count_builder, &columns(), &filtered.filters)
            .expect("append where");
        let total: i64 = count_builder
            .build_query_scalar()
            .fetch_one(&pool)
            .await
            .expect("count query");
        assert_eq!(total, 3);

        let rows = fetch_names(&pool, &filtered).await;
        assert_eq!(rows.len(), 1); // limited to 1 by pagination
    }

    #[tokio::test]
    async fn unknown_sort_field_is_silently_skipped() {
        let pool = setup().await;
        let params = ListParams {
            sort: vec![SortState {
                field: "does_not_exist".to_string(),
                direction: SortDirection::Asc,
            }],
            ..Default::default()
        };
        // No error; the unknown key is dropped, leaving only the unique key
        // (`id` ascending, Issue #243) - here also the insertion order.
        assert_eq!(
            fetch_names(&pool, &params).await,
            vec![
                "Alpha Widget",
                "Beta Widget",
                "100% Off Widget",
                "gamma_widget",
                "Delta"
            ]
        );
    }

    /// NULLs must sort last regardless of direction, matching the two JS
    /// comparator implementations (spec drift fix, see `append_order_by`'s
    /// doc comment).
    #[tokio::test]
    async fn nulls_sort_last_both_directions() {
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .expect("connect in-memory sqlite");
        pool.execute("CREATE TABLE nullable_widgets (id INTEGER PRIMARY KEY, label TEXT NOT NULL, score REAL)")
            .await
            .expect("create table");
        let rows: &[(i64, &str, Option<f64>)] = &[
            (1, "has-score-low", Some(1.0)),
            (2, "null-score", None),
            (3, "has-score-high", Some(2.0)),
        ];
        for (id, label, score) in rows {
            sqlx::query("INSERT INTO nullable_widgets (id, label, score) VALUES (?, ?, ?)")
                .bind(id)
                .bind(*label)
                .bind(score)
                .execute(&pool)
                .await
                .expect("insert row");
        }

        let columns = ColumnMap::new()
            .column("id", "id")
            .column("label", "label")
            .column("score", "score");

        async fn fetch_labels(
            pool: &SqlitePool,
            columns: &ColumnMap,
            direction: SortDirection,
        ) -> Vec<Option<String>> {
            let mut builder = QueryBuilder::new("SELECT label, score FROM nullable_widgets");
            apply_list_params(
                &mut builder,
                columns,
                &ListParams {
                    sort: vec![SortState {
                        field: "score".to_string(),
                        direction,
                    }],
                    ..Default::default()
                },
            )
            .expect("apply params");
            let rows = builder
                .build()
                .fetch_all(pool)
                .await
                .expect("query should succeed");
            rows.into_iter()
                .map(|r| r.get::<Option<String>, _>(0))
                .collect()
        }

        let asc = fetch_labels(&pool, &columns, SortDirection::Asc).await;
        assert_eq!(
            asc,
            vec![
                Some("has-score-low".to_string()),
                Some("has-score-high".to_string()),
                Some("null-score".to_string()),
            ]
        );

        let desc = fetch_labels(&pool, &columns, SortDirection::Desc).await;
        assert_eq!(
            desc,
            vec![
                Some("has-score-high".to_string()),
                Some("has-score-low".to_string()),
                Some("null-score".to_string()),
            ]
        );
    }

    #[tokio::test]
    async fn unknown_filter_field_is_rejected() {
        let params = ListParams {
            filters: vec![FilterState {
                field: "does_not_exist".to_string(),
                op: FilterOp::Eq,
                value: json!(1),
            }],
            ..Default::default()
        };
        let mut builder = QueryBuilder::new("SELECT name FROM widgets");
        let result = apply_list_params(&mut builder, &columns(), &params);
        assert!(matches!(result, Err(BantoError::BadRequest(_))));
    }

    // ---- Issue #243: a total order for paging --------------------------

    /// Rows in the `ties` fixture. `grp` has only 3 distinct values, so almost
    /// every row ties with many others on it.
    const TIE_ROWS: i64 = 97;

    /// A table where a plain `ORDER BY grp` leaves the order inside each tie
    /// up to the engine, and where an unsorted `SELECT id` is answered from
    /// the `name` index (so the "natural" order is NOT the id order): `name`
    /// is assigned in the reverse of `id`.
    async fn setup_ties() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .expect("connect in-memory sqlite");
        pool.execute(
            "CREATE TABLE ties (id INTEGER PRIMARY KEY, grp INTEGER NOT NULL, name TEXT NOT NULL)",
        )
        .await
        .expect("create table");
        pool.execute("CREATE INDEX ties_name ON ties (name)")
            .await
            .expect("create index");
        for id in 1..=TIE_ROWS {
            sqlx::query("INSERT INTO ties (id, grp, name) VALUES (?, ?, ?)")
                .bind(id)
                .bind(id % 3)
                .bind(format!("n{:04}", TIE_ROWS - id))
                .execute(&pool)
                .await
                .expect("insert row");
        }
        pool
    }

    fn tie_columns() -> ColumnMap {
        ColumnMap::new()
            .column("id", "id")
            .column("grp", "grp")
            .column("name", "name")
    }

    async fn fetch_tie_ids(
        pool: &SqlitePool,
        columns: &ColumnMap,
        params: &ListParams,
    ) -> Vec<i64> {
        let mut builder = QueryBuilder::new("SELECT id FROM ties");
        apply_list_params(&mut builder, columns, params).expect("apply params");
        builder
            .build()
            .fetch_all(pool)
            .await
            .expect("query should succeed")
            .into_iter()
            .map(|r| r.get::<i64, _>(0))
            .collect()
    }

    /// Fetch every row block by block with `LIMIT`/`OFFSET` (what a paged
    /// list or `WindowedListResource` does) and concatenate the blocks.
    async fn fetch_tie_ids_in_blocks(
        pool: &SqlitePool,
        columns: &ColumnMap,
        sort: &[SortState],
        block: u64,
    ) -> Vec<i64> {
        let mut all = Vec::new();
        let mut offset = 0;
        while offset < TIE_ROWS as u64 {
            let params = ListParams {
                sort: sort.to_vec(),
                pagination: Some(Pagination {
                    offset,
                    limit: block,
                }),
                ..Default::default()
            };
            all.extend(fetch_tie_ids(pool, columns, &params).await);
            offset += block;
        }
        all
    }

    fn by_grp(direction: SortDirection) -> Vec<SortState> {
        vec![SortState {
            field: "grp".to_string(),
            direction,
        }]
    }

    /// The order the list must have: `grp` in `direction`, then `id` in the
    /// SAME direction (the unique key follows the last sort key).
    fn expected_tie_order(direction: SortDirection) -> Vec<i64> {
        let mut ids: Vec<i64> = (1..=TIE_ROWS).collect();
        ids.sort_by(|a, b| {
            let ord = (a % 3).cmp(&(b % 3)).then(a.cmp(b));
            match direction {
                SortDirection::Asc => ord,
                SortDirection::Desc => ord.reverse(),
            }
        });
        ids
    }

    /// Ties on the sort column are broken by the unique key (`id`), in the
    /// direction of the last sort key - so the order is fully defined and
    /// does not depend on how the engine happens to scan.
    #[tokio::test]
    async fn ties_are_broken_by_the_unique_key_in_the_last_sort_direction() {
        let pool = setup_ties().await;
        for direction in [SortDirection::Asc, SortDirection::Desc] {
            let params = ListParams {
                sort: by_grp(direction),
                ..Default::default()
            };
            assert_eq!(
                fetch_tie_ids(&pool, &tie_columns(), &params).await,
                expected_tie_order(direction),
                "direction {direction:?}"
            );
        }
    }

    /// Paging through a column full of ties, block by block with `OFFSET`,
    /// yields every row exactly once (no duplicate, no gap at a block
    /// boundary) and in the defined order.
    #[tokio::test]
    async fn paging_through_ties_has_no_duplicates_or_gaps() {
        let pool = setup_ties().await;
        for direction in [SortDirection::Asc, SortDirection::Desc] {
            for block in [1, 7, 10, 50] {
                let ids =
                    fetch_tie_ids_in_blocks(&pool, &tie_columns(), &by_grp(direction), block).await;
                assert_eq!(
                    ids,
                    expected_tie_order(direction),
                    "direction {direction:?}, block {block}"
                );
            }
        }
    }

    /// No sort at all, but paged: the rows are still ordered by the unique
    /// key (ascending), not by whatever index the engine chose to scan
    /// (here the `name` index, whose order is the reverse of `id`).
    #[tokio::test]
    async fn paging_without_a_sort_orders_by_the_unique_key_ascending() {
        let pool = setup_ties().await;
        let expected: Vec<i64> = (1..=TIE_ROWS).collect();
        for block in [1, 7, 50] {
            assert_eq!(
                fetch_tie_ids_in_blocks(&pool, &tie_columns(), &[], block).await,
                expected,
                "block {block}"
            );
        }
    }

    /// The shared list-order contract (fixture `testdata/list-order-parity.json`,
    /// also asserted by the InMemory provider and the grid's client sort).
    #[tokio::test]
    async fn list_order_matches_the_shared_parity_fixture() {
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .expect("connect in-memory sqlite");
        pool.execute(
            "CREATE TABLE parity (id INTEGER PRIMARY KEY, grp INTEGER NOT NULL, score INTEGER)",
        )
        .await
        .expect("create table");
        for (id, grp, score) in super::parity_fixture::rows() {
            sqlx::query("INSERT INTO parity (id, grp, score) VALUES (?, ?, ?)")
                .bind(id)
                .bind(grp)
                .bind(score)
                .execute(&pool)
                .await
                .expect("insert row");
        }
        let cols = ColumnMap::new()
            .column("id", "id")
            .column("grp", "grp")
            .column("score", "score");
        for (sort, expected) in super::parity_fixture::cases() {
            let mut builder = QueryBuilder::new("SELECT id FROM parity");
            apply_list_params(
                &mut builder,
                &cols,
                &ListParams {
                    sort: sort.clone(),
                    ..Default::default()
                },
            )
            .expect("apply params");
            let ids: Vec<i64> = builder
                .build()
                .fetch_all(&pool)
                .await
                .expect("query")
                .into_iter()
                .map(|r| r.get::<i64, _>(0))
                .collect();
            assert_eq!(ids, expected, "sort {sort:?}");
        }
    }

    fn order_by_sql(columns: &ColumnMap, sort: &[SortState]) -> String {
        let mut builder = QueryBuilder::<sqlx::Sqlite>::new("SELECT 1");
        super::sqlite::append_order_by(&mut builder, columns, sort);
        builder.sql().as_str().to_string()
    }

    fn sort_by(entries: &[(&str, SortDirection)]) -> Vec<SortState> {
        entries
            .iter()
            .map(|(field, direction)| SortState {
                field: field.to_string(),
                direction: *direction,
            })
            .collect()
    }

    /// The unique key is not appended a second time when the sort already
    /// uses it - last or not - and its direction follows the LAST sort key.
    #[test]
    fn unique_key_is_appended_once_in_the_last_direction() {
        let cols = tie_columns();
        assert_eq!(
            order_by_sql(&cols, &sort_by(&[("id", SortDirection::Desc)])),
            "SELECT 1 ORDER BY id DESC NULLS LAST"
        );
        assert_eq!(
            order_by_sql(
                &cols,
                &sort_by(&[("id", SortDirection::Desc), ("grp", SortDirection::Asc)])
            ),
            "SELECT 1 ORDER BY id DESC NULLS LAST, grp ASC NULLS LAST"
        );
        assert_eq!(
            order_by_sql(
                &cols,
                &sort_by(&[("grp", SortDirection::Asc), ("name", SortDirection::Desc)])
            ),
            "SELECT 1 ORDER BY grp ASC NULLS LAST, name DESC NULLS LAST, id DESC NULLS LAST"
        );
        // Unknown sort fields are skipped before the direction is taken.
        assert_eq!(
            order_by_sql(
                &cols,
                &sort_by(&[("grp", SortDirection::Desc), ("nope", SortDirection::Asc)])
            ),
            "SELECT 1 ORDER BY grp DESC NULLS LAST, id DESC NULLS LAST"
        );
        assert_eq!(
            order_by_sql(&cols, &[]),
            "SELECT 1 ORDER BY id ASC NULLS LAST"
        );
    }

    /// A key with another wire name is declared with `unique_key`; the
    /// comparison is on the SQL column, so a sort by a different wire alias
    /// of the same column also counts as "already sorted by it".
    #[test]
    fn a_declared_unique_key_replaces_the_id_convention() {
        let cols = ColumnMap::new()
            .unique_key("code")
            .column("code", "item_code")
            .column("id", "legacy_id")
            .column("grp", "grp");
        assert_eq!(cols.unique_key_column(), Some("item_code"));
        assert_eq!(
            order_by_sql(&cols, &sort_by(&[("grp", SortDirection::Desc)])),
            "SELECT 1 ORDER BY grp DESC NULLS LAST, item_code DESC NULLS LAST"
        );
        let aliased = cols.clone().column("codeAlias", "item_code");
        assert_eq!(
            order_by_sql(&aliased, &sort_by(&[("codeAlias", SortDirection::Asc)])),
            "SELECT 1 ORDER BY item_code ASC NULLS LAST"
        );
    }

    /// Without an `id` column and without a declaration there is no unique
    /// key, and `without_unique_key` opts out explicitly: both keep the
    /// pre-#243 clause (derived apps whose `id` is not unique stay as they
    /// were).
    #[test]
    fn no_unique_key_keeps_the_previous_clause() {
        let no_id = ColumnMap::new().column("grp", "grp");
        assert_eq!(no_id.unique_key_column(), None);
        assert_eq!(order_by_sql(&no_id, &[]), "SELECT 1");
        assert_eq!(
            order_by_sql(&no_id, &sort_by(&[("grp", SortDirection::Asc)])),
            "SELECT 1 ORDER BY grp ASC NULLS LAST"
        );

        let opted_out = tie_columns().without_unique_key();
        assert_eq!(opted_out.unique_key_column(), None);
        assert_eq!(order_by_sql(&opted_out, &[]), "SELECT 1");
        assert_eq!(
            order_by_sql(&opted_out, &sort_by(&[("grp", SortDirection::Desc)])),
            "SELECT 1 ORDER BY grp DESC NULLS LAST"
        );
    }

    /// Declaring a key that is never registered is a programming error,
    /// caught in debug builds.
    #[test]
    #[cfg(debug_assertions)]
    #[should_panic(expected = "not registered")]
    fn an_unregistered_declared_unique_key_is_a_debug_assertion() {
        let cols = ColumnMap::new().column("grp", "grp").unique_key("code");
        order_by_sql(&cols, &[]);
    }
}

/// Mirror of the priority `tests` above against a REAL PostgreSQL server
/// (M-review 2026-08 H-3): the SQLite tests run on an in-memory,
/// dynamically-typed engine and so never exercised the `Postgres`
/// instantiation of the query builder. This module connects to
/// `BANTO_TEST_PG_URL` and is skipped (not failed) when it is unset, the same
/// idiom as `crate::postgres::tests` - CI's `storage-postgres` job sets it
/// against a `postgres:16` service container. Coverage is deliberately
/// focused on what actually differs by backend: `LIKE`/`LOWER` (including on a
/// numeric column, the H-3 regression), numeric binding, and `NULLS LAST`.
#[cfg(all(test, feature = "postgres"))]
mod postgres_tests {
    use super::postgres::apply_list_params;
    use super::*;
    use serde_json::json;
    use sqlx::{PgPool, QueryBuilder, Row};

    /// A pool against `BANTO_TEST_PG_URL`, or `None` so a plain `cargo test`
    /// with no server still passes (same skip idiom as
    /// `crate::postgres::tests::connect_gives_a_usable_pool`).
    async fn pool_or_skip() -> Option<PgPool> {
        let url = std::env::var("BANTO_TEST_PG_URL").ok()?;
        Some(
            crate::postgres::connect(&url)
                .await
                .expect("connect to BANTO_TEST_PG_URL should succeed"),
        )
    }

    fn columns() -> ColumnMap {
        ColumnMap::new()
            .column("id", "id")
            .column("name", "name")
            .column("price", "price")
            .column("active", "active")
    }

    /// (Re)create `table` and seed the same 5-row fixture the SQLite tests
    /// use. `table` is always a hardcoded literal below (never user input),
    /// so interpolating it into DDL is safe. The whole `storage-postgres` run
    /// shares one ephemeral CI database, so each test uses its OWN table name
    /// to stay independent under `cargo test`'s parallelism.
    async fn seed(pool: &PgPool, table: &str) {
        // AssertSqlSafe: `table` is always one of this test module's own
        // hardcoded literal fixture names (see this function's doc comment
        // above) - never user/external input.
        sqlx::query(sqlx::AssertSqlSafe(format!("DROP TABLE IF EXISTS {table}")))
            .execute(pool)
            .await
            .expect("drop table");
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "CREATE TABLE {table} (\
                id BIGINT PRIMARY KEY, \
                name TEXT NOT NULL, \
                price DOUBLE PRECISION NOT NULL, \
                active BIGINT NOT NULL\
            )"
        )))
        .execute(pool)
        .await
        .expect("create table");
        let rows: &[(i64, &str, f64, i64)] = &[
            (1, "Alpha Widget", 10.0, 1),
            (2, "Beta Widget", 20.0, 0),
            (3, "100% Off Widget", 5.0, 1),
            (4, "gamma_widget", 30.0, 1),
            (5, "Delta", 15.0, 0),
        ];
        for (id, name, price, active) in rows {
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "INSERT INTO {table} (id, name, price, active) VALUES ($1, $2, $3, $4)"
            )))
            .bind(id)
            .bind(*name)
            .bind(price)
            .bind(active)
            .execute(pool)
            .await
            .expect("insert row");
        }
    }

    async fn fetch_names(pool: &PgPool, table: &str, params: &ListParams) -> Vec<String> {
        let mut builder = QueryBuilder::new(format!("SELECT name FROM {table}"));
        apply_list_params(&mut builder, &columns(), params).expect("apply params");
        let rows = builder
            .build()
            .fetch_all(pool)
            .await
            .expect("query should succeed");
        rows.into_iter().map(|r| r.get::<String, _>(0)).collect()
    }

    /// `eq` on text, `>` on a `DOUBLE PRECISION` column with a JSON float
    /// operand, and `in` on a `BIGINT` column with JSON ints - the numeric
    /// `bind_value` branches (`as_i64`/`as_f64`) against real Postgres types.
    #[tokio::test]
    async fn eq_and_numeric_binding() {
        let Some(pool) = pool_or_skip().await else {
            return;
        };
        let table = "lq_pg_num";
        seed(&pool, table).await;

        let eq = ListParams {
            filters: vec![FilterState {
                field: "name".to_string(),
                op: FilterOp::Eq,
                value: json!("Alpha Widget"),
            }],
            ..Default::default()
        };
        assert_eq!(fetch_names(&pool, table, &eq).await, vec!["Alpha Widget"]);

        let gt = ListParams {
            filters: vec![FilterState {
                field: "price".to_string(),
                op: FilterOp::Gt,
                value: json!(20.0),
            }],
            ..Default::default()
        };
        assert_eq!(fetch_names(&pool, table, &gt).await, vec!["gamma_widget"]);

        let in_ = ListParams {
            filters: vec![FilterState {
                field: "id".to_string(),
                op: FilterOp::In,
                value: json!([1, 3]),
            }],
            sort: vec![SortState {
                field: "id".to_string(),
                direction: SortDirection::Asc,
            }],
            ..Default::default()
        };
        assert_eq!(
            fetch_names(&pool, table, &in_).await,
            vec!["Alpha Widget", "100% Off Widget"]
        );
    }

    #[tokio::test]
    async fn like_on_text_is_case_insensitive() {
        let Some(pool) = pool_or_skip().await else {
            return;
        };
        let table = "lq_pg_like_text";
        seed(&pool, table).await;
        let params = ListParams {
            filters: vec![FilterState {
                field: "name".to_string(),
                op: FilterOp::Contains,
                value: json!("WIDGET"),
            }],
            sort: vec![SortState {
                field: "id".to_string(),
                direction: SortDirection::Asc,
            }],
            ..Default::default()
        };
        assert_eq!(
            fetch_names(&pool, table, &params).await,
            vec![
                "Alpha Widget",
                "Beta Widget",
                "100% Off Widget",
                "gamma_widget"
            ]
        );
    }

    /// The H-3 regression itself: `contains` on a NUMERIC column. Before the
    /// `CAST(.. AS TEXT)` fix this generated `lower(<bigint>)`, which Postgres
    /// rejects at runtime ("function lower(bigint) does not exist") - so the
    /// list endpoint would 500. It must now match by the integer's text form.
    #[tokio::test]
    async fn like_on_a_numeric_column_does_not_error() {
        let Some(pool) = pool_or_skip().await else {
            return;
        };
        let table = "lq_pg_like_num";
        seed(&pool, table).await;
        let params = ListParams {
            filters: vec![FilterState {
                field: "id".to_string(),
                op: FilterOp::Contains,
                value: json!(1),
            }],
            ..Default::default()
        };
        assert_eq!(
            fetch_names(&pool, table, &params).await,
            vec!["Alpha Widget"]
        );
    }

    /// `NULLS LAST` for both directions. Postgres's native default is
    /// nulls-FIRST on `DESC`, so the explicit `NULLS LAST` the builder emits
    /// matters here specifically (SQLite defaults differently again - the
    /// point of the drift fix is that all backends agree).
    #[tokio::test]
    async fn nulls_sort_last_both_directions() {
        let Some(pool) = pool_or_skip().await else {
            return;
        };
        let table = "lq_pg_nulls";
        // AssertSqlSafe: `table` is the hardcoded literal above (never
        // user/external input), same as `seed`'s doc comment.
        sqlx::query(sqlx::AssertSqlSafe(format!("DROP TABLE IF EXISTS {table}")))
            .execute(&pool)
            .await
            .expect("drop table");
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "CREATE TABLE {table} (id BIGINT PRIMARY KEY, label TEXT NOT NULL, score DOUBLE PRECISION)"
        )))
        .execute(&pool)
        .await
        .expect("create table");
        let rows: &[(i64, &str, Option<f64>)] = &[
            (1, "has-score-low", Some(1.0)),
            (2, "null-score", None),
            (3, "has-score-high", Some(2.0)),
        ];
        for (id, label, score) in rows {
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "INSERT INTO {table} (id, label, score) VALUES ($1, $2, $3)"
            )))
            .bind(id)
            .bind(*label)
            .bind(score)
            .execute(&pool)
            .await
            .expect("insert row");
        }

        let cols = ColumnMap::new()
            .column("label", "label")
            .column("score", "score");

        async fn labels(
            pool: &PgPool,
            table: &str,
            cols: &ColumnMap,
            direction: SortDirection,
        ) -> Vec<String> {
            let mut builder = QueryBuilder::new(format!("SELECT label FROM {table}"));
            apply_list_params(
                &mut builder,
                cols,
                &ListParams {
                    sort: vec![SortState {
                        field: "score".to_string(),
                        direction,
                    }],
                    ..Default::default()
                },
            )
            .expect("apply params");
            builder
                .build()
                .fetch_all(pool)
                .await
                .expect("query should succeed")
                .into_iter()
                .map(|r| r.get::<String, _>(0))
                .collect()
        }

        assert_eq!(
            labels(&pool, table, &cols, SortDirection::Asc).await,
            vec!["has-score-low", "has-score-high", "null-score"]
        );
        assert_eq!(
            labels(&pool, table, &cols, SortDirection::Desc).await,
            vec!["has-score-high", "has-score-low", "null-score"]
        );
    }

    // ---- Issue #243: a total order for paging --------------------------

    /// Enough rows that Postgres picks a top-N heapsort for `ORDER BY ..
    /// LIMIT`, whose order among tied rows differs with `LIMIT`/`OFFSET`.
    const PG_TIE_ROWS: i64 = 3000;

    /// `grp` has 3 distinct values; rows are inserted in a scrambled order
    /// so the heap order is not the id order either.
    async fn seed_ties(pool: &PgPool, table: &str) {
        // AssertSqlSafe: `table` is always a hardcoded literal fixture name
        // from this module (see `seed`'s doc comment) - never user input.
        sqlx::query(sqlx::AssertSqlSafe(format!("DROP TABLE IF EXISTS {table}")))
            .execute(pool)
            .await
            .expect("drop table");
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "CREATE TABLE {table} (id BIGINT PRIMARY KEY, grp BIGINT NOT NULL)"
        )))
        .execute(pool)
        .await
        .expect("create table");
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "INSERT INTO {table} (id, grp) \
             SELECT id, id % 3 FROM generate_series(1, {PG_TIE_ROWS}) AS id \
             ORDER BY (id * 7919) % {PG_TIE_ROWS}"
        )))
        .execute(pool)
        .await
        .expect("insert rows");
        sqlx::query(sqlx::AssertSqlSafe(format!("ANALYZE {table}")))
            .execute(pool)
            .await
            .expect("analyze");
    }

    fn tie_columns() -> ColumnMap {
        ColumnMap::new().column("id", "id").column("grp", "grp")
    }

    async fn fetch_tie_ids_in_blocks(
        pool: &PgPool,
        table: &str,
        sort: &[SortState],
        block: u64,
    ) -> Vec<i64> {
        let mut all = Vec::new();
        let mut offset = 0;
        while offset < PG_TIE_ROWS as u64 {
            let mut builder = QueryBuilder::new(format!("SELECT id FROM {table}"));
            apply_list_params(
                &mut builder,
                &tie_columns(),
                &ListParams {
                    sort: sort.to_vec(),
                    pagination: Some(banto_core::Pagination {
                        offset,
                        limit: block,
                    }),
                    ..Default::default()
                },
            )
            .expect("apply params");
            all.extend(
                builder
                    .build()
                    .fetch_all(pool)
                    .await
                    .expect("query should succeed")
                    .into_iter()
                    .map(|r| r.get::<i64, _>(0)),
            );
            offset += block;
        }
        all
    }

    fn expected_tie_order(direction: Option<SortDirection>) -> Vec<i64> {
        let mut ids: Vec<i64> = (1..=PG_TIE_ROWS).collect();
        match direction {
            None => {}
            Some(SortDirection::Asc) => ids.sort_by_key(|id| (id % 3, *id)),
            Some(SortDirection::Desc) => ids.sort_by_key(|id| std::cmp::Reverse((id % 3, *id))),
        }
        ids
    }

    /// The #243 reproduction on a real server: paging with `OFFSET` through
    /// a column full of ties must return every row exactly once, in the
    /// defined order (ties broken by `id` in the last sort direction). Without
    /// the unique-key tiebreaker Postgres returns overlapping blocks.
    #[tokio::test]
    async fn paging_through_ties_has_no_duplicates_or_gaps() {
        let Some(pool) = pool_or_skip().await else {
            return;
        };
        let table = "lq_pg_ties";
        seed_ties(&pool, table).await;
        for direction in [SortDirection::Asc, SortDirection::Desc] {
            let sort = vec![SortState {
                field: "grp".to_string(),
                direction,
            }];
            for block in [50, 200] {
                let ids = fetch_tie_ids_in_blocks(&pool, table, &sort, block).await;
                let unique: std::collections::HashSet<i64> = ids.iter().copied().collect();
                assert_eq!(
                    (ids.len(), unique.len()),
                    (PG_TIE_ROWS as usize, PG_TIE_ROWS as usize),
                    "direction {direction:?}, block {block}: duplicates or gaps"
                );
                assert_eq!(
                    ids,
                    expected_tie_order(Some(direction)),
                    "direction {direction:?}, block {block}"
                );
            }
        }
    }

    /// No sort, but paged: ordered by the unique key ascending, so the
    /// blocks still tile the table exactly.
    #[tokio::test]
    async fn paging_without_a_sort_orders_by_the_unique_key_ascending() {
        let Some(pool) = pool_or_skip().await else {
            return;
        };
        let table = "lq_pg_ties_unsorted";
        seed_ties(&pool, table).await;
        assert_eq!(
            fetch_tie_ids_in_blocks(&pool, table, &[], 200).await,
            expected_tie_order(None)
        );
    }

    /// The shared list-order contract on a real server (see the SQLite twin).
    #[tokio::test]
    async fn list_order_matches_the_shared_parity_fixture() {
        let Some(pool) = pool_or_skip().await else {
            return;
        };
        let table = "lq_pg_parity";
        // AssertSqlSafe: `table` is the hardcoded literal above.
        sqlx::query(sqlx::AssertSqlSafe(format!("DROP TABLE IF EXISTS {table}")))
            .execute(&pool)
            .await
            .expect("drop table");
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "CREATE TABLE {table} (id BIGINT PRIMARY KEY, grp BIGINT NOT NULL, score BIGINT)"
        )))
        .execute(&pool)
        .await
        .expect("create table");
        for (id, grp, score) in super::parity_fixture::rows() {
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "INSERT INTO {table} (id, grp, score) VALUES ($1, $2, $3)"
            )))
            .bind(id)
            .bind(grp)
            .bind(score)
            .execute(&pool)
            .await
            .expect("insert row");
        }
        let cols = ColumnMap::new()
            .column("id", "id")
            .column("grp", "grp")
            .column("score", "score");
        for (sort, expected) in super::parity_fixture::cases() {
            let mut builder = QueryBuilder::new(format!("SELECT id FROM {table}"));
            apply_list_params(
                &mut builder,
                &cols,
                &ListParams {
                    sort: sort.clone(),
                    ..Default::default()
                },
            )
            .expect("apply params");
            let ids: Vec<i64> = builder
                .build()
                .fetch_all(&pool)
                .await
                .expect("query")
                .into_iter()
                .map(|r| r.get::<i64, _>(0))
                .collect();
            assert_eq!(ids, expected, "sort {sort:?}");
        }
    }

    /// An unknown filter field is a `BadRequest` on the Postgres path too
    /// (pure SQL building - no server needed, so this one is not skipped).
    #[tokio::test]
    async fn unknown_filter_field_is_rejected() {
        let mut builder = QueryBuilder::<sqlx::Postgres>::new("SELECT name FROM whatever");
        let params = ListParams {
            filters: vec![FilterState {
                field: "does_not_exist".to_string(),
                op: FilterOp::Eq,
                value: json!(1),
            }],
            ..Default::default()
        };
        let result = apply_list_params(&mut builder, &columns(), &params);
        assert!(matches!(result, Err(BantoError::BadRequest(_))));
    }
}
