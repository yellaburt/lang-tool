-- lang-tool initial schema
-- Phase A: per-user personal library. Public-library / folder support is
-- structured in but not exercised yet.

-- Passages live in their own table. ReadingState is per-user, so when public
-- library lands, each reader's progress stays independent.

create extension if not exists "pgcrypto"; -- for gen_random_uuid()

-- =====================================================================
-- passages
-- =====================================================================
create table public.passages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete cascade,
  -- visibility: 'private' (owner only) | 'public' (everyone reads, admin writes)
  -- only 'private' is created by users in Phase A.
  visibility text not null default 'private' check (visibility in ('private', 'public')),
  title text not null,
  language text not null,
  raw_text text not null,
  -- chunks is the entire array of {id, index, sentenceIndex, tlText, englishGloss, audioRef}.
  -- We keep them in one JSONB column rather than a separate chunks table because:
  --   - they're always read/written as one unit per passage
  --   - the array is bounded (rarely >100 entries for a typical news passage)
  --   - queries never filter or join by chunk
  chunks jsonb not null,
  processing_status jsonb not null,  -- discriminated union: {kind: 'complete' | 'in-progress' | 'error', ...}
  sentence_count integer not null default 0,
  created_at timestamptz not null default now()
);

create index passages_owner_idx on public.passages(owner_id);
create index passages_visibility_idx on public.passages(visibility);

-- =====================================================================
-- reading_state — per-user, per-passage progress
-- =====================================================================
create table public.reading_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  passage_id uuid not null references public.passages(id) on delete cascade,
  last_read_chunk_index integer not null default 0,
  last_opened_at timestamptz not null default now(),
  primary key (user_id, passage_id)
);

create index reading_state_user_idx on public.reading_state(user_id);
create index reading_state_recent_idx on public.reading_state(user_id, last_opened_at desc);

-- =====================================================================
-- user_settings — one JSONB blob per user, the existing Settings shape
-- =====================================================================
create table public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  settings jsonb not null,
  updated_at timestamptz not null default now()
);

-- =====================================================================
-- Row-Level Security: enforce per-user access in the database itself
-- =====================================================================
alter table public.passages enable row level security;
alter table public.reading_state enable row level security;
alter table public.user_settings enable row level security;

-- passages: users see their own + any public ones. Insert/update/delete only on their own.
create policy "passages_select_own_or_public"
  on public.passages for select
  using (auth.uid() = owner_id or visibility = 'public');

create policy "passages_insert_own"
  on public.passages for insert
  with check (auth.uid() = owner_id and visibility = 'private');

create policy "passages_update_own"
  on public.passages for update
  using (auth.uid() = owner_id);

create policy "passages_delete_own"
  on public.passages for delete
  using (auth.uid() = owner_id);

-- reading_state: only the user's own rows
create policy "reading_state_select_own"
  on public.reading_state for select
  using (auth.uid() = user_id);

create policy "reading_state_insert_own"
  on public.reading_state for insert
  with check (auth.uid() = user_id);

create policy "reading_state_update_own"
  on public.reading_state for update
  using (auth.uid() = user_id);

create policy "reading_state_delete_own"
  on public.reading_state for delete
  using (auth.uid() = user_id);

-- user_settings: only the user's own row
create policy "user_settings_select_own"
  on public.user_settings for select
  using (auth.uid() = user_id);

create policy "user_settings_insert_own"
  on public.user_settings for insert
  with check (auth.uid() = user_id);

create policy "user_settings_update_own"
  on public.user_settings for update
  using (auth.uid() = user_id);

-- =====================================================================
-- Helper view: passages enriched with the current user's reading state.
-- =====================================================================
create view public.passages_with_state
with (security_invoker = true) as
select
  p.*,
  coalesce(rs.last_read_chunk_index, 0) as last_read_chunk_index,
  coalesce(rs.last_opened_at, p.created_at) as last_opened_at
from public.passages p
left join public.reading_state rs
  on rs.passage_id = p.id and rs.user_id = auth.uid();
