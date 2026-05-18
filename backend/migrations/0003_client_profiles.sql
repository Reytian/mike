-- Editable client profiles.
-- Applied 2026-05-18. Idempotent.
--
-- A client_profile is the structured representation of a single client/entity
-- (e.g. "Crescent Pacific Holdings Ltd."). Extracted once from vault docs
-- (registration certificate, articles, etc.), edited by hand for accuracy,
-- then reused for every subsequent template-fill.
--
-- The `data` jsonb holds well-known field keys (name, registration_number,
-- registered_office, directors[], …) plus an `additional` sub-object for
-- jurisdiction-specific extras.
--
-- source_document_ids tracks which vault docs the profile was extracted
-- from. Vault docs deleted later don't cascade — the profile is the source
-- of truth, the docs are evidence.

create table if not exists public.client_profiles (
    id uuid primary key default gen_random_uuid(),
    user_id text not null,
    label text not null,
    jurisdiction text,
    data jsonb not null default '{}'::jsonb,
    source_document_ids uuid[] not null default '{}'::uuid[],
    notes text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists client_profiles_user_idx
    on public.client_profiles(user_id);

-- Direct-client grant hardening (mirrors the existing pattern in schema.sql)
revoke all on public.client_profiles from anon, authenticated;
