/**
 * Frontend client for the vault routes on Mike's backend.
 * Mirrors backend/src/routes/vault.ts.
 *
 * Vault docs never reach the cloud LLM (gated server-side in
 * buildDocContext / buildProjectDocContext); these endpoints are the
 * UI surface for managing them.
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
    if (!r.ok) {
        const detail = await r.text();
        throw new Error(detail || `API error: ${r.status}`);
    }
    if (
        r.status === 204 ||
        r.headers.get("content-length") === "0"
    ) {
        return undefined as T;
    }
    return (await r.json()) as T;
}

export interface VaultDocument {
    id: string;
    filename: string;
    file_type: string | null;
    size_bytes: number;
    page_count: number | null;
    ocr_status: "pending" | "skipped" | "done" | "failed" | null;
    ocr_text_layer_present: boolean | null;
    confidentiality: "vault" | "shared" | "template";
    status: string;
    created_at: string;
    updated_at: string;
}

export interface FillTemplateResponse {
    template_document_id: string;
    filled_version_id: string | null;
    slot_values: Record<string, string | null>;
    unresolved_slots: string[];
    sources_used: string[];
    executed_on: "macbook" | "macmini";
    latency_ms: number;
    model: string;
    filled_text: string;
}

export async function listVaultDocuments(): Promise<VaultDocument[]> {
    return api<VaultDocument[]>("/vault/documents");
}

export async function uploadVaultDocument(file: File): Promise<VaultDocument> {
    const authHeaders = await getAuthHeader();
    const form = new FormData();
    form.append("file", file);
    const r = await fetch(`${API_BASE}/vault/documents`, {
        method: "POST",
        headers: { ...authHeaders },
        body: form,
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json() as Promise<VaultDocument>;
}

export async function deleteVaultDocument(documentId: string): Promise<void> {
    await api(`/vault/documents/${documentId}`, { method: "DELETE" });
}

export async function getVaultDocumentUrl(
    documentId: string,
): Promise<{ url: string; filename: string }> {
    return api(`/vault/documents/${documentId}/url`);
}

export async function setDocumentConfidentiality(
    documentId: string,
    level: "vault" | "shared" | "template",
): Promise<{ ok: true; confidentiality: string }> {
    return api(`/vault/documents/${documentId}/confidentiality`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level }),
    });
}

export async function fillTemplate(payload: {
    templateDocumentId: string;
    sourceDocumentIds?: string[];
    clientProfileIds?: string[];
    slotsSchema?: Record<string, { type?: string; role?: string; hint?: string }>;
}): Promise<FillTemplateResponse> {
    return api<FillTemplateResponse>("/vault/fill-template", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            template_document_id: payload.templateDocumentId,
            source_document_ids: payload.sourceDocumentIds ?? [],
            client_profile_ids: payload.clientProfileIds ?? [],
            slots_schema: payload.slotsSchema,
        }),
    });
}
