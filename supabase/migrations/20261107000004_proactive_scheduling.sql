-- Proposal times are proactive: they no longer require availability blocks.
-- Existing availability data remains available for historical/admin use.
create or replace function public._slot_is_bookable(
  p_provider uuid, p_business_a uuid, p_business_b uuid, p_start timestamptz, p_end timestamptz
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_start is not null
    and p_end > p_start
    and p_start > now()
    and (extract(epoch from p_start)::bigint % 900) = 0
    and not exists (
      select 1 from public.appointment_participants ap
      where ap.business_id in (p_business_a, p_business_b)
        and tstzrange(ap.starts_at, ap.ends_at, '[)') && tstzrange(p_start, p_end, '[)')
    )
$$;
