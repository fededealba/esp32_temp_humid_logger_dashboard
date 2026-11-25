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
--
-- Column-level grant: anon may only supply the four columns the firmware
-- sends. In particular it can't set received_at, which the stale-check and
-- dashboard treat as the trustworthy arrival time -- a single forged row
-- dated in the future would otherwise make a dead station look alive
-- indefinitely. (Supabase grants anon table-wide privileges by default, and
-- a column grant only takes effect once the table-wide one is revoked.)
revoke insert on public.readings from anon;
grant insert (device_id, temperature, humidity, device_ts) on public.readings to anon;

-- Value checks live in the policy rather than as table CHECK constraints so
-- they apply only to anon writes (never to service_role writes) and
-- don't have to validate rows that already exist. Ranges match the
-- firmware's own isPlausible(); the firmware omits device_ts entirely until
-- its clock has synced over NTP, rather than sending a 1970 date.
drop policy if exists "anon can insert readings" on public.readings;
create policy "anon can insert readings"
  on public.readings
  for insert
  to anon
  with check (
    temperature between -40 and 85
    and humidity between 0 and 100
    and length(device_id) between 1 and 64
    and (
      device_ts is null
      or (device_ts >= '2020-01-01' and device_ts <= now() + interval '10 minutes')
    )
  );

-- Server-side stride downsampling: given a target point count and an
-- optional cutoff, returns evenly-spaced rows (always including the
-- newest) instead of making the dashboard fetch the whole table and
-- thin it out in JS. Keeps "all time" / large-range queries fast and
-- payload-bounded no matter how big the table grows.
--
-- The stride is computed per device_id (partition by), not globally: with
-- two or more devices interleaved in time, a single global stride picks
-- rows without regard to which device they belong to, so each device's own
-- line ends up with uneven clusters and gaps instead of a smooth series --
-- this was live and broken for a full day before being caught. Each device
-- independently gets up to target_points rows.
--
-- Everything comes back as one JSON value, with the in-range total: a
-- scalar isn't subject to Supabase's 1,000-row API cap, so no paging is
-- needed. Its predecessor, readings_downsampled, returned a row set and
-- had to be paged, re-running the whole window computation for every
-- 1,000-row page -- "all time" over ~480k rows cost 4 sequential full
-- passes (~5s) plus a separate count=exact (~1.7s), and once hit the
-- statement timeout. (PostgREST's Range header couldn't page it either:
-- every page silently returned the same first chunk.)
--
-- Ranking works on (device_id, received_at, id) only, which the index below
-- covers, so it can run as an index-only scan in partition order instead
-- of sorting the full rows; full rows are fetched by primary key only for
-- the ~2,000-per-device sample. The cutoff uses coalesce rather than
-- `cutoff is null or ...` so the condition stays index-friendly.
drop function if exists public.readings_downsampled(integer, timestamptz, integer, integer);

create index if not exists readings_device_received_idx
  on public.readings (device_id, received_at desc) include (id);

create or replace function public.readings_downsampled_json(
  target_points integer default 2000,
  cutoff timestamptz default null
)
returns json
language sql
stable
as $$
  with ranked as (
    select
      r.id,
      row_number() over (partition by r.device_id order by r.received_at desc) - 1 as rn,
      count(*) over (partition by r.device_id) as total
    from public.readings r
    where r.received_at >= coalesce(cutoff, '-infinity'::timestamptz)
  ),
  picked as (
    select id
    from ranked
    where total <= greatest(target_points, 1)
       or mod(rn, greatest(ceil(total::numeric / greatest(target_points, 1))::int, 1)) = 0
  ),
  sampled as (
    select r.id, r.device_id, r.temperature, r.humidity, r.device_ts, r.received_at
    from public.readings r
    join picked p on p.id = r.id
  )
  select json_build_object(
    'total_in_range', (select count(*) from ranked),
    'rows', coalesce((select json_agg(s order by s.received_at desc) from sampled s), '[]'::json)
  );
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

-- Heartbeat: set on every stale-check run, not just on transitions. The
-- dashboard warns when it's old, which is the only visible sign that the
-- GitHub Actions schedule itself has stopped (GitHub disables scheduled
-- workflows after 60 days of repo inactivity, silently).
alter table public.alert_state add column if not exists last_checked_at timestamptz;

alter table public.alert_state enable row level security;
