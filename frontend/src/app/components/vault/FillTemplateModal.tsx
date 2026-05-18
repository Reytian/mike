"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
    AlertCircle,
    CheckCircle2,
    Download,
    Loader2,
    Lock,
    ShieldCheck,
    Upload,
    UserSquare2,
    X,
} from "lucide-react";
import {
    fillTemplate,
    type FillTemplateResponse,
    type VaultDocument,
} from "@/app/lib/vaultApi";
import {
    listStandaloneDocuments,
    uploadStandaloneDocument,
} from "@/app/lib/mikeApi";
import type { MikeDocument } from "@/app/components/shared/types";
import type { ClientProfile } from "@/app/lib/profileApi";

interface Props {
    open: boolean;
    onClose: () => void;
    vaultDocs: VaultDocument[];
    profiles?: ClientProfile[];
}

/**
 * Pick a template (a regular Mike doc with {SLOT_NAME} placeholders) and
 * one or more vault docs as the data sources. Runs entirely through the
 * local LDA sidecar — no cloud calls.
 */
export function FillTemplateModal({
    open,
    onClose,
    vaultDocs,
    profiles = [],
}: Props) {
    const [templates, setTemplates] = useState<MikeDocument[]>([]);
    const [templateId, setTemplateId] = useState<string>("");
    const [sourceIds, setSourceIds] = useState<Set<string>>(new Set());
    const [profileIds, setProfileIds] = useState<Set<string>>(new Set());
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<FillTemplateResponse | null>(null);
    const [editedValues, setEditedValues] = useState<Record<string, string>>(
        {},
    );
    const [error, setError] = useState<string | null>(null);
    const [loadingTemplates, setLoadingTemplates] = useState(false);
    const [uploadingTemplate, setUploadingTemplate] = useState(false);
    const templateFileRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setLoadingTemplates(true);
        listStandaloneDocuments()
            .then((list) => {
                if (!cancelled) setTemplates(list);
            })
            .catch((err) => {
                if (!cancelled) setError((err as Error).message);
            })
            .finally(() => {
                if (!cancelled) setLoadingTemplates(false);
            });
        return () => {
            cancelled = true;
        };
    }, [open]);

    useEffect(() => {
        if (!open) {
            setResult(null);
            setError(null);
            setSourceIds(new Set());
            setProfileIds(new Set());
            setTemplateId("");
            setRunning(false);
            setEditedValues({});
        }
    }, [open]);

    /** Effective slot map = LLM result merged with the user's inline edits. */
    const effectiveSlotValues = useMemo<Record<string, string | null>>(() => {
        if (!result) return {};
        const merged: Record<string, string | null> = { ...result.slot_values };
        for (const [slot, v] of Object.entries(editedValues)) {
            if (v && v.trim()) merged[slot] = v;
        }
        return merged;
    }, [result, editedValues]);

    /** Re-render filled_text with the user's edits applied. Starts from the
     *  sidecar's filled_text (which already has resolved slots substituted)
     *  and overlays each user edit by replacing the bare {SLOT} placeholder
     *  where the unresolved slot still lives. */
    const effectiveFilledText = useMemo(() => {
        if (!result) return "";
        let text = result.filled_text;
        for (const [slot, value] of Object.entries(editedValues)) {
            if (value && value.trim()) {
                text = text.split(`{${slot}}`).join(value);
            }
        }
        return text;
    }, [result, editedValues]);

    const remainingUnresolved = useMemo(() => {
        return Object.entries(effectiveSlotValues)
            .filter(([_, v]) => !v)
            .map(([k]) => k);
    }, [effectiveSlotValues]);

    const handleTemplateUpload = async (
        e: React.ChangeEvent<HTMLInputElement>,
    ) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setUploadingTemplate(true);
        setError(null);
        try {
            const created = await uploadStandaloneDocument(file);
            const list = await listStandaloneDocuments();
            setTemplates(list);
            setTemplateId(created.id);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setUploadingTemplate(false);
            if (templateFileRef.current) templateFileRef.current.value = "";
        }
    };

    const canRun = useMemo(
        () =>
            templateId !== "" &&
            (sourceIds.size > 0 || profileIds.size > 0) &&
            !running,
        [templateId, sourceIds, profileIds, running],
    );

    const handleRun = async () => {
        if (!canRun) return;
        setRunning(true);
        setError(null);
        try {
            const r = await fillTemplate({
                templateDocumentId: templateId,
                sourceDocumentIds: [...sourceIds],
                clientProfileIds: [...profileIds],
            });
            setResult(r);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setRunning(false);
        }
    };

    const handleDownload = () => {
        if (!result) return;
        // Use the user-edited text, not the raw sidecar output, so the
        // download reflects in-place fixes to unresolved slots.
        const blob = new Blob([effectiveFilledText], { type: "text/markdown" });
        const url = URL.createObjectURL(blob);
        const a = window.document.createElement("a");
        a.href = url;
        const tpl = templates.find((t) => t.id === result.template_document_id);
        a.download = `${tpl?.filename ?? "filled"}.filled.md`;
        a.click();
        URL.revokeObjectURL(url);
    };

    if (!open) return null;
    if (typeof document === "undefined") return null;

    return createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-2xl">
                {/* Header */}
                <div className="flex items-start justify-between border-b border-gray-100 px-5 py-4">
                    <div className="flex items-start gap-3">
                        <div className="rounded-lg bg-emerald-50 p-2 text-emerald-700">
                            <ShieldCheck className="h-5 w-5" />
                        </div>
                        <div>
                            <h2 className="text-base font-semibold text-gray-900">
                                Fill template from vault
                            </h2>
                            <p className="mt-0.5 text-xs text-gray-500">
                                Runs entirely on this laptop. Cloud LLM never
                                sees the source documents.
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="rounded-md p-1 text-gray-400 hover:bg-gray-50 hover:text-gray-700"
                        aria-label="Close"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Body */}
                <div className="max-h-[60vh] space-y-4 overflow-y-auto px-5 py-4">
                    {/* Template picker */}
                    <div>
                        <label className="mb-1 block text-xs font-medium text-gray-700">
                            Template{" "}
                            <span className="text-gray-400">
                                (with {"{SLOT_NAME}"} placeholders)
                            </span>
                        </label>
                        <div className="flex items-center gap-2">
                            <select
                                value={templateId}
                                onChange={(e) => setTemplateId(e.target.value)}
                                disabled={loadingTemplates}
                                className="flex-1 rounded-md border border-gray-200 px-2 py-1.5 text-sm focus:border-emerald-400 focus:outline-none"
                            >
                                <option value="">
                                    {loadingTemplates
                                        ? "Loading…"
                                        : "Pick a template…"}
                                </option>
                                {templates.map((t) => (
                                    <option key={t.id} value={t.id}>
                                        {t.filename}
                                    </option>
                                ))}
                            </select>
                            <input
                                ref={templateFileRef}
                                type="file"
                                accept=".txt,.md,.docx,.doc"
                                className="hidden"
                                onChange={handleTemplateUpload}
                            />
                            <button
                                type="button"
                                onClick={() => templateFileRef.current?.click()}
                                disabled={uploadingTemplate}
                                className="flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                            >
                                {uploadingTemplate ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                    <Upload className="h-3 w-3" />
                                )}
                                Upload
                            </button>
                        </div>
                    </div>

                    {/* Profiles (preferred when available) */}
                    {profiles.length > 0 && (
                        <div>
                            <label className="mb-1 block text-xs font-medium text-gray-700">
                                Client profiles{" "}
                                <span className="text-gray-400">
                                    (preferred — pre-edited)
                                </span>
                            </label>
                            <div className="max-h-32 overflow-y-auto rounded-md border border-gray-200">
                                {profiles.map((p) => {
                                    const checked = profileIds.has(p.id);
                                    return (
                                        <label
                                            key={p.id}
                                            className={`flex cursor-pointer items-center gap-2 border-b border-gray-100 px-2.5 py-1.5 text-xs last:border-b-0 ${
                                                checked
                                                    ? "bg-emerald-50/60"
                                                    : "hover:bg-gray-50"
                                            }`}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={checked}
                                                onChange={() => {
                                                    const n = new Set(profileIds);
                                                    if (checked) n.delete(p.id);
                                                    else n.add(p.id);
                                                    setProfileIds(n);
                                                }}
                                                className="h-3 w-3 accent-emerald-600"
                                            />
                                            <UserSquare2 className="h-3 w-3 text-emerald-600" />
                                            <span className="flex-1 truncate text-gray-800">
                                                {p.label}
                                            </span>
                                            {p.jurisdiction && (
                                                <span className="text-[10px] text-gray-400">
                                                    {p.jurisdiction}
                                                </span>
                                            )}
                                        </label>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* Source docs */}
                    <div>
                        <label className="mb-1 block text-xs font-medium text-gray-700">
                            Source documents (vault)
                            {profiles.length > 0 && (
                                <span className="ml-1 text-gray-400">
                                    (or combine with profiles above)
                                </span>
                            )}
                        </label>
                        {vaultDocs.length === 0 ? (
                            <div className="rounded-md border border-dashed border-gray-200 px-3 py-4 text-center text-xs text-gray-400">
                                Upload to the vault first.
                            </div>
                        ) : (
                            <div className="max-h-44 overflow-y-auto rounded-md border border-gray-200">
                                {vaultDocs.map((d) => {
                                    const checked = sourceIds.has(d.id);
                                    return (
                                        <label
                                            key={d.id}
                                            className={`flex cursor-pointer items-center gap-2 border-b border-gray-100 px-2.5 py-1.5 text-xs last:border-b-0 ${
                                                checked
                                                    ? "bg-emerald-50/60"
                                                    : "hover:bg-gray-50"
                                            }`}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={checked}
                                                onChange={() => {
                                                    const n = new Set(sourceIds);
                                                    if (checked)
                                                        n.delete(d.id);
                                                    else n.add(d.id);
                                                    setSourceIds(n);
                                                }}
                                                className="h-3 w-3 accent-emerald-600"
                                            />
                                            <Lock className="h-3 w-3 text-emerald-600" />
                                            <span className="flex-1 truncate text-gray-800">
                                                {d.filename}
                                            </span>
                                            {d.ocr_status === "done" && (
                                                <span className="text-[10px] text-emerald-700">
                                                    OCR
                                                </span>
                                            )}
                                        </label>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    {/* Result */}
                    {error && (
                        <div className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <div className="break-words">{error}</div>
                        </div>
                    )}
                    {result && (
                        <div className="space-y-2">
                            <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                <div>
                                    <div className="font-medium">
                                        Filled —{" "}
                                        {
                                            Object.values(
                                                effectiveSlotValues,
                                            ).filter((v) => v).length
                                        }{" "}
                                        of{" "}
                                        {
                                            Object.keys(effectiveSlotValues)
                                                .length
                                        }{" "}
                                        slots, ran on {result.executed_on}{" "}
                                        ({result.model}),{" "}
                                        {Math.round(result.latency_ms / 1000)} s
                                    </div>
                                    {remainingUnresolved.length > 0 ? (
                                        <div className="mt-0.5 text-emerald-700/80">
                                            Still unresolved:{" "}
                                            {remainingUnresolved.join(", ")}
                                            <span className="ml-1 text-emerald-700/60">
                                                — fill below to fix
                                            </span>
                                        </div>
                                    ) : (
                                        Object.keys(editedValues).length > 0 && (
                                            <div className="mt-0.5 text-emerald-700/80">
                                                All slots filled (including
                                                your manual edits).
                                            </div>
                                        )
                                    )}
                                </div>
                            </div>
                            <div className="overflow-hidden rounded-md border border-gray-200">
                                <div className="border-b border-gray-100 bg-gray-50 px-3 py-1.5 text-[11px] font-medium text-gray-500">
                                    Filled preview (live)
                                </div>
                                <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap px-3 py-2 text-[11px] leading-relaxed text-gray-700">
                                    {effectiveFilledText}
                                </pre>
                            </div>
                            <div className="overflow-hidden rounded-md border border-gray-200">
                                <div className="border-b border-gray-100 bg-gray-50 px-3 py-1.5 text-[11px] font-medium text-gray-500">
                                    Slot map{" "}
                                    <span className="text-gray-400">
                                        (click an unresolved slot to fill it
                                        manually)
                                    </span>
                                </div>
                                <div className="max-h-56 overflow-y-auto divide-y divide-gray-50">
                                    {Object.entries(effectiveSlotValues).map(
                                        ([slot, value]) => {
                                            const wasUnresolved =
                                                result.slot_values[slot] == null;
                                            const userEdited =
                                                editedValues[slot] != null;
                                            return (
                                                <div
                                                    key={slot}
                                                    className="flex items-center gap-3 px-3 py-1.5 text-[11px]"
                                                >
                                                    <span className="w-40 shrink-0 truncate font-mono text-gray-500">
                                                        {`{${slot}}`}
                                                    </span>
                                                    {wasUnresolved ? (
                                                        <input
                                                            value={
                                                                editedValues[
                                                                    slot
                                                                ] ?? ""
                                                            }
                                                            onChange={(e) =>
                                                                setEditedValues(
                                                                    (prev) => ({
                                                                        ...prev,
                                                                        [slot]:
                                                                            e
                                                                                .target
                                                                                .value,
                                                                    }),
                                                                )
                                                            }
                                                            placeholder="(not found — type a value)"
                                                            className={`flex-1 rounded-md border px-2 py-1 text-[11px] focus:outline-none ${
                                                                editedValues[
                                                                    slot
                                                                ]
                                                                    ? "border-emerald-300 bg-emerald-50/40 text-gray-800 focus:border-emerald-500"
                                                                    : "border-gray-200 italic text-gray-400 focus:border-emerald-400"
                                                            }`}
                                                        />
                                                    ) : (
                                                        <span
                                                            className={`flex-1 ${
                                                                userEdited
                                                                    ? "text-emerald-800"
                                                                    : "text-gray-800"
                                                            }`}
                                                        >
                                                            {value}
                                                        </span>
                                                    )}
                                                </div>
                                            );
                                        },
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-end gap-2 border-t border-gray-100 bg-gray-50 px-5 py-3">
                    {!result ? (
                        <>
                            <button
                                onClick={onClose}
                                disabled={running}
                                className="rounded-md px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-50"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleRun}
                                disabled={!canRun}
                                className="flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                            >
                                {running && (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                )}
                                {running ? "Filling…" : "Fill"}
                            </button>
                        </>
                    ) : (
                        <>
                            <button
                                onClick={handleDownload}
                                className="flex items-center gap-1.5 rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
                            >
                                <Download className="h-3.5 w-3.5" />
                                Download filled
                            </button>
                            <button
                                onClick={onClose}
                                className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700"
                            >
                                Done
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
}
