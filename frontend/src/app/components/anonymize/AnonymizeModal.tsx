"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
    Loader2,
    Shield,
    X,
    CheckCircle2,
    AlertCircle,
    Download,
    ExternalLink,
} from "lucide-react";
import {
    anonymizeDocument,
    deanonymizeVersion,
    getAnonymizerHealth,
    type AnonymizeResult,
    type AnonymizerHealth,
    type AnonymizerTarget,
} from "@/app/lib/anonymizeApi";
import { getDocumentUrl } from "@/app/lib/mikeApi";

interface Props {
    open: boolean;
    onClose: () => void;
    documentId: string;
    filename: string;
    onSuccess?: (result: AnonymizeResult) => void;
}

const EXCLUDE_OPTIONS: { value: string; label: string; hint: string }[] = [
    { value: "date", label: "Dates", hint: "Effective date, signature date, etc." },
    { value: "amount", label: "Amounts", hint: "Purchase price, fees, share counts" },
    { value: "regnum", label: "Reg numbers", hint: "USCC, EIN, Cayman reg, etc." },
    { value: "address", label: "Addresses", hint: "Street + city + state + ZIP" },
];

export function AnonymizeModal({
    open,
    onClose,
    documentId,
    filename,
    onSuccess,
}: Props) {
    const [target, setTarget] = useState<AnonymizerTarget>("auto");
    const [excludeTypes, setExcludeTypes] = useState<Set<string>>(new Set());
    const [health, setHealth] = useState<AnonymizerHealth | null>(null);
    const [loadingHealth, setLoadingHealth] = useState(false);
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<AnonymizeResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [downloading, setDownloading] = useState(false);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setLoadingHealth(true);
        getAnonymizerHealth()
            .then((h) => {
                if (!cancelled) setHealth(h);
            })
            .catch((err) => {
                if (!cancelled)
                    setError(`Could not reach anonymizer: ${(err as Error).message}`);
            })
            .finally(() => {
                if (!cancelled) setLoadingHealth(false);
            });
        return () => {
            cancelled = true;
        };
    }, [open]);

    useEffect(() => {
        if (!open) {
            setResult(null);
            setError(null);
            setRunning(false);
            setExcludeTypes(new Set());
            setTarget("auto");
        }
    }, [open]);

    if (!open) return null;
    if (typeof document === "undefined") return null;

    const handleRun = async () => {
        setRunning(true);
        setError(null);
        try {
            const res = await anonymizeDocument(documentId, {
                target,
                format: "md",
                excludeTypes: [...excludeTypes],
            });
            setResult(res);
            onSuccess?.(res);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setRunning(false);
        }
    };

    const handleDownloadAnonymized = async () => {
        if (!result) return;
        setDownloading(true);
        try {
            // R2-signed URL for the anonymized version; reuses Mike's
            // existing /single-documents/:id/url?version_id=… route.
            const { url } = await getDocumentUrl(
                documentId,
                result.anonymized_version_id,
            );
            if (url) window.open(url, "_blank", "noopener,noreferrer");
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setDownloading(false);
        }
    };

    const handleDownloadRestored = async () => {
        if (!result) return;
        setDownloading(true);
        try {
            const { blob, filename: outName } = await deanonymizeVersion(
                documentId,
                result.anonymized_version_id,
                target,
            );
            const objectUrl = URL.createObjectURL(blob);
            const a = window.document.createElement("a");
            a.href = objectUrl;
            a.download = outName;
            a.click();
            URL.revokeObjectURL(objectUrl);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setDownloading(false);
        }
    };

    const macminiDot = health
        ? health.macmini.status === "ok"
            ? "bg-emerald-500"
            : health.macmini.status === "degraded"
              ? "bg-amber-500"
              : "bg-gray-300"
        : "bg-gray-200";

    const macbookDot = health
        ? health.macbook.status === "ok"
            ? "bg-emerald-500"
            : health.macbook.status === "degraded"
              ? "bg-amber-500"
              : "bg-gray-300"
        : "bg-gray-200";

    const autoTargetHint = health?.chosenWhenAuto
        ? `Will run on ${health.chosenWhenAuto === "macmini" ? "Mac Mini (gemma4-v4)" : "MacBook (qwen3:4b)"}`
        : loadingHealth
          ? "Checking sidecar availability…"
          : "No sidecar reachable";

    return createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-2xl">
                {/* Header */}
                <div className="flex items-start justify-between border-b border-gray-100 px-5 py-4">
                    <div className="flex items-start gap-3">
                        <div className="rounded-lg bg-emerald-50 p-2 text-emerald-700">
                            <Shield className="h-5 w-5" />
                        </div>
                        <div>
                            <h2 className="text-base font-semibold text-gray-900">
                                Anonymize document
                            </h2>
                            <p className="mt-0.5 truncate text-xs text-gray-500">
                                {filename}
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
                <div className="space-y-4 px-5 py-4">
                    {/* Target selector */}
                    <fieldset>
                        <legend className="mb-2 text-xs font-medium text-gray-700">
                            Where should this run?
                        </legend>
                        <div className="space-y-1.5">
                            <TargetRadio
                                value="auto"
                                current={target}
                                onChange={setTarget}
                                label="Auto"
                                caption={autoTargetHint}
                                dot={
                                    <span className="flex items-center gap-1.5">
                                        <span
                                            className={`h-2 w-2 rounded-full ${macminiDot}`}
                                            title={`Mac Mini: ${health?.macmini.status ?? "loading"}`}
                                        />
                                        <span
                                            className={`h-2 w-2 rounded-full ${macbookDot}`}
                                            title={`MacBook: ${health?.macbook.status ?? "loading"}`}
                                        />
                                    </span>
                                }
                            />
                            <TargetRadio
                                value="macmini"
                                current={target}
                                onChange={setTarget}
                                label="Force Mac Mini"
                                caption="gemma4-v4, higher quality, slower"
                                dot={
                                    <span
                                        className={`h-2 w-2 rounded-full ${macminiDot}`}
                                    />
                                }
                            />
                            <TargetRadio
                                value="local"
                                current={target}
                                onChange={setTarget}
                                label="Force MacBook (offline-safe)"
                                caption="Document never leaves this laptop. qwen3:4b — review entity coverage carefully."
                                dot={
                                    <span
                                        className={`h-2 w-2 rounded-full ${macbookDot}`}
                                    />
                                }
                            />
                        </div>
                    </fieldset>

                    {/* Exclude types */}
                    <fieldset>
                        <legend className="mb-2 text-xs font-medium text-gray-700">
                            Keep visible (don&apos;t replace)
                        </legend>
                        <div className="grid grid-cols-2 gap-1.5">
                            {EXCLUDE_OPTIONS.map((opt) => {
                                const checked = excludeTypes.has(opt.value);
                                return (
                                    <label
                                        key={opt.value}
                                        className={`flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs ${
                                            checked
                                                ? "border-emerald-400 bg-emerald-50/60"
                                                : "border-gray-200 hover:bg-gray-50"
                                        }`}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={checked}
                                            onChange={() => {
                                                const next = new Set(excludeTypes);
                                                if (checked) next.delete(opt.value);
                                                else next.add(opt.value);
                                                setExcludeTypes(next);
                                            }}
                                            className="mt-0.5 h-3 w-3 accent-emerald-600"
                                        />
                                        <span>
                                            <span className="block font-medium text-gray-800">
                                                {opt.label}
                                            </span>
                                            <span className="block text-[11px] text-gray-500">
                                                {opt.hint}
                                            </span>
                                        </span>
                                    </label>
                                );
                            })}
                        </div>
                    </fieldset>

                    {/* Result / Error */}
                    {error && (
                        <div className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <div className="break-words">{error}</div>
                        </div>
                    )}
                    {result && (
                        <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <div>
                                <div className="font-medium">
                                    Anonymized — {result.entity_count} entities, ran
                                    on {result.executed_on}, {Math.round(result.latency_ms / 1000)} s
                                </div>
                                <div className="mt-0.5 text-emerald-700/80">
                                    Saved as a new version. Use the download buttons below.
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
                                disabled={running}
                                className="flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                            >
                                {running && (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                )}
                                {running ? "Anonymizing…" : "Anonymize"}
                            </button>
                        </>
                    ) : (
                        <>
                            <button
                                onClick={handleDownloadAnonymized}
                                disabled={downloading}
                                className="flex items-center gap-1.5 rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                            >
                                <ExternalLink className="h-3.5 w-3.5" />
                                Open anonymized
                            </button>
                            <button
                                onClick={handleDownloadRestored}
                                disabled={downloading}
                                className="flex items-center gap-1.5 rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                            >
                                <Download className="h-3.5 w-3.5" />
                                Restore round-trip
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

interface TargetRadioProps {
    value: AnonymizerTarget;
    current: AnonymizerTarget;
    onChange: (t: AnonymizerTarget) => void;
    label: string;
    caption: string;
    dot?: React.ReactNode;
}

function TargetRadio({
    value,
    current,
    onChange,
    label,
    caption,
    dot,
}: TargetRadioProps) {
    const selected = value === current;
    return (
        <label
            className={`flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 text-sm ${
                selected
                    ? "border-emerald-500 bg-emerald-50/70"
                    : "border-gray-200 hover:bg-gray-50"
            }`}
        >
            <input
                type="radio"
                name="anon-target"
                value={value}
                checked={selected}
                onChange={() => onChange(value)}
                className="accent-emerald-600"
            />
            <span className="flex-1">
                <span className="block font-medium text-gray-800">{label}</span>
                <span className="block text-[11px] text-gray-500">{caption}</span>
            </span>
            {dot}
        </label>
    );
}
