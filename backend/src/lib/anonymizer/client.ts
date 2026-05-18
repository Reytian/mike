/**
 * HTTP client for the LDA sidecar.
 *
 * One instance per endpoint (macbook / macmini). The client does not know
 * about routing — it just sends the request and surfaces a typed result.
 * See routing.ts for the auto-fallback decision tree.
 */

import type {
    AnonymizationMapping,
    AnonymizeResult,
    AnonymizedFile,
    DeanonymizeResult,
    ExecutedOn,
    HealthReport,
    ScanResult,
} from "./types";
import { getAnonymizerConfig, type AnonymizerEndpoint } from "./config";

interface SidecarHealthRaw {
    status: string;
    backend: string;
    model: string;
    ollama_reachable: boolean;
    model_loaded: boolean;
    pandoc: boolean;
    pdftotext: boolean;
}

interface SidecarScanRaw {
    entity_count: number;
    entities: { text: string; type: string; canonical: string }[];
    type_counts: Record<string, number>;
}

interface SidecarAnonymizeRaw {
    job_id: string;
    entity_count: number;
    latency_ms: number;
    format: string;
    anonymized_files: { name: string; content_type: string; content_b64: string }[];
    mapping: AnonymizationMapping;
}

function authHeader(): Record<string, string> {
    const token = getAnonymizerConfig().authToken;
    return token ? { Authorization: `Bearer ${token}` } : {};
}

function endpointToExecutedOn(name: AnonymizerEndpoint["name"]): ExecutedOn {
    return name === "macbook" ? "macbook" : "macmini";
}

export class AnonymizerHttpError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly endpoint: AnonymizerEndpoint,
    ) {
        super(message);
        this.name = "AnonymizerHttpError";
    }
}

/** GET /health on a single endpoint. Times out per config. */
export async function checkHealth(
    endpoint: AnonymizerEndpoint,
): Promise<HealthReport> {
    const { healthTimeoutMs } = getAnonymizerConfig();
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), healthTimeoutMs);
    try {
        const r = await fetch(`${endpoint.url}/health`, {
            method: "GET",
            signal: controller.signal,
        });
        clearTimeout(timer);
        const latencyMs = Date.now() - started;
        if (!r.ok) {
            return {
                status: "unreachable",
                latencyMs,
                error: `HTTP ${r.status}`,
            };
        }
        const data = (await r.json()) as SidecarHealthRaw;
        const ok = data.status === "ok";
        return {
            status: ok ? "ok" : "degraded",
            backend: data.backend,
            model: data.model,
            ollamaReachable: data.ollama_reachable,
            modelLoaded: data.model_loaded,
            pandoc: data.pandoc,
            pdftotext: data.pdftotext,
            latencyMs,
        };
    } catch (err: unknown) {
        clearTimeout(timer);
        const msg = err instanceof Error ? err.message : String(err);
        return {
            status: "unreachable",
            latencyMs: Date.now() - started,
            error: msg,
        };
    }
}

