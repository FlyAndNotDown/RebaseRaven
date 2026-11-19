import { useTranslation } from "react-i18next";
import { HoverTip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type ChangeState = { opened?: boolean; shelved?: boolean; conflict?: boolean };

export function ChangeNumber({ id }: { id: string }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex h-4 shrink-0 items-center rounded bg-foreground/12 px-1 font-mono text-[10px] leading-none font-medium text-foreground/80 tabular-nums">
      {id === "default" ? t("p4.defaultChange") : `#${id}`}
    </span>
  );
}

export function ChangeBadge({ id, ...state }: { id: string } & ChangeState) {
  return <span className="inline-flex shrink-0 items-center gap-1.5 align-middle">
    <ChangelistMarker {...state} />
    <ChangeNumber id={id} />
  </span>;
}

export function SubmittedHistoryMarker({ before, after, className }: { before: boolean; after: boolean; className?: string }) {
  return <span aria-hidden className={cn("relative flex shrink-0 items-center self-stretch", className)}>
    {before && <span className="absolute top-0 bottom-[calc(50%+8px)] left-1/2 w-px -translate-x-1/2 bg-muted-foreground/45" />}
    <ChangelistMarker />
    {after && <span className="absolute top-[calc(50%+8px)] bottom-0 left-1/2 w-px -translate-x-1/2 bg-muted-foreground/45" />}
  </span>;
}

export function ChangelistMarker({ opened = false, shelved = false, conflict = false, className }: ChangeState & { className?: string }) {
  const { t } = useTranslation();
  const label = [conflict && t("p4.status.needsResolve"), shelved && t("p4.shelved")].filter(Boolean).join(" · ");
  const filled = opened && !conflict;
  const marker = (
    <span className={cn("inline-flex size-4 shrink-0", className)} role={label ? "img" : undefined}
      aria-label={label || undefined} aria-hidden={!label}>
      <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
        strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"
        className={cn("size-full", conflict ? "text-status-warning" : "text-muted-foreground")}>
        <path d="M8 1.5 15 14.5H1Z" fill={filled && !shelved ? "currentColor" : "none"} />
        {shelved && <>
          {filled && <path d="m8 1.5 5 9.25H3Z" fill="currentColor" stroke="none" />}
          <path d="M3 10.75h10" />
        </>}
        {conflict && <g transform={shelved ? undefined : "translate(0 1.25)"}>
          <path d="M8 4.85v1.8" />
          <circle cx="8" cy="8.75" r=".8" fill="currentColor" stroke="none" />
        </g>}
      </svg>
    </span>
  );
  return label ? <HoverTip label={label}>{marker}</HoverTip> : marker;
}
