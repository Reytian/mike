/**
 * Vault — local-only documents that the cloud LLM cannot see.
 *
 * Endpoints
 * ---------
 *   GET  /vault/documents                      list vault docs for current user
 *   POST /vault/documents                      upload to vault; PDFs auto-OCR
 *   GET  /vault/documents/:id/url              R2-signed URL for download
 *   DELETE /vault/documents/:id                delete a vault doc
 *   PATCH  /vault/documents/:id/confidentiality body { level: 'vault'|'shared'|'template' }
 *                                              move a doc in/out of the vault
 *   POST /vault/fill-template                  body { template_document_id,
 *                                                     source_document_ids[],
 *                                                     slots_schema? }
 *                                              run local fill_template
 *
 * The chat tool layer (buildDocContext + buildProjectDocContext) already
 * excludes documents with confidentiality='vault' from docStore/docIndex,
 * so vault documents are unreachable to the LLM even if their UUID leaks
 * into a user message.
 */

import { Router } from "express";
import crypto from "node:crypto";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
    buildContentDisposition,
    downloadFile,
    deleteFile,
    getSignedUrl,
    storageKey,
    uploadFile,
} from "../lib/storage";
import { ensureDocAccess } from "../lib/access";
import { singleFileUpload } from "../lib/upload";
import { loadActiveVersion } from "../lib/documentVersions";
import {
    AnonymizerUnavailableError,
    routedExtractProfile,
    routedFillTemplate,
    routedOcr,
} from "../lib/anonymizer/routing";
import type {
    ExtractedProfile,
    FillSlotSchemaEntry,
} from "../lib/anonymizer/types";

export const vaultRouter = Router();

const ALLOWED_EXT = new Set(["pdf", "docx", "doc", "txt", "md"]);
const ALLOWED_CONFIDENTIALITY = new Set(["shared", "vault", "template"]);

function extOf(filename: string): string {
    const i = filename.lastIndexOf(".");
    return i > 0 ? filename.slice(i + 1).toLowerCase() : "";
}

function contentTypeFor(ext: string): string {
    if (ext === "pdf") return "application/pdf";
    if (ext === "docx")
        return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (ext === "doc") return "application/msword";
    return "text/plain; charset=utf-8";
}

function bufToArrayBuffer(buf: Buffer): ArrayBuffer {
    return buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;
}

function handle503(
    res: import("express").Response,
    err: AnonymizerUnavailableError,
) {
    return void res.status(503).json({
        detail: err.message,
        attempted: err.attempted,
        health: err.health,
    });
}

// ---------------------------------------------------------------------------
// GET /vault/documents — list this user's vault docs
// ---------------------------------------------------------------------------

vaultRouter.get("/vault/documents", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const { data, error } = await db
        .from("documents")
        .select(
            "id, filename, file_type, size_bytes, page_count, ocr_status, ocr_text_layer_present, confidentiality, status, created_at, updated_at",
        )
        .eq("user_id", userId)
        .eq("confidentiality", "vault")
        .order("created_at", { ascending: false });
    if (error) return void res.status(500).json({ detail: error.message });
    res.json(data ?? []);
});

// ---------------------------------------------------------------------------
// POST /vault/documents — upload to vault, auto-OCR PDFs without text layer
// ---------------------------------------------------------------------------

