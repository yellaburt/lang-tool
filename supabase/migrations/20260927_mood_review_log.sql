-- Mood review log: model-vs-lexicon disagreements on subjunctive forms.
--
-- The chunk-and-gloss pipeline treats a deterministic conjugation lexicon
-- (supabase/functions/_shared/subjunctive.ts) as the authority on mood and
-- tense. When the model's reading disagrees — it tagged a form the lexicon
-- says isn't subjunctive (vetoed), or left untagged a form the lexicon is
-- sure is — the disagreement is written here rather than silently resolved.
-- Recurring disagreement on one lemma means that lexicon entry needs an audit
-- (a false veto from a bad entry shows up here too).
--
-- Written by the client after the chunk has an id (chunk ids are assigned
-- client-side), so chunk_id is always set for rows from v6 onward.
--
-- Prefix checked against existing migrations (latest was 20260602) — a
-- duplicate prefix previously caused silent persistence failures.

create table if not exists public.mood_review_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  passage_id uuid references public.passages(id) on delete set null,
  chunk_id uuid,
  chunk_text text not null,
  lemma text not null,
  token text not null,
  lexicon_answer text not null,
  model_answer text not null,
  prompt_version text not null,
  created_at timestamptz not null default now()
);

-- Auditing groups by lemma.
create index if not exists mood_review_log_lemma_idx
  on public.mood_review_log (lemma, created_at desc);

alter table public.mood_review_log enable row level security;

create policy "Users see their own mood review rows"
  on public.mood_review_log
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users insert their own mood review rows"
  on public.mood_review_log
  for insert
  to authenticated
  with check (auth.uid() = user_id);
