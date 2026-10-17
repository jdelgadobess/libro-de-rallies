-- The team's 4x4s with their technical sheet (ficha técnica) data and photos.
create table public.cars (
  id uuid primary key default gen_random_uuid(),
  data jsonb not null default '{}',
  photos jsonb not null default '[]',
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.cars enable row level security;
create policy "read cars" on public.cars for select to authenticated using (public.my_role() is not null);
create policy "edit cars" on public.cars for all to authenticated
  using (public.my_role() in ('admin', 'editor')) with check (public.my_role() in ('admin', 'editor'));
grant select, insert, update, delete on public.cars to authenticated;
