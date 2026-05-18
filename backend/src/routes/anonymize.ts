/**
 * REST endpoints for document anonymization, exposed to the frontend.
 *
 *   GET  /anonymizer/health
 *        Reports both sidecars' status (used by the UI badge).
 *
 *   POST /anonymizer/scan
 *        Body: { text: string }
 *        Returns the regex-only entity preview. Cheap, no LLM call.
 *
 *   POST /single-documents/:documentId/anonymize
 *        Body: { target?, excludeTypes?, format? }
 *        Loads the document's active version, anonymizes via the routed
 *        sidecar, stores the anonymized bytes + mapping.json as a new
 *        `document_versions` row (`source='anonymized'`).
 *
 *   POST /single-documents/:documentId/versions/:versionId/deanonymize
 *        Loads an anonymized version (must have a mapping_storage_key set)
 *        and returns the restored bytes inline. Caller picks whether to
 *        save the result; for MVP we don't auto-create a deanonymized
 *        version row.
 *
 * Storage layout (R2):
 *   documents/{userId}/{documentId}/anonymized/{versionId}{ext}   ← anonymized file
 *   documents/{userId}/{documentId}/mappings/{versionId}.json     ← mapping.json
 */

import { Router } from "express";
import crypto from "node:crypto";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
    AnonymizerUnavailableError,
    getRoutingHealth,
    routedAnonymize,
    routedDeanonymize,
    routedScan,
} from "../lib/anonymizer/routing";
import type {
    AnonymizationMapping,
    AnonymizerTarget,
} from "../lib/anonymizer/types";
import {
    buildContentDisposition,
    downloadFile,
    storageKey as defaultStorageKey,
    uploadFile,
} from "../lib/storage";
import { ensureDocAccess } from "../lib/access";
import { loadActiveVersion } from "../lib/documentVersions";

export const anonymizeRouter = Router();

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

const TARGETS = new Set<AnonymizerTarget>(["auto", "local", "macmini"]);

function parseTarget(value: unknown): AnonymizerTarget {
    if (typeof value === "string" && TARGETS.has(value as AnonymizerTarget)) {
        return value as AnonymizerTarget;
    }
    return "auto";
}

function parseExcludeTypes(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const clean = value
        .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
        .map((v) => v.trim().toLowerCase());
    return clean.length > 0 ? clean : undefined;
}

function anonymizedStorageKey(
    userId: string,
    docId: string,
    versionId: string,
    ext: string,
): string {
    return `documents/${userId}/${docId}/anonymized/${versionId}${ext}`;
}

function mappingStorageKey(
    userId: string,
    docId: string,
    versionId: string,
): string {
    return `documents/${userId}/${docId}/mappings/${versionId}.json`;
}

function extensionFor(name: string): string {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot).toLowerCase() : ".bin";
}

function ensureSensible(format: unknown): "md" | "txt" | "docx" {
    if (format === "txt" || format === "docx") return format;
    return "md";
}

function bufferToArrayBuffer(buf: Buffer): ArrayBuffer {
    return buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;
}

function unavailable(res: import("express").Response, err: AnonymizerUnavailableError) {
    return void res.status(503).json({
        detail: err.message,
        attempted: err.attempted,
        health: err.health,
    });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /anonymizer/health — for the UI status badge.
anonymizeRouter.get("/anonymizer/health", requireAuth, async (_req, res) => {
    try {
        const report = await getRoutingHealth();
        res.json(report);
    } catch (err) {
        res.status(500).json({
            detail: (err as Error).message,
        });
    }
});

// POST /anonymizer/scan — ad-hoc regex scan of user-supplied text.
anonymizeRouter.post("/anonymizer/scan", requireAuth, async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (!text.trim()) {
        return void res.status(400).json({ detail: "text is required" });
    }
    const target = parseTarget(req.body?.target);
    try {
        const { result, executedOn } = await routedScan(text, target);
        res.json({ ...result, executedOn });
    } catch (err) {
        if (err instanceof AnonymizerUnavailableError) return unavailable(res, err);
        res.status(500).json({ detail: (err as Error).message });
    }
});

