import type { ReactNode } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function SyncPopover<Action extends string>({
  action,
  openAction,
  onOpenAction,
  label,
  hint,
  badge,
  icon,
  children,
  disabled,
}: {
  action: Action;
  openAction: Action | null;
  onOpenAction: (action: Action | null) => void;
  label: string;
  hint: string;
  badge?: number;
  icon: ReactNode;
  children: ReactNode;
  disabled?: boolean;
}) {

  const open = openAction === action;
  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => onOpenAction(next ? action : openAction === action ? null : openAction)}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverPrimitive.Trigger asChild>
            <ToolbarButton label={hint} badge={badge} disabled={disabled}>
              {icon}
            </ToolbarButton>
          </PopoverPrimitive.Trigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="z-50 w-64 max-w-64 min-w-0 origin-(--radix-popover-content-transform-origin) rounded-lg bg-popover p-3 text-popover-foreground shadow-md ring-1 ring-foreground/10 data-[side=bottom]:slide-in-from-top-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          onInteractOutside={(event) => {
            const target = event.target;
            if (target instanceof Element && target.closest("[data-slot=dropdown-menu-content]")) {
              event.preventDefault();
            }
          }}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

const actionClass =
  "h-[calc(1.75rem-2px)]! w-[calc(1.75rem-2px)]! rounded-[6px] text-foreground hover:bg-background dark:hover:bg-background";

export function ToolbarButton({
  label,
  badge,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { label: string; badge?: number }) {

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className={cn(actionClass, "relative")}
      aria-label={label}
      {...props}
    >
      {children}
      {badge != null ? (
        <span className="pointer-events-none absolute top-0.5 right-0.5 z-10 flex h-3 min-w-3 items-center justify-center rounded-full bg-foreground px-0.5 text-[9px] leading-none font-semibold text-background tabular-nums ring-2 ring-secondary">
          {badge}
        </span>
      ) : null}
    </Button>
  );
}
