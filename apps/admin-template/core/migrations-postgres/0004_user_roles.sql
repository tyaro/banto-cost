-- PostgreSQL port of migrations-sqlite/0004_user_roles.sql. `ALTER TABLE ...
-- ADD COLUMN ... DEFAULT ... CHECK (...)` is identical syntax in Postgres, so
-- this matches the SQLite version byte-for-byte apart from this header.
--
-- M10: RBAC roles for the `users` table (spec docs/roadmap.md M10). Existing
-- accounts default to 'admin' so nobody is locked out of their own instance by
-- this migration.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','editor','viewer'));