vaultRouter.post(
    "/vault/documents",
    requireAuth,
    singleFileUpload("file"),
    async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();

        const file = req.file;
        if (!file)
            return void res.status(400).json({ detail: "file is required" });
        const filename = file.originalname;
        const ext = extOf(filename);
        if (!ALLOWED_EXT.has(ext)) {
            return void res.status(400).json({
                detail: `Unsupported file type: ${ext || "(none)"}. Allowed: ${[...ALLOWED_EXT].join(", ")}`,
            });
        }

        // Initial bytes — for PDFs we'll possibly replace these with the OCRed bytes.
        let storedBytes: Buffer = file.buffer;
        let ocrStatus: "pending" | "skipped" | "done" | "failed" | null = null;
        let textLayerPresent: boolean | null = null;

        if (ext === "pdf") {
            ocrStatus = "pending";
            try {
                const ocr = await routedOcr(
                    { filename, bytes: storedBytes },
                    { languages: "eng+chi_sim" },
                );
                storedBytes = ocr.bytes;
                ocrStatus = ocr.status;
                // If we skipped because a text layer was already present,
                // record that as a property.
                textLayerPresent = ocr.status === "skipped";
            } catch (err) {
                // Don't block the upload — store the original bytes anyway
                // so the user can still see / read the PDF in the vault.
                // ocr_status='failed' surfaces the issue in the UI.
                console.error(`[vault/upload] OCR failed for ${filename}:`, err);
                ocrStatus = "failed";
            }
        }

        const { data: doc, error: insertErr } = await db
            .from("documents")
            .insert({
                project_id: null,
                user_id: userId,
                filename,
                file_type: ext,
                size_bytes: storedBytes.byteLength,
                status: "processing",
                confidentiality: "vault",
                ocr_status: ocrStatus,
                ocr_text_layer_present: textLayerPresent,
            })
            .select("*")
            .single();
        if (insertErr || !doc) {
            return void res
                .status(500)
                .json({ detail: `Failed to create vault doc: ${insertErr?.message}` });
        }

        try {
            const docId = doc.id as string;
            const key = storageKey(userId, docId, filename);
            await uploadFile(
                key,
                bufToArrayBuffer(storedBytes),
                contentTypeFor(ext),
            );

            const { data: versionRow, error: verErr } = await db
                .from("document_versions")
                .insert({
                    document_id: docId,
                    storage_path: key,
                    pdf_storage_path: ext === "pdf" ? key : null,
                    source: "upload",
                    version_number: 1,
                    display_name: filename,
                })
                .select("id")
                .single();
            if (verErr || !versionRow) {
                throw new Error(
                    `Failed to record vault version: ${verErr?.message}`,
                );
            }

            await db
                .from("documents")
                .update({
                    current_version_id: versionRow.id,
                    status: "ready",
                    size_bytes: storedBytes.byteLength,
                    updated_at: new Date().toISOString(),
                })
                .eq("id", docId);

            const { data: updated } = await db
                .from("documents")
                .select("*")
                .eq("id", docId)
                .single();
            return void res
                .status(201)
                .json({ ...(updated ?? doc), storage_path: key });
        } catch (e) {
            await db
                .from("documents")
                .update({ status: "error" })
                .eq("id", doc.id);
            return void res
                .status(500)
                .json({ detail: `Vault upload failed: ${String(e)}` });
        }
    },
);

// ---------------------------------------------------------------------------
// GET /vault/documents/:id/url — signed R2 URL
// ---------------------------------------------------------------------------

vaultRouter.get(
    "/vault/documents/:documentId/url",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { documentId } = req.params;
        const db = createServerSupabase();
        const { data: doc } = await db
            .from("documents")
            .select("id, filename, user_id, project_id, confidentiality")
            .eq("id", documentId)
            .single();
        if (!doc || doc.confidentiality !== "vault") {
            return void res.status(404).json({ detail: "Vault doc not found" });
        }
        const access = await ensureDocAccess(doc, userId, userEmail, db);
        if (!access.ok) {
            return void res.status(404).json({ detail: "Vault doc not found" });
        }
        const active = await loadActiveVersion(documentId, db);
        if (!active) {
            return void res
                .status(404)
                .json({ detail: "No file available" });
        }
        const url = await getSignedUrl(active.storage_path, 3600, doc.filename);
        if (!url) {
            return void res
                .status(503)
                .json({ detail: "Storage not configured" });
        }
        res.json({ url, filename: doc.filename });
    },
);

// ---------------------------------------------------------------------------
// DELETE /vault/documents/:id
// ---------------------------------------------------------------------------

