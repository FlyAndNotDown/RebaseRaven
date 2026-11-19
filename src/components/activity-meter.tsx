import { useTranslation } from "@/i18n";
import { useId, useState } from "react";
import { LoaderCircleIcon, XIcon } from "lucide-react";
import { Popover } from "radix-ui";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useActivities, useGitPick } from "@/state/git-context";
import type { Activity } from "@/types/git";

export function ActivityMeter() {
  const { t } = useTranslation();
  const titleId = useId();
  const { activeTabId, cancelActivity } = useGitPick(["activeTabId", "cancelActivity"]);
  const activities = useActivities().filter((activity) => activity.tabId === activeTabId);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  if (activities.length === 0) return null;

  const latest = activities[activities.length - 1];

  return (
    <Popover.Root
      key={activeTabId}
      onOpenChange={(open) => {
        if (!open) setExpandedId(null);
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className="ml-2 flex h-7 w-40 shrink-0 items-center gap-1.5 rounded-md px-1.5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted"
          aria-label={
            activities.length === 1
              ? latest.label
              : t("desktop.activityMeter.operations", { count: activities.length })
          }
        >
          <ActivityBar activity={latest} />
          {latest.progress != null ? (
            <span className="w-7 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
              {Math.round(latest.progress)}%
            </span>
          ) : null}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          aria-labelledby={titleId}
          className="z-50 w-[36rem] max-w-(--radix-popover-content-available-width) max-h-[min(24rem,var(--radix-popover-content-available-height))] overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <p id={titleId} className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
            {activities.length === 1 ? t("desktop.activityMeter.running") : t("desktop.activityMeter.running", { count: activities.length })}
          </p>
          {activities.map((activity) => {
            const expanded = expandedId === activity.id;
            const stopping = activity.cancelling;
            return (
              <div key={activity.id} className="flex items-center gap-2 rounded-md hover:bg-muted/60">
                <button
                  type="button"
                  className="min-w-0 flex-1 rounded-md px-2 py-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                  aria-expanded={expanded}
                  onClick={() => setExpandedId(current => current === activity.id ? null : activity.id)}
                >
                  <span className="flex items-center gap-2">
                    <span className={cn("min-w-0 flex-1 text-sm", expanded ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "truncate")}>
                      {activity.label}
                    </span>
                    {activity.progress != null ? (
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                        {Math.round(activity.progress)}%
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-1.5 block"><ActivityBar activity={activity} /></span>
                  {activity.detail ? (
                    <span className={cn("mt-1 block font-mono text-[11px] text-muted-foreground", expanded ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "truncate")}>
                      {activity.detail}
                    </span>
                  ) : null}
                </button>
                {activity.cancellable ? (
                  <HoverTip label={t(stopping ? "desktop.activityMeter.stopping" : "common.cancel")}>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="mr-1 shrink-0"
                      disabled={stopping}
                      aria-label={t(stopping ? "desktop.activityMeter.cancelling" : "desktop.activityMeter.cancelNamed", { name: activity.label })}
                      onClick={() => void cancelActivity(activity.id)}
                    >
                      {stopping ? <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:animate-none" /> : <XIcon aria-hidden />}
                    </Button>
                  </HoverTip>
                ) : null}
                {stopping ? <span role="status" className="sr-only">{t("desktop.activityMeter.cancelling", { name: activity.label })}</span> : null}
              </div>
            );
          })}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function ActivityBar({ activity }: { activity: Activity }) {
  const progress = activity.progress;
  return (
    <span className="relative block h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
      {progress != null ? (
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-foreground/75 transition-[width] duration-150"
          style={{ width: `${progress}%` }}
        />
      ) : (
        <span className="activity-indeterminate absolute inset-y-0 left-0 rounded-full bg-foreground/75" />
      )}
    </span>
  );
}
