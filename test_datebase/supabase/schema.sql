-- Run this file once in Supabase Dashboard > SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text check (char_length(display_name) <= 80),
  location text check (char_length(location) <= 120),
  favorite_theme text check (char_length(favorite_theme) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.saved_deals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ebay_item_id text not null,
  title text not null check (char_length(title) <= 300),
  listing_url text not null,
  image_url text,
  price_cents bigint not null check (price_cents >= 0),
  shipping_cents bigint check (shipping_cents >= 0),
  currency text not null default 'USD' check (char_length(currency) = 3),
  item_condition text,
  saved_at timestamptz not null default now(),
  unique (user_id, ebay_item_id)
);

create table if not exists public.watchlists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  search_query text not null check (char_length(search_query) between 1 and 150),
  set_number text check (char_length(set_number) <= 30),
  max_price_cents bigint check (max_price_cents is null or max_price_cents >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ebay_item_id text,
  title text not null check (char_length(title) between 1 and 300),
  amount_cents bigint not null check (amount_cents >= 0),
  currency text not null default 'USD' check (char_length(currency) = 3),
  status text not null check (status in ('planned', 'purchased', 'sold', 'cancelled')),
  occurred_at date not null default current_date,
  notes text check (char_length(notes) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists saved_deals_user_saved_at_idx on public.saved_deals (user_id, saved_at desc);
create index if not exists watchlists_user_updated_at_idx on public.watchlists (user_id, updated_at desc);
create index if not exists transactions_user_occurred_at_idx on public.transactions (user_id, occurred_at desc);

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at();
drop trigger if exists watchlists_set_updated_at on public.watchlists;
create trigger watchlists_set_updated_at before update on public.watchlists for each row execute function public.set_updated_at();
drop trigger if exists transactions_set_updated_at on public.transactions;
create trigger transactions_set_updated_at before update on public.transactions for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (user_id, display_name)
  values (new.id, left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 80))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.saved_deals enable row level security;
alter table public.watchlists enable row level security;
alter table public.transactions enable row level security;

drop policy if exists profiles_own_rows on public.profiles;
create policy profiles_own_rows on public.profiles for all to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists saved_deals_own_rows on public.saved_deals;
create policy saved_deals_own_rows on public.saved_deals for all to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists watchlists_own_rows on public.watchlists;
create policy watchlists_own_rows on public.watchlists for all to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists transactions_own_rows on public.transactions;
create policy transactions_own_rows on public.transactions for all to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

revoke all on public.profiles, public.saved_deals, public.watchlists, public.transactions from anon;
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.profiles, public.saved_deals, public.watchlists, public.transactions to authenticated;
