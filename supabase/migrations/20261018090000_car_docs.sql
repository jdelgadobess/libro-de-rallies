-- Documents attached to each car (insurance, registration, invoices…). Files live in the private "coches" bucket.
alter table public.cars add column if not exists docs jsonb not null default '[]';

insert into storage.buckets (id, name, public, file_size_limit)
values ('coches', 'coches', false, 26214400)
on conflict (id) do nothing;

create policy "read car docs" on storage.objects for select to authenticated
  using (bucket_id = 'coches' and public.my_role() is not null);
create policy "add car docs" on storage.objects for insert to authenticated
  with check (bucket_id = 'coches' and public.my_role() in ('admin', 'editor'));
create policy "change car docs" on storage.objects for update to authenticated
  using (bucket_id = 'coches' and public.my_role() in ('admin', 'editor'));
create policy "remove car docs" on storage.objects for delete to authenticated
  using (bucket_id = 'coches' and public.my_role() in ('admin', 'editor'));
