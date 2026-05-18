/**
 * Shared types for the LDA anonymizer integration.
 *
 * Mirrors the JSON envelopes produced by the LDA sidecar (lda_server.py).
 * Keep this file aligned with the Pydantic models there.
 */

export type AnonymizerTarget = "auto" | "local" | "macmini";
export type ExecutedOn = "macbook" | "macmini";

export interface ScanEntity {
    text: string;
    type: string;
    canonical: string;
}

export interface ScanResult {
    entityCount: number;
    entities: ScanEntity[];
    typeCounts: Record<string, number>;
}

export interface AnonymizedFile {
    name: string;
    contentType: string;
    bytes: Buffer;
}

export interface MappingEntry {
    value: string;
    type: string;
    aliases: string[];
}

export interface ReplacementLogEntry {
    placeholder: string;
    original_text: string;
    position: number;
    context_before: string;
    context_after: string;
}

export interface AnonymizationMapping {
    metadata: {
        created_at: string;
        source_files?: string[];
        job_id?: string;
        entity_count: number;
        excluded_types: string[];
    };
    mappings: Record<string, MappingEntry>;
    replacement_log_per_doc?: Record<string, ReplacementLogEntry[]>;
    replacement_log?: ReplacementLogEntry[];
}

export interface AnonymizeResult {
    jobId: string;
    entityCount: number;
    latencyMs: number;
    format: string;
    anonymizedFiles: AnonymizedFile[];
    mapping: AnonymizationMapping;
    executedOn: ExecutedOn;
}

export interface DeanonymizeResult {
    bytes: Buffer;
    contentType: string;
    filename: string;
    stats: {
        position_matched: number;
        context_matched: number;
        fallback_count: number;
        remaining_placeholders: number;
        total_in_log: number;
    };
    executedOn: ExecutedOn;
}

export interface HealthReport {
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

export interface RoutingHealth {
    macbook: HealthReport;
    macmini: HealthReport;
    chosenWhenAuto: ExecutedOn | null;
}
