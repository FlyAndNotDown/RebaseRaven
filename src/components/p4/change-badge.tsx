import { useTranslation } from "@/i18n";
import { ArchiveIcon, TriangleAlertIcon } from "lucide-react";
import { IconBadge } from "@/components/icon-badge";
import { HoverTip } from "@/components/ui/tooltip";

export function ChangeBadge({ id }: { id: string }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex h-4 shrink-0 items-center rounded bg-foreground/12 px-1 font-mono text-[10px] leading-none font-medium text-foreground/80 tabular-nums">
      {id === "default" ? t("p4.defaultChange") : `#${id}`}
    </span>
  );
}

export function ChangelistMarker({ opened, shelved = false, conflict = false }: { opened: boolean; shelved?: boolean; conflict?: boolean }) {
  const { t } = useTranslation();
  const label = [conflict && t("p4.status.needsResolve"), shelved && t("p4.shelved")].filter(Boolean).join(" · ");
  const marker = <span className="relative inline-flex size-3.5 shrink-0" role={label ? "img" : undefined} aria-label={label || undefined} aria-hidden={!label}>
    <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" style={{color: opened ? "var(--graph-9)" : "var(--graph-1)"}}><path d="M8 2 15 14H1Z" fill="currentColor" /></svg>
    {conflict ? <IconBadge><TriangleAlertIcon className="size-2.5 text-status-warning" /></IconBadge> : shelved ? <IconBadge><ArchiveIcon className="size-2.5 text-diff-hunk" /></IconBadge> : null}
  </span>;
  return label ? <HoverTip label={label}>{marker}</HoverTip> : marker;
}
