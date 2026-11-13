-- banto-cost (docs/project/design.md §3.6, review §8-16 M-1・M-5): 日付・月の
-- 形式の検査と売上予定の (案件, 月) の一意制約.
--
-- Business dates are TEXT 'YYYY-MM-DD' and months TEXT 'YYYY-MM'; closing,
-- monthly totals and period ranges compare and cut these strings, so a row
-- like '2026-6-1' would silently fall out of a month. The services always
-- parse them first; these checks stop the other ways in (hand-written SQL,
-- a future import from the company spreadsheets).
--
-- SQLite cannot add a CHECK to an existing table without rebuilding it, so
-- each table gets a BEFORE INSERT and a BEFORE UPDATE OF <columns> trigger
-- that aborts unless the value round-trips through date() (a real calendar
-- date in the canonical form; a month is checked as its first day). Rows
-- already stored are not re-checked, and an update checks only the columns
-- whose value it changes. A later migration that rebuilds one of
-- these tables (create new, copy, drop, rename) drops its triggers and must
-- create them again. Timestamps (*_at) are not business dates and are not
-- checked. The Postgres twin uses one trigger function.
--
-- revenue_plan and pipeline_revenue_plan hold one line per month (month
-- NULL = timing undecided, one such line at most); the services already
-- refuse duplicates (duplicate_plan_month). A trigger refuses an insert or
-- an update that would make a second line for the same project (pipeline
-- version) and month. It is not a unique index because duplicates already
-- stored (hand-written SQL) would make creating the index fail and stop the
-- app from starting; like the date checks, existing rows are not re-checked.

CREATE TRIGGER projects_dates_insert BEFORE INSERT ON projects
WHEN (NEW.planned_start IS NOT NULL AND date(NEW.planned_start) IS NOT NEW.planned_start)
    OR (NEW.planned_end IS NOT NULL AND date(NEW.planned_end) IS NOT NEW.planned_end)
