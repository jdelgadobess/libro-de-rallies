-- Waypoints imported before the score existed: take it from the description ("15 PT", "25 pts", "50 puntos").
update public.waypoints
set points = substring(descr from '(?i)(\d{1,4})\s*(?:pts?|ptos?|puntos?|points?)\y')::int
where points is null and descr ~* '\d{1,4}\s*(pts?|ptos?|puntos?|points?)\y';
