import { useId } from "react";
import { useTranslation } from "@/i18n";
import { ArchiveIcon, TriangleAlertIcon } from "lucide-react";
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
  const maskId = useId();
  const StatusIcon = conflict ? TriangleAlertIcon : shelved ? ArchiveIcon : null;
  const label = [conflict && t("p4.status.needsResolve"), shelved && t("p4.shelved")].filter(Boolean).join(" · ");
  const marker = <span className="inline-flex size-4 shrink-0" style={{color: opened ? "var(--graph-9)" : "var(--graph-1)"}} role={label ? "img" : undefined} aria-label={label || undefined} aria-hidden={!label}>
    <svg aria-hidden viewBox="0 0 20 20" className="size-4">
      {StatusIcon ? <defs><mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="20" height="20">
        <rect width="20" height="20" fill="white" />
        <StatusIcon className="size-2.5" x="10" y="10" width="10" height="10" fill="black" stroke="black" strokeWidth="6" />
      </mask></defs> : null}
      <path d="M9 2 17 16H1Z" fill="currentColor" mask={StatusIcon ? `url(#${maskId})` : undefined} />
      {StatusIcon ? <StatusIcon className="size-2.5" x="10" y="10" width="10" height="10" strokeWidth="2.25" /> : null}
    </svg>
  </span>;
  return label ? <HoverTip label={label}>{marker}</HoverTip> : marker;
}
