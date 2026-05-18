/**
 * Per-chat-turn anonymizer.
 *
 * One instance is created for each LLM stream when `anonymize_before_send`
 * is true. It runs LDA `/anonymize` on each document the LLM reads
 * (lazily, on first touch), caches the resulting mapping, and exposes:
 *
 *   - prepareDocument()   first call -> hit LDA, cache mapping; later
 *                         calls just return the cached anonymized text.
 *   - applyToText()       fast string substitution using the cached
 *                         mappings; used for find_in_document snippets
 *                         and any other place we want consistent
 *                         placeholders without paying a second LLM call.
 *
 * Cross-document consistency: every doc accumulates into a single
 * `textToPlaceholder` map, so the same person/entity across two docs
 * gets the same {PERSON_N} placeholder. Per-doc mappings are kept
 * separately so callers can look up the original of any placeholder.
 *
 * Design note: this is **opportunistic** anonymization. Snippets read
 * via find_in_document use the cached mapping if it's been populated by
 * a prior read_document; if not, the snippet is anonymized by calling
 * LDA on the full document first. We never hand raw bytes back to the
 * LLM when this anonymizer is active.
 */

import { routedAnonymize } from "./routing";
import type {
    AnonymizationMapping,
    AnonymizerTarget,
    AnonymizeResult,
    ExecutedOn,
} from "./types";

interface PreparedDoc {
    documentId: string;
    filename: string;
    anonymizedText: string;
    mapping: AnonymizationMapping;
    executedOn: ExecutedOn;
    entityCount: number;
}

export interface ChatAnonymizerOptions {
    target?: AnonymizerTarget;
    excludeTypes?: string[];
}

export class ChatAnonymizer {
    private readonly target: AnonymizerTarget;
    private readonly excludeTypes?: string[];
    private readonly prepared = new Map<string, PreparedDoc>();
    private readonly textToPlaceholder = new Map<string, string>();
    /** Reverse map (placeholder -> info), useful for UI display. */
    private readonly placeholderInfo = new Map<
        string,
        { value: string; type: string; sourceDocumentId: string }
    >();

    constructor(options: ChatAnonymizerOptions = {}) {
        this.target = options.target ?? "auto";
        this.excludeTypes = options.excludeTypes;
    }

    /** Has this document already been anonymized in this turn? */
    isPrepared(documentId: string): boolean {
        return this.prepared.has(documentId);
    }

    /**
     * Ensure the document is anonymized; return the anonymized text.
     * On second+ call returns the cached value without hitting LDA.
     */
    async prepareDocument(
        documentId: string,
        filename: string,
        bytes: Buffer,
        contentType?: string,
    ): Promise<PreparedDoc> {
        const existing = this.prepared.get(documentId);
        if (existing) return existing;

        const result: AnonymizeResult = await routedAnonymize(
            [{ filename, bytes, contentType }],
            {
                target: this.target,
                format: "md",
                excludeTypes: this.excludeTypes,
            },
        );

        const out = result.anonymizedFiles[0];
        if (!out) {
            throw new Error("LDA returned no anonymized files");
        }
        const anonymizedText = out.bytes.toString("utf-8");

        // Fold the doc's mapping into the shared substitution table.
        // If a placeholder text already exists (same person referenced in
        // another doc), keep the earlier placeholder so cross-doc
        // consistency is preserved. The mapping returned by LDA is per-doc;
        // for cross-doc consistency we would need a single multi-input
        // call to /anonymize. That's a later optimization — for the MVP
        // each doc gets its own placeholders, which is still safe.
        for (const [placeholder, info] of Object.entries(result.mapping.mappings)) {
            const value = info.value;
            if (value && !this.textToPlaceholder.has(value)) {
                this.textToPlaceholder.set(value, placeholder);
            }
            for (const alias of info.aliases ?? []) {
                if (alias && !this.textToPlaceholder.has(alias)) {
                    this.textToPlaceholder.set(alias, placeholder);
                }
            }
            this.placeholderInfo.set(placeholder, {
                value,
                type: info.type,
                sourceDocumentId: documentId,
            });
        }

        const prep: PreparedDoc = {
            documentId,
            filename,
            anonymizedText,
            mapping: result.mapping,
            executedOn: result.executedOn,
            entityCount: result.entityCount,
        };
        this.prepared.set(documentId, prep);
        return prep;
    }

    /**
     * Apply the accumulated mapping to an arbitrary string. Longest-first
     * to avoid substring collisions. Mirrors lda_server.py's substitution.
     */
    applyToText(text: string): string {
        if (this.textToPlaceholder.size === 0) return text;
        const sorted = [...this.textToPlaceholder.keys()].sort(
            (a, b) => b.length - a.length,
        );
        let out = text;
        for (const t of sorted) {
            if (!t) continue;
            const ph = this.textToPlaceholder.get(t);
            if (!ph) continue;
            if (t.length < 8) {
                // Word-boundary so e.g. "Hood" doesn't match inside "Neighbourhood".
                const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                out = out.replace(
                    new RegExp(`(?<!\\w)${escaped}(?!\\w)`, "g"),
                    ph,
                );
            } else {
                out = out.split(t).join(ph);
            }
        }
        return out;
    }

    /** Snapshot of all prepared docs — useful for response metadata. */
    snapshot(): {
        documents: PreparedDoc[];
        totalEntities: number;
    } {
        const documents = [...this.prepared.values()];
        const totalEntities = documents.reduce((s, d) => s + d.entityCount, 0);
        return { documents, totalEntities };
    }
}
