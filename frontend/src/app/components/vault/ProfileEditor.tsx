"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
    AlertCircle,
    CheckCircle2,
    Loader2,
    Lock,
    Save,
    UserSquare2,
    X,
} from "lucide-react";
import {
    createProfile,
    extractProfileFromDocs,
    updateProfile,
    type ClientProfile,
    type ProfileData,
} from "@/app/lib/profileApi";
import type { VaultDocument } from "@/app/lib/vaultApi";

interface Props {
    open: boolean;
    onClose: () => void;
    vaultDocs: VaultDocument[];
    /** Existing profile to edit; null for new-profile mode. */
    existing?: ClientProfile | null;
    onSaved?: (p: ClientProfile) => void;
}

const FIELD_DEFS: { key: keyof ProfileData; label: string; multiline?: boolean }[] =
    [
        { key: "name", label: "Name" },
        { key: "name_zh", label: "中文名 (if applicable)" },
        { key: "registration_number", label: "Registration number" },
        { key: "jurisdiction", label: "Jurisdiction" },
        { key: "entity_type", label: "Entity type" },
        { key: "registered_office", label: "Registered office", multiline: true },
        { key: "date_incorporated", label: "Date incorporated" },
        { key: "authorized_capital", label: "Authorized capital" },
        { key: "business_scope", label: "Business scope", multiline: true },
        { key: "tax_id", label: "Tax ID / EIN" },
    ];

const LIST_FIELDS: { key: "directors" | "shareholders" | "officers"; label: string }[] =
    [
        { key: "directors", label: "Directors" },
        { key: "shareholders", label: "Shareholders" },
        { key: "officers", label: "Officers" },
    ];

const emptyProfile = (): ProfileData => ({
    name: null,
    name_zh: null,
    registration_number: null,
    jurisdiction: null,
    entity_type: null,
    registered_office: null,
    date_incorporated: null,
    authorized_capital: null,
    directors: [],
    shareholders: [],
    officers: [],
    business_scope: null,
    tax_id: null,
});