vaultRouter.delete(
    "/vault/documents/:documentId",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const { documentId } = req.params;
        const db = createServerSupabase();
        const { data: doc } = await db
            .from("documents")
            .select("id, confidentiality")
            .eq("id", documentId)
            .eq("user_id", userId)
            .single();
        if (!doc || doc.confidentiality !== "vault") {
            return void res.status(404).json({ detail: "Vault doc not found" });
        }
        const { data: versions } = await db
            .from("document_versions")
            .select("storage_path, pdf_storage_path")
            .eq("document_id", documentId);
        await Promise.all(
            (versions ?? []).flatMap((v) =>
                [v.storage_path, v.pdf_storage_path]
                    .filter((p): p is string => typeof p === "string" && !!p)
                    .map((p) => deleteFile(p).catch(() => {})),
            ),
        );
        await db.from("documents").delete().eq("id", documentId);
        res.status(204).send();
    },
);

// ---------------------------------------------------------------------------
// PATCH /vault/documents/:id/confidentiality
// ---------------------------------------------------------------------------

vaultRouter.patch(
    "/vault/documents/:documentId/confidentiality",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const { documentId } = req.params;
        const level = (req.body?.level ?? "") as string;
        if (!ALLOWED_CONFIDENTIALITY.has(level)) {
            return void res.status(400).json({
                detail: `level must be one of ${[...ALLOWED_CONFIDENTIALITY].join(", ")}`,
            });
        }
        const db = createServerSupabase();
        const { data: doc } = await db
            .from("documents")
            .select("id")
            .eq("id", documentId)
            .eq("user_id", userId)
            .single();
        if (!doc)
            return void res.status(404).json({ detail: "Document not found" });
        await db
            .from("documents")
            .update({
                confidentiality: level,
                updated_at: new Date().toISOString(),
            })
            .eq("id", documentId);
        res.json({ ok: true, confidentiality: level });
    },
);

// ---------------------------------------------------------------------------
// POST /vault/fill-template
// ---------------------------------------------------------------------------

interface FillTemplateBody {
    template_document_id?: unknown;
    source_document_ids?: unknown;
    client_profile_ids?: unknown;
    slots_schema?: unknown;
    target?: unknown;
}

interface ProfileExtractBody {
    source_document_ids?: unknown;
    jurisdiction_hint?: unknown;
}

interface ProfileSaveBody {
    label?: unknown;
    jurisdiction?: unknown;
    data?: unknown;
    source_document_ids?: unknown;
    notes?: unknown;
}

interface ProfileRow {
    id: string;
    user_id: string;
    label: string;
    jurisdiction: string | null;
    data: ExtractedProfile;
    source_document_ids: string[] | null;
    notes: string | null;
    created_at: string;
    updated_at: string;
}

/**
 * Render a structured profile to markdown the slot resolver can read as
 * if it were any other source document. Order is stable so the LLM can
 * rely on consistent positioning.
 */
function profileToMarkdown(label: string, data: ExtractedProfile): string {
    const lines: string[] = [`# Client profile: ${label}`, ""];
    const push = (k: string, v: unknown) => {
        if (v == null || v === "") return;
        if (Array.isArray(v)) {
            if (v.length === 0) return;
            lines.push(`- **${k}:**`);
            for (const item of v) lines.push(`  - ${String(item)}`);
        } else {
            lines.push(`- **${k}:** ${String(v)}`);
        }
    };
    push("Name", data.name);
    push("Name (Chinese)", data.name_zh);
    push("Registration number", data.registration_number);
    push("Jurisdiction", data.jurisdiction);
    push("Entity type", data.entity_type);
    push("Registered office", data.registered_office);
    push("Date incorporated", data.date_incorporated);
    push("Authorized capital", data.authorized_capital);
    push("Directors", data.directors);
    push("Shareholders", data.shareholders);
    push("Officers", data.officers);
    push("Business scope", data.business_scope);
    push("Tax ID", data.tax_id);
    if (data.additional && Object.keys(data.additional).length > 0) {
        lines.push("- **Additional:**");
        for (const [k, v] of Object.entries(data.additional)) {
            lines.push(`  - ${k}: ${JSON.stringify(v)}`);
        }
    }
    return lines.join("\n");
}

