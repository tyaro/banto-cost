-- banto-cost (docs/project/design.md §3.6, review §8-16 M-1・M-5): 日付・月の
-- 形式の検査と売上予定の (案件, 月) の一意制約.
--
-- Business dates are TEXT 'YYYY-MM-DD' and months TEXT 'YYYY-MM'; closing,
-- monthly totals and period ranges compare and cut these strings, so a row
-- like '2026-6-1' would silently fall out of a month. The services always
-- parse them first; these checks stop the other ways in (hand-written SQL,
-- a future import from the company spreadsheets).
--
-- Each table gets one BEFORE INSERT OR UPDATE OF <columns> trigger running
-- banto_cost_check_dates(), which requires the value to round-trip through
-- to_date() (a real calendar date in the canonical form; a month is checked
-- as its first day), as the SQLite twin does with date(). Rows already
-- stored are not re-checked, and an update checks only the columns whose
-- value it changes. Timestamps (*_at) are not business dates and are not
-- checked.
--
-- revenue_plan and pipeline_revenue_plan hold one line per month (month
-- NULL = timing undecided, one such line at most); the services already
-- refuse duplicates (duplicate_plan_month). A trigger refuses an insert or
-- an update that would make a second line for the same project (pipeline
-- version) and month. It is not a unique index because duplicates already
-- stored (hand-written SQL) would make creating the index fail and stop the
-- app from starting; like the date checks, existing rows are not re-checked.

-- TG_ARGV holds (kind, column) pairs, kind 'date' or 'month'. On UPDATE a
-- column whose value did not change is not checked, so a row stored before
-- this migration can still have its other columns updated.
CREATE OR REPLACE FUNCTION banto_cost_check_dates() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    new_row jsonb := to_jsonb(NEW);
    old_row jsonb;
    i integer := 0;
    kind text;
    col text;
    v text;
    d date;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        old_row := to_jsonb(OLD);
    END IF;
    WHILE i < TG_NARGS LOOP
        kind := TG_ARGV[i];
        col := TG_ARGV[i + 1];
        i := i + 2;
        v := new_row ->> col;
        CONTINUE WHEN v IS NULL;
        CONTINUE WHEN TG_OP = 'UPDATE' AND v IS NOT DISTINCT FROM old_row ->> col;
        IF kind = 'month' THEN
            v := v || '-01';
        END IF;
        d := NULL;
        IF v ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
            BEGIN
                d := to_date(v, 'YYYY-MM-DD');
            EXCEPTION WHEN others THEN
                d := NULL;
            END;
        END IF;
        IF d IS NULL OR to_char(d, 'YYYY-MM-DD') <> v THEN
            RAISE EXCEPTION '%: dates must be YYYY-MM-DD and months YYYY-MM (%)', TG_TABLE_NAME, col
                USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$;

CREATE TRIGGER projects_dates BEFORE INSERT OR UPDATE OF planned_start, planned_end ON projects
    FOR EACH ROW EXECUTE FUNCTION banto_cost_check_dates('date', 'planned_start', 'date', 'planned_end');

CREATE TRIGGER pipeline_versions_dates BEFORE INSERT OR UPDATE OF expected_order_month, expected_start_month, expected_end_month, confirmed_on ON pipeline_versions
    FOR EACH ROW EXECUTE FUNCTION banto_cost_check_dates('month', 'expected_order_month', 'month', 'expected_start_month', 'month', 'expected_end_month', 'date', 'confirmed_on');

CREATE TRIGGER pipeline_revenue_plan_dates BEFORE INSERT OR UPDATE OF month ON pipeline_revenue_plan
    FOR EACH ROW EXECUTE FUNCTION banto_cost_check_dates('month', 'month');

CREATE TRIGGER order_conversions_dates BEFORE INSERT OR UPDATE OF converted_on, cancelled_on ON order_conversions
    FOR EACH ROW EXECUTE FUNCTION banto_cost_check_dates('date', 'converted_on', 'date', 'cancelled_on');

CREATE TRIGGER order_conversion_corrections_dates BEFORE INSERT OR UPDATE OF old_converted_on, new_converted_on, corrected_on ON order_conversion_corrections
    FOR EACH ROW EXECUTE FUNCTION banto_cost_check_dates('date', 'old_converted_on', 'date', 'new_converted_on', 'date', 'corrected_on');

CREATE TRIGGER order_changes_dates BEFORE INSERT OR UPDATE OF plan_month ON order_changes
    FOR EACH ROW EXECUTE FUNCTION banto_cost_check_dates('month', 'plan_month');

CREATE TRIGGER revenue_plan_dates BEFORE INSERT OR UPDATE OF month ON revenue_plan
    FOR EACH ROW EXECUTE FUNCTION banto_cost_check_dates('month', 'month');

CREATE TRIGGER revenue_recognitions_dates BEFORE INSERT OR UPDATE OF recognized_on ON revenue_recognitions
    FOR EACH ROW EXECUTE FUNCTION banto_cost_check_dates('date', 'recognized_on');

