-- Anonymization columns on document_versions.
-- Applied 2026-05-18. Idempotent.
--
-- Adds two new source values ('anonymized', 'deanonymized') plus the link from
-- an anonymized version back to its source version and the R2 storage key for
-- the placeholder mapping JSON. entity_count and model_used are diagnostic.
--
-- mapping_storage_key stores the LDA mapping.json output that bridges
-- placeholders back to real names. It MUST never be sent to a cloud LLM —
-- only Mike's backend reads it (for the /deanonymize endpoint, and for the
-- chat / tabular auto-anonymize wrap when those land).

alter table public.document_versions
  drop constraint if exists document_versions_source_check;

alter table public.document_versions
  add constraint document_versions_source_check
  check (source = any (array[
    'upload'::text,
    'user_upload'::text,
    'assistant_edit'::text,
    'user_accept'::text,
    'user_reject'::text,
    'generated'::text,
    'anonymized'::text,
    'deanonymized'::text
  ]));

alter table public.document_versions
  add column if not exists source_version_id uuid
    references public.document_versions(id) on delete set null;

alter table public.document_versions
  add column if not exists mapping_storage_key text;

alter table public.document_versions
  add column if not exists entity_count integer;

alter table public.document_versions
  add column if not exists model_used text;

create index if not exists document_versions_source_version_idx
  on public.document_versions(source_version_id);
