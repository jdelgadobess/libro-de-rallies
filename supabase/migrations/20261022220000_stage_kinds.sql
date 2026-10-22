-- Three stage types: following a track, following waypoints, or hunting waypoints for points.
alter table public.stages drop constraint if exists stages_kind_check;
update public.stages set kind = 'seg_wp' where kind = 'seguimiento';
alter table public.stages add constraint stages_kind_check check (kind in ('seg_track', 'seg_wp', 'caza'));
