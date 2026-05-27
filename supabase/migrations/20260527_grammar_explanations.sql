-- Grammar explanations cache + per-user history.
--
-- Mirror of the word-lookup pair (public.word_lookups +
-- public.word_lookup_events). The explain-grammar Edge Function reads/writes
-- the cache and inserts an event on every tap (cache hit or miss), so the
-- per-user history captures usage even when no fresh model call happens.
--
-- Cache key is (spanish_text, english_gloss, language). english_gloss is
-- part of the key because the same Spanish sentence under a different gloss
-- can warrant slightly different framing in the explanation. Cross-passage
-- cache hits will be rare; in-passage re-taps will hit reliably. Haiku is
-- cheap so this is fine.

create table if not exists public.grammar_explanations (
  id uuid primary key default gen_random_uuid(),
  spanish_text text not null,
  english_gloss text not null,
  language text not null default 'es',
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create unique index if not exists grammar_explanations_key_idx
  on public.grammar_explanations (spanish_text, english_gloss, language);

alter table public.grammar_explanations enable row level security;

create policy "Authenticated users can read grammar explanations"
  on public.grammar_explanations
  for select
  to authenticated
  using (true);

create policy "Authenticated users can insert grammar explanations"
  on public.grammar_explanations
  for insert
  to authenticated
  with check (true);

-- Per-user history. chunk_id is nullable + no FK so events survive chunk
-- deletion (we may want to resurface "you looked this up before" even after
-- the source passage is gone).
create table if not exists public.grammar_explanation_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  spanish_text text not null,
  english_gloss text not null,
  passage_id uuid references public.passages(id) on delete set null,
  chunk_id uuid,
  language text not null default 'es',
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists grammar_explanation_events_user_time_idx
  on public.grammar_explanation_events (user_id, created_at desc);

alter table public.grammar_explanation_events enable row level security;

create policy "Users see their own grammar events"
  on public.grammar_explanation_events
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users insert their own grammar events"
  on public.grammar_explanation_events
  for insert
  to authenticated
  with check (auth.uid() = user_id);
