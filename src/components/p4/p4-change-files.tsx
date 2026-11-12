import { GitBranchIcon } from "lucide-react";
import { toast } from "sonner";
import { CommitMessage } from "@/components/commit-message";
import { AuthorAvatar } from "@/components/author-avatar";
import { FileRowsSkeleton } from "@/components/skeletons";
import { FileStatusIcon } from "@/components/p4/file-status-icon";
import { HoverTip } from "@/components/ui/tooltip";
import { t, useTranslation } from "@/i18n";
import { formatAbsoluteTime, formatExactTime } from "@/lib/format";
import { depotBase, p4ActionStatus } from "@/lib/p4";
import { cn } from "@/lib/utils";
import type { P4Changelist } from "@/types/p4";

async function copyText(value: string, success: string) {
  if (!value) {
    toast.error(t("p4.nothingToCopy"));
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    toast.success(success);
  } catch {
    toast.error(t("p4.couldNotCopy"));
  }
}

export function P4ChangeFiles({ detail, summary, file, loading = false, binaryPath, onSelect, onStream }: {
  detail: P4Changelist | null;
  summary?: P4Changelist | null;
  file: string | null;
  loading?: boolean;
  binaryPath?: string;
  onSelect: (path: string) => void;
  onStream?: () => void;
}) {
  useTranslation();
  const meta = detail ?? summary;
  return (
    <div className="absolute inset-0 flex min-h-0 flex-col">
      <CommitMessage key={meta?.id ?? "empty"} className="border-b" message={meta?.description || (meta ? t("p4.changeNumber", { id: meta.id }) : "")} metadata={<>
        {meta ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <HoverTip label={t("p4.copyUser")}>
            <button
              type="button"
              className="inline-flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-muted hover:text-foreground"
              onClick={() => void copyText(meta.user, t("p4.copiedUser"))}
            >
              <AuthorAvatar vcs="perforce" name={meta.user} email="" className="size-4" />
              <span className="truncate">{meta.user}</span>
            </button>
            </HoverTip>
            {meta.time ? (
              <HoverTip label={formatExactTime(meta.time)}>
              <button
                type="button"
                className="shrink-0 rounded-md px-1 py-0.5 tabular-nums hover:bg-muted hover:text-foreground"
                onClick={() => void copyText(formatExactTime(meta.time), t("p4.copiedTime"))}
              >
                {formatAbsoluteTime(meta.time)}
              </button>
              </HoverTip>
            ) : null}
            <HoverTip label={t("p4.copyChangelist")}>
            <button
              type="button"
              className="shrink-0 rounded-md px-1 py-0.5 font-mono hover:bg-muted hover:text-foreground"
              onClick={() => void copyText(meta.id, t("p4.copiedChangelist"))}
            >
              #{meta.id}
            </button>
            </HoverTip>
          </div>
        ) : null}
      </>} />
      <div className="relative min-h-0 flex-1">
        {loading ? <FileRowsSkeleton fill /> : null}
        <div className={cn("absolute inset-0 overflow-auto px-1 py-1", loading && "hidden")}>
        {detail?.stream && onStream ? <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted/70" onClick={onStream}><GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{t("p4.streamWork.title")}</span><span className="font-mono text-[11px] text-muted-foreground">{depotBase(detail.stream.path)}</span></button> : null}
        {detail?.files.map((item) => (
          <button
            key={item.depotPath}
            type="button"
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted/70",
              file === item.depotPath && "bg-muted",
            )}
            onClick={() => onSelect(item.depotPath)}
          >
            <FileStatusIcon status={item.status || p4ActionStatus(item.action)} />
            <span className="min-w-0 flex-1 truncate font-mono" title={item.depotPath}>{depotBase(item.depotPath)}</span>
            {item.binary || binaryPath === item.depotPath ? (
              <span className="shrink-0 text-muted-foreground">{t("p4.binary")}</span>
            ) : null}
          </button>
        ))}
        </div>
      </div>
    </div>
  );
}
