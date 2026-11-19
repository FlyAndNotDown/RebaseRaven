import { AuthorAvatar } from "@/components/author-avatar";
import { HoverTip } from "@/components/ui/tooltip";
import { formatAbsoluteTime, formatExactTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export function AuthorName({
  name,
  email = "",
  className,
  title,
  vcs = "git",
  wrap = false,
}: {
  name: string;
  email?: string;
  className?: string;
  title?: string;
  vcs?: "git" | "perforce";
  wrap?: boolean;
}) {
  if (!name) return null;
  return (
    <span title={title} className={cn("flex w-28 shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground", className)}>
      <AuthorAvatar name={name} email={email} className="size-4" vcs={vcs} />
      <span className={cn("min-w-0", wrap ? "wrap-anywhere" : "truncate")}>{name}</span>
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
