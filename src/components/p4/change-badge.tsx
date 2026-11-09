import { useTranslation } from "@/i18n";

export function ChangeBadge({ id }: { id: string }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex h-4 shrink-0 items-center rounded bg-foreground/12 px-1 font-mono text-[10px] leading-none font-medium text-foreground/80 tabular-nums">
      {id === "default" ? t("p4.defaultChange") : `#${id}`}
    </span>
  );
}

export function ChangelistMarker({ opened }: { opened: boolean }) {
  return <svg aria-hidden viewBox="0 0 16 16" className="size-3.5 shrink-0" style={{color: opened ? "var(--graph-9)" : "var(--graph-1)"}}><path d="M8 2 15 14H1Z" fill="currentColor" /></svg>;
}
