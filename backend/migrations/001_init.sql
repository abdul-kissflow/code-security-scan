-- Core schema: users, sessions, scans, scan_stages.
-- Run via `npm run migrate` (backend/src/migrate.js) - see that file for how
-- migrations are tracked/applied.

create extension if not exists pgcrypto;

create table users (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,
  name        text,
  created_at  timestamptz not null default now()
);

-- connect-pg-simple's expected shape (session store for express-session).
create table session (
  sid     varchar not null collate "default" primary key,
  sess    json not null,
  expire  timestamp(6) not null
);
create index idx_session_expire on session (expire);

create table scans (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id),
  original_name   text not null,
  file_count      integer not null default 0,
  extract_dir     text not null,
  -- 'running' | 'done' | 'error' | 'cancelled' - denormalized so the left
  -- nav is a plain indexed SELECT, not a per-request aggregate over
  -- scan_stages on every render.
  overall_status  text not null default 'running',
  health_score    integer,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index idx_scans_user_id on scans (user_id, created_at desc);

create table scan_stages (
  scan_id         uuid not null references scans(id) on delete cascade,
  -- matches the exact keys already used in the app's in-memory "results"
  -- object: secrets | dependencies | sonar | codeQuality | explanations
  stage_key       text not null,
  -- 'idle' | 'running' | 'done' | 'error' | 'cancelled'
  status          text not null default 'idle',
  result          jsonb,
  error_message   text,
  started_at      timestamptz,
  completed_at    timestamptz,
  primary key (scan_id, stage_key)
);
