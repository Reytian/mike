/**
 * Frontend client for the LDA anonymizer routes on Mike's backend.
 *
 * Mirrors backend/src/routes/anonymize.ts. Auth header attached via the
 * same Supabase session helper used in mikeApi.ts.
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

export type AnonymizerTarget = "auto" | "local" | "macmini";
export type ExecutedOn = "macbook" | "macmini";

export interface SidecarStatus {
    status: "ok" | "degraded" | "unreachable";
    backend?: string;
    model?: string;
    ollamaReachable?: boolean;
    modelLoaded?: boolean;
    pandoc?: boolean;
    pdftotext?: boolean;
    latencyMs?: number;
    error?: string;
}

export interface AnonymizerHealth {
    macbook: SidecarStatus;
    macmini: SidecarStatus;
    chosenWhenAuto: ExecutedOn | null;
}

export interface ScanResult {
    entityCount: number;
    entities: { text: string; type: string; canonical: string }[];
    typeCounts: Record<string, number>;
    executedOn?: ExecutedOn;
}

export interface AnonymizeResult {
    anonymized_version_id: string;
    source_version_id: string;
    entity_count: number;
    latency_ms: number;
    executed_on: ExecutedOn;
    mapping_storage_key: string;
    anonymized_filename: string;
    anonymized_content_type: string;
    display_name: string | null;
    created_at: string;
}

export async function getAnonymizerHealth(): Promise<AnonymizerHealth> {
    return api<AnonymizerHealth>("/anonymizer/health");
}

export async function scanText(
    text: string,
    target: AnonymizerTarget = "auto",
): Promise<ScanResult> {
    return api<ScanResult>("/anonymizer/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, target }),
    });
}

export async function anonymizeDocument(
    documentId: string,
    options: {
        target?: AnonymizerTarget;
        format?: "md" | "txt" | "docx";
        excludeTypes?: string[];
    } = {},
): Promise<AnonymizeResult> {
    return api<AnonymizeResult>(
        `/single-documents/${documentId}/anonymize`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                target: options.target ?? "auto",
                format: options.format ?? "md",
                excludeTypes: options.excludeTypes ?? [],
            }),
        },
    );
}

/**
 * Returns the restored file as a Blob. Caller wraps it in an object URL
 * for download or preview.
 */
export async function deanonymizeVersion(
    documentId: string,
    versionId: string,
    target: AnonymizerTarget = "auto",
): Promise<{ blob: Blob; filename: string; executedOn: ExecutedOn }> {
    const authHeaders = await getAuthHeader();
    const r = await fetch(
        `${API_BASE}/single-documents/${documentId}/versions/${versionId}/deanonymize`,
        {
            method: "POST",
            cache: "no-store",
            headers: {
                "Content-Type": "application/json",
                ...authHeaders,
            },
            body: JSON.stringify({ target }),
        },
    );
    if (!r.ok) {
        const detail = await r.text();
        throw new Error(detail || `deanonymize error: ${r.status}`);
    }
    const disposition = r.headers.get("content-disposition") ?? "";
    const filename =
        /filename="([^"]+)"/.exec(disposition)?.[1] ?? "restored.bin";
    const executedOn = (r.headers.get("x-lda-executed-on") as ExecutedOn) || "macbook";
    const blob = await r.blob();
    return { blob, filename, executedOn };
}
