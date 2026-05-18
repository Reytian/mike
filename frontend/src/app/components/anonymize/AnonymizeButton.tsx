"use client";

import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { AnonymizeModal } from "./AnonymizeModal";
import type { AnonymizeResult } from "@/app/lib/anonymizeApi";

interface Props {
    documentId: string;
    filename: string;
    /** Optional: notified when an anonymized version is produced. */
    onAnonymized?: (result: AnonymizeResult) => void;
    /** Visual variant. "ghost" is icon-only (for dense rows). */
    variant?: "ghost" | "primary";
    title?: string;
    className?: string;
}

export function AnonymizeButton({
    documentId,
    filename,
    onAnonymized,
    variant = "ghost",
    title = "Anonymize document",
    className,
}: Props) {
    const [open, setOpen] = useState(false);

    return (
        <>
            <button
                type="button"
                onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setOpen(true);
                }}
                title={title}
                aria-label={title}
                className={
                    className ??
                    (variant === "primary"
                        ? "flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
                        : "rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-emerald-700")
                }
            >
                <ShieldCheck className="h-4 w-4" />
                {variant === "primary" && <span>Anonymize</span>}
            </button>
            <AnonymizeModal
                open={open}
                onClose={() => setOpen(false)}
                documentId={documentId}
                filename={filename}
                onSuccess={(res) => {
                    onAnonymized?.(res);
                }}
            />
        </>
    );
}
