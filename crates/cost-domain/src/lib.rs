//! 案件原価・利益管理の計算規則。
//!
//! - 金額は円の整数（[`Yen`]）、工数は分の整数（[`Minutes`]）で扱い、浮動小数を使わない。
//! - 不明な値は `None` で表し、0円・0%に置き換えない。
//! - 利益率は分母が0または不明のとき `None`（画面では「算出不可」）。
//!
//! 仕様は `docs/project/spec.md`、設計は `docs/project/design.md` を参照。
//! 各モジュールのテスト名にある `t02` などは仕様書の受入条件番号。

pub mod budget;
pub mod calc_basis;
pub mod calendar;
pub mod closeout;
pub mod forecast;
pub mod ledger;
pub mod money;
pub mod order;
pub mod outlook;
pub mod pipeline;
pub mod project;
pub mod purchase;
pub mod revenue;
pub mod time;

pub use calendar::{Date, FiscalCalendar, YearMonth};
pub use money::{labor_cost, ratio_permille, Minutes, Yen};