// POST /single-documents/:documentId/anonymize
anonymizeRouter.post(
    "/single-documents/:documentId/anonymize",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { documentId } = req.params;
        const db = createServerSupabase();

        const target = parseTarget(req.body?.target);
        const excludeTypes = parseExcludeTypes(req.body?.excludeTypes);
        const format = ensureSensible(req.body?.format);

        const { data: doc } = await db
            .from("documents")
            .select("id, filename, file_type, user_id, project_id")
            .eq("id", documentId)
            .single();
        if (!doc) {
            return void res.status(404).json({ detail: "Document not found" });
        }
        const access = await ensureDocAccess(doc, userId, userEmail, db);
        if (!access.ok) {
            return void res.status(404).json({ detail: "Document not found" });
        }

        const active = await loadActiveVersion(documentId, db);
        if (!active) {
            return void res
                .status(409)
                .json({ detail: "Document has no active version" });
        }

        const sourceBytes = await downloadFile(active.storage_path);
        if (!sourceBytes) {
            return void res
                .status(500)
                .json({ detail: "Could not fetch source bytes from storage" });
        }

        try {
            const filename = (doc.filename as string) ?? `document-${documentId}`;
            const result = await routedAnonymize(
                [
                    {
                        filename,
                        bytes: Buffer.from(sourceBytes),
                        contentType:
                            extensionFor(filename) === ".docx"
                                ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                                : extensionFor(filename) === ".pdf"
                                  ? "application/pdf"
                                  : "text/plain",
                    },
                ],
                { target, excludeTypes, format },
            );

            if (result.anonymizedFiles.length === 0) {
                return void res
                    .status(500)
                    .json({ detail: "Sidecar returned no anonymized files" });
            }
            const out = result.anonymizedFiles[0];
            const versionSlug = crypto.randomUUID().replace(/-/g, "");
            const ext = extensionFor(out.name);
            const anonKey = anonymizedStorageKey(
                doc.user_id as string,
                documentId,
                versionSlug,
                ext,
            );
            const mapKey = mappingStorageKey(
                doc.user_id as string,
                documentId,
                versionSlug,
            );

            await uploadFile(anonKey, bufferToArrayBuffer(out.bytes), out.contentType);
            await uploadFile(
                mapKey,
                bufferToArrayBuffer(Buffer.from(JSON.stringify(result.mapping))),
                "application/json",
            );

            // Pick a sensible version_number — one past the highest
            // existing user-facing version. Same heuristic used by the
            // upload route. Anonymized rows are tracked but not counted as
            // an edit version, so we leave version_number null and rely on
            // display_name + source to render them.
            const { data: versionRow, error: verErr } = await db
                .from("document_versions")
                .insert({
                    document_id: documentId,
                    storage_path: anonKey,
                    pdf_storage_path: null,
                    source: "anonymized",
                    source_version_id: active.id,
                    mapping_storage_key: mapKey,
                    entity_count: result.entityCount,
                    model_used: `${result.executedOn}/${(await getRoutingHealth()).macbook.model ?? "unknown"}`,
                    display_name: `Anonymized (${result.executedOn})`,
                })
                .select(
                    "id, version_number, source, source_version_id, created_at, display_name, entity_count, model_used, mapping_storage_key",
                )
                .single();
            if (verErr || !versionRow) {
                return void res.status(500).json({
                    detail: `Failed to record anonymized version: ${verErr?.message}`,
                });
            }

            res.status(201).json({
                anonymized_version_id: versionRow.id,
                source_version_id: active.id,
                entity_count: result.entityCount,
                latency_ms: result.latencyMs,
                executed_on: result.executedOn,
                mapping_storage_key: mapKey,
                anonymized_filename: out.name,
                anonymized_content_type: out.contentType,
                display_name: versionRow.display_name,
                created_at: versionRow.created_at,
            });
        } catch (err) {
            if (err instanceof AnonymizerUnavailableError) {
                return unavailable(res, err);
            }
            res.status(500).json({ detail: (err as Error).message });
        }
    },
);

// POST /single-documents/:documentId/versions/:versionId/deanonymize
//
// Look up an anonymized version, fetch its mapping, fetch its (possibly
// already-edited) current bytes, and stream back the restored file.
anonymizeRouter.post(
    "/single-documents/:documentId/versions/:versionId/deanonymize",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { documentId, versionId } = req.params;
        const db = createServerSupabase();
        const target = parseTarget(req.body?.target);

        const { data: doc } = await db
            .from("documents")
            .select("id, filename, user_id, project_id")
            .eq("id", documentId)
            .single();
        if (!doc) {
            return void res.status(404).json({ detail: "Document not found" });
        }
        const access = await ensureDocAccess(doc, userId, userEmail, db);
        if (!access.ok) {
            return void res.status(404).json({ detail: "Document not found" });
        }

        // Load the version we're being asked to deanonymize. It may be
        // the anonymized version itself, OR an edit derived from it.
        const { data: editedRow } = await db
            .from("document_versions")
            .select(
                "id, document_id, storage_path, source, source_version_id, mapping_storage_key",
            )
            .eq("id", versionId)
            .single();
        if (!editedRow || editedRow.document_id !== documentId) {
            return void res.status(404).json({ detail: "Version not found" });
        }

        // Walk to the version that carries the mapping. If this row itself
        // is `anonymized`, use it; if it's an `assistant_edit` derived from
        // an anonymized parent, follow source_version_id.
        let mappingKey: string | null =
            (editedRow.mapping_storage_key as string | null) ?? null;
        if (!mappingKey && editedRow.source_version_id) {
            const { data: parent } = await db
                .from("document_versions")
                .select("mapping_storage_key")
                .eq("id", editedRow.source_version_id as string)
                .single();
            mappingKey = (parent?.mapping_storage_key as string | null) ?? null;
        }
        if (!mappingKey) {
            return void res.status(409).json({
                detail:
                    "No mapping available for this version; only anonymized versions (or their direct edits) can be deanonymized.",
            });
        }

        const [editedBytes, mappingBytes] = await Promise.all([
            downloadFile(editedRow.storage_path as string),
            downloadFile(mappingKey),
        ]);
        if (!editedBytes || !mappingBytes) {
            return void res.status(500).json({
                detail: "Could not fetch version bytes or mapping from storage",
            });
        }
        let mapping: AnonymizationMapping;
        try {
            mapping = JSON.parse(
                Buffer.from(mappingBytes).toString("utf-8"),
            ) as AnonymizationMapping;
        } catch (err) {
            return void res.status(500).json({
                detail: `Mapping JSON is corrupt: ${(err as Error).message}`,
            });
        }

        try {
            const restored = await routedDeanonymize(
                {
                    filename: `version-${versionId}${extensionFor(editedRow.storage_path as string)}`,
                    bytes: Buffer.from(editedBytes),
                },
                mapping,
                { target },
            );

            res.setHeader("Content-Type", restored.contentType);
            res.setHeader(
                "Content-Disposition",
                buildContentDisposition("attachment", restored.filename),
            );
            res.setHeader("X-LDA-Executed-On", restored.executedOn);
            res.setHeader("X-LDA-Stats", JSON.stringify(restored.stats));
            res.send(restored.bytes);
        } catch (err) {
            if (err instanceof AnonymizerUnavailableError) {
                return unavailable(res, err);
            }
            res.status(500).json({ detail: (err as Error).message });
        }
    },
);
