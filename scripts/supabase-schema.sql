-- Supabase schema for the ESP32 temp/humidity dashboard.
--
-- Run this once in the Supabase SQL Editor (Project → SQL Editor → New query)
-- before setting SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY on the dashboard,
-- or SUPABASE_URL / SUPABASE_ANON_KEY in firmware/temp_hum_complete/secrets.h.
-- Without this table, both the ESP32 (insert) and the dashboard (select)
-- requests fail with a "relation does not exist" / 404 error from PostgREST.
-- Safe to re-run in full any time this file changes (every statement is
-- idempotent).

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

alter table public.readings enable row level security;

-- The ESP32 writes with the anon/publishable key over a connection that
-- doesn't validate the TLS certificate (client.setInsecure(), see the .ino),
-- so it's scoped to INSERT only rather than using service_role: a captured
-- key can add fake rows but can't read, modify, or delete anything. The
-- dashboard still reads/writes with service_role server-side (Vercel env
-- vars), a different trust boundary than a physical device.
drop policy if exists "anon can insert readings" on public.readings;
create policy "anon can insert readings"
  on public.readings
  for insert
  to anon
  with check (true);

-- Server-side stride downsampling: given a target point count and an
-- optional cutoff, returns evenly-spaced rows (always including the
-- newest) instead of making the dashboard fetch the whole table and
-- thin it out in JS. Keeps "all time" / large-range queries fast and
-- payload-bounded no matter how big the table grows.
--
-- The stride is computed per device_id (partition by), not globally: with
-- two or more devices interleaved in time, a single global stride picks
-- rows without regard to which device they belong to, so each device's own
-- line ends up with uneven clusters and gaps instead of a smooth series —
-- this was live and broken for a full day before being caught. Each device
-- independently gets up to target_points rows.
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
      row_number() over (partition by r.device_id order by r.received_at desc) - 1 as rn,
      count(*) over (partition by r.device_id) as total
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

-- Single-row table tracking whether the last stale-check found the device
-- offline, and when we last messaged Telegram about it. Lets
-- scripts/check-stale.mjs alert once per outage (and once on recovery)
-- instead of spamming a message on every cron run while it stays down.
create table if not exists public.alert_state (
  id smallint primary key default 1,
  is_stale boolean not null default false,
  last_alert_at timestamptz,
  constraint alert_state_singleton check (id = 1)
);

insert into public.alert_state (id, is_stale)
values (1, false)
on conflict (id) do nothing;

alter table public.alert_state enable row level security;
