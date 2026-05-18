/**
 * Shared "auto-anonymize" preferences read from localStorage.
 *
 * Until we add a proper UI toggle, users opt into auto-anonymize for chat
 * and tabular flows by setting:
 *
 *   localStorage.setItem("mike.anonymize_before_send", "true")
 *   localStorage.setItem("mike.anonymize_target", "auto"|"local"|"macmini")
 *
 * Both keys are read on every request, so toggling takes effect on the
 * next chat turn / tabular generation — no reload needed.
 */

export interface AnonymizePrefs {
    anonymizeBeforeSend: boolean;
    anonymizeTarget: "auto" | "local" | "macmini";
}

export function readAnonymizePrefs(): AnonymizePrefs {
    if (typeof window === "undefined") {
        return { anonymizeBeforeSend: false, anonymizeTarget: "auto" };
    }
    const flag = window.localStorage.getItem("mike.anonymize_before_send") === "true";
    const t = window.localStorage.getItem("mike.anonymize_target");
    const target: AnonymizePrefs["anonymizeTarget"] =
        t === "local" || t === "macmini" ? t : "auto";
    return { anonymizeBeforeSend: flag, anonymizeTarget: target };
}
