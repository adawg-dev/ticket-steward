-- Databases for one worker slot; the Postgres entrypoint runs this once, on the slot's fresh data directory.
CREATE DATABASE concentrate;
CREATE DATABASE concentrate_tg;
\connect concentrate_tg
CREATE EXTENSION IF NOT EXISTS timescaledb;