export function ProfileEditor({
    open,
    onClose,
    vaultDocs,
    existing = null,
    onSaved,
}: Props) {
    const [label, setLabel] = useState("");
    const [jurisdictionHint, setJurisdictionHint] = useState("");
    const [data, setData] = useState<ProfileData>(emptyProfile);
    const [sourceIds, setSourceIds] = useState<Set<string>>(new Set());
    const [notes, setNotes] = useState("");
    const [extracting, setExtracting] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [extractInfo, setExtractInfo] = useState<{
        latency_ms: number;
        model: string;
        executed_on: string;
    } | null>(null);

    useEffect(() => {
        if (!open) return;
        if (existing) {
            setLabel(existing.label);
            setJurisdictionHint(existing.jurisdiction ?? "");
            setData({ ...emptyProfile(), ...existing.data });
            setSourceIds(new Set(existing.source_document_ids ?? []));
            setNotes(existing.notes ?? "");
        } else {
            setLabel("");
            setJurisdictionHint("");
            setData(emptyProfile());
            setSourceIds(new Set());
            setNotes("");
        }
        setError(null);
        setExtractInfo(null);
    }, [open, existing]);

    if (!open) return null;
    if (typeof document === "undefined") return null;

    const setField = (key: keyof ProfileData, value: string) => {
        setData((prev) => ({ ...prev, [key]: value || null }));
    };

    const setListField = (
        key: "directors" | "shareholders" | "officers",
        raw: string,
    ) => {
        const list = raw
            .split(/[\n,;]/)
            .map((s) => s.trim())
            .filter(Boolean);
        setData((prev) => ({ ...prev, [key]: list }));
    };

    const listToText = (list?: string[]) => (list ?? []).join("\n");

    const handleExtract = async () => {
        if (sourceIds.size === 0) {
            setError("Pick at least one vault document to extract from.");
            return;
        }
        setExtracting(true);
        setError(null);
        try {
            const r = await extractProfileFromDocs({
                sourceDocumentIds: [...sourceIds],
                jurisdictionHint: jurisdictionHint || undefined,
            });
            // Merge into existing data — user-edited fields are preserved
            // for fields the extractor returned null for.
            setData((prev) => {
                const merged = { ...prev } as unknown as Record<string, unknown>;
                for (const [k, v] of Object.entries(r.profile)) {
                    if (v == null) continue;
                    if (Array.isArray(v) && v.length === 0) continue;
                    merged[k] = v;
                }
                return merged as unknown as ProfileData;
            });
            // Suggest a label from the extracted name if the user hasn't typed one
            if (!label && r.profile.name) setLabel(r.profile.name);
            if (!jurisdictionHint && r.profile.jurisdiction) {
                setJurisdictionHint(r.profile.jurisdiction);
            }
            setExtractInfo({
                latency_ms: r.latency_ms,
                model: r.model,
                executed_on: r.executed_on,
            });
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setExtracting(false);
        }
    };

    const handleSave = async () => {
        if (!label.trim()) {
            setError("Label is required (e.g. the company name).");
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const payload = {
                label: label.trim(),
                jurisdiction: jurisdictionHint || null,
                data,
                sourceDocumentIds: [...sourceIds],
                notes: notes || null,
            };
            const saved = existing
                ? await updateProfile(existing.id, payload)
                : await createProfile(payload);
            onSaved?.(saved);
            onClose();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setSaving(false);
        }
    };

    return createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="flex h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
                {/* Header */}
                <div className="flex items-start justify-between border-b border-gray-100 px-5 py-4">
                    <div className="flex items-start gap-3">
                        <div className="rounded-lg bg-emerald-50 p-2 text-emerald-700">
                            <UserSquare2 className="h-5 w-5" />
                        </div>
                        <div>
                            <h2 className="text-base font-semibold text-gray-900">
                                {existing
                                    ? `Edit profile · ${existing.label}`
                                    : "New client profile"}
                            </h2>
                            <p className="mt-0.5 text-xs text-gray-500">
                                Extract from a vault doc, edit, reuse for every
                                template fill. Cloud LLM never sees this.
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
                <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
                    {/* Label + jurisdiction */}
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="mb-1 block text-xs font-medium text-gray-700">
                                Label
                            </label>
                            <input
                                value={label}
                                onChange={(e) => setLabel(e.target.value)}
                                placeholder="Acme Holdings Ltd."
                                className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-sm focus:border-emerald-400 focus:outline-none"
                            />
                        </div>
                        <div>
                            <label className="mb-1 block text-xs font-medium text-gray-700">
                                Jurisdiction
                            </label>
                            <input
                                value={jurisdictionHint}
                                onChange={(e) =>
                                    setJurisdictionHint(e.target.value)
                                }
                                placeholder="Cayman Islands / Delaware / China (PRC)"
                                className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-sm focus:border-emerald-400 focus:outline-none"
                            />
                        </div>
                    </div>

                    {/* Extract from vault */}
                    <fieldset className="rounded-md border border-emerald-100 bg-emerald-50/40 p-3">
                        <legend className="px-1 text-xs font-medium text-emerald-700">
                            Extract from vault doc(s)
                        </legend>
                        {vaultDocs.length === 0 ? (
                            <p className="text-xs text-gray-400">
                                Upload a registration doc to the vault first.
                            </p>
                        ) : (
                            <div className="max-h-32 overflow-y-auto rounded-md border border-emerald-100 bg-white">
                                {vaultDocs.map((d) => {
                                    const checked = sourceIds.has(d.id);
                                    return (
                                        <label
                                            key={d.id}
                                            className={`flex cursor-pointer items-center gap-2 border-b border-gray-100 px-2.5 py-1.5 text-xs last:border-b-0 ${
                                                checked
                                                    ? "bg-emerald-50/70"
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
                                        </label>
                                    );
                                })}
                            </div>
                        )}
                        <button
                            type="button"
                            onClick={handleExtract}
                            disabled={extracting || sourceIds.size === 0}
                            className="mt-2 flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                            {extracting && (
                                <Loader2 className="h-3 w-3 animate-spin" />
                            )}
                            {extracting ? "Extracting…" : "Extract"}
                        </button>
                        {extractInfo && (
                            <p className="mt-2 flex items-center gap-1 text-[11px] text-emerald-700">
                                <CheckCircle2 className="h-3 w-3" />
                                {Math.round(extractInfo.latency_ms / 1000)} s on{" "}
                                {extractInfo.executed_on} ({extractInfo.model})
                            </p>
                        )}
                    </fieldset>

                    {/* Field editor */}
                    <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                        {FIELD_DEFS.map((f) => (
                            <div
                                key={f.key as string}
                                className={f.multiline ? "col-span-2" : ""}
                            >
                                <label className="mb-1 block text-[11px] font-medium text-gray-600">
                                    {f.label}
                                </label>
                                {f.multiline ? (
                                    <textarea
                                        value={
                                            (data[f.key] as string | null | undefined) ?? ""
                                        }
                                        onChange={(e) =>
                                            setField(f.key, e.target.value)
                                        }
                                        rows={2}
                                        className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-xs focus:border-emerald-400 focus:outline-none"
                                    />
                                ) : (
                                    <input
                                        value={
                                            (data[f.key] as string | null | undefined) ?? ""
                                        }
                                        onChange={(e) =>
                                            setField(f.key, e.target.value)
                                        }
                                        className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-xs focus:border-emerald-400 focus:outline-none"
                                    />
                                )}
                            </div>
                        ))}
                    </div>

                    {/* List fields */}
                    <div className="grid grid-cols-3 gap-3">
                        {LIST_FIELDS.map((f) => (
                            <div key={f.key}>
                                <label className="mb-1 block text-[11px] font-medium text-gray-600">
                                    {f.label}{" "}
                                    <span className="text-gray-400">
                                        (one per line)
                                    </span>
                                </label>
                                <textarea
                                    value={listToText(data[f.key])}
                                    onChange={(e) =>
                                        setListField(f.key, e.target.value)
                                    }
                                    rows={3}
                                    className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-xs focus:border-emerald-400 focus:outline-none"
                                />
                            </div>
                        ))}
                    </div>

                    {/* Notes */}
                    <div>
                        <label className="mb-1 block text-[11px] font-medium text-gray-600">
                            Internal notes
                        </label>
                        <textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            rows={2}
                            placeholder="(visible only to you; never sent to cloud LLM)"
                            className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-xs focus:border-emerald-400 focus:outline-none"
                        />
                    </div>

                    {error && (
                        <div className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <div className="break-words">{error}</div>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-end gap-2 border-t border-gray-100 bg-gray-50 px-5 py-3">
                    <button
                        onClick={onClose}
                        disabled={saving}
                        className="rounded-md px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={saving || !label.trim()}
                        className="flex items-center gap-1.5 rounded-md bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
                    >
                        {saving ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <Save className="h-3.5 w-3.5" />
                        )}
                        {existing ? "Save" : "Create profile"}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
