-- Per-user word lookup history.
--
-- Distinct from public.word_lookups, which is a SHARED cache keyed on
-- (word, chunk_text, language). This table tracks WHO looked up what,
-- WHERE (passage + chunk), and WHEN — so we can later build an SRS-style
-- review surface that resurfaces previously-looked-up words.
--
-- We keep the definition jsonb here too (not just a reference to
-- word_lookups) so the review UI can render an event without joining
-- against the cache, and so the event survives a cache eviction.

create table if not exists public.word_lookup_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  word text not null,
  chunk_text text not null,
  passage_id uuid references public.passages(id) on delete set null,
  chunk_id uuid,
  language text not null default 'es',
  definition jsonb not null,
  created_at timestamptz not null default now()
);

-- Query by user + recency for review surfaces.
create index if not exists word_lookup_events_user_time_idx
  on public.word_lookup_events (user_id, created_at desc);

alter table public.word_lookup_events enable row level security;

create policy "Users see their own lookup events"
  on public.word_lookup_events
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users insert their own lookup events"
  on public.word_lookup_events
  for insert
  to authenticated
  with check (auth.uid() = user_id);
