/**
 * Routing — pick a sidecar for an anonymize / scan / deanonymize call.
 *
 * Default decision:
 *   target='auto'    -> Mac Mini first (gemma4-v4 higher quality),
 *                       MacBook fallback when Mac Mini is unreachable.
 *   target='macmini' -> force Mac Mini
 *   target='local'   -> force MacBook
 *
 * Health is cached for `healthCacheMs` (default 10s) so we don't ping
 * every request. Cache is per-endpoint.
 */

import {
    anonymize as clientAnonymize,
    checkHealth as clientCheckHealth,
    deanonymize as clientDeanonymize,
    scan as clientScan,
} from "./client";
import { getAnonymizerConfig, type AnonymizerEndpoint } from "./config";
import type {
    AnonymizationMapping,
    AnonymizerTarget,
    AnonymizeResult,
    DeanonymizeResult,
    ExecutedOn,
    HealthReport,
    RoutingHealth,
    ScanResult,
} from "./types";

interface CachedHealth {
    fetchedAt: number;
    report: HealthReport;
}

const healthCache = new Map<string, CachedHealth>();

function isFresh(entry: CachedHealth | undefined, ttlMs: number): boolean {
    if (!entry) return false;
    return Date.now() - entry.fetchedAt < ttlMs;
}

async function getHealth(
    endpoint: AnonymizerEndpoint,
    force = false,
): Promise<HealthReport> {
    const { healthCacheMs } = getAnonymizerConfig();
    const cached = healthCache.get(endpoint.name);
    if (!force && isFresh(cached, healthCacheMs)) return cached!.report;
    const report = await clientCheckHealth(endpoint);
    healthCache.set(endpoint.name, { fetchedAt: Date.now(), report });
    return report;
}

/** Public — return a snapshot of both sidecars' health for the UI badge. */
export async function getRoutingHealth(force = false): Promise<RoutingHealth> {
    const cfg = getAnonymizerConfig();
    const [macbook, macmini] = await Promise.all([
        getHealth(cfg.endpoints.macbook, force),
        getHealth(cfg.endpoints.macmini, force),
    ]);
    const chosen: ExecutedOn | null =
        macmini.status === "ok"
            ? "macmini"
            : macbook.status === "ok"
              ? "macbook"
              : null;
    return { macbook, macmini, chosenWhenAuto: chosen };
}

/** Test-only — clear the health cache. */
export function _clearHealthCache(): void {
    healthCache.clear();
}

export class AnonymizerUnavailableError extends Error {
    constructor(
        message: string,
        readonly attempted: ExecutedOn[],
        readonly health: RoutingHealth,
    ) {
        super(message);
        this.name = "AnonymizerUnavailableError";
    }
}

interface ResolvedRoute {
    primary: AnonymizerEndpoint;
    fallback: AnonymizerEndpoint | null;
}

async function resolveRoute(target: AnonymizerTarget): Promise<ResolvedRoute> {
    const cfg = getAnonymizerConfig();
    if (target === "local") {
        return { primary: cfg.endpoints.macbook, fallback: null };
    }
    if (target === "macmini") {
        return { primary: cfg.endpoints.macmini, fallback: null };
    }
    // auto: Mac Mini first, MacBook fallback. Pre-check health to skip
    // a dead Mac Mini without paying the LLM-call timeout.
    const macminiHealth = await getHealth(cfg.endpoints.macmini);
    if (macminiHealth.status === "ok") {
        return {
            primary: cfg.endpoints.macmini,
            fallback: cfg.endpoints.macbook,
        };
    }
    return { primary: cfg.endpoints.macbook, fallback: null };
}

async function runWithFallback<T>(
    target: AnonymizerTarget,
    op: (endpoint: AnonymizerEndpoint) => Promise<T>,
): Promise<T> {
    const cfg = getAnonymizerConfig();
    if (cfg.disabled) {
        throw new AnonymizerUnavailableError(
            "anonymizer disabled via LDA_DISABLED env",
            [],
            await getRoutingHealth(),
        );
    }
    const route = await resolveRoute(target);
    const attempted: ExecutedOn[] = [];
    try {
        attempted.push(route.primary.name);
        return await op(route.primary);
    } catch (err) {
        if (!route.fallback) {
            const health = await getRoutingHealth(true);
            throw new AnonymizerUnavailableError(
                `LDA sidecar (${route.primary.name}) failed: ${(err as Error).message}`,
                attempted,
                health,
            );
        }
        // Invalidate the primary's health so subsequent calls skip it.
        healthCache.set(route.primary.name, {
            fetchedAt: Date.now(),
            report: {
                status: "unreachable",
                error: (err as Error).message,
            },
        });
        try {
            attempted.push(route.fallback.name);
            return await op(route.fallback);
        } catch (err2) {
            const health = await getRoutingHealth(true);
            throw new AnonymizerUnavailableError(
                `LDA sidecar fallback also failed: ${(err2 as Error).message}`,
                attempted,
                health,
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function routedScan(
    text: string,
    target: AnonymizerTarget = "auto",
): Promise<{ result: ScanResult; executedOn: ExecutedOn }> {
    return runWithFallback(target, async (endpoint) => ({
        result: await clientScan(endpoint, text),
        executedOn: endpoint.name === "macbook" ? "macbook" : "macmini",
    }));
}

export async function routedAnonymize(
    files: { filename: string; bytes: Buffer; contentType?: string }[],
    options: {
        target?: AnonymizerTarget;
        format?: "md" | "txt" | "docx";
        jobId?: string;
        excludeTypes?: string[];
    } = {},
): Promise<AnonymizeResult> {
    const target = options.target ?? "auto";
    return runWithFallback(target, (endpoint) =>
        clientAnonymize(endpoint, files, {
            format: options.format,
            jobId: options.jobId,
            excludeTypes: options.excludeTypes,
        }),
    );
}

export async function routedDeanonymize(
    editedFile: { filename: string; bytes: Buffer; contentType?: string },
    mapping: AnonymizationMapping,
    options: {
        target?: AnonymizerTarget;
        referenceDocx?: { filename: string; bytes: Buffer };
        targetFormat?: "md" | "txt" | "docx";
    } = {},
): Promise<DeanonymizeResult> {
    const target = options.target ?? "auto";
    return runWithFallback(target, (endpoint) =>
        clientDeanonymize(endpoint, editedFile, mapping, {
            referenceDocx: options.referenceDocx,
            targetFormat: options.targetFormat,
        }),
    );
}
