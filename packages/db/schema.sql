-- Shopping List HE (Supabase Postgres)

create extension if not exists pgcrypto;

-- Households are keyed by telegram_chat_id (v1: one group)
create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  telegram_chat_id text unique not null,
  name text,
  created_at timestamptz not null default now()
);

create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name_he text not null,
  normalized_name text not null,
  category text not null default 'כללי',
  qty numeric,
  unit text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_items_household_active on public.items(household_id, active);
create index if not exists idx_items_household_norm on public.items(household_id, normalized_name);

create table if not exists public.shopping_trips (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  store_name text,
  store_branch text,
  city text,
  status text not null default 'ACTIVE',
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists idx_trips_household_status on public.shopping_trips(household_id, status);

create table if not exists public.cart_entries (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.shopping_trips(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  in_cart boolean not null,
  price numeric,
  qty_bought numeric,
  note text,
  updated_at timestamptz not null default now(),
  unique(trip_id, item_id)
);

create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.shopping_trips(id) on delete cascade,
  item_name_he text not null,
  category text not null,
  price numeric,
  qty_bought numeric,
  created_at timestamptz not null default now()
);

create table if not exists public.shopping_sessions (
  token text primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  trip_id uuid not null references public.shopping_trips(id) on delete cascade,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_sessions_household on public.shopping_sessions(household_id);
create index if not exists idx_sessions_expires on public.shopping_sessions(expires_at);

-- RLS: for now, service role only (API uses service_role). Keep tables locked down.
alter table public.households enable row level security;
alter table public.items enable row level security;
alter table public.shopping_trips enable row level security;
alter table public.cart_entries enable row level security;
alter table public.purchases enable row level security;
alter table public.shopping_sessions enable row level security;

-- No policies (default deny). We'll access via service_role.
