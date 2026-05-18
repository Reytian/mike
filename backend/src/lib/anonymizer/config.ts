/**
 * Anonymizer config — read sidecar URLs and auth token from env.
 *
 * Env vars (all optional with sensible local-dev defaults):
 *
 *   LDA_MACBOOK_URL   default http://127.0.0.1:7100
 *   LDA_MACMINI_URL   default http://ClapTraps-Mac-mini.local:7100
 *   LDA_AUTH_TOKEN    bearer token, must match the sidecar's LDA_AUTH_TOKEN.
 *                     Empty = no auth (only safe on localhost / trusted LAN).
 *   LDA_HEALTH_TIMEOUT_MS  default 400 (LAN budget; localhost is much faster)
 *   LDA_HEALTH_CACHE_MS    default 10000 (10s, matches plan)
 *   LDA_DISABLED       if "true", every anonymizer call returns a 503-style
 *                      error envelope. Used in test/CI environments.
 */

export interface AnonymizerEndpoint {
    name: "macbook" | "macmini";
    url: string;
}

export interface AnonymizerConfig {
    endpoints: {
        macbook: AnonymizerEndpoint;
        macmini: AnonymizerEndpoint;
    };
    authToken: string;
    healthTimeoutMs: number;
    healthCacheMs: number;
    disabled: boolean;
}

function stripTrailingSlash(s: string): string {
    return s.replace(/\/+$/, "");
}

function envInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

let cached: AnonymizerConfig | null = null;

export function getAnonymizerConfig(): AnonymizerConfig {
    if (cached) return cached;
    cached = {
        endpoints: {
            macbook: {
                name: "macbook",
                url: stripTrailingSlash(
                    process.env.LDA_MACBOOK_URL ?? "http://127.0.0.1:7100",
                ),
            },
            macmini: {
                name: "macmini",
                url: stripTrailingSlash(
                    process.env.LDA_MACMINI_URL ??
                        "http://ClapTraps-Mac-mini.local:7100",
                ),
            },
        },
        authToken: process.env.LDA_AUTH_TOKEN ?? "",
        healthTimeoutMs: envInt("LDA_HEALTH_TIMEOUT_MS", 400),
        healthCacheMs: envInt("LDA_HEALTH_CACHE_MS", 10_000),
        disabled:
            (process.env.LDA_DISABLED ?? "").toLowerCase() === "true",
    };
    return cached;
}

/** Test-only — clear the memoized config. */
export function _resetAnonymizerConfig(): void {
    cached = null;
}