/** POST /scan — regex-only, no LLM call. Fast. */
export async function scan(
    endpoint: AnonymizerEndpoint,
    text: string,
): Promise<ScanResult> {
    const r = await fetch(`${endpoint.url}/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify({ text }),
    });
    if (!r.ok) {
        throw new AnonymizerHttpError(
            `scan failed on ${endpoint.name}: HTTP ${r.status}`,
            r.status,
            endpoint,
        );
    }
    const data = (await r.json()) as SidecarScanRaw;
    return {
        entityCount: data.entity_count,
        entities: data.entities,
        typeCounts: data.type_counts,
    };
}

/**
 * POST /anonymize — multipart upload of one or more files.
 * The sidecar's Pass-1 + Pass-2 LLM calls can take ~10s on Mac Mini /
 * gemma4-v4 and 30-120s on MacBook / qwen3:4b. The fetch has no client-side
 * timeout; the route layer is responsible for its own timeout policy.
 */
export async function anonymize(
    endpoint: AnonymizerEndpoint,
    files: { filename: string; bytes: Buffer; contentType?: string }[],
    options: {
        format?: "md" | "txt" | "docx";
        jobId?: string;
        excludeTypes?: string[];
    } = {},
): Promise<AnonymizeResult> {
    if (files.length === 0) {
        throw new Error("anonymize: at least one file required");
    }
    const form = new FormData();
    for (const f of files) {
        form.append(
            "files",
            // Node's undici Blob accepts (parts, options); cast via ArrayBuffer
            // because Blob's BufferSource types don't include Node Buffer.
            new Blob([new Uint8Array(f.bytes)], {
                type:
                    f.contentType ?? "application/octet-stream",
            }),
            f.filename,
        );
    }
    form.append("format", options.format ?? "md");
    if (options.jobId) form.append("job_id", options.jobId);
    if (options.excludeTypes && options.excludeTypes.length > 0) {
        form.append("exclude_types", options.excludeTypes.join(","));
    }

    const r = await fetch(`${endpoint.url}/anonymize`, {
        method: "POST",
        headers: { ...authHeader() },
        body: form,
    });
    if (!r.ok) {
        const detail = await r.text().catch(() => "");
        throw new AnonymizerHttpError(
            `anonymize failed on ${endpoint.name}: HTTP ${r.status}: ${detail.slice(0, 200)}`,
            r.status,
            endpoint,
        );
    }
    const data = (await r.json()) as SidecarAnonymizeRaw;

    const decoded: AnonymizedFile[] = data.anonymized_files.map((f) => ({
        name: f.name,
        contentType: f.content_type,
        bytes: Buffer.from(f.content_b64, "base64"),
    }));

    return {
        jobId: data.job_id,
        entityCount: data.entity_count,
        latencyMs: data.latency_ms,
        format: data.format,
        anonymizedFiles: decoded,
        mapping: data.mapping,
        executedOn: endpointToExecutedOn(endpoint.name),
    };
}

/**
 * POST /deanonymize — multipart of the edited file + mapping JSON.
 * Returns the restored bytes; deterministic, no LLM call.
 */
export async function deanonymize(
    endpoint: AnonymizerEndpoint,
    editedFile: { filename: string; bytes: Buffer; contentType?: string },
    mapping: AnonymizationMapping,
    options: {
        referenceDocx?: { filename: string; bytes: Buffer };
        targetFormat?: "md" | "txt" | "docx";
    } = {},
): Promise<DeanonymizeResult> {
    const form = new FormData();
    form.append(
        "edited_file",
        new Blob([new Uint8Array(editedFile.bytes)], {
            type: editedFile.contentType ?? "application/octet-stream",
        }),
        editedFile.filename,
    );
    form.append(
        "mapping_json",
        new Blob([JSON.stringify(mapping)], { type: "application/json" }),
        "mapping.json",
    );
    if (options.referenceDocx) {
        form.append(
            "reference_docx",
            new Blob([new Uint8Array(options.referenceDocx.bytes)], {
                type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            }),
            options.referenceDocx.filename,
        );
    }
    if (options.targetFormat) form.append("target_format", options.targetFormat);

    const r = await fetch(`${endpoint.url}/deanonymize`, {
        method: "POST",
        headers: { ...authHeader() },
        body: form,
    });
    if (!r.ok) {
        const detail = await r.text().catch(() => "");
        throw new AnonymizerHttpError(
            `deanonymize failed on ${endpoint.name}: HTTP ${r.status}: ${detail.slice(0, 200)}`,
            r.status,
            endpoint,
        );
    }
    const contentType = r.headers.get("content-type") ?? "application/octet-stream";
    const disposition = r.headers.get("content-disposition") ?? "";
    const filename =
        /filename="([^"]+)"/.exec(disposition)?.[1] ?? `${editedFile.filename}.restored`;
    const statsHeader = r.headers.get("x-lda-stats");
    const stats = statsHeader
        ? (JSON.parse(statsHeader) as DeanonymizeResult["stats"])
        : {
              position_matched: 0,
              context_matched: 0,
              fallback_count: 0,
              remaining_placeholders: 0,
              total_in_log: 0,
          };
    const bytes = Buffer.from(await r.arrayBuffer());
    return {
        bytes,
        contentType,
        filename,
        stats,
        executedOn: endpointToExecutedOn(endpoint.name),
    };
}
