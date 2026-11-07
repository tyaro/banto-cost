-- banto-cost P7a (docs/project/design.md §9.4 item 4, §10.3, T36): the
-- target gross margin (目標粗利率) as a calc-basis item. 原資 = confirmed
-- order − order × rate is shown next to the budget and the forecast; it is
-- never written into an approved budget. No company value is seeded: an
-- unset rate shows 原資 as 未設定, never 0%.
INSERT INTO calc_items (key, item_group, label, unit, value_type, project_overridable,
    managers_may_override, edit_capability, sort_order) VALUES
    ('target_margin_pct', 'profit', '目標粗利率（原資の算出）', 'percent', 'percent', 1, 0, 'finance.close', 130);
