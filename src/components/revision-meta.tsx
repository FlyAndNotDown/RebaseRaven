import { AuthorAvatar } from "@/components/author-avatar";
import { HoverTip } from "@/components/ui/tooltip";
import { formatAbsoluteTime, formatExactTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export function RevisionDot({ before = true, after = true, extend = 0 }: { before?: boolean; after?: boolean; extend?: number }) {
  return <span aria-hidden className="relative w-4 shrink-0 self-stretch text-[var(--graph-1)]">
    {before ? <span className="absolute left-1/2 w-[2px] -translate-x-1/2 bg-current" style={{top:-extend, bottom:"50%"}} /> : null}
    {after ? <span className="absolute left-1/2 w-[2px] -translate-x-1/2 bg-current" style={{top:"50%", bottom:-extend}} /> : null}
    <span className="absolute top-1/2 left-1/2 size-2 -translate-1/2 rounded-full bg-current" />
  </span>;
}

export function AuthorName({
  name,
  email = "",
  className,
  vcs = "git",
}: {
  name: string;
  email?: string;
  className?: string;
  vcs?: "git" | "perforce";
}) {
  if (!name) return null;
  return (
    <span className={cn("flex w-28 shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground", className)}>
      <AuthorAvatar name={name} email={email} className="size-4" vcs={vcs} />
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}

export function ExactTime({ time, className }: { time: number; className?: string }) {
  if (!time) return null;
  return (
    <HoverTip label={formatExactTime(time)}>
      <span
        className={cn(
          "w-[7.25rem] shrink-0 text-right text-[11px] tabular-nums text-muted-foreground",
          className,
        )}
      >
        {formatAbsoluteTime(time)}
      </span>
    </HoverTip>
  );
}
