"use client";

import { useEffect, useState } from "react";
import { Check, Shield, ShieldOff } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Lightweight toggle for the chat-side auto-anonymize feature.
 *
 * State lives in localStorage so every chat + tabular surface reads from
 * one source (anonymizePrefs.readAnonymizePrefs). This component just
 * mutates those keys + re-renders.
 *
 *   localStorage.mike.anonymize_before_send  "true" | "false"
 *   localStorage.mike.anonymize_target       "auto" | "local" | "macmini"
 */

type Target = "auto" | "local" | "macmini";

function readPrefs(): { enabled: boolean; target: Target } {
    if (typeof window === "undefined") {
        return { enabled: false, target: "auto" };
    }
    const enabled =
        window.localStorage.getItem("mike.anonymize_before_send") === "true";
    const t = window.localStorage.getItem("mike.anonymize_target");
    const target: Target = t === "local" || t === "macmini" ? t : "auto";
    return { enabled, target };
}

function writePrefs(enabled: boolean, target: Target): void {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
        "mike.anonymize_before_send",
        enabled ? "true" : "false",
    );
    window.localStorage.setItem("mike.anonymize_target", target);
    // Notify other components in this tab (storage event only fires across
    // tabs). Custom event so anyone listening can refresh their own state.
    window.dispatchEvent(new CustomEvent("mike:anonymize_prefs_changed"));
}

export function useAnonymizePrefs() {
    const [prefs, setPrefs] = useState<{ enabled: boolean; target: Target }>({
        enabled: false,
        target: "auto",
    });

    useEffect(() => {
        const refresh = () => setPrefs(readPrefs());
        refresh();
        const handler = () => refresh();
        window.addEventListener("mike:anonymize_prefs_changed", handler);
        window.addEventListener("storage", handler);
        return () => {
            window.removeEventListener("mike:anonymize_prefs_changed", handler);
            window.removeEventListener("storage", handler);
        };
    }, []);

    return prefs;
}

interface Props {
    /** Hide on routes where anonymize doesn't apply. */
    hidden?: boolean;
}

export function AnonymizeToggle({ hidden }: Props) {
    const { enabled, target } = useAnonymizePrefs();
    if (hidden) return null;

    const label =
        target === "macmini"
            ? "Mac Mini"
            : target === "local"
              ? "MacBook"
              : "Auto";

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label="Auto-anonymize before cloud LLM"
                    title={
                        enabled
                            ? `Auto-anonymize ON — ${label}`
                            : "Auto-anonymize OFF"
                    }
                    className={`flex items-center gap-1.5 rounded-lg px-2 h-8 text-sm transition-colors ${
                        enabled
                            ? "text-emerald-700 bg-emerald-50/70 hover:bg-emerald-100"
                            : "text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                    }`}
                >
                    {enabled ? (
                        <Shield className="h-3.5 w-3.5" />
                    ) : (
                        <ShieldOff className="h-3.5 w-3.5" />
                    )}
                    <span className="hidden sm:inline">
                        {enabled ? `Anon · ${label}` : "Anon"}
                    </span>
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-64" align="start">
                <DropdownMenuLabel className="text-xs font-medium text-gray-500">
                    Auto-anonymize before cloud LLM
                </DropdownMenuLabel>
                <DropdownMenuItem
                    className="cursor-pointer"
                    onSelect={() => writePrefs(false, target)}
                >
                    <span className="flex items-center gap-2 text-sm">
                        {!enabled && <Check className="h-3.5 w-3.5 text-emerald-600" />}
                        <span className={enabled ? "ml-5" : ""}>Off (send originals)</span>
                    </span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs font-medium text-gray-500">
                    On — pick a sidecar
                </DropdownMenuLabel>
                <DropdownMenuItem
                    className="cursor-pointer"
                    onSelect={() => writePrefs(true, "auto")}
                >
                    <span className="flex items-center gap-2 text-sm">
                        {enabled && target === "auto" && (
                            <Check className="h-3.5 w-3.5 text-emerald-600" />
                        )}
                        <span className={enabled && target === "auto" ? "" : "ml-5"}>
                            <span className="font-medium">Auto</span>
                            <span className="block text-[11px] text-gray-500">
                                Mac Mini, then MacBook fallback
                            </span>
                        </span>
                    </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                    className="cursor-pointer"
                    onSelect={() => writePrefs(true, "macmini")}
                >
                    <span className="flex items-center gap-2 text-sm">
                        {enabled && target === "macmini" && (
                            <Check className="h-3.5 w-3.5 text-emerald-600" />
                        )}
                        <span className={enabled && target === "macmini" ? "" : "ml-5"}>
                            <span className="font-medium">Force Mac Mini</span>
                            <span className="block text-[11px] text-gray-500">
                                gemma4-v4, higher quality
                            </span>
                        </span>
                    </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                    className="cursor-pointer"
                    onSelect={() => writePrefs(true, "local")}
                >
                    <span className="flex items-center gap-2 text-sm">
                        {enabled && target === "local" && (
                            <Check className="h-3.5 w-3.5 text-emerald-600" />
                        )}
                        <span className={enabled && target === "local" ? "" : "ml-5"}>
                            <span className="font-medium">Force MacBook</span>
                            <span className="block text-[11px] text-gray-500">
                                Offline-safe. qwen3:4b — check entity coverage.
                            </span>
                        </span>
                    </span>
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
