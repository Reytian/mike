-- Vault + template support.
-- Applied 2026-05-18. Idempotent.
--
-- documents.confidentiality
--   'shared' (default) — visible to chat tools, eligible for cloud LLM context
--   'vault'            — local-only; buildDocContext + every chat tool skips
--                        these. The cloud LLM never learns vault docs exist.
--   'template'         — empty form / contract template. Visible to chat as
--                        a regular doc, but flagged so the UI can offer
--                        "Fill from vault" actions.
--
-- documents.ocr_status / ocr_text_layer_present
--   Set by the upload pipeline. If a PDF arrives without a text layer, the
--   backend runs OCR (LDA sidecar /ocr) and writes the OCRed bytes back
--   into the same storage_path. ocr_status tracks the run for UI display.

alter table public.documents
  add column if not exists confidentiality text not null default 'shared';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'documents_confidentiality_check'
  ) then
    alter table public.documents
      add constraint documents_confidentiality_check
      check (confidentiality = any (array[
        'shared'::text,
        'vault'::text,
        'template'::text
      ]));
  end if;
end;
$$;

alter table public.documents
  add column if not exists ocr_status text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'documents_ocr_status_check'
  ) then
    alter table public.documents
      add constraint documents_ocr_status_check
      check (ocr_status is null or ocr_status = any (array[
        'pending'::text,
        'skipped'::text,
        'done'::text,
        'failed'::text
      ]));
  end if;
end;
$$;

alter table public.documents
  add column if not exists ocr_text_layer_present boolean;

create index if not exists documents_confidentiality_idx
  on public.documents(user_id, confidentiality);