vaultRouter.post("/vault/fill-template", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const body = (req.body && typeof req.body === "object"
        ? (req.body as FillTemplateBody)
        : {}) as FillTemplateBody;

    const templateId = body.template_document_id;
    const sourceIds = body.source_document_ids;
    const profileIds = body.client_profile_ids;
    if (typeof templateId !== "string" || !templateId) {
        return void res
            .status(400)
            .json({ detail: "template_document_id required" });
    }
    const cleanSourceIds = Array.isArray(sourceIds)
        ? sourceIds.filter(
              (s): s is string => typeof s === "string" && s.length > 0,
          )
        : [];
    const cleanProfileIds = Array.isArray(profileIds)
        ? profileIds.filter(
              (s): s is string => typeof s === "string" && s.length > 0,
          )
        : [];
    if (cleanSourceIds.length === 0 && cleanProfileIds.length === 0) {
        return void res.status(400).json({
            detail:
                "at least one of source_document_ids[] or client_profile_ids[] required",
        });
    }

    // Permitted slots_schema shape: Record<slot, {type?, role?, hint?}>
    let slotsSchema: Record<string, FillSlotSchemaEntry> | undefined;
    if (body.slots_schema && typeof body.slots_schema === "object") {
        slotsSchema = body.slots_schema as Record<string, FillSlotSchemaEntry>;
    }

    // Load + access-check the template doc. Pull template_schema too — if
    // the template was generated via generate_docx (which auto-detects
    // slots) or enriched via define_template_schema, those hints flow
    // into the slot resolver automatically. Explicit body.slots_schema
    // wins when both are present.
    const { data: templateDoc } = await db
        .from("documents")
        .select(
            "id, filename, file_type, user_id, project_id, confidentiality, template_schema",
        )
        .eq("id", templateId)
        .single();
    if (
        !slotsSchema &&
        templateDoc?.template_schema &&
        typeof templateDoc.template_schema === "object"
    ) {
        slotsSchema = templateDoc.template_schema as Record<
            string,
            FillSlotSchemaEntry
        >;
    }
    if (!templateDoc) {
        return void res.status(404).json({ detail: "Template not found" });
    }
    const tplAccess = await ensureDocAccess(templateDoc, userId, userEmail, db);
    if (!tplAccess.ok) {
        return void res.status(404).json({ detail: "Template not found" });
    }
    const tplActive = await loadActiveVersion(templateId, db);
    if (!tplActive) {
        return void res
            .status(409)
            .json({ detail: "Template has no active version" });
    }
    const tplBytes = await downloadFile(tplActive.storage_path);
    if (!tplBytes) {
        return void res
            .status(500)
            .json({ detail: "Could not load template bytes" });
    }

    // Access-check + load each source doc. Sources may be vault docs (the
    // common case) — vault-only access is enforced by user ownership.
    const sources: { filename: string; bytes: Buffer; contentType: string }[] =
        [];
    if (cleanSourceIds.length > 0) {
        const { data: sourceDocs } = await db
            .from("documents")
            .select(
                "id, filename, file_type, user_id, project_id, confidentiality",
            )
            .in("id", cleanSourceIds);
        for (const sd of sourceDocs ?? []) {
            const access = await ensureDocAccess(sd, userId, userEmail, db);
            if (!access.ok) continue;
            const active = await loadActiveVersion(sd.id as string, db);
            if (!active) continue;
            const buf = await downloadFile(active.storage_path);
            if (!buf) continue;
            sources.push({
                filename: sd.filename as string,
                bytes: Buffer.from(buf),
                contentType: contentTypeFor(extOf(sd.filename as string)),
            });
        }
    }

    // Load each profile + render it to markdown as a virtual source file.
    // The slot resolver doesn't know the difference between a real source
    // doc and a profile-rendered markdown — both are just text it scans.
    if (cleanProfileIds.length > 0) {
        const { data: profileRows } = await db
            .from("client_profiles")
            .select("*")
            .in("id", cleanProfileIds)
            .eq("user_id", userId);
        for (const p of (profileRows ?? []) as ProfileRow[]) {
            const md = profileToMarkdown(p.label, p.data);
            sources.push({
                filename: `profile-${p.label.replace(/[^a-z0-9\-]/gi, "_")}.md`,
                bytes: Buffer.from(md, "utf-8"),
                contentType: "text/markdown; charset=utf-8",
            });
        }
    }

    if (sources.length === 0) {
        return void res.status(400).json({
            detail:
                "no readable sources (check that source_document_ids / client_profile_ids exist and belong to you)",
        });
    }

    try {
        const result = await routedFillTemplate(
            {
                filename: templateDoc.filename as string,
                bytes: Buffer.from(tplBytes),
                contentType: contentTypeFor(
                    extOf(templateDoc.filename as string),
                ),
            },
            sources,
            { slotsSchema },
        );

        // Persist the filled output as a new document_versions row attached
        // to the template doc. source='generated' lines up with how the
        // existing generate_docx tool stores its outputs.
        const versionSlug = crypto.randomUUID().replace(/-/g, "");
        const outKey = `documents/${userId}/${templateId}/filled/${versionSlug}.md`;
        const outBytes = Buffer.from(result.filledText, "utf-8");
        await uploadFile(
            outKey,
            bufToArrayBuffer(outBytes),
            "text/markdown; charset=utf-8",
        );

        const { data: versionRow } = await db
            .from("document_versions")
            .insert({
                document_id: templateId,
                storage_path: outKey,
                source: "generated",
                source_version_id: tplActive.id,
                display_name: `Filled (${result.executedOn})`,
            })
            .select("id, created_at, display_name")
            .single();

        res.status(201).json({
            template_document_id: templateId,
            filled_version_id: versionRow?.id ?? null,
            slot_values: result.slotValues,
            unresolved_slots: result.unresolvedSlots,
            sources_used: result.sourcesUsed,
            executed_on: result.executedOn,
            latency_ms: result.latencyMs,
            model: result.model,
            filled_text: result.filledText,
        });
    } catch (err) {
        if (err instanceof AnonymizerUnavailableError) {
            return handle503(res, err);
        }
        res.status(500).json({ detail: (err as Error).message });
    }
});

