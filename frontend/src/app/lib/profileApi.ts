/**
 * Frontend client for the client_profiles routes under /vault/profiles.
 *
 * A profile is the structured representation of a single client/entity,
 * extracted once from vault docs (registration cert, articles, etc.)
 * then edited for accuracy and reused for every subsequent template-fill.
 */

import { supabase } from "@/lib/supabase";

const API_BASE =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

async function getAuthHeader(): Promise<Record<string, string>> {
    const {
        data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) return {};
    return { Authorization: `Bearer ${session.access_token}` };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const authHeaders = await getAuthHeader();
    const { headers: initHeaders, ...rest } = init ?? {};
    const r = await fetch(`${API_BASE}${path}`, {
        cache: "no-store",
        ...rest,
        headers: {
            Accept: "application/json",
            ...authHeaders,
            ...(initHeaders as Record<string, string> | undefined),
        },
    });
    if (!r.ok) throw new Error((await r.text()) || `API error: ${r.status}`);
    if (r.status === 204 || r.headers.get("content-length") === "0") {
        return undefined as T;
    }
    return (await r.json()) as T;
}

export interface ProfileData {
    name: string | null;
    name_zh?: string | null;
    registration_number?: string | null;
    jurisdiction?: string | null;
    entity_type?: string | null;
    registered_office?: string | null;
    date_incorporated?: string | null;
    authorized_capital?: string | null;
    directors?: string[];
    shareholders?: string[];
    officers?: string[];
    business_scope?: string | null;
    tax_id?: string | null;
    additional?: Record<string, unknown>;
}

export interface ClientProfile {
    id: string;
    user_id: string;
    label: string;
    jurisdiction: string | null;
    data: ProfileData;
    source_document_ids: string[];
    notes: string | null;
    created_at: string;
    updated_at: string;
}

export interface ExtractProfileResponse {
    profile: ProfileData;
    sources_used: string[];
    latency_ms: number;
    model: string;
    executed_on: "macbook" | "macmini";
}

export async function listProfiles(): Promise<ClientProfile[]> {
    return api<ClientProfile[]>("/vault/profiles");
}

export async function extractProfileFromDocs(payload: {
    sourceDocumentIds: string[];
    jurisdictionHint?: string;
}): Promise<ExtractProfileResponse> {
    return api<ExtractProfileResponse>("/vault/profiles/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            source_document_ids: payload.sourceDocumentIds,
            jurisdiction_hint: payload.jurisdictionHint,
        }),
    });
}

export async function createProfile(payload: {
    label: string;
    jurisdiction?: string | null;
    data: ProfileData;
    sourceDocumentIds?: string[];
    notes?: string | null;
}): Promise<ClientProfile> {
    return api<ClientProfile>("/vault/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            label: payload.label,
            jurisdiction: payload.jurisdiction ?? null,
            data: payload.data,
            source_document_ids: payload.sourceDocumentIds ?? [],
            notes: payload.notes ?? null,
        }),
    });
}

export async function updateProfile(
    id: string,
    update: Partial<{
        label: string;
        jurisdiction: string | null;
        data: ProfileData;
        sourceDocumentIds: string[];
        notes: string | null;
    }>,
): Promise<ClientProfile> {
    return api<ClientProfile>(`/vault/profiles/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            label: update.label,
            jurisdiction: update.jurisdiction,
            data: update.data,
            source_document_ids: update.sourceDocumentIds,
            notes: update.notes,
        }),
    });
}

export async function deleteProfile(id: string): Promise<void> {
    await api(`/vault/profiles/${id}`, { method: "DELETE" });
}
