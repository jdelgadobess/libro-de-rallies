-- Each stage's type: «caza» (waypoints to hunt for points, in any order) or «seguimiento» (following the
-- roadbook in order). A stage is created here before it has waypoints, so it shows in every list.
create table if not exists public.stages (
  rally_id uuid not null references public.rallies(id) on delete cascade,
  stage text not null,
  kind text not null default 'caza' check (kind in ('caza', 'seguimiento')),
  created_by text,
  created_at timestamptz not null default now(),
  primary key (rally_id, stage)
);

alter table public.stages enable row level security;
create policy "read stages" on public.stages for select to authenticated using (public.my_role() is not null);
create policy "edit stages" on public.stages for all to authenticated
  using (public.my_role() in ('admin', 'editor')) with check (public.my_role() in ('admin', 'editor'));
grant select, insert, update, delete on public.stages to authenticated;
