-- Reference routes (e.g. downloaded from Wikiloc) used to find paths that join the waypoints.
-- The stage it was imported for is a label; the analysis looks at every route near the waypoints. points = segments of [lat, lon] pairs.

create table public.routes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  rally_id uuid references public.rallies(id) on delete set null,
  stage text not null default '',
  source text not null default '',
  points jsonb not null,
  created_by text,
  created_at timestamptz not null default now()
);

alter table public.routes enable row level security;
create policy "read routes" on public.routes for select to authenticated using (public.my_role() is not null);
create policy "edit routes" on public.routes for all to authenticated
  using (public.my_role() in ('admin', 'editor')) with check (public.my_role() in ('admin', 'editor'));
grant select, insert, update, delete on public.routes to authenticated;

alter publication supabase_realtime add table public.routes;
