-- Waypoints joined by a drawn track, in the order they were joined (list of waypoint ids).
alter table public.tracks add column wps jsonb not null default '[]';
