alter table public.exchanges add column if not exists archived_at timestamptz;

alter table public.exchange_messages drop constraint if exists exchange_messages_event_type_check;
alter table public.exchange_messages add constraint exchange_messages_event_type_check
  check (event_type in ('created', 'countered', 'accepted', 'rejected', 'archived'));

alter table public.notifications drop constraint if exists notifications_event_type_check;
alter table public.notifications add constraint notifications_event_type_check
  check (event_type in ('message', 'created', 'countered', 'accepted', 'rejected', 'archived'));

create or replace function public.counter_exchange(
  p_exchange_id uuid,
  p_expected_version integer,
  p_requested_start timestamptz,
  p_offered_start timestamptz,
  p_note text default null
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := public._require_business();
  v_note text := public._clean_note(p_note);
  v_exchange public.exchanges%rowtype;
  v_current public.exchange_proposals%rowtype;
  v_other uuid;
  v_requested_duration integer;
  v_offered_duration integer;
  v_requested_end timestamptz;
  v_offered_end timestamptz;
  v_proposal_id uuid;
  v_version integer;
  v_me_name text;
begin
  select e.* into v_exchange from public.exchanges e where e.id = p_exchange_id for update;
  if not found or v_me not in (v_exchange.requester_business_id, v_exchange.recipient_business_id) then
    raise exception 'NOT_FOUND' using errcode = '42501';
  end if;
  if v_exchange.status not in ('pending', 'countered') then
    raise exception 'EXCHANGE_CLOSED' using errcode = '22023';
  end if;
  if v_exchange.current_version <> p_expected_version then
    raise exception 'STALE_VERSION' using errcode = '40001';
  end if;
  if v_exchange.awaiting_business_id is distinct from v_me
    and v_exchange.requester_business_id <> v_me then
    raise exception 'NOT_YOUR_TURN' using errcode = '42501';
  end if;

  select p.* into v_current from public.exchange_proposals p where p.id = v_exchange.current_proposal_id;

  select s.duration_minutes into v_requested_duration
  from public.services s join public.businesses b on b.id = s.business_id and b.is_active
  where s.id = v_current.requested_service_id and s.is_active and s.business_id = v_exchange.recipient_business_id;
  select s.duration_minutes into v_offered_duration
  from public.services s join public.businesses b on b.id = s.business_id and b.is_active
  where s.id = v_current.offered_service_id and s.is_active and s.business_id = v_exchange.requester_business_id;
  if v_requested_duration is null or v_offered_duration is null then
    raise exception 'SERVICE_INACTIVE' using errcode = '22023';
  end if;

  if p_requested_start is null or p_offered_start is null then
    raise exception 'INVALID_SLOT' using errcode = '22023';
  end if;
  v_requested_end := p_requested_start + make_interval(mins => v_requested_duration);
  v_offered_end := p_offered_start + make_interval(mins => v_offered_duration);

  if tstzrange(p_requested_start, v_requested_end, '[)') && tstzrange(p_offered_start, v_offered_end, '[)') then
    raise exception 'SLOTS_OVERLAP' using errcode = '22023';
  end if;
  if not public._slot_is_bookable(v_exchange.recipient_business_id, v_exchange.requester_business_id, v_exchange.recipient_business_id, p_requested_start, v_requested_end)
    or not public._slot_is_bookable(v_exchange.requester_business_id, v_exchange.requester_business_id, v_exchange.recipient_business_id, p_offered_start, v_offered_end) then
    raise exception 'SLOT_UNAVAILABLE' using errcode = '22023';
  end if;

  v_other := case when v_me = v_exchange.requester_business_id then v_exchange.recipient_business_id else v_exchange.requester_business_id end;
  v_version := v_exchange.current_version + 1;

  insert into public.exchange_proposals (
    exchange_id, version, author_business_id, requested_service_id, offered_service_id,
    requested_snapshot, offered_snapshot, requested_starts_at, requested_ends_at,
    offered_starts_at, offered_ends_at, note
  ) values (
    v_exchange.id, v_version, v_me, v_current.requested_service_id, v_current.offered_service_id,
    public._service_snapshot(v_current.requested_service_id), public._service_snapshot(v_current.offered_service_id),
    p_requested_start, v_requested_end, p_offered_start, v_offered_end, v_note
  )
  returning id into v_proposal_id;

  update public.exchanges
  set status = 'countered', current_version = v_version, current_proposal_id = v_proposal_id, awaiting_business_id = v_other
  where id = v_exchange.id;

  select b.display_name into v_me_name from public.businesses b where b.id = v_me;
  perform public._record_event(
    v_exchange.id, v_me, v_other, 'event', 'countered', v_proposal_id,
    v_me_name || ' envió una contrapropuesta.', v_note
  );

  return v_version;
end;
$$;


create or replace function public.archive_exchange(p_exchange_id uuid, p_expected_version integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := public._require_business();
  v_exchange public.exchanges%rowtype;
begin
  select * into v_exchange from public.exchanges where id = p_exchange_id for update;
  if not found or v_exchange.requester_business_id <> v_me then
    raise exception 'NOT_FOUND' using errcode = '42501';
  end if;
  if v_exchange.archived_at is not null then return; end if;
  if v_exchange.current_version is distinct from p_expected_version then
    raise exception 'STALE_VERSION' using errcode = '40001';
  end if;
  if v_exchange.status = 'accepted' then
    raise exception 'EXCHANGE_CLOSED' using errcode = '22023';
  end if;
  update public.exchanges
  set archived_at = now(), status = 'rejected', awaiting_business_id = null
  where id = p_exchange_id;
  perform public._record_event(
    p_exchange_id, v_me, v_exchange.recipient_business_id, 'event', 'archived',
    v_exchange.current_proposal_id, 'El comercio que propuso el intercambio lo archivó.', null
  );
end;
$$;

revoke execute on function public.archive_exchange(uuid, integer) from public, anon;
grant execute on function public.archive_exchange(uuid, integer) to authenticated;
