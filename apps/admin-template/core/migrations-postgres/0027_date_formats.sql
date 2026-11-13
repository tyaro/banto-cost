-- banto-cost (docs/project/design.md §3.6, review §8-16 M-1・M-5): 日付・月の
-- 形式の検査と売上予定の (案件, 月) の一意制約.
--
-- Business dates are TEXT 'YYYY-MM-DD' and months TEXT 'YYYY-MM'; closing,
-- monthly totals and period ranges compare and cut these strings, so a row
-- like '2026-6-1' would silently fall out of a month. The services always
-- parse them first; these checks stop the other ways in (hand-written SQL,
-- a future import from the company spreadsheets).
--
-- Each table gets one CHECK constraint, added NOT VALID so that, as in the
-- SQLite twin (which uses triggers), rows already stored are not re-checked.
-- The pattern checks the shape and the month and day ranges (01-12, 01-31);
-- unlike the SQLite twin it does not reject a day past the month's end such
-- as '2026-02-30' (Postgres is not used yet, 2026-11-13). Timestamps (*_at)
-- are not business dates and are not checked.
--
-- revenue_plan and pipeline_revenue_plan hold one line per month (month
-- NULL = timing undecided, one such line at most); the services already
-- refuse duplicates (duplicate_plan_month), the indexes make it a rule.

ALTER TABLE projects ADD CONSTRAINT projects_dates_format CHECK (
    planned_start ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
    AND planned_end ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
) NOT VALID;

ALTER TABLE pipeline_versions ADD CONSTRAINT pipeline_versions_dates_format CHECK (
    expected_order_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
    AND expected_start_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
    AND expected_end_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
    AND confirmed_on ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
) NOT VALID;

ALTER TABLE pipeline_revenue_plan ADD CONSTRAINT pipeline_revenue_plan_dates_format CHECK (
    month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
) NOT VALID;

ALTER TABLE order_conversions ADD CONSTRAINT order_conversions_dates_format CHECK (
    converted_on ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
    AND cancelled_on ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
) NOT VALID;

ALTER TABLE order_conversion_corrections ADD CONSTRAINT order_conversion_corrections_dates_format CHECK (
    old_converted_on ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
    AND new_converted_on ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
    AND corrected_on ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
) NOT VALID;

ALTER TABLE order_changes ADD CONSTRAINT order_changes_dates_format CHECK (
    plan_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
) NOT VALID;

ALTER TABLE revenue_plan ADD CONSTRAINT revenue_plan_dates_format CHECK (
    month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
) NOT VALID;

ALTER TABLE revenue_recognitions ADD CONSTRAINT revenue_recognitions_dates_format CHECK (
    recognized_on ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
) NOT VALID;

ALTER TABLE outlook_snapshot_rows ADD CONSTRAINT outlook_snapshot_rows_dates_format CHECK (
    month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
) NOT VALID;

ALTER TABLE calc_values ADD CONSTRAINT calc_values_dates_format CHECK (
    valid_from ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
) NOT VALID;

ALTER TABLE time_entries ADD CONSTRAINT time_entries_dates_format CHECK (
    work_date ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
) NOT VALID;

ALTER TABLE budget_versions ADD CONSTRAINT budget_versions_dates_format CHECK (
    created_on ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
) NOT VALID;

ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_dates_format CHECK (
    ordered_on ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
) NOT VALID;

ALTER TABLE direct_costs ADD CONSTRAINT direct_costs_dates_format CHECK (
    booked_on ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
) NOT VALID;

ALTER TABLE forecast_versions ADD CONSTRAINT forecast_versions_dates_format CHECK (
    base_date ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
    AND planned_end ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
) NOT VALID;

ALTER TABLE project_closeouts ADD CONSTRAINT project_closeouts_dates_format CHECK (
    settled_on ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
) NOT VALID;

ALTER TABLE closeout_reopenings ADD CONSTRAINT closeout_reopenings_dates_format CHECK (
    reopened_on ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
) NOT VALID;

ALTER TABLE closing_periods ADD CONSTRAINT closing_periods_dates_format CHECK (
    month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
) NOT VALID;

ALTER TABLE closing_events ADD CONSTRAINT closing_events_dates_format CHECK (
    month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
) NOT VALID;

ALTER TABLE fixed_cost_contracts ADD CONSTRAINT fixed_cost_contracts_dates_format CHECK (
    from_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
    AND to_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
) NOT VALID;

ALTER TABLE fixed_cost_postings ADD CONSTRAINT fixed_cost_postings_dates_format CHECK (
    month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
    AND booked_on ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
) NOT VALID;

ALTER TABLE recurring_revenues ADD CONSTRAINT recurring_revenues_dates_format CHECK (
    from_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
    AND to_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
) NOT VALID;

CREATE UNIQUE INDEX revenue_plan_month ON revenue_plan (project_id, COALESCE(month, ''));

CREATE UNIQUE INDEX pipeline_revenue_plan_month
    ON pipeline_revenue_plan (pipeline_version_id, COALESCE(month, ''));
