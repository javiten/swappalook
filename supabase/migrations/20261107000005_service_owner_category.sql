-- Services: owner and category are derived from the authenticated business.
-- Preserves existing data. RLS stays enabled; writes still use the user's session.

create or replace function public.enforce_service_owner_category()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business uuid;
  v_category uuid;
begin
  if tg_op = 'INSERT' then
    v_business := coalesce(new.business_id, public.current_business_id());
    if v_business is null then
      raise exception 'BUSINESS_REQUIRED' using errcode = '22023';
    end if;
    new.business_id := v_business;
  end if;

  select b.primary_category_id into v_category
  from public.businesses b
  where b.id = new.business_id;

  if v_category is null then
    raise exception 'BUSINESS_CATEGORY_MISSING' using errcode = '22023';
  end if;

  if new.category_id is null then
    new.category_id := v_category;
  elsif new.category_id <> v_category then
    raise exception 'CATEGORY_MISMATCH' using errcode = '22023';
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_service_owner_category() from public, anon, authenticated;

-- Named to fire before services_validate_category (triggers run alphabetically).
drop trigger if exists services_a_enforce_owner_category on public.services;
create trigger services_a_enforce_owner_category
  before insert or update of category_id, business_id on public.services
  for each row execute function public.enforce_service_owner_category();
