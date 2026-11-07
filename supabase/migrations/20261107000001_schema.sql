-- SwappaLook core schema: tables, constraints, indexes, triggers and RLS.
-- All timestamps are timestamptz. Time ranges are half-open [start, end).

create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Categories
-- ---------------------------------------------------------------------------

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]+$'),
  name text not null check (char_length(btrim(name)) between 1 and 60),
  is_active boolean not null default true,
  sort_order integer not null default 100,
  accent_color text check (accent_color is null or accent_color ~ '^#[0-9a-fA-F]{6}$'),
  soft_color text check (soft_color is null or soft_color ~ '^#[0-9a-fA-F]{6}$'),
  thumbnail_url text check (thumbnail_url is null or char_length(thumbnail_url) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index categories_active_sort_idx on public.categories (is_active, sort_order, name);
create trigger categories_updated_at before update on public.categories
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Businesses (one per Auth user)
-- ---------------------------------------------------------------------------

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete restrict,
  login text not null unique check (login = lower(login) and login ~ '^[a-z0-9._-]+@swappa$'),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 60),
  description text not null default '' check (char_length(description) <= 500),
  time_zone text not null default 'America/Argentina/Buenos_Aires',
  primary_category_id uuid references public.categories (id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index businesses_active_idx on public.businesses (is_active);
create trigger businesses_updated_at before update on public.businesses
  for each row execute function public.set_updated_at();

create or replace function public.validate_business_time_zone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names tz where tz.name = new.time_zone) then
    raise exception 'INVALID_TIME_ZONE' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger businesses_validate_time_zone
  before insert or update of time_zone on public.businesses
  for each row execute function public.validate_business_time_zone();

-- Resolves the active business for the authenticated caller.
create or replace function public.current_business_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select b.id from public.businesses b where b.user_id = auth.uid() and b.is_active
$$;

-- ---------------------------------------------------------------------------
-- Services
-- ---------------------------------------------------------------------------

create table public.services (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  category_id uuid not null references public.categories (id) on delete restrict,
  title text not null check (char_length(btrim(title)) between 2 and 80),
  description text not null default '' check (char_length(description) <= 600),
  duration_minutes integer not null check (duration_minutes between 15 and 480 and duration_minutes % 5 = 0),
  image_url text check (image_url is null or (image_url ~ '^https://' and char_length(image_url) <= 500)),
  is_active boolean not null default true,
  seed_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index services_business_idx on public.services (business_id, is_active);
create index services_category_idx on public.services (category_id, is_active);
create trigger services_updated_at before update on public.services
  for each row execute function public.set_updated_at();

-- A service can only be moved into (or created in) an active category.
create or replace function public.validate_service_category()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.category_id is distinct from old.category_id then
    if not exists (select 1 from public.categories c where c.id = new.category_id and c.is_active) then
      raise exception 'CATEGORY_INACTIVE' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;

create trigger services_validate_category
  before insert or update of category_id on public.services
  for each row execute function public.validate_service_category();

-- ---------------------------------------------------------------------------
-- Availability
-- ---------------------------------------------------------------------------

create table public.availability_blocks (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  seed_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint availability_valid_range check (ends_at > starts_at and ends_at - starts_at <= interval '24 hours'),
  constraint availability_no_overlap exclude using gist (
    business_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  )
);

create index availability_business_time_idx on public.availability_blocks (business_id, starts_at);
create trigger availability_updated_at before update on public.availability_blocks
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Exchanges and proposals
-- ---------------------------------------------------------------------------

create table public.exchanges (
  id uuid primary key default gen_random_uuid(),
  requester_business_id uuid not null references public.businesses (id) on delete restrict,
  recipient_business_id uuid not null references public.businesses (id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'countered', 'accepted', 'rejected')),
  current_proposal_id uuid,
  current_version integer not null default 1 check (current_version >= 1),
  awaiting_business_id uuid references public.businesses (id),
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint exchanges_distinct_businesses check (requester_business_id <> recipient_business_id),
  constraint exchanges_awaiting_consistent check (
    (status in ('pending', 'countered') and awaiting_business_id in (requester_business_id, recipient_business_id))
    or (status in ('accepted', 'rejected') and awaiting_business_id is null)
  )
);

create index exchanges_requester_activity_idx on public.exchanges (requester_business_id, last_activity_at desc);
create index exchanges_recipient_activity_idx on public.exchanges (recipient_business_id, last_activity_at desc);
create trigger exchanges_updated_at before update on public.exchanges
  for each row execute function public.set_updated_at();

