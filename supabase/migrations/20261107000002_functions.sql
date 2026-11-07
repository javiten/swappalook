-- SwappaLook transition functions. Every state change runs inside one of these
-- functions: the actor is resolved from auth.uid(), never from arguments.
-- Error messages are stable codes that the app maps to Spanish copy.

-- ---------------------------------------------------------------------------
-- Internal helpers (not callable by clients)
-- ---------------------------------------------------------------------------

create or replace function public._business_lock(p_business_id uuid)
returns void
language sql
volatile
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('swappalook:business:' || p_business_id::text, 0))
$$;

-- Locks both businesses in a deterministic order to avoid deadlocks.
create or replace function public._lock_business_pair(p_a uuid, p_b uuid)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  perform public._business_lock(least(p_a, p_b));
  perform public._business_lock(greatest(p_a, p_b));
end;
$$;

create or replace function public._service_snapshot(p_service_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'service_id', s.id,
    'title', s.title,
    'description', s.description,
    'duration_minutes', s.duration_minutes,
    'category_id', c.id,
    'category_name', c.name,
    'category_slug', c.slug,
    'provider_business_id', b.id,
    'provider_name', b.display_name,
    'provider_time_zone', b.time_zone
  )
  from public.services s
  join public.categories c on c.id = s.category_id
  join public.businesses b on b.id = s.business_id
  where s.id = p_service_id
$$;

-- True when [p_start, p_end) is in the future, on the 15-minute grid, fully inside
-- one availability block of the provider, and free for both participating businesses.
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

create or replace function public._record_event(
  p_exchange_id uuid, p_actor uuid, p_recipient uuid, p_kind text, p_event_type text,
  p_proposal_id uuid, p_body text, p_note text
)
returns uuid
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_message_id uuid;
begin
  insert into public.exchange_messages (exchange_id, kind, author_business_id, event_type, proposal_id, body, note)
  values (p_exchange_id, p_kind, p_actor, p_event_type, p_proposal_id, p_body, p_note)
  returning id into v_message_id;

  insert into public.notifications (recipient_business_id, exchange_id, message_id, event_type)
  values (p_recipient, p_exchange_id, v_message_id, coalesce(p_event_type, 'message'));

  update public.exchanges set last_activity_at = now() where id = p_exchange_id;
  return v_message_id;
end;
$$;

