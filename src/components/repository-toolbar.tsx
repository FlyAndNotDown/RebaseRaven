import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function RepositoryRefButton({children, className, ...props}: Omit<ComponentProps<typeof Button>, "variant" | "size">) {
  return <Button {...props} variant="outline" size="sm" className={cn("max-w-44 shrink-0 font-mono text-[0.8rem]", className)}><span className="min-w-0 truncate">{children}</span></Button>;
}

export function RepositoryActions({children}: {children: ReactNode}) {
  return <div className="flex h-7 shrink-0 items-center gap-1.5 rounded-[min(var(--radius-md),12px)] border border-input bg-secondary px-0.5">{children}</div>;
}

export function ToolbarButton({label, badge, children, className, ...props}: ComponentProps<typeof Button> & {label: string; badge?: number}) {
  return <Button
    type="button"
    variant="ghost"
    size="icon-sm"
    className={cn("relative h-[calc(1.75rem-2px)]! w-[calc(1.75rem-2px)]! rounded-[6px] text-foreground hover:bg-background dark:hover:bg-background", className)}
    aria-label={label}
    {...props}
  >
    {children}
    {badge != null ? <span className="pointer-events-none absolute top-0.5 right-0.5 z-10 flex h-3 min-w-3 items-center justify-center rounded-full bg-foreground px-0.5 text-[9px] leading-none font-semibold text-background tabular-nums ring-2 ring-secondary">{badge}</span> : null}
  </Button>;
}