-- "requested" = the service the original requester receives (provided by the recipient).
-- "offered"   = the service the original requester provides (received by the recipient).
create table public.exchange_proposals (
  id uuid primary key default gen_random_uuid(),
  exchange_id uuid not null references public.exchanges (id) on delete cascade,
  version integer not null check (version >= 1),
  author_business_id uuid not null references public.businesses (id),
  requested_service_id uuid not null references public.services (id),
  offered_service_id uuid not null references public.services (id),
  requested_snapshot jsonb not null,
  offered_snapshot jsonb not null,
  requested_starts_at timestamptz not null,
  requested_ends_at timestamptz not null,
  offered_starts_at timestamptz not null,
  offered_ends_at timestamptz not null,
  note text check (note is null or char_length(note) <= 500),
  created_at timestamptz not null default now(),
  constraint proposals_unique_version unique (exchange_id, version),
  constraint proposals_requested_range check (requested_ends_at > requested_starts_at),
  constraint proposals_offered_range check (offered_ends_at > offered_starts_at),
  constraint proposals_no_self_overlap check (
    not (tstzrange(requested_starts_at, requested_ends_at, '[)') && tstzrange(offered_starts_at, offered_ends_at, '[)'))
  )
);

create index proposals_exchange_idx on public.exchange_proposals (exchange_id, version);

alter table public.exchanges
  add constraint exchanges_current_proposal_fk
  foreign key (current_proposal_id) references public.exchange_proposals (id)
  deferrable initially deferred;

create or replace function public.prevent_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'IMMUTABLE_RECORD' using errcode = '42501';
end;
$$;

create trigger exchange_proposals_immutable
  before update on public.exchange_proposals
  for each row execute function public.prevent_mutation();

-- ---------------------------------------------------------------------------
-- Appointments and reservations
-- ---------------------------------------------------------------------------

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  exchange_id uuid not null references public.exchanges (id) on delete restrict,
  proposal_id uuid not null references public.exchange_proposals (id) on delete restrict,
  role text not null check (role in ('requested', 'offered')),
  service_id uuid not null references public.services (id),
  provider_business_id uuid not null references public.businesses (id),
  receiver_business_id uuid not null references public.businesses (id),
  service_title text not null,
  service_description text not null default '',
  duration_minutes integer not null,
  category_id uuid references public.categories (id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint appointments_one_per_role unique (exchange_id, role),
  constraint appointments_distinct check (provider_business_id <> receiver_business_id),
  constraint appointments_range check (ends_at > starts_at)
);

create index appointments_provider_time_idx on public.appointments (provider_business_id, starts_at);
create index appointments_receiver_time_idx on public.appointments (receiver_business_id, starts_at);