BEGIN
    SELECT RAISE(ABORT, 'projects: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER projects_dates_update BEFORE UPDATE OF planned_start, planned_end ON projects
WHEN (NEW.planned_start IS NOT OLD.planned_start AND NEW.planned_start IS NOT NULL AND date(NEW.planned_start) IS NOT NEW.planned_start)
    OR (NEW.planned_end IS NOT OLD.planned_end AND NEW.planned_end IS NOT NULL AND date(NEW.planned_end) IS NOT NEW.planned_end)
BEGIN
    SELECT RAISE(ABORT, 'projects: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER pipeline_versions_dates_insert BEFORE INSERT ON pipeline_versions
WHEN (NEW.expected_order_month IS NOT NULL AND (length(NEW.expected_order_month) <> 7 OR date(NEW.expected_order_month || '-01') IS NOT NEW.expected_order_month || '-01'))
    OR (NEW.expected_start_month IS NOT NULL AND (length(NEW.expected_start_month) <> 7 OR date(NEW.expected_start_month || '-01') IS NOT NEW.expected_start_month || '-01'))
    OR (NEW.expected_end_month IS NOT NULL AND (length(NEW.expected_end_month) <> 7 OR date(NEW.expected_end_month || '-01') IS NOT NEW.expected_end_month || '-01'))
    OR (NEW.confirmed_on IS NOT NULL AND date(NEW.confirmed_on) IS NOT NEW.confirmed_on)
BEGIN
    SELECT RAISE(ABORT, 'pipeline_versions: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER pipeline_versions_dates_update BEFORE UPDATE OF expected_order_month, expected_start_month, expected_end_month, confirmed_on ON pipeline_versions
WHEN (NEW.expected_order_month IS NOT OLD.expected_order_month AND NEW.expected_order_month IS NOT NULL AND (length(NEW.expected_order_month) <> 7 OR date(NEW.expected_order_month || '-01') IS NOT NEW.expected_order_month || '-01'))
    OR (NEW.expected_start_month IS NOT OLD.expected_start_month AND NEW.expected_start_month IS NOT NULL AND (length(NEW.expected_start_month) <> 7 OR date(NEW.expected_start_month || '-01') IS NOT NEW.expected_start_month || '-01'))
    OR (NEW.expected_end_month IS NOT OLD.expected_end_month AND NEW.expected_end_month IS NOT NULL AND (length(NEW.expected_end_month) <> 7 OR date(NEW.expected_end_month || '-01') IS NOT NEW.expected_end_month || '-01'))
    OR (NEW.confirmed_on IS NOT OLD.confirmed_on AND NEW.confirmed_on IS NOT NULL AND date(NEW.confirmed_on) IS NOT NEW.confirmed_on)
BEGIN
    SELECT RAISE(ABORT, 'pipeline_versions: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER pipeline_revenue_plan_dates_insert BEFORE INSERT ON pipeline_revenue_plan
WHEN (NEW.month IS NOT NULL AND (length(NEW.month) <> 7 OR date(NEW.month || '-01') IS NOT NEW.month || '-01'))
BEGIN
    SELECT RAISE(ABORT, 'pipeline_revenue_plan: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER pipeline_revenue_plan_dates_update BEFORE UPDATE OF month ON pipeline_revenue_plan
WHEN (NEW.month IS NOT OLD.month AND NEW.month IS NOT NULL AND (length(NEW.month) <> 7 OR date(NEW.month || '-01') IS NOT NEW.month || '-01'))
BEGIN
    SELECT RAISE(ABORT, 'pipeline_revenue_plan: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER order_conversions_dates_insert BEFORE INSERT ON order_conversions
WHEN (NEW.converted_on IS NOT NULL AND date(NEW.converted_on) IS NOT NEW.converted_on)
    OR (NEW.cancelled_on IS NOT NULL AND date(NEW.cancelled_on) IS NOT NEW.cancelled_on)
BEGIN
    SELECT RAISE(ABORT, 'order_conversions: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER order_conversions_dates_update BEFORE UPDATE OF converted_on, cancelled_on ON order_conversions
WHEN (NEW.converted_on IS NOT OLD.converted_on AND NEW.converted_on IS NOT NULL AND date(NEW.converted_on) IS NOT NEW.converted_on)
    OR (NEW.cancelled_on IS NOT OLD.cancelled_on AND NEW.cancelled_on IS NOT NULL AND date(NEW.cancelled_on) IS NOT NEW.cancelled_on)
BEGIN
    SELECT RAISE(ABORT, 'order_conversions: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER order_conversion_corrections_dates_insert BEFORE INSERT ON order_conversion_corrections
WHEN (NEW.old_converted_on IS NOT NULL AND date(NEW.old_converted_on) IS NOT NEW.old_converted_on)
    OR (NEW.new_converted_on IS NOT NULL AND date(NEW.new_converted_on) IS NOT NEW.new_converted_on)
    OR (NEW.corrected_on IS NOT NULL AND date(NEW.corrected_on) IS NOT NEW.corrected_on)
BEGIN
    SELECT RAISE(ABORT, 'order_conversion_corrections: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER order_conversion_corrections_dates_update BEFORE UPDATE OF old_converted_on, new_converted_on, corrected_on ON order_conversion_corrections
WHEN (NEW.old_converted_on IS NOT OLD.old_converted_on AND NEW.old_converted_on IS NOT NULL AND date(NEW.old_converted_on) IS NOT NEW.old_converted_on)
    OR (NEW.new_converted_on IS NOT OLD.new_converted_on AND NEW.new_converted_on IS NOT NULL AND date(NEW.new_converted_on) IS NOT NEW.new_converted_on)
    OR (NEW.corrected_on IS NOT OLD.corrected_on AND NEW.corrected_on IS NOT NULL AND date(NEW.corrected_on) IS NOT NEW.corrected_on)
BEGIN
    SELECT RAISE(ABORT, 'order_conversion_corrections: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER order_changes_dates_insert BEFORE INSERT ON order_changes
WHEN (NEW.plan_month IS NOT NULL AND (length(NEW.plan_month) <> 7 OR date(NEW.plan_month || '-01') IS NOT NEW.plan_month || '-01'))
BEGIN
    SELECT RAISE(ABORT, 'order_changes: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER order_changes_dates_update BEFORE UPDATE OF plan_month ON order_changes
WHEN (NEW.plan_month IS NOT OLD.plan_month AND NEW.plan_month IS NOT NULL AND (length(NEW.plan_month) <> 7 OR date(NEW.plan_month || '-01') IS NOT NEW.plan_month || '-01'))
BEGIN
    SELECT RAISE(ABORT, 'order_changes: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER revenue_plan_dates_insert BEFORE INSERT ON revenue_plan
WHEN (NEW.month IS NOT NULL AND (length(NEW.month) <> 7 OR date(NEW.month || '-01') IS NOT NEW.month || '-01'))
BEGIN
    SELECT RAISE(ABORT, 'revenue_plan: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER revenue_plan_dates_update BEFORE UPDATE OF month ON revenue_plan
WHEN (NEW.month IS NOT OLD.month AND NEW.month IS NOT NULL AND (length(NEW.month) <> 7 OR date(NEW.month || '-01') IS NOT NEW.month || '-01'))
BEGIN
    SELECT RAISE(ABORT, 'revenue_plan: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER revenue_recognitions_dates_insert BEFORE INSERT ON revenue_recognitions
WHEN (NEW.recognized_on IS NOT NULL AND date(NEW.recognized_on) IS NOT NEW.recognized_on)
BEGIN
    SELECT RAISE(ABORT, 'revenue_recognitions: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER revenue_recognitions_dates_update BEFORE UPDATE OF recognized_on ON revenue_recognitions
WHEN (NEW.recognized_on IS NOT OLD.recognized_on AND NEW.recognized_on IS NOT NULL AND date(NEW.recognized_on) IS NOT NEW.recognized_on)
BEGIN
    SELECT RAISE(ABORT, 'revenue_recognitions: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER outlook_snapshot_rows_dates_insert BEFORE INSERT ON outlook_snapshot_rows
WHEN (NEW.month IS NOT NULL AND (length(NEW.month) <> 7 OR date(NEW.month || '-01') IS NOT NEW.month || '-01'))
BEGIN
    SELECT RAISE(ABORT, 'outlook_snapshot_rows: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER outlook_snapshot_rows_dates_update BEFORE UPDATE OF month ON outlook_snapshot_rows
WHEN (NEW.month IS NOT OLD.month AND NEW.month IS NOT NULL AND (length(NEW.month) <> 7 OR date(NEW.month || '-01') IS NOT NEW.month || '-01'))
BEGIN
    SELECT RAISE(ABORT, 'outlook_snapshot_rows: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER calc_values_dates_insert BEFORE INSERT ON calc_values
WHEN (NEW.valid_from IS NOT NULL AND date(NEW.valid_from) IS NOT NEW.valid_from)
BEGIN
    SELECT RAISE(ABORT, 'calc_values: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER calc_values_dates_update BEFORE UPDATE OF valid_from ON calc_values
WHEN (NEW.valid_from IS NOT OLD.valid_from AND NEW.valid_from IS NOT NULL AND date(NEW.valid_from) IS NOT NEW.valid_from)
BEGIN
    SELECT RAISE(ABORT, 'calc_values: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER time_entries_dates_insert BEFORE INSERT ON time_entries
WHEN (NEW.work_date IS NOT NULL AND date(NEW.work_date) IS NOT NEW.work_date)
BEGIN
    SELECT RAISE(ABORT, 'time_entries: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER time_entries_dates_update BEFORE UPDATE OF work_date ON time_entries
WHEN (NEW.work_date IS NOT OLD.work_date AND NEW.work_date IS NOT NULL AND date(NEW.work_date) IS NOT NEW.work_date)
BEGIN
    SELECT RAISE(ABORT, 'time_entries: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER budget_versions_dates_insert BEFORE INSERT ON budget_versions
WHEN (NEW.created_on IS NOT NULL AND date(NEW.created_on) IS NOT NEW.created_on)
BEGIN
    SELECT RAISE(ABORT, 'budget_versions: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER budget_versions_dates_update BEFORE UPDATE OF created_on ON budget_versions
WHEN (NEW.created_on IS NOT OLD.created_on AND NEW.created_on IS NOT NULL AND date(NEW.created_on) IS NOT NEW.created_on)
BEGIN
    SELECT RAISE(ABORT, 'budget_versions: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER purchase_orders_dates_insert BEFORE INSERT ON purchase_orders
WHEN (NEW.ordered_on IS NOT NULL AND date(NEW.ordered_on) IS NOT NEW.ordered_on)
BEGIN
    SELECT RAISE(ABORT, 'purchase_orders: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER purchase_orders_dates_update BEFORE UPDATE OF ordered_on ON purchase_orders
WHEN (NEW.ordered_on IS NOT OLD.ordered_on AND NEW.ordered_on IS NOT NULL AND date(NEW.ordered_on) IS NOT NEW.ordered_on)
BEGIN
    SELECT RAISE(ABORT, 'purchase_orders: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER direct_costs_dates_insert BEFORE INSERT ON direct_costs
WHEN (NEW.booked_on IS NOT NULL AND date(NEW.booked_on) IS NOT NEW.booked_on)
BEGIN
    SELECT RAISE(ABORT, 'direct_costs: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER direct_costs_dates_update BEFORE UPDATE OF booked_on ON direct_costs
WHEN (NEW.booked_on IS NOT OLD.booked_on AND NEW.booked_on IS NOT NULL AND date(NEW.booked_on) IS NOT NEW.booked_on)
BEGIN
    SELECT RAISE(ABORT, 'direct_costs: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER forecast_versions_dates_insert BEFORE INSERT ON forecast_versions
WHEN (NEW.base_date IS NOT NULL AND date(NEW.base_date) IS NOT NEW.base_date)
    OR (NEW.planned_end IS NOT NULL AND date(NEW.planned_end) IS NOT NEW.planned_end)
BEGIN
    SELECT RAISE(ABORT, 'forecast_versions: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER forecast_versions_dates_update BEFORE UPDATE OF base_date, planned_end ON forecast_versions
WHEN (NEW.base_date IS NOT OLD.base_date AND NEW.base_date IS NOT NULL AND date(NEW.base_date) IS NOT NEW.base_date)
    OR (NEW.planned_end IS NOT OLD.planned_end AND NEW.planned_end IS NOT NULL AND date(NEW.planned_end) IS NOT NEW.planned_end)
BEGIN
    SELECT RAISE(ABORT, 'forecast_versions: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER project_closeouts_dates_insert BEFORE INSERT ON project_closeouts
WHEN (NEW.settled_on IS NOT NULL AND date(NEW.settled_on) IS NOT NEW.settled_on)
BEGIN
    SELECT RAISE(ABORT, 'project_closeouts: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER project_closeouts_dates_update BEFORE UPDATE OF settled_on ON project_closeouts
WHEN (NEW.settled_on IS NOT OLD.settled_on AND NEW.settled_on IS NOT NULL AND date(NEW.settled_on) IS NOT NEW.settled_on)
BEGIN
    SELECT RAISE(ABORT, 'project_closeouts: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER closeout_reopenings_dates_insert BEFORE INSERT ON closeout_reopenings
WHEN (NEW.reopened_on IS NOT NULL AND date(NEW.reopened_on) IS NOT NEW.reopened_on)
BEGIN
    SELECT RAISE(ABORT, 'closeout_reopenings: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER closeout_reopenings_dates_update BEFORE UPDATE OF reopened_on ON closeout_reopenings
WHEN (NEW.reopened_on IS NOT OLD.reopened_on AND NEW.reopened_on IS NOT NULL AND date(NEW.reopened_on) IS NOT NEW.reopened_on)
BEGIN
    SELECT RAISE(ABORT, 'closeout_reopenings: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER closing_periods_dates_insert BEFORE INSERT ON closing_periods
WHEN (NEW.month IS NOT NULL AND (length(NEW.month) <> 7 OR date(NEW.month || '-01') IS NOT NEW.month || '-01'))
BEGIN
    SELECT RAISE(ABORT, 'closing_periods: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER closing_periods_dates_update BEFORE UPDATE OF month ON closing_periods
WHEN (NEW.month IS NOT OLD.month AND NEW.month IS NOT NULL AND (length(NEW.month) <> 7 OR date(NEW.month || '-01') IS NOT NEW.month || '-01'))
BEGIN
    SELECT RAISE(ABORT, 'closing_periods: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER closing_events_dates_insert BEFORE INSERT ON closing_events
WHEN (NEW.month IS NOT NULL AND (length(NEW.month) <> 7 OR date(NEW.month || '-01') IS NOT NEW.month || '-01'))
BEGIN
    SELECT RAISE(ABORT, 'closing_events: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER closing_events_dates_update BEFORE UPDATE OF month ON closing_events
WHEN (NEW.month IS NOT OLD.month AND NEW.month IS NOT NULL AND (length(NEW.month) <> 7 OR date(NEW.month || '-01') IS NOT NEW.month || '-01'))
BEGIN
    SELECT RAISE(ABORT, 'closing_events: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER fixed_cost_contracts_dates_insert BEFORE INSERT ON fixed_cost_contracts
WHEN (NEW.from_month IS NOT NULL AND (length(NEW.from_month) <> 7 OR date(NEW.from_month || '-01') IS NOT NEW.from_month || '-01'))
    OR (NEW.to_month IS NOT NULL AND (length(NEW.to_month) <> 7 OR date(NEW.to_month || '-01') IS NOT NEW.to_month || '-01'))
BEGIN
    SELECT RAISE(ABORT, 'fixed_cost_contracts: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER fixed_cost_contracts_dates_update BEFORE UPDATE OF from_month, to_month ON fixed_cost_contracts
WHEN (NEW.from_month IS NOT OLD.from_month AND NEW.from_month IS NOT NULL AND (length(NEW.from_month) <> 7 OR date(NEW.from_month || '-01') IS NOT NEW.from_month || '-01'))
    OR (NEW.to_month IS NOT OLD.to_month AND NEW.to_month IS NOT NULL AND (length(NEW.to_month) <> 7 OR date(NEW.to_month || '-01') IS NOT NEW.to_month || '-01'))
BEGIN
    SELECT RAISE(ABORT, 'fixed_cost_contracts: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER fixed_cost_postings_dates_insert BEFORE INSERT ON fixed_cost_postings
WHEN (NEW.month IS NOT NULL AND (length(NEW.month) <> 7 OR date(NEW.month || '-01') IS NOT NEW.month || '-01'))
    OR (NEW.booked_on IS NOT NULL AND date(NEW.booked_on) IS NOT NEW.booked_on)
BEGIN
    SELECT RAISE(ABORT, 'fixed_cost_postings: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER fixed_cost_postings_dates_update BEFORE UPDATE OF month, booked_on ON fixed_cost_postings
WHEN (NEW.month IS NOT OLD.month AND NEW.month IS NOT NULL AND (length(NEW.month) <> 7 OR date(NEW.month || '-01') IS NOT NEW.month || '-01'))
    OR (NEW.booked_on IS NOT OLD.booked_on AND NEW.booked_on IS NOT NULL AND date(NEW.booked_on) IS NOT NEW.booked_on)
BEGIN
    SELECT RAISE(ABORT, 'fixed_cost_postings: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER recurring_revenues_dates_insert BEFORE INSERT ON recurring_revenues
WHEN (NEW.from_month IS NOT NULL AND (length(NEW.from_month) <> 7 OR date(NEW.from_month || '-01') IS NOT NEW.from_month || '-01'))
    OR (NEW.to_month IS NOT NULL AND (length(NEW.to_month) <> 7 OR date(NEW.to_month || '-01') IS NOT NEW.to_month || '-01'))
BEGIN
    SELECT RAISE(ABORT, 'recurring_revenues: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER recurring_revenues_dates_update BEFORE UPDATE OF from_month, to_month ON recurring_revenues
WHEN (NEW.from_month IS NOT OLD.from_month AND NEW.from_month IS NOT NULL AND (length(NEW.from_month) <> 7 OR date(NEW.from_month || '-01') IS NOT NEW.from_month || '-01'))
    OR (NEW.to_month IS NOT OLD.to_month AND NEW.to_month IS NOT NULL AND (length(NEW.to_month) <> 7 OR date(NEW.to_month || '-01') IS NOT NEW.to_month || '-01'))
BEGIN
    SELECT RAISE(ABORT, 'recurring_revenues: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER revenue_plan_month_insert BEFORE INSERT ON revenue_plan
WHEN EXISTS (
    SELECT 1 FROM revenue_plan p
    WHERE p.project_id = NEW.project_id AND p.month IS NEW.month
)
BEGIN
    SELECT RAISE(ABORT, 'revenue_plan: one line per project_id and month');
END;

CREATE TRIGGER revenue_plan_month_update BEFORE UPDATE OF project_id, month ON revenue_plan
WHEN (NEW.project_id IS NOT OLD.project_id OR NEW.month IS NOT OLD.month)
    AND EXISTS (
    SELECT 1 FROM revenue_plan p
    WHERE p.project_id = NEW.project_id AND p.month IS NEW.month AND p.id <> NEW.id
)
BEGIN
    SELECT RAISE(ABORT, 'revenue_plan: one line per project_id and month');
END;

CREATE TRIGGER pipeline_revenue_plan_month_insert BEFORE INSERT ON pipeline_revenue_plan
WHEN EXISTS (
    SELECT 1 FROM pipeline_revenue_plan p
    WHERE p.pipeline_version_id = NEW.pipeline_version_id AND p.month IS NEW.month
)
BEGIN
    SELECT RAISE(ABORT, 'pipeline_revenue_plan: one line per pipeline_version_id and month');
END;

CREATE TRIGGER pipeline_revenue_plan_month_update BEFORE UPDATE OF pipeline_version_id, month ON pipeline_revenue_plan
WHEN (NEW.pipeline_version_id IS NOT OLD.pipeline_version_id OR NEW.month IS NOT OLD.month)
    AND EXISTS (
    SELECT 1 FROM pipeline_revenue_plan p
    WHERE p.pipeline_version_id = NEW.pipeline_version_id AND p.month IS NEW.month AND p.id <> NEW.id
)
BEGIN
    SELECT RAISE(ABORT, 'pipeline_revenue_plan: one line per pipeline_version_id and month');
END;
