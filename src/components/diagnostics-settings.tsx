import { formatBytes, t, useTranslation } from "@/i18n";
import { useEffect, useId, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { CheckIcon, DownloadIcon, ExternalLinkIcon, FolderOpenIcon, InfoIcon, LoaderCircleIcon, RefreshCwIcon, TriangleAlertIcon, XIcon, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/tooltip";
import { diagnosticsApi } from "@/lib/diagnostics";
import type { DiagnosticSummary } from "@/types/diagnostics";

type Action = "refresh" | "export" | "directory" | "issues";
type Feedback = { outcome: "success" | "warning" | "error"; message: string };
const actions: Action[] = ["refresh", "export", "directory", "issues"];

export function DiagnosticsSettings() {
  useTranslation();
  const titleId = useId();
  const [summary, setSummary] = useState<DiagnosticSummary | null>(null);
  const [action, setAction] = useState<Action | null>("refresh");
  const [feedback, setFeedback] = useState<Partial<Record<Action, Feedback>>>({});
  const mounted = useRef(false);
  const busy = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let current = true;
    void diagnosticsApi.summary().then((value) => {
      if (current) setSummary(value);
    }).catch(() => {
      if (current) setFeedback((previous) => ({ ...previous, refresh: { outcome: "error", message: t("desktop.diagnosticsSettings.could_not_read_local_diagnostics_try_again") } }));
    }).finally(() => {
      if (current) {
        busy.current = false;
        setAction(null);
      }
    });
    return () => { current = false; mounted.current = false; };
  }, []);

  async function run(next: Action) {
    if (busy.current) return;
    busy.current = true;
    setAction(next);
    setFeedback((previous) => ({ ...previous, [next]: undefined }));
    try {
      switch (next) {
        case "refresh": {
          const value = await diagnosticsApi.summary();
          if (mounted.current) {
            setSummary(value);
            setFeedback((previous) => ({ ...previous, [next]: { outcome: "success", message: t("desktop.diagnosticsSettings.storage_refreshed") } }));
          }
          break;
        }
        case "export": {
          const destination = await save({
            title: t("desktop.diagnosticsSettings.export_local_diagnostics"),
            defaultPath: "rebasely-diagnostics.zip",
            filters: [{ name: t("desktop.diagnosticsSettings.zipArchive"), extensions: ["zip"] }],
          });
          if (!destination || !mounted.current) return;
          const result = await diagnosticsApi.export(destination);
          if (mounted.current) setFeedback((previous) => ({ ...previous, [next]: {
            outcome: result.skippedEntries > 0 ? "warning" : "success",
            message: result.skippedEntries > 0
              ? `${t("desktop.diagnosticsSettings.zip_exported_unrecognized_diagnostic_entries_were_excluded")} ${t("desktop.diagnosticsSettings.review_export_before_sharing")}`
              : t("desktop.diagnosticsSettings.zip_exported_review_it_before_sharing_in_an"),
          } }));
          break;
        }
        case "directory":
          await diagnosticsApi.openDirectory();
          if (mounted.current) setFeedback((previous) => ({ ...previous, [next]: { outcome: "success", message: t("desktop.diagnosticsSettings.diagnostics_folder_opened") } }));
          break;
        case "issues":
          await diagnosticsApi.openIssues();
          if (mounted.current) setFeedback((previous) => ({ ...previous, [next]: { outcome: "success", message: t("desktop.diagnosticsSettings.issues_opened") } }));
          break;
      }
    } catch {
      if (mounted.current) setFeedback((previous) => ({ ...previous, [next]: {
        outcome: "error",
        message: next === "export"
          ? t("desktop.diagnosticsSettings.could_not_export_diagnostics_choose_a_writable_zip")
          : next === "refresh" ? t("desktop.diagnosticsSettings.could_not_read_local_diagnostics_try_again")
          : next === "directory" ? t("desktop.diagnosticsSettings.could_not_open_the_diagnostics_folder_try_again")
          : t("desktop.diagnosticsSettings.could_not_open_issues_try_again"),
      } }));
    } finally {
      busy.current = false;
      if (mounted.current) setAction(null);
    }
  }

  function actionIcon(next: Action, IdleIcon: LucideIcon) {
    if (action === next) return <LoaderCircleIcon className="motion-safe:animate-spin" aria-hidden="true" />;
    const result = feedback[next];
    if (!result) return <IdleIcon aria-hidden="true" />;
    if (result.outcome === "error") return <XIcon className="text-destructive" aria-hidden="true" />;
    if (result.outcome === "warning") return <TriangleAlertIcon className="text-status-warning" aria-hidden="true" />;
    return <CheckIcon aria-hidden="true" />;
  }

  function actionTip(next: Action, idle: string) {
    return feedback[next]?.message ?? idle;
  }

  function announcement(next: Action) {
    return action === next && next === "export" ? t("desktop.diagnosticsSettings.exporting")
      : action === next && next === "refresh" ? t("desktop.diagnosticsSettings.reading_diagnostic_storage") : feedback[next]?.message ?? "";
  }

  return (
    <section aria-labelledby={titleId} className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <h3 id={titleId} className="text-sm font-medium">{t("desktop.diagnosticsSettings.local_diagnostics")}</h3>
          <HoverTip label={[
            t("desktop.diagnosticsSettings.local_log_contents"),
            summary ? t("desktop.diagnosticsSettings.retention", { days: summary.retentionDays, maximum: formatBytes(summary.maxBytes) }) : "",
          ].filter(Boolean).join("\n")}>
            <Button variant="ghost" size="icon-xs" aria-label={t("desktop.diagnosticsSettings.about_local_diagnostics")}><InfoIcon /></Button>
          </HoverTip>
        </div>
        <HoverTip label={actionTip("refresh", t("desktop.diagnosticsSettings.refresh_diagnostic_storage_usage"))}>
          <Button variant="outline" size="icon-sm" aria-label={t("desktop.diagnosticsSettings.refresh_diagnostic_storage_usage")} aria-describedby={`${titleId}-refresh-feedback`} aria-busy={action === "refresh"} disabled={action !== null} onClick={() => void run("refresh")}>
            {actionIcon("refresh", RefreshCwIcon)}
          </Button>
        </HoverTip>
      </div>
      <p role="status" className="text-xs text-muted-foreground">
        {summary ? t("desktop.diagnosticsSettings.storageUsage", { used: formatBytes(summary.totalBytes), maximum: formatBytes(summary.maxBytes), count: summary.fileCount })
          : action === "refresh" ? t("desktop.diagnosticsSettings.reading_diagnostic_storage") : t("desktop.diagnosticsSettings.storage_usage_unavailable")}
      </p>
      <div className="flex flex-wrap gap-2">
        <HoverTip label={actionTip("export", t("desktop.diagnosticsSettings.review_export_before_sharing"))}>
          <Button size="sm" disabled={action !== null} aria-busy={action === "export"} aria-describedby={`${titleId}-export-feedback`} onClick={() => void run("export")}>
            {actionIcon("export", DownloadIcon)}{t("desktop.diagnosticsSettings.export_zip")}
          </Button>
        </HoverTip>
        <HoverTip label={actionTip("directory", t("desktop.sshKeysSettings.open_folder"))}>
          <Button variant="outline" size="sm" disabled={action !== null} aria-busy={action === "directory"} aria-describedby={`${titleId}-directory-feedback`} onClick={() => void run("directory")}>
            {actionIcon("directory", FolderOpenIcon)}{t("desktop.sshKeysSettings.open_folder")}
          </Button>
        </HoverTip>
        <HoverTip label={actionTip("issues", t("desktop.diagnosticsSettings.open_issues"))}>
          <Button variant="outline" size="sm" disabled={action !== null} aria-busy={action === "issues"} aria-describedby={`${titleId}-issues-feedback`} onClick={() => void run("issues")}>
            {actionIcon("issues", ExternalLinkIcon)}{t("desktop.diagnosticsSettings.open_issues")}
          </Button>
        </HoverTip>
      </div>
      {actions.map((next) => <span key={next} id={`${titleId}-${next}-feedback`} role="status" aria-atomic="true" className="sr-only">{announcement(next)}</span>)}
    </section>
  );
}
