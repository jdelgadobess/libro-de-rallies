-- Tracks driven in each stage (from a GPX or KML). points = segments of [lat, lon] pairs.

create table public.tracks (
  id uuid primary key default gen_random_uuid(),
  rally_id uuid not null references public.rallies(id) on delete cascade,
  stage text not null default '',
  name text not null,
  points jsonb not null,
  created_by text,
  created_at timestamptz not null default now()
);
create index tracks_rally_idx on public.tracks (rally_id);

alter table public.tracks enable row level security;
create policy "read tracks" on public.tracks for select to authenticated using (public.my_role() is not null);
create policy "edit tracks" on public.tracks for all to authenticated
  using (public.my_role() in ('admin', 'editor')) with check (public.my_role() in ('admin', 'editor'));
grant select, insert, update, delete on public.tracks to authenticated;

alter publication supabase_realtime add table public.tracks;
