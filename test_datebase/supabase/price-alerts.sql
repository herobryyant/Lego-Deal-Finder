-- Add an email destination to user profiles.
alter table public.profiles
  add column if not exists alert_email text
  check (
    alert_email is null
    or char_length(alert_email) <= 254
  );

-- Add automated email settings to watchlists.
alter table public.watchlists
  add column if not exists email_alerts boolean
    not null default true,
  add column if not exists last_checked_at timestamptz;

-- Record previously sent alerts to prevent duplicate emails.
create table if not exists public.price_alerts (
  id uuid primary key default gen_random_uuid(),

  watchlist_id uuid not null
    references public.watchlists(id)
    on delete cascade,

  user_id uuid not null
    references auth.users(id)
    on delete cascade,

  ebay_item_id text not null,
  title text not null
    check (char_length(title) between 1 and 300),
  listing_url text not null,
  total_price_cents bigint not null
    check (total_price_cents >= 0),

  sent_at timestamptz not null default now(),

  unique (
    watchlist_id,
    ebay_item_id,
    total_price_cents
  )
);

create index if not exists
  price_alerts_user_sent_idx
on public.price_alerts (
  user_id,
  sent_at desc
);

create index if not exists
  price_alerts_watchlist_idx
on public.price_alerts (
  watchlist_id
);

alter table public.price_alerts
  enable row level security;

drop policy if exists
  price_alerts_own_rows
on public.price_alerts;

create policy price_alerts_own_rows
on public.price_alerts
for select
to authenticated
using (
  (select auth.uid()) = user_id
);

revoke all
on public.price_alerts
from anon;

grant select
on public.price_alerts
to authenticated;

grant select, insert, update, delete
on public.price_alerts
to service_role;

-- Give existing users their authentication email as the default alert email.
update public.profiles as profile
set alert_email = lower(auth_user.email)
from auth.users as auth_user
where profile.user_id = auth_user.id
  and profile.alert_email is null;

-- Give future users a default alert email.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (
    user_id,
    display_name,
    alert_email
  )
  values (
    new.id,
    left(
      coalesce(
        new.raw_user_meta_data ->> 'display_name',
        ''
      ),
      80
    ),
    lower(new.email)
  )
  on conflict (user_id) do nothing;

  return new;
end;
$$;