// ---------------------------------------------------------------------------
// Client profile routes
// ---------------------------------------------------------------------------

// POST /vault/profiles/extract
//   { source_document_ids: string[], jurisdiction_hint?: string }
//   → preview of the extracted profile (NOT persisted). Caller saves with
//   POST /vault/profiles once they've reviewed/edited.
vaultRouter.post("/vault/profiles/extract", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const body = (req.body && typeof req.body === "object"
        ? (req.body as ProfileExtractBody)
        : {}) as ProfileExtractBody;
    const sourceIds = Array.isArray(body.source_document_ids)
        ? body.source_document_ids.filter(
              (s): s is string => typeof s === "string" && s.length > 0,
          )
        : [];
    if (sourceIds.length === 0) {
        return void res
            .status(400)
            .json({ detail: "source_document_ids[] required" });
    }
    const jurisdictionHint =
        typeof body.jurisdiction_hint === "string"
            ? body.jurisdiction_hint
            : undefined;
    const db = createServerSupabase();

    const { data: docs } = await db
        .from("documents")
        .select("id, filename, file_type, user_id, project_id, confidentiality")
        .in("id", sourceIds);
    const sources: { filename: string; bytes: Buffer; contentType: string }[] =
        [];
    for (const d of docs ?? []) {
        const access = await ensureDocAccess(d, userId, userEmail, db);
        if (!access.ok) continue;
        const active = await loadActiveVersion(d.id as string, db);
        if (!active) continue;
        const buf = await downloadFile(active.storage_path);
        if (!buf) continue;
        sources.push({
            filename: d.filename as string,
            bytes: Buffer.from(buf),
            contentType: contentTypeFor(extOf(d.filename as string)),
        });
    }
    if (sources.length === 0) {
        return void res
            .status(400)
            .json({ detail: "no readable source documents" });
    }
    try {
        const result = await routedExtractProfile(sources, {
            jurisdictionHint,
        });
        res.json({
            profile: result.profile,
            sources_used: result.sourcesUsed,
            latency_ms: result.latencyMs,
            model: result.model,
            executed_on: result.executedOn,
        });
    } catch (err) {
        if (err instanceof AnonymizerUnavailableError)
            return handle503(res, err);
        res.status(500).json({ detail: (err as Error).message });
    }
});

