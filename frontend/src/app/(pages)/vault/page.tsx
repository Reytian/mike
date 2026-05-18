"use client";

import { useEffect, useRef, useState } from "react";
import {
    File,
    FileText,
    Lock,
    Loader2,
    Trash2,
    Upload,
    Plus,
    AlertCircle,
    CheckCircle2,
    ShieldCheck,
} from "lucide-react";
import {
    deleteVaultDocument,
    getVaultDocumentUrl,
    listVaultDocuments,
    uploadVaultDocument,
    type VaultDocument,
} from "@/app/lib/vaultApi";
import { FillTemplateModal } from "@/app/components/vault/FillTemplateModal";

function bytesToHuman(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function VaultDocIcon({ ext }: { ext: string | null }) {
    if (ext === "pdf") return <FileText className="h-4 w-4 text-red-500" />;
    return <File className="h-4 w-4 text-blue-500" />;
}

function OcrBadge({ doc }: { doc: VaultDocument }) {
    if (doc.file_type !== "pdf") return null;
    switch (doc.ocr_status) {
        case "done":
            return (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                    <CheckCircle2 className="h-2.5 w-2.5" /> OCR
                </span>
            );
        case "skipped":
            return (
                <span className="inline-flex items-center gap-1 rounded-full bg-gray-50 px-2 py-0.5 text-[10px] text-gray-500">
                    text layer
                </span>
            );
        case "failed":
            return (
                <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-medium text-rose-700">
                    <AlertCircle className="h-2.5 w-2.5" /> OCR failed
                </span>
            );
        case "pending":
            return (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700">
                    <Loader2 className="h-2.5 w-2.5 animate-spin" /> OCR…
                </span>
            );
        default:
            return null;
    }
}

export default function VaultPage() {
    const [docs, setDocs] = useState<VaultDocument[]>([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [fillOpen, setFillOpen] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const refresh = async () => {
        setLoading(true);
        try {
            const list = await listVaultDocuments();
            setDocs(list);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        refresh();
    }, []);

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        setUploading(true);
        setError(null);
        try {
            for (const f of files) {
                await uploadVaultDocument(f);
            }
            await refresh();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm("Delete this vault document?")) return;
        try {
            await deleteVaultDocument(id);
            setDocs((prev) => prev.filter((d) => d.id !== id));
        } catch (err) {
            setError((err as Error).message);
        }
    };

    const handleOpen = async (id: string) => {
        try {
            const { url } = await getVaultDocumentUrl(id);
            window.open(url, "_blank", "noopener,noreferrer");
        } catch (err) {
            setError((err as Error).message);
        }
    };

    return (
        <div className="mx-auto max-w-4xl p-6">
            <div className="mb-6 flex items-start justify-between gap-4">
                <div>
                    <h1 className="flex items-center gap-2 text-2xl font-semibold text-gray-900">
                        <Lock className="h-5 w-5 text-emerald-600" />
                        Client vault
                    </h1>
                    <p className="mt-1 max-w-2xl text-sm text-gray-500">
                        Documents in the vault are stored locally and are{" "}
                        <span className="font-medium text-gray-700">
                            never sent to any cloud LLM
                        </span>
                        . Use them as the source for filling templates with
                        private client information.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={() => setFillOpen(true)}
                        className="flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-800 hover:bg-emerald-100"
                    >
                        <ShieldCheck className="h-3.5 w-3.5" />
                        Fill template
                    </button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".pdf,.docx,.doc,.txt,.md"
                        multiple
                        className="hidden"
                        onChange={handleUpload}
                    />
                    <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploading}
                        className="flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
                    >
                        {uploading ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <Plus className="h-3.5 w-3.5" />
                        )}
                        {uploading ? "Uploading…" : "Add to vault"}
                    </button>
                </div>
            </div>

            {error && (
                <div className="mb-4 flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <div>{error}</div>
                </div>
            )}

            <div className="overflow-hidden rounded-lg border border-gray-100">
                {loading ? (
                    <div className="flex items-center justify-center py-12 text-sm text-gray-400">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Loading vault…
                    </div>
                ) : docs.length === 0 ? (
                    <div className="px-4 py-12 text-center text-sm text-gray-400">
                        <Upload className="mx-auto mb-2 h-6 w-6 text-gray-300" />
                        No vault documents yet. Add registration documents,
                        passports, board resolutions, or anything else that
                        should never reach a cloud LLM.
                    </div>
                ) : (
                    <ul className="divide-y divide-gray-100">
                        {docs.map((d) => (
                            <li
                                key={d.id}
                                className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50"
                            >
                                <VaultDocIcon ext={d.file_type} />
                                <button
                                    type="button"
                                    onClick={() => handleOpen(d.id)}
                                    className="flex-1 truncate text-left text-sm text-gray-800 hover:text-emerald-700 hover:underline"
                                >
                                    {d.filename}
                                </button>
                                <OcrBadge doc={d} />
                                <span className="text-xs text-gray-400">
                                    {bytesToHuman(d.size_bytes)}
                                </span>
                                <span className="text-xs text-gray-300">
                                    {new Date(d.created_at).toLocaleDateString(
                                        undefined,
                                        {
                                            month: "short",
                                            day: "numeric",
                                            year: "numeric",
                                        },
                                    )}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => handleDelete(d.id)}
                                    className="rounded-md p-1 text-gray-400 hover:bg-rose-50 hover:text-rose-600"
                                    aria-label={`Delete ${d.filename}`}
                                >
                                    <Trash2 className="h-3.5 w-3.5" />
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <FillTemplateModal
                open={fillOpen}
                onClose={() => setFillOpen(false)}
                vaultDocs={docs}
            />
        </div>
    );
}
