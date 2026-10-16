-- Repair videos for the Mecánica tab (links to YouTube), shared by everyone with access.
create table public.videos (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  title text not null default '',
  url text not null,
  created_by text,
  created_at timestamptz not null default now()
);

alter table public.videos enable row level security;
create policy "read videos" on public.videos for select to authenticated using (public.my_role() is not null);
create policy "edit videos" on public.videos for all to authenticated
  using (public.my_role() in ('admin', 'editor')) with check (public.my_role() in ('admin', 'editor'));
grant select, insert, update, delete on public.videos to authenticated;
