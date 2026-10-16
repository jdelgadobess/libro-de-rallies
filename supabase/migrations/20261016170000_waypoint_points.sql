-- Score of each waypoint (10, 25, 50, 100 pts…), to filter what is shown on the map.
alter table public.waypoints add column points int check (points > 0);
