-- The last route proposals calculated for each stage, so every device (phone, tablet) can see them
-- without the off-road map or doing the calculation again.
create table public.plans (
  rally_id uuid not null references public.rallies(id) on delete cascade,
  stage text not null,
  alts jsonb not null default '[]',
  note text not null default '',
  created_by text,
  created_at timestamptz not null default now(),
  primary key (rally_id, stage)
);

alter table public.plans enable row level security;
create policy "read plans" on public.plans for select to authenticated using (public.my_role() is not null);
create policy "edit plans" on public.plans for all to authenticated
  using (public.my_role() in ('admin', 'editor')) with check (public.my_role() in ('admin', 'editor'));
grant select, insert, update, delete on public.plans to authenticated;
