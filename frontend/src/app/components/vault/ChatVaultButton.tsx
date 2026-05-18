"use client";

import { useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { listVaultDocuments, type VaultDocument } from "@/app/lib/vaultApi";
import { listProfiles, type ClientProfile } from "@/app/lib/profileApi";
import { FillTemplateModal } from "./FillTemplateModal";

/**
 * Lives in the chat input toolbar. Click to open the FillTemplateModal
 * with vault docs + profiles loaded on demand — no extra fetch unless
 * the user actually wants to fill.
 *
 * The cloud LLM never sees the vault contents this surfaces. The button
 * just hands off to the existing local-only fill workflow.
 */
export function ChatVaultButton() {
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [vaultDocs, setVaultDocs] = useState<VaultDocument[]>([]);
    const [profiles, setProfiles] = useState<ClientProfile[]>([]);
    const [error, setError] = useState<string | null>(null);

    const handleOpen = async () => {
        setLoading(true);
        setError(null);
        try {
            const [d, p] = await Promise.all([
                listVaultDocuments(),
                listProfiles(),
            ]);
            setVaultDocs(d);
            setProfiles(p);
            setOpen(true);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <>
            <button
                type="button"
                onClick={handleOpen}
                aria-label="Fill template from vault"
                title={
                    error
                        ? `Could not load vault: ${error}`
                        : "Fill template from vault (local-only)"
                }
                className="flex items-center gap-1.5 rounded-lg px-2 h-8 text-sm text-gray-400 hover:bg-gray-100 hover:text-emerald-700 transition-colors"
            >
                {loading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                    <ShieldCheck className="h-3.5 w-3.5" />
                )}
                <span className="hidden sm:inline">Vault</span>
            </button>
            <FillTemplateModal
                open={open}
                onClose={() => setOpen(false)}
                vaultDocs={vaultDocs}
                profiles={profiles}
            />
        </>
    );
}
