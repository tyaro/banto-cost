//! The shared edge cases of date-time-pickers §5.3 / §5.6 (PR-5):
//! `datetime-cases.json` is also run by the frontend's tests
//! (`packages/forms/tests/temporalField.test.ts`,
//! `packages/grid-svelte/tests/temporal.test.ts`), so Rust and TypeScript keep
//! the same canonical forms, rules and default messages.

use banto_core::datetime::{
    is_iso_date, is_iso_datetime, is_iso_time, validate_date, validate_datetime, validate_time,
};
use serde_json::Value;

fn cases() -> Value {
    serde_json::from_str(include_str!("datetime-cases.json")).expect("datetime-cases.json")
}

fn text<'a>(case: &'a Value, key: &str) -> Option<&'a str> {
    case.get(key).and_then(Value::as_str)
}

#[test]
fn canonical_forms_match_the_shared_table() {
    let cases = cases();
    let canonical = cases["canonical"].as_array().expect("canonical");
    assert!(!canonical.is_empty());
    for case in canonical {
        let value = text(case, "value").expect("value");
        let valid = case["valid"].as_bool().expect("valid");
        let actual = match text(case, "type").expect("type") {
            "date" => is_iso_date(value),
            "time" => is_iso_time(value),
            "datetime" => is_iso_datetime(value),
            other => panic!("unknown type {other}"),
        };
        assert_eq!(actual, valid, "{case}");
    }
}

#[test]
fn validation_rules_match_the_shared_table() {
    let cases = cases();
    let rules = cases["rules"].as_array().expect("rules");
    assert!(!rules.is_empty());
    for case in rules {
        let value = text(case, "value").expect("value");
        let (min, max) = (text(case, "min"), text(case, "max"));
        let step = case
            .get("step")
            .and_then(Value::as_u64)
            .map(|step| u32::try_from(step).expect("step"));
        let expected = text(case, "error");
        let actual = match text(case, "type").expect("type") {
            "date" => validate_date(value, min, max),
            "time" => validate_time(value, min, max, step),
            "datetime" => validate_datetime(value, min, max, step),
            other => panic!("unknown type {other}"),
        };
        assert_eq!(actual.as_deref(), expected, "{case}");
    }
}
