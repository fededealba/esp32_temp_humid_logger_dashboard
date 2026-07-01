-- Supabase schema for the ESP32 temp/humidity dashboard.
--
-- Run this once in the Supabase SQL Editor (Project → SQL Editor → New query)
-- before setting SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY on the dashboard or
-- in firmware/temp_hum_complete/secrets.h. Without this table, both the
-- ESP32 (insert) and the dashboard (select) requests fail with a
-- "relation does not exist" / 404 error from PostgREST.

create table if not exists public.readings (
  id bigint generated always as identity primary key,
  device_id text not null default 'unknown',
  temperature double precision not null,
  humidity double precision not null,
  device_ts timestamptz,
  received_at timestamptz not null default now()
);

create index if not exists readings_received_at_idx
  on public.readings (received_at desc);

-- RLS is enabled with no policies, which blocks the anon/authenticated
-- roles entirely. Note this does NOT protect against the firmware's key
-- leaking: the ESP32 and the dashboard both use the service_role key,
-- which bypasses RLS by design. If a device is ever lost or its flash
-- dumped, rotate the service_role key in Project Settings -> API and
-- reflash every device with the new one.
alter table public.readings enable row level security;
