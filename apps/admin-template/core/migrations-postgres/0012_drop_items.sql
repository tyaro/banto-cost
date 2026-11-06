-- PostgreSQL port of migrations-sqlite/0012_drop_items.sql.
--
-- banto-cost: remove the template's `items` demo resource (product list).
-- 0001_items.sql stays as released (migrations are append-only, see
-- scripts/verify-migrations-frozen.mjs); this drops the table and its demo
-- rows from databases created before the removal. Audit log rows that name
-- `resource = 'items'` are history and are kept.
DROP TABLE IF EXISTS items;