CREATE TRIGGER outlook_snapshot_rows_dates BEFORE INSERT OR UPDATE OF month ON outlook_snapshot_rows
    FOR EACH ROW EXECUTE FUNCTION banto_cost_check_dates('month', 'month');

CREATE TRIGGER calc_values_dates BEFORE INSERT OR UPDATE OF valid_from ON calc_values
    FOR EACH ROW EXECUTE FUNCTION banto_cost_check_dates('date', 'valid_from');

CREATE TRIGGER time_entries_dates BEFORE INSERT OR UPDATE OF work_date ON time_entries
    FOR EACH ROW EXECUTE FUNCTION banto_cost_check_dates('date', 'work_date');

CREATE TRIGGER budget_versions_dates BEFORE INSERT OR UPDATE OF created_on ON budget_versions
    FOR EACH ROW EXECUTE FUNCTION banto_cost_check_dates('date', 'created_on');

CREATE TRIGGER purchase_orders_dates BEFORE INSERT OR UPDATE OF ordered_on ON purchase_orders
    FOR EACH ROW EXECUTE FUNCTION banto_cost_check_dates('date', 'ordered_on');

CREATE TRIGGER direct_costs_dates BEFORE INSERT OR UPDATE OF booked_on ON direct_costs
    FOR EACH ROW EXECUTE FUNCTION banto_cost_check_dates('date', 'booked_on');

CREATE TRIGGER forecast_versions_dates BEFORE INSERT OR UPDATE OF base_date, planned_end ON forecast_versions
    FOR EACH ROW EXECUTE FUNCTION banto_cost_check_dates('date', 'base_date', 'date', 'planned_end');

CREATE TRIGGER project_closeouts_dates BEFORE INSERT OR UPDATE OF settled_on ON project_closeouts
    FOR EACH ROW EXECUTE FUNCTION banto_cost_check_dates('date', 'settled_on');

CREATE TRIGGER closeout_reopenings_dates BEFORE INSERT OR UPDATE OF reopened_on ON closeout_reopenings
    FOR EACH ROW EXECUTE FUNCTION banto_cost_check_dates('date', 'reopened_on');

CREATE TRIGGER closing_periods_dates BEFORE INSERT OR UPDATE OF month ON closing_periods
    FOR EACH ROW EXECUTE FUNCTION banto_cost_check_dates('month', 'month');

CREATE TRIGGER closing_events_dates BEFORE INSERT OR UPDATE OF month ON closing_events
    FOR EACH ROW EXECUTE FUNCTION banto_cost_check_dates('month', 'month');

CREATE TRIGGER fixed_cost_contracts_dates BEFORE INSERT OR UPDATE OF from_month, to_month ON fixed_cost_contracts
    FOR EACH ROW EXECUTE FUNCTION banto_cost_check_dates('month', 'from_month', 'month', 'to_month');

CREATE TRIGGER fixed_cost_postings_dates BEFORE INSERT OR UPDATE OF month, booked_on ON fixed_cost_postings
    FOR EACH ROW EXECUTE FUNCTION banto_cost_check_dates('month', 'month', 'date', 'booked_on');

CREATE TRIGGER recurring_revenues_dates BEFORE INSERT OR UPDATE OF from_month, to_month ON recurring_revenues
    FOR EACH ROW EXECUTE FUNCTION banto_cost_check_dates('month', 'from_month', 'month', 'to_month');

-- TG_ARGV[0] is the key column (project_id or pipeline_version_id). The
-- services write a project's revenue plan after updating the project row
-- (revenue_version), which holds that row's lock, so two writers of the
-- same project's plan do not both pass this check.
CREATE OR REPLACE FUNCTION banto_cost_check_plan_month() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    new_row jsonb := to_jsonb(NEW);
    old_row jsonb;
    key text := TG_ARGV[0];
    taken boolean;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        old_row := to_jsonb(OLD);
        IF new_row -> key IS NOT DISTINCT FROM old_row -> key
            AND new_row -> 'month' IS NOT DISTINCT FROM old_row -> 'month' THEN
            RETURN NEW;
        END IF;
    END IF;
    EXECUTE format(
        'SELECT EXISTS (SELECT 1 FROM %I WHERE %I = $1 AND month IS NOT DISTINCT FROM $2 AND id <> $3)',
        TG_TABLE_NAME, key)
        INTO taken
        USING (new_row ->> key)::bigint, new_row ->> 'month', (new_row ->> 'id')::bigint;
    IF taken THEN
        RAISE EXCEPTION '%: one line per % and month', TG_TABLE_NAME, key
            USING ERRCODE = 'unique_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER revenue_plan_month BEFORE INSERT OR UPDATE OF project_id, month ON revenue_plan
    FOR EACH ROW EXECUTE FUNCTION banto_cost_check_plan_month('project_id');

CREATE TRIGGER pipeline_revenue_plan_month BEFORE INSERT OR UPDATE OF pipeline_version_id, month ON pipeline_revenue_plan
    FOR EACH ROW EXECUTE FUNCTION banto_cost_check_plan_month('pipeline_version_id');
