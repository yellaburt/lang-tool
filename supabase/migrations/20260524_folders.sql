-- Folders + sub-folders for the library.
--
-- Two nullable text columns on passages, kept deliberately simple:
--   folder    NULL  → passage is top-level (no folder)
--   subfolder NULL  → passage is directly in `folder` (or root if folder is
--                     also null)
-- Constraint: subfolder cannot be set without folder. We're not using a
-- separate folders table because (a) folders are implicit — they exist iff a
-- passage references them, (b) two levels max is enough for a personal
-- library, and (c) renaming a folder is just an UPDATE.

alter table public.passages
  add column if not exists folder text,
  add column if not exists subfolder text;

alter table public.passages
  drop constraint if exists subfolder_requires_folder;
alter table public.passages
  add constraint subfolder_requires_folder
  check (subfolder is null or folder is not null);

create index if not exists passages_owner_folder_idx
  on public.passages (owner_id, folder, subfolder);
