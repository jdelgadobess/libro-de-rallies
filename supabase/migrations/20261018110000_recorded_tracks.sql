-- Tracks recorded with the phone's GPS are marked as such, with their start, end, time and distance.
alter table public.tracks add column if not exists kind text not null default '';
alter table public.tracks add column if not exists meta jsonb not null default '{}';
