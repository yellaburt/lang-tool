-- Per-passage chunking mode.
--
-- 'prose' (default) splits on sentence-ending punctuation and batches ~2
-- sentences per chunk-and-gloss call. 'lyrics' splits on newlines and sends
-- one line per call, preserving blank-line stanza breaks via the
-- preceded_by_blank_line flag stored inside each chunk's JSONB record.
--
-- Existing rows inherit 'prose'. The column is set at INSERT time and is not
-- intended to change later — chunkingMode is a user choice at paste time
-- that determines how the rest of the chunks for the passage are produced.

alter table public.passages
  add column if not exists chunking_mode text not null default 'prose';

alter table public.passages
  drop constraint if exists passages_chunking_mode_check;
alter table public.passages
  add constraint passages_chunking_mode_check
  check (chunking_mode in ('prose', 'lyrics'));
