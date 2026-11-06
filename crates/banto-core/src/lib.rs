//! Banto core: shared types and traits used by both Tauri command handlers
//! and the embedded REST server (spec §3.2, §10).
//!
//! Everything the frontend `DataProvider` sends across the boundary is
//! defined here so that Tauri commands and REST endpoints deserialize the
//! exact same shapes.

pub mod error;
pub mod params;

pub use error::{BantoError, ErrorBody, FieldError};
pub use params::{
    FilterOp, FilterState, ListParams, ListResult, Pagination, SortDirection, SortState,
};
