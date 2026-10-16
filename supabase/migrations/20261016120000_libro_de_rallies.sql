-- Libro de Rallies: years (rallies), waypoints, who may enter, and the Google Earth feed token.

create table public.rallies (
  id uuid primary key default gen_random_uuid(),
  year int not null,
  name text not null,
  created_at timestamptz not null default now()
);

create table public.waypoints (
  id uuid primary key default gen_random_uuid(),
  rally_id uuid not null references public.rallies(id) on delete cascade,
  stage text not null default '',
  name text not null,
  lat double precision not null check (lat between -90 and 90),
  lon double precision not null check (lon between -180 and 180),
  page text not null default '',
  descr text not null default '',
  seq bigint,
  source text,
  created_by text,
  created_at timestamptz not null default now()
);
create index waypoints_rally_idx on public.waypoints (rally_id);

-- The first person to sign in claims the site; the single-row key stops anyone else.
create table public.site_owner (
  id boolean primary key default true check (id),
  user_id uuid not null default auth.uid(),
  email text,
  created_at timestamptz not null default now()
);

create table public.members (
  email text primary key check (email = lower(email)),
  role text not null check (role in ('admin', 'editor', 'viewer')),
  added_at timestamptz not null default now()
);

create table public.earth_feed (
  id boolean primary key default true check (id),
  token text not null,
  created_at timestamptz not null default now()
);

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select case
    when auth.uid() is null then null
    when exists (select 1 from public.site_owner where user_id = auth.uid()) then 'admin'
    else (select role from public.members where email = lower(auth.jwt() ->> 'email'))
  end
$$;
revoke all on function public.my_role() from public;
grant execute on function public.my_role() to authenticated;

alter table public.rallies enable row level security;
alter table public.waypoints enable row level security;
alter table public.site_owner enable row level security;
alter table public.members enable row level security;
alter table public.earth_feed enable row level security;

create policy "read rallies" on public.rallies for select to authenticated using (public.my_role() is not null);
create policy "edit rallies" on public.rallies for all to authenticated
  using (public.my_role() in ('admin', 'editor')) with check (public.my_role() in ('admin', 'editor'));

create policy "read waypoints" on public.waypoints for select to authenticated using (public.my_role() is not null);
create policy "edit waypoints" on public.waypoints for all to authenticated
  using (public.my_role() in ('admin', 'editor')) with check (public.my_role() in ('admin', 'editor'));

create policy "see owner" on public.site_owner for select to authenticated using (true);
create policy "claim site" on public.site_owner for insert to authenticated with check (user_id = auth.uid());

create policy "see members" on public.members for select to authenticated
  using (public.my_role() = 'admin' or email = lower(auth.jwt() ->> 'email'));
create policy "manage members" on public.members for all to authenticated
  using (public.my_role() = 'admin') with check (public.my_role() = 'admin');

create policy "manage feed" on public.earth_feed for all to authenticated
  using (public.my_role() = 'admin') with check (public.my_role() = 'admin');

grant select, insert, update, delete on public.rallies, public.waypoints, public.members, public.earth_feed to authenticated;
grant select, insert on public.site_owner to authenticated;

-- live updates for everyone who has the page open
alter publication supabase_realtime add table public.rallies, public.waypoints;
