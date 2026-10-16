#!/bin/bash
# Runs once, when the Docker volume is first created.
# blk_owner: owns the schema, runs migrations. Not a superuser, so RLS is not bypassed by accident.
# app_node:  the only runtime account (Node.js). Never owns tables, so RLS always applies to it.
# blk_backup: read-only account for pg_dump (backup). BYPASSRLS so the dump has every row; SELECT only.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE ROLE blk_owner LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS PASSWORD '${BLK_OWNER_PASSWORD}';
  CREATE ROLE app_node  LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS PASSWORD '${APP_NODE_PASSWORD}';
  CREATE ROLE blk_backup LOGIN NOSUPERUSER NOCREATEROLE BYPASSRLS PASSWORD '${BLK_BACKUP_PASSWORD:-dev_backup_pw}';
  ALTER DATABASE blk OWNER TO blk_owner;
  CREATE DATABASE blk_test OWNER blk_owner;
EOSQL

for db in blk blk_test; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<-EOSQL
    ALTER SCHEMA public OWNER TO blk_owner;
    REVOKE ALL ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public TO app_node;
    GRANT USAGE ON SCHEMA public TO blk_backup;
EOSQL
done
