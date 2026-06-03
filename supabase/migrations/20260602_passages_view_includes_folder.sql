-- Recreate passages_with_state so it actually returns folder / subfolder /
-- chunking_mode.
--
-- The view was created in the initial schema (20260513) as `select p.*, ...`.
-- Postgres expands `*` to a fixed column list AT VIEW-CREATION TIME — it does
-- NOT pick up columns added to the base table afterwards. folder + subfolder
-- (20260524) and chunking_mode (20260528) were all added later, so the view
-- kept returning only the original 10 passage columns.
--
-- Effect: fetchPassages() reads this view, so it never saw folder/subfolder
-- and passageFromRow() coerced them to null. Every library refresh (which
-- fires whenever you navigate back to the library, e.g. after reading a
-- passage) overwrote each passage with a folder=null copy — silently ejecting
-- it from its folder. chunking_mode had the same problem, resetting lyrics
-- passages to 'prose' on reload.
--
-- DROP + CREATE rather than CREATE OR REPLACE: the new columns expand from
-- `p.*` ahead of the trailing reading-state columns, which shifts their output
-- position. CREATE OR REPLACE VIEW only allows new columns to be appended at
-- the end, so it would error here.

drop view if exists public.passages_with_state;

create view public.passages_with_state
with (security_invoker = true) as
select
  p.*,
  coalesce(rs.last_read_chunk_index, 0) as last_read_chunk_index,
  coalesce(rs.last_opened_at, p.created_at) as last_opened_at
from public.passages p
left join public.reading_state rs
  on rs.passage_id = p.id and rs.user_id = auth.uid();