// GET /vault/profiles — list
vaultRouter.get("/vault/profiles", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const { data, error } = await db
        .from("client_profiles")
        .select("*")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false });
    if (error) return void res.status(500).json({ detail: error.message });
    res.json(data ?? []);
});

// POST /vault/profiles — save a new one
vaultRouter.post("/vault/profiles", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const body = (req.body && typeof req.body === "object"
        ? (req.body as ProfileSaveBody)
        : {}) as ProfileSaveBody;
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!label) {
        return void res.status(400).json({ detail: "label required" });
    }
    const jurisdiction =
        typeof body.jurisdiction === "string" ? body.jurisdiction : null;
    const data: ExtractedProfile =
        body.data && typeof body.data === "object"
            ? (body.data as ExtractedProfile)
            : { name: label };
    const sourceDocumentIds = Array.isArray(body.source_document_ids)
        ? body.source_document_ids.filter(
              (s): s is string => typeof s === "string" && s.length > 0,
          )
        : [];
    const notes = typeof body.notes === "string" ? body.notes : null;

    const db = createServerSupabase();
    const { data: row, error } = await db
        .from("client_profiles")
        .insert({
            user_id: userId,
            label,
            jurisdiction,
            data,
            source_document_ids: sourceDocumentIds,
            notes,
        })
        .select("*")
        .single();
    if (error || !row) {
        return void res
            .status(500)
            .json({ detail: error?.message ?? "insert failed" });
    }
    res.status(201).json(row);
});

// PATCH /vault/profiles/:id — update fields
vaultRouter.patch("/vault/profiles/:id", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { id } = req.params;
    const body = (req.body && typeof req.body === "object"
        ? (req.body as ProfileSaveBody)
        : {}) as ProfileSaveBody;
    const update: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
    };
    if (typeof body.label === "string" && body.label.trim()) {
        update.label = body.label.trim();
    }
    if (typeof body.jurisdiction === "string" || body.jurisdiction === null) {
        update.jurisdiction = body.jurisdiction;
    }
    if (body.data && typeof body.data === "object") {
        update.data = body.data;
    }
    if (Array.isArray(body.source_document_ids)) {
        update.source_document_ids = body.source_document_ids.filter(
            (s): s is string => typeof s === "string" && s.length > 0,
        );
    }
    if (typeof body.notes === "string" || body.notes === null) {
        update.notes = body.notes;
    }
    const db = createServerSupabase();
    const { data: row, error } = await db
        .from("client_profiles")
        .update(update)
        .eq("id", id)
        .eq("user_id", userId)
        .select("*")
        .single();
    if (error || !row) {
        return void res
            .status(404)
            .json({ detail: error?.message ?? "profile not found" });
    }
    res.json(row);
});

// DELETE /vault/profiles/:id
vaultRouter.delete("/vault/profiles/:id", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { id } = req.params;
    const db = createServerSupabase();
    await db
        .from("client_profiles")
        .delete()
        .eq("id", id)
        .eq("user_id", userId);
    res.status(204).send();
});