create table public.appointment_participants (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.appointments (id) on delete cascade,
  business_id uuid not null references public.businesses (id),
  participation text not null check (participation in ('provider', 'receiver')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint participants_unique unique (appointment_id, business_id),
  constraint participants_range check (ends_at > starts_at),
  constraint participants_no_double_booking exclude using gist (
    business_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  )
);

create index participants_business_time_idx on public.appointment_participants (business_id, starts_at);

create trigger appointments_immutable
  before update on public.appointments
  for each row execute function public.prevent_mutation();
create trigger appointment_participants_immutable
  before update on public.appointment_participants
  for each row execute function public.prevent_mutation();

-- ---------------------------------------------------------------------------
-- Conversation and notifications
-- ---------------------------------------------------------------------------

create table public.exchange_messages (
  id uuid primary key default gen_random_uuid(),
  exchange_id uuid not null references public.exchanges (id) on delete cascade,
  kind text not null check (kind in ('message', 'event')),
  author_business_id uuid not null references public.businesses (id),
  event_type text check (event_type is null or event_type in ('created', 'countered', 'accepted', 'rejected')),
  proposal_id uuid references public.exchange_proposals (id),
  body text not null check (char_length(body) between 1 and 2000),
  note text check (note is null or char_length(note) <= 500),
  created_at timestamptz not null default now(),
  constraint messages_kind_consistent check (
    (kind = 'message' and event_type is null) or (kind = 'event' and event_type is not null)
  )
);

create index messages_exchange_time_idx on public.exchange_messages (exchange_id, created_at);

create trigger exchange_messages_immutable
  before update on public.exchange_messages
  for each row execute function public.prevent_mutation();

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_business_id uuid not null references public.businesses (id) on delete cascade,
  exchange_id uuid not null references public.exchanges (id) on delete cascade,
  message_id uuid not null references public.exchange_messages (id) on delete cascade,
  event_type text not null check (event_type in ('message', 'created', 'countered', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint notifications_unique_event unique (recipient_business_id, message_id)
);

create index notifications_unread_idx on public.notifications (recipient_business_id, exchange_id) where read_at is null;
create index notifications_recipient_time_idx on public.notifications (recipient_business_id, created_at desc);

-- Recipients may only move read_at forward from null; everything else is fixed.
create or replace function public.guard_notification_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.recipient_business_id <> old.recipient_business_id
    or new.exchange_id <> old.exchange_id
    or new.message_id <> old.message_id
    or new.event_type <> old.event_type
    or new.created_at <> old.created_at
    or (old.read_at is not null and new.read_at is distinct from old.read_at)
    or new.read_at is null then
    raise exception 'IMMUTABLE_RECORD' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger notifications_guard_update
  before update on public.notifications
  for each row execute function public.guard_notification_update();

-- ---------------------------------------------------------------------------
-- Participant helper (used by RLS)
-- ---------------------------------------------------------------------------

create or replace function public.is_exchange_participant(p_exchange_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.exchanges e
    where e.id = p_exchange_id
      and public.current_business_id() in (e.requester_business_id, e.recipient_business_id)
  )
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on public.categories, public.businesses, public.services, public.availability_blocks,
  public.exchanges, public.exchange_proposals, public.appointments, public.appointment_participants,
  public.exchange_messages, public.notifications
from anon, authenticated;

grant select on public.categories to authenticated;
grant select (id, display_name, description, time_zone, primary_category_id, is_active) on public.businesses to authenticated;
grant update (display_name, description, time_zone) on public.businesses to authenticated;
grant select on public.services to authenticated;
grant insert (business_id, category_id, title, description, duration_minutes, image_url, is_active) on public.services to authenticated;
grant update (category_id, title, description, duration_minutes, image_url, is_active) on public.services to authenticated;
grant select on public.availability_blocks to authenticated;
grant select on public.exchanges, public.exchange_proposals, public.appointments,
  public.appointment_participants, public.exchange_messages to authenticated;
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

grant all on public.categories, public.businesses, public.services, public.availability_blocks,
  public.exchanges, public.exchange_proposals, public.appointments, public.appointment_participants,
  public.exchange_messages, public.notifications
to service_role;

revoke execute on function public.current_business_id() from public, anon;
grant execute on function public.current_business_id() to authenticated, service_role;
revoke execute on function public.is_exchange_participant(uuid) from public, anon;
grant execute on function public.is_exchange_participant(uuid) to authenticated, service_role;
revoke execute on function public.validate_service_category() from public, anon, authenticated;
revoke execute on function public.validate_business_time_zone() from public, anon, authenticated;
revoke execute on function public.guard_notification_update() from public, anon, authenticated;
revoke execute on function public.prevent_mutation() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.categories enable row level security;
alter table public.businesses enable row level security;
alter table public.services enable row level security;
alter table public.availability_blocks enable row level security;
alter table public.exchanges enable row level security;
alter table public.exchange_proposals enable row level security;
alter table public.appointments enable row level security;
alter table public.appointment_participants enable row level security;
alter table public.exchange_messages enable row level security;
alter table public.notifications enable row level security;

create policy categories_select on public.categories for select to authenticated
using (
  (select public.current_business_id()) is not null
  and (
    is_active
    or exists (
      select 1 from public.services s
      where s.category_id = categories.id and s.business_id = (select public.current_business_id())
    )
  )
);

create policy businesses_select_directory on public.businesses for select to authenticated
using ((select public.current_business_id()) is not null and is_active);

create policy businesses_update_own on public.businesses for update to authenticated
using (id = (select public.current_business_id()))
with check (id = (select public.current_business_id()));

create policy services_select on public.services for select to authenticated
using (
  (select public.current_business_id()) is not null
  and (
    business_id = (select public.current_business_id())
    or (is_active and exists (select 1 from public.businesses b where b.id = services.business_id and b.is_active))
  )
);

create policy services_insert_own on public.services for insert to authenticated
with check (business_id = (select public.current_business_id()));

create policy services_update_own on public.services for update to authenticated
using (business_id = (select public.current_business_id()))
with check (business_id = (select public.current_business_id()));

create policy availability_select_own on public.availability_blocks for select to authenticated
using (business_id = (select public.current_business_id()));

create policy exchanges_select_participant on public.exchanges for select to authenticated
using ((select public.current_business_id()) in (requester_business_id, recipient_business_id));

create policy proposals_select_participant on public.exchange_proposals for select to authenticated
using (public.is_exchange_participant(exchange_id));

create policy appointments_select_participant on public.appointments for select to authenticated
using (public.is_exchange_participant(exchange_id));

create policy participants_select_participant on public.appointment_participants for select to authenticated
using (
  exists (
    select 1 from public.appointments a
    where a.id = appointment_participants.appointment_id and public.is_exchange_participant(a.exchange_id)
  )
);

create policy messages_select_participant on public.exchange_messages for select to authenticated
using (public.is_exchange_participant(exchange_id));

create policy notifications_select_own on public.notifications for select to authenticated
using (recipient_business_id = (select public.current_business_id()));

create policy notifications_mark_read_own on public.notifications for update to authenticated
using (recipient_business_id = (select public.current_business_id()))
with check (recipient_business_id = (select public.current_business_id()));
