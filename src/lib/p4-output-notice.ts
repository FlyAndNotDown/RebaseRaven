import { toast } from "sonner";
import { t } from "@/i18n";
import { formatSyncCounts, syncSummary } from "@/lib/p4";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import type { P4AutoResolveSummary, P4SyncSummary } from "@/types/p4";

type WarningKind = keyof P4SyncSummary["warnings"];
export interface P4OutputNotice {
  kind: "success" | "info" | "warning" | "error";
  message: string;
}

const warningKinds: WarningKind[] = ["inUse", "targetExists", "writable", "modified", "opened", "resolve", "outsideView"];

function warning(line: string): { kind: WarningKind; file: string } | null {
  const writable = /^Can't clobber writable file (.+)$/i.exec(line);
  if (writable) return { kind: "writable", file: writable[1] };
  const modified = /^Can't (?:clobber|overwrite) modified file (.+)$/i.exec(line);
  if (modified) return { kind: "modified", file: modified[1] };
  const entry = /^(.*?) - (.+)$/.exec(line);
  if (!entry) return null;
  const [, file, status] = entry;
  if (/^can't (?:update|delete) (?:open|opened) file(?: .*)?$/i.test(status)
    || /^is opened and not being changed\.?$/i.test(status)
    || /^is opened for .+ and can't be (?:deleted|updated)\.?$/i.test(status)) {
    return { kind: "opened", file };
  }
  if (/^can't (?:update|overwrite) modified file(?: .*)?$/i.test(status)) return { kind: "modified", file };
  if (/^must resolve(?: .*)?$/i.test(status)) return { kind: "resolve", file };
  if (/^file\(s\) not in client view\.?$/i.test(status)) return { kind: "outsideView", file };
  return null;
}

function fileKey(file: string): string {
  const path = file.trim();
  // Depot paths can be case sensitive even when the local machine is Windows.
  if (path.startsWith("//")) return path.replace(/#\d+$/, "");
  return /^(?:[a-z]:[\\/]|\\\\)/i.test(path) ? path.replace(/\\/g, "/").toLowerCase() : path;
}

function isProgress(line: string): boolean {
  return /^\/\/.+ - (?:updating|refreshing|replacing|added as|deleted as|moved from|moved to) .+$/.test(line);
}

function isUnchanged(line: string): boolean {
  const status = messageBody(line);
  return /^(?:file\(s\) up-to-date|up to date|no file\(s\) to (?:resolve|reconcile|revert))\.?$/i.test(status);
}

function shortReason(line: string): string {
  const reason = p4DisplayError(messageBody(line)).replace(/\s+/g, " ").trim();
  return reason.length > 180 ? `${reason.slice(0, 179)}…` : reason;
}

function messageBody(line: string): string {
  return /^(?:\/|[a-z]:[\\/]|\\\\|\.\.\.)/i.test(line) ? line.replace(/^.*? - /, "") : line;
}

/** Summarize native diagnostics without mistaking file progress for failures. */
function outputNotice(output: string, succeeded: boolean, autoResolve?: P4AutoResolveSummary | null): P4OutputNotice {
  const files = new Map(warningKinds.map(kind => [kind, new Set<string>()]));
  let unchanged = false;
  let firstError = "";
  let errors = 0;
  // Iterate rather than split: a large sync can return hundreds of MB of progress.
  for (const match of output.matchAll(/[^\r\n]+/g)) {
    const line = match[0].trim().replace(/^warning:\s*/i, "");
    if (!line) continue;
    const skipped = warning(line);
    if (skipped) files.get(skipped.kind)!.add(fileKey(skipped.file));
    else if (isUnchanged(line)) unchanged = true;
    else if (!isProgress(line)) {
      if (!firstError || /^Perforce .+ error:$/i.test(firstError)) firstError = shortReason(line);
      errors += 1;
    }
  }
  return formatNotice(Object.fromEntries([...files].map(([kind,entries]) => [kind,entries.size])), errors, firstError, unchanged, succeeded, () => syncSummary(output), autoResolve);
}

function formatNotice(warnings: P4SyncSummary["warnings"], errors: number, firstError: string, unchanged: boolean,
  succeeded: boolean, counts: () => string, autoResolve?: P4AutoResolveSummary | null): P4OutputNotice {
  const messages = warningKinds.flatMap(kind => {
    if (autoResolve && kind === "resolve") return [];
    const count = warnings[kind] ?? 0;
    return count ? [t(`p4.feedback.${kind}`, { count })] : [];
  });
  if (errors > 0) {
    const more = errors > 1 ? t("p4.feedback.more", { count: errors - 1 }) : "";
    const diagnostics = [firstError || t("p4.feedback.failed"), more].filter(Boolean);
    if (!succeeded) return { kind: "error", message: [...diagnostics, ...messages].join(" · ") };
    messages.unshift(...diagnostics);
  }
  if (autoResolve) {
    const message = t("p4.autoResolveSummary", { resolved: autoResolve.resolved, remaining: autoResolve.remaining });
    return {
      kind: messages.length || autoResolve.remaining > 0 || autoResolve.failed ? "warning" : "success",
      message: [...messages, message].join(" · "),
    };
  }
  if (messages.length) return { kind: "warning", message: messages.join(" · ") };
  if (succeeded) return { kind: "success", message: counts() };
  if (unchanged) return { kind: "info", message: t("p4.feedback.noChanges") };
  return { kind: "error", message: t("p4.feedback.failed") };
}

export function p4ErrorNotice(output: string): P4OutputNotice {
  return outputNotice(output, false);
}

export function p4SyncNotice(output: P4SyncSummary | string, autoResolve?: P4AutoResolveSummary | null): P4OutputNotice {
  if (typeof output === "string") return outputNotice(output, true, autoResolve);
  return formatNotice(output.warnings, output.diagnostics, shortReason(output.firstDiagnostic), output.unchanged,
    !output.failed, () => formatSyncCounts(output), autoResolve);
}

export function notifyP4Error(message: string): void {
  if (!message) return;
  const notice = p4ErrorNotice(message);
  toast[notice.kind](notice.message);
}
