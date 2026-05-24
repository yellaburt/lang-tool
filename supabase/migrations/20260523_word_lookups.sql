-- Word lookup cache.
--
-- Stores contextual word definitions returned by the define-word Edge
-- Function so that re-tapping the same word in the same chunk (by anyone)
-- is instant and free. Cache is shared across all users — there's nothing
-- user-specific about the definition of a Spanish word in a given chunk.
--
-- Cache key is (word, chunk_text, language). chunk_text is included
-- because the same word can mean different things in different contexts
-- ("banco" = bank or bench).

create table if not exists public.word_lookups (
  id uuid primary key default gen_random_uuid(),
  word text not null,
  chunk_text text not null,
  language text not null default 'es',
  definition jsonb not null,
  created_at timestamptz not null default now()
);

-- Unique index = cache key. The Edge Function uses ON CONFLICT DO NOTHING
-- on insert; reads are by exact match.
create unique index if not exists word_lookups_key_idx
  on public.word_lookups (word, chunk_text, language);

-- RLS: any signed-in user can read or write the cache. The data is
-- non-sensitive (just dictionary entries) and shared across all users.
alter table public.word_lookups enable row level security;

create policy "Authenticated users can read word lookups"
  on public.word_lookups
  for select
  to authenticated
  using (true);

create policy "Authenticated users can insert word lookups"
  on public.word_lookups
  for insert
  to authenticated
  with check (true);
