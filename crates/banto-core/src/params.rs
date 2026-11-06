use serde::{Deserialize, Serialize};

/// Sort direction for a single column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortDirection {
    Asc,
    Desc,
}

/// One entry of a multi-column sort. Order in the containing `Vec` is the
/// sort priority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SortState {
    /// Column/field identifier as declared in the frontend column definition.
    pub field: String,
    pub direction: SortDirection,
}

/// Filter operators shared by the grid column filters and REST queries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Eq,
    Ne,
    Lt,
    Lte,
    Gt,
    Gte,
    Contains,
    StartsWith,
    In,
    IsNull,
    NotNull,
}

/// A single column filter condition. Conditions in a list are combined
/// with AND; OR groups can be added later without breaking this shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FilterState {
    pub field: String,
    pub op: FilterOp,
    /// JSON value so string/number/date/list operands share one type.
    #[serde(default)]
    pub value: serde_json::Value,
}

/// Offset-based pagination. Cursor-based paging can be introduced as an
/// enum variant later (spec §10 keeps the wire shape forward-compatible).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pagination {
    pub offset: u64,
    pub limit: u64,
}

impl Default for Pagination {
    fn default() -> Self {
        Self {
            offset: 0,
            limit: 50,
        }
    }
}

/// Parameters for `DataProvider.getList` (spec §3.2).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ListParams {
    #[serde(default)]
    pub pagination: Option<Pagination>,
    #[serde(default)]
    pub sort: Vec<SortState>,
    #[serde(default)]
    pub filters: Vec<FilterState>,
}

/// Result envelope for `DataProvider.getList`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResult<T> {
    pub rows: Vec<T>,
    pub total_count: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// `ListResult`'s `total_count` must serialize as `totalCount` to match
    /// `packages/admin-core/src/types.ts::ListResult`.
    #[test]
    fn list_result_serializes_as_camel_case() {
        let value = ListResult {
            rows: vec!["a", "b"],
            total_count: 2,
        };
        assert_eq!(
            serde_json::to_value(&value).unwrap(),
            json!({ "rows": ["a", "b"], "totalCount": 2 })
        );
    }

    /// `SortState` mirrors `packages/admin-core/src/types.ts::SortState`:
    /// `{ field, direction: 'asc' | 'desc' }`.
    #[test]
    fn sort_state_matches_ts_shape() {
        let value = SortState {
            field: "price".to_string(),
            direction: SortDirection::Asc,
        };
        assert_eq!(
            serde_json::to_value(&value).unwrap(),
            json!({ "field": "price", "direction": "asc" })
        );
        let value = SortState {
            field: "price".to_string(),
            direction: SortDirection::Desc,
        };
        assert_eq!(
            serde_json::to_value(&value).unwrap(),
            json!({ "field": "price", "direction": "desc" })
        );
    }

    /// `FilterState` mirrors `packages/admin-core/src/types.ts::FilterState`:
    /// `{ field, op: <snake_case>, value }`.
    #[test]
    fn filter_state_matches_ts_shape() {
        let value = FilterState {
            field: "name".to_string(),
            op: FilterOp::StartsWith,
            value: json!("green"),
        };
        assert_eq!(
            serde_json::to_value(&value).unwrap(),
            json!({ "field": "name", "op": "starts_with", "value": "green" })
        );

        // Every FilterOp variant must round-trip through its snake_case wire name.
        let ops = [
            (FilterOp::Eq, "eq"),
            (FilterOp::Ne, "ne"),
            (FilterOp::Lt, "lt"),
            (FilterOp::Lte, "lte"),
            (FilterOp::Gt, "gt"),
            (FilterOp::Gte, "gte"),
            (FilterOp::Contains, "contains"),
            (FilterOp::StartsWith, "starts_with"),
            (FilterOp::In, "in"),
            (FilterOp::IsNull, "is_null"),
            (FilterOp::NotNull, "not_null"),
        ];
        for (op, wire) in ops {
            assert_eq!(serde_json::to_value(op).unwrap(), json!(wire));
            let round_tripped: FilterOp = serde_json::from_value(json!(wire)).unwrap();
            assert_eq!(round_tripped, op);
        }
    }

    /// `Pagination` mirrors `packages/admin-core/src/types.ts::Pagination`:
    /// `{ offset, limit }`.
    #[test]
    fn pagination_matches_ts_shape() {
        let value = Pagination {
            offset: 20,
            limit: 50,
        };
        assert_eq!(
            serde_json::to_value(value).unwrap(),
            json!({ "offset": 20, "limit": 50 })
        );
    }

    /// `ListParams` mirrors `packages/admin-core/src/types.ts::ListParams`.
    #[test]
    fn list_params_matches_ts_shape() {
        let value = ListParams {
            pagination: Some(Pagination {
                offset: 0,
                limit: 20,
            }),
            sort: vec![SortState {
                field: "id".to_string(),
                direction: SortDirection::Desc,
            }],
            filters: vec![FilterState {
                field: "stock".to_string(),
                op: FilterOp::Gte,
                value: json!(0),
            }],
        };
        assert_eq!(
            serde_json::to_value(&value).unwrap(),
            json!({
                "pagination": { "offset": 0, "limit": 20 },
                "sort": [{ "field": "id", "direction": "desc" }],
                "filters": [{ "field": "stock", "op": "gte", "value": 0 }]
            })
        );
    }
}
