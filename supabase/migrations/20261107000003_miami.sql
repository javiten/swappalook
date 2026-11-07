-- SwappaLook businesses operate in Miami time for calendar editing and display.
update public.businesses set time_zone = 'America/New_York' where time_zone = 'America/Argentina/Buenos_Aires';
alter table public.businesses alter column time_zone set default 'America/New_York';
