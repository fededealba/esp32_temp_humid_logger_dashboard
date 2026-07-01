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

-- Server-side stride downsampling: given a target point count and an
-- optional cutoff, returns evenly-spaced rows (always including the
-- newest) instead of making the dashboard fetch the whole table and
-- thin it out in JS. Keeps "all time" / large-range queries fast and
-- payload-bounded no matter how big the table grows.
--
-- page_offset/page_limit are handled inside the function (not via
-- PostgREST's Range header) because PostgREST does not paginate `setof`
-- RPC results reliably — every page request silently returned the same
-- first chunk when tested against Range headers instead.
create or replace function public.readings_downsampled(
  target_points integer default 2000,
  cutoff timestamptz default null,
  page_offset integer default 0,
  page_limit integer default 1000
)
returns setof public.readings
language sql
stable
as $$
  with base as (
    select
      r.*,
      row_number() over (order by r.received_at desc) - 1 as rn,
      count(*) over () as total
    from public.readings r
    where cutoff is null or r.received_at >= cutoff
  ),
  sampled as (
    select id, device_id, temperature, humidity, device_ts, received_at
    from base
    where total <= greatest(target_points, 1)
       or mod(rn, greatest(ceil(total::numeric / greatest(target_points, 1))::int, 1)) = 0
    order by received_at desc
  )
  select * from sampled
  limit greatest(page_limit, 0)
  offset greatest(page_offset, 0);
$$;
