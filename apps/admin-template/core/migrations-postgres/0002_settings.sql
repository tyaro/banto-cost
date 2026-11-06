-- PostgreSQL port of migrations-sqlite/0002_settings.sql. Both columns are
-- TEXT in either backend, so this is identical to the SQLite version.
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