create or replace function public._clean_note(p_note text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'NOTE_TOO_LONG' using errcode = '22023';
  end if;
  return v_note;
end;
$$;

create or replace function public._require_business()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_me uuid := public.current_business_id();
begin
  if v_me is null then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  return v_me;
end;
$$;

-- ---------------------------------------------------------------------------
-- Bookable openings (scoped, leaks no appointment details)
-- ---------------------------------------------------------------------------

create or replace function public.get_available_starts(
  p_service_id uuid, p_counterparty_id uuid, p_from timestamptz default null, p_to timestamptz default null
)
returns table (slot_start timestamptz, slot_end timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := public._require_business();
  v_provider uuid;
  v_duration integer;
  v_from timestamptz;
  v_to timestamptz;
begin
  if p_counterparty_id is null or p_counterparty_id = v_me
    or not exists (select 1 from public.businesses b where b.id = p_counterparty_id and b.is_active) then
    raise exception 'INVALID_COUNTERPARTY' using errcode = '22023';
  end if;

  select s.business_id, s.duration_minutes into v_provider, v_duration
  from public.services s
  join public.businesses b on b.id = s.business_id and b.is_active
  where s.id = p_service_id and s.is_active;

  if v_provider is null or v_provider not in (v_me, p_counterparty_id) then
    raise exception 'SERVICE_UNAVAILABLE' using errcode = '22023';
  end if;

  v_from := greatest(coalesce(p_from, now()), now());
  v_to := least(coalesce(p_to, v_from + interval '30 days'), v_from + interval '62 days');

  return query
  select g.s, g.s + make_interval(mins => v_duration)
  from public.availability_blocks ab
  cross join lateral (
    select pg_catalog.date_bin('15 minutes'::interval, greatest(ab.starts_at, v_from), timestamptz '2000-01-01 00:00:00+00') as b0,
           greatest(ab.starts_at, v_from) as lower_bound
  ) x
  cross join lateral pg_catalog.generate_series(
    case when x.b0 < x.lower_bound then x.b0 + interval '15 minutes' else x.b0 end,
    ab.ends_at - make_interval(mins => v_duration),
    interval '15 minutes'
  ) as g(s)
  where ab.business_id = v_provider
    and ab.ends_at > v_from
    and ab.starts_at < v_to
    and g.s < v_to
    and g.s > now()
    and not exists (
      select 1 from public.appointment_participants ap
      where ap.business_id in (v_me, p_counterparty_id)
        and tstzrange(ap.starts_at, ap.ends_at, '[)') && tstzrange(g.s, g.s + make_interval(mins => v_duration), '[)')
    )
  order by 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- Exchange transitions
-- ---------------------------------------------------------------------------

create or replace function public.create_exchange(
  p_requested_service_id uuid,
  p_offered_service_id uuid,
  p_requested_start timestamptz,
  p_offered_start timestamptz,
  p_note text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := public._require_business();
  v_note text := public._clean_note(p_note);
  v_requested public.services%rowtype;
  v_offered public.services%rowtype;
  v_other uuid;
  v_requested_end timestamptz;
  v_offered_end timestamptz;
  v_exchange_id uuid;
  v_proposal_id uuid;
  v_me_name text;
begin
  select s.* into v_requested
  from public.services s
  join public.businesses b on b.id = s.business_id and b.is_active
  where s.id = p_requested_service_id and s.is_active;
  if not found or v_requested.business_id = v_me then
    raise exception 'SERVICE_UNAVAILABLE' using errcode = '22023';
  end if;

  select s.* into v_offered
  from public.services s
  where s.id = p_offered_service_id and s.is_active and s.business_id = v_me;
  if not found then
    raise exception 'SERVICE_UNAVAILABLE' using errcode = '22023';
  end if;

  v_other := v_requested.business_id;
  if p_requested_start is null or p_offered_start is null then
    raise exception 'INVALID_SLOT' using errcode = '22023';
  end if;
  v_requested_end := p_requested_start + make_interval(mins => v_requested.duration_minutes);
  v_offered_end := p_offered_start + make_interval(mins => v_offered.duration_minutes);

  if tstzrange(p_requested_start, v_requested_end, '[)') && tstzrange(p_offered_start, v_offered_end, '[)') then
    raise exception 'SLOTS_OVERLAP' using errcode = '22023';
  end if;
  if not public._slot_is_bookable(v_other, v_me, v_other, p_requested_start, v_requested_end)
    or not public._slot_is_bookable(v_me, v_me, v_other, p_offered_start, v_offered_end) then
    raise exception 'SLOT_UNAVAILABLE' using errcode = '22023';
  end if;

  select b.display_name into v_me_name from public.businesses b where b.id = v_me;

  insert into public.exchanges (requester_business_id, recipient_business_id, status, current_version, awaiting_business_id)
  values (v_me, v_other, 'pending', 1, v_other)
  returning id into v_exchange_id;

  insert into public.exchange_proposals (
    exchange_id, version, author_business_id, requested_service_id, offered_service_id,
    requested_snapshot, offered_snapshot, requested_starts_at, requested_ends_at,
    offered_starts_at, offered_ends_at, note
  ) values (
    v_exchange_id, 1, v_me, v_requested.id, v_offered.id,
    public._service_snapshot(v_requested.id), public._service_snapshot(v_offered.id),
    p_requested_start, v_requested_end, p_offered_start, v_offered_end, v_note
  )
  returning id into v_proposal_id;

  update public.exchanges set current_proposal_id = v_proposal_id where id = v_exchange_id;

  perform public._record_event(
    v_exchange_id, v_me, v_other, 'event', 'created', v_proposal_id,
    v_me_name || ' envió una propuesta de intercambio.', v_note
  );

  return v_exchange_id;
end;
$$;

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
  if v_exchange.awaiting_business_id <> v_me then
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

create or replace function public.accept_exchange(p_exchange_id uuid, p_expected_version integer)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := public._require_business();
  v_exchange public.exchanges%rowtype;
  v_current public.exchange_proposals%rowtype;
  v_other uuid;
  v_requested_appt uuid;
  v_offered_appt uuid;
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
  if v_exchange.awaiting_business_id <> v_me then
    raise exception 'NOT_YOUR_TURN' using errcode = '42501';
  end if;

  select p.* into v_current from public.exchange_proposals p where p.id = v_exchange.current_proposal_id;

  if not exists (
      select 1 from public.services s join public.businesses b on b.id = s.business_id and b.is_active
      where s.id = v_current.requested_service_id and s.is_active and s.business_id = v_exchange.recipient_business_id)
    or not exists (
      select 1 from public.services s join public.businesses b on b.id = s.business_id and b.is_active
      where s.id = v_current.offered_service_id and s.is_active and s.business_id = v_exchange.requester_business_id) then
    raise exception 'SERVICE_INACTIVE' using errcode = '22023';
  end if;

  -- Serialize against concurrent acceptances and availability edits for both businesses.
  perform public._lock_business_pair(v_exchange.requester_business_id, v_exchange.recipient_business_id);

  if not public._slot_is_bookable(v_exchange.recipient_business_id, v_exchange.requester_business_id, v_exchange.recipient_business_id,
       v_current.requested_starts_at, v_current.requested_ends_at)
    or not public._slot_is_bookable(v_exchange.requester_business_id, v_exchange.requester_business_id, v_exchange.recipient_business_id,
       v_current.offered_starts_at, v_current.offered_ends_at) then
    raise exception 'SLOT_UNAVAILABLE' using errcode = '22023';
  end if;

  begin
    insert into public.appointments (
      exchange_id, proposal_id, role, service_id, provider_business_id, receiver_business_id,
      service_title, service_description, duration_minutes, category_id, starts_at, ends_at
    ) values (
      v_exchange.id, v_current.id, 'requested', v_current.requested_service_id,
      v_exchange.recipient_business_id, v_exchange.requester_business_id,
      v_current.requested_snapshot ->> 'title', coalesce(v_current.requested_snapshot ->> 'description', ''),
      (v_current.requested_snapshot ->> 'duration_minutes')::integer,
      (v_current.requested_snapshot ->> 'category_id')::uuid,
      v_current.requested_starts_at, v_current.requested_ends_at
    ) returning id into v_requested_appt;

    insert into public.appointments (
      exchange_id, proposal_id, role, service_id, provider_business_id, receiver_business_id,
      service_title, service_description, duration_minutes, category_id, starts_at, ends_at
    ) values (
      v_exchange.id, v_current.id, 'offered', v_current.offered_service_id,
      v_exchange.requester_business_id, v_exchange.recipient_business_id,
      v_current.offered_snapshot ->> 'title', coalesce(v_current.offered_snapshot ->> 'description', ''),
      (v_current.offered_snapshot ->> 'duration_minutes')::integer,
      (v_current.offered_snapshot ->> 'category_id')::uuid,
      v_current.offered_starts_at, v_current.offered_ends_at
    ) returning id into v_offered_appt;

    insert into public.appointment_participants (appointment_id, business_id, participation, starts_at, ends_at) values
      (v_requested_appt, v_exchange.recipient_business_id, 'provider', v_current.requested_starts_at, v_current.requested_ends_at),
      (v_requested_appt, v_exchange.requester_business_id, 'receiver', v_current.requested_starts_at, v_current.requested_ends_at),
      (v_offered_appt, v_exchange.requester_business_id, 'provider', v_current.offered_starts_at, v_current.offered_ends_at),
      (v_offered_appt, v_exchange.recipient_business_id, 'receiver', v_current.offered_starts_at, v_current.offered_ends_at);
  exception
    when exclusion_violation or unique_violation then
      raise exception 'SLOT_UNAVAILABLE' using errcode = '22023';
  end;

  update public.exchanges set status = 'accepted', awaiting_business_id = null where id = v_exchange.id;

  v_other := case when v_me = v_exchange.requester_business_id then v_exchange.recipient_business_id else v_exchange.requester_business_id end;
  select b.display_name into v_me_name from public.businesses b where b.id = v_me;
  perform public._record_event(
    v_exchange.id, v_me, v_other, 'event', 'accepted', v_current.id,
    v_me_name || ' aceptó el intercambio. Se confirmaron los dos turnos.', null
  );
end;
$$;

create or replace function public.reject_exchange(p_exchange_id uuid, p_expected_version integer, p_reason text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := public._require_business();
  v_reason text := public._clean_note(p_reason);
  v_exchange public.exchanges%rowtype;
  v_other uuid;
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
  if v_exchange.awaiting_business_id <> v_me then
    raise exception 'NOT_YOUR_TURN' using errcode = '42501';
  end if;

  update public.exchanges set status = 'rejected', awaiting_business_id = null where id = v_exchange.id;

  v_other := case when v_me = v_exchange.requester_business_id then v_exchange.recipient_business_id else v_exchange.requester_business_id end;
  select b.display_name into v_me_name from public.businesses b where b.id = v_me;
  perform public._record_event(
    v_exchange.id, v_me, v_other, 'event', 'rejected', v_exchange.current_proposal_id,
    v_me_name || ' rechazó el intercambio.', v_reason
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Conversation and notifications
-- ---------------------------------------------------------------------------

create or replace function public.send_exchange_message(p_exchange_id uuid, p_body text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := public._require_business();
  v_body text := btrim(coalesce(p_body, ''));
  v_exchange public.exchanges%rowtype;
  v_other uuid;
begin
  if char_length(v_body) = 0 then
    raise exception 'EMPTY_MESSAGE' using errcode = '22023';
  end if;
  if char_length(v_body) > 2000 then
    raise exception 'MESSAGE_TOO_LONG' using errcode = '22023';
  end if;

  select e.* into v_exchange from public.exchanges e where e.id = p_exchange_id;
  if not found or v_me not in (v_exchange.requester_business_id, v_exchange.recipient_business_id) then
    raise exception 'NOT_FOUND' using errcode = '42501';
  end if;

  v_other := case when v_me = v_exchange.requester_business_id then v_exchange.recipient_business_id else v_exchange.requester_business_id end;
  return public._record_event(v_exchange.id, v_me, v_other, 'message', null, null, v_body, null);
end;
$$;

create or replace function public.mark_exchange_read(p_exchange_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := public._require_business();
  v_count integer;
begin
  update public.notifications n
  set read_at = now()
  where n.recipient_business_id = v_me and n.exchange_id = p_exchange_id and n.read_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Availability management (dates and times are local to the business time zone)
-- ---------------------------------------------------------------------------

create or replace function public._assert_provided_appointments_covered(p_business_id uuid, p_start timestamptz, p_end timestamptz)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.appointments a
    where a.provider_business_id = p_business_id
      and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(p_start, p_end, '[)')
      and not exists (
        select 1 from public.availability_blocks ab
        where ab.business_id = p_business_id and ab.starts_at <= a.starts_at and ab.ends_at >= a.ends_at
      )
  ) then
    raise exception 'APPOINTMENT_OUTSIDE_AVAILABILITY' using errcode = '22023';
  end if;
end;
$$;

create or replace function public._local_range(p_business_id uuid, p_date date, p_start time, p_end time)
returns tstzrange
language plpgsql
stable
set search_path = ''
as $$
declare
  v_tz text;
  v_start timestamptz;
  v_end timestamptz;
begin
  if p_date is null or p_start is null or p_end is null or p_end <= p_start then
    raise exception 'INVALID_RANGE' using errcode = '22023';
  end if;
  select b.time_zone into v_tz from public.businesses b where b.id = p_business_id;
  v_start := (p_date + p_start) at time zone v_tz;
  v_end := (p_date + p_end) at time zone v_tz;
  if v_end <= v_start then
    raise exception 'INVALID_RANGE' using errcode = '22023';
  end if;
  if v_end <= now() then
    raise exception 'PAST_RANGE' using errcode = '22023';
  end if;
  return tstzrange(v_start, v_end, '[)');
end;
$$;

create or replace function public.create_availability_block(p_date date, p_start time, p_end time)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := public._require_business();
  v_range tstzrange := public._local_range(v_me, p_date, p_start, p_end);
  v_id uuid;
begin
  perform public._business_lock(v_me);
  begin
    insert into public.availability_blocks (business_id, starts_at, ends_at)
    values (v_me, lower(v_range), upper(v_range))
    returning id into v_id;
  exception
    when exclusion_violation then
      raise exception 'AVAILABILITY_OVERLAP' using errcode = '22023';
  end;
  return v_id;
end;
$$;

create or replace function public.update_availability_block(p_block_id uuid, p_date date, p_start time, p_end time)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := public._require_business();
  v_range tstzrange := public._local_range(v_me, p_date, p_start, p_end);
  v_old public.availability_blocks%rowtype;
begin
  perform public._business_lock(v_me);
  select ab.* into v_old from public.availability_blocks ab
  where ab.id = p_block_id and ab.business_id = v_me for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = '42501';
  end if;

  begin
    update public.availability_blocks
    set starts_at = lower(v_range), ends_at = upper(v_range)
    where id = v_old.id;
  exception
    when exclusion_violation then
      raise exception 'AVAILABILITY_OVERLAP' using errcode = '22023';
  end;

  perform public._assert_provided_appointments_covered(v_me, v_old.starts_at, v_old.ends_at);
end;
$$;

create or replace function public.delete_availability_block(p_block_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := public._require_business();
  v_old public.availability_blocks%rowtype;
begin
  perform public._business_lock(v_me);
  delete from public.availability_blocks ab
  where ab.id = p_block_id and ab.business_id = v_me
  returning ab.* into v_old;
  if v_old.id is null then
    raise exception 'NOT_FOUND' using errcode = '42501';
  end if;
  perform public._assert_provided_appointments_covered(v_me, v_old.starts_at, v_old.ends_at);
end;
$$;

-- Used by the demo seed (service role only) to move a demo block without
-- breaking any confirmed appointment.
create or replace function public.seed_upsert_availability(p_business_id uuid, p_seed_key text, p_start timestamptz, p_end timestamptz)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old public.availability_blocks%rowtype;
begin
  perform public._business_lock(p_business_id);
  select ab.* into v_old from public.availability_blocks ab where ab.seed_key = p_seed_key for update;

  if found then
    if v_old.starts_at = p_start and v_old.ends_at = p_end then
      return 'unchanged';
    end if;
    if exists (
      select 1 from public.appointments a
      where a.provider_business_id = v_old.business_id
        and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(v_old.starts_at, v_old.ends_at, '[)')
    ) then
      return 'kept_booked';
    end if;
    begin
      update public.availability_blocks set starts_at = p_start, ends_at = p_end where id = v_old.id;
    exception when exclusion_violation then
      return 'skipped_overlap';
    end;
    return 'moved';
  end if;

  begin
    insert into public.availability_blocks (business_id, starts_at, ends_at, seed_key)
    values (p_business_id, p_start, p_end, p_seed_key);
  exception when exclusion_violation then
    return 'skipped_overlap';
  end;
  return 'created';
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function public._business_lock(uuid) from public, anon, authenticated;
revoke execute on function public._lock_business_pair(uuid, uuid) from public, anon, authenticated;
revoke execute on function public._service_snapshot(uuid) from public, anon, authenticated;
revoke execute on function public._slot_is_bookable(uuid, uuid, uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public._record_event(uuid, uuid, uuid, text, text, uuid, text, text) from public, anon, authenticated;
revoke execute on function public._clean_note(text) from public, anon, authenticated;
revoke execute on function public._require_business() from public, anon, authenticated;
revoke execute on function public._assert_provided_appointments_covered(uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public._local_range(uuid, date, time, time) from public, anon, authenticated;
revoke execute on function public.seed_upsert_availability(uuid, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.seed_upsert_availability(uuid, text, timestamptz, timestamptz) to service_role;

revoke execute on function public.get_available_starts(uuid, uuid, timestamptz, timestamptz) from public, anon;
revoke execute on function public.create_exchange(uuid, uuid, timestamptz, timestamptz, text) from public, anon;
revoke execute on function public.counter_exchange(uuid, integer, timestamptz, timestamptz, text) from public, anon;
revoke execute on function public.accept_exchange(uuid, integer) from public, anon;
revoke execute on function public.reject_exchange(uuid, integer, text) from public, anon;
revoke execute on function public.send_exchange_message(uuid, text) from public, anon;
revoke execute on function public.mark_exchange_read(uuid) from public, anon;
revoke execute on function public.create_availability_block(date, time, time) from public, anon;
revoke execute on function public.update_availability_block(uuid, date, time, time) from public, anon;
revoke execute on function public.delete_availability_block(uuid) from public, anon;

grant execute on function public.get_available_starts(uuid, uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.create_exchange(uuid, uuid, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.counter_exchange(uuid, integer, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.accept_exchange(uuid, integer) to authenticated;
grant execute on function public.reject_exchange(uuid, integer, text) to authenticated;
grant execute on function public.send_exchange_message(uuid, text) to authenticated;
grant execute on function public.mark_exchange_read(uuid) to authenticated;
grant execute on function public.create_availability_block(date, time, time) to authenticated;
grant execute on function public.update_availability_block(uuid, date, time, time) to authenticated;
grant execute on function public.delete_availability_block(uuid) to authenticated;
