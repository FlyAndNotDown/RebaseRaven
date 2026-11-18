import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { t } from "@/i18n";
import { activityApi } from "@/lib/activity";
import { progressFromGitLine } from "./snapshot-compare";
import type { Activity } from "@/types/git";

const ActivityContext = createContext<Activity[]>([]);
const ActionContext = createContext<ReturnType<typeof useActivityController>["actions"] | null>(null);

function useActivityController(activeTabIdRef: RefObject<string>) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const activityStops = useRef(new Map<string, "ready" | "requested">());
  const runActivity = useCallback(
    async <T,>(
      label: string,
      detail: string | undefined,
      fn: (activityId: string) => Promise<T>,
      cancellable = false,
      tabId?: string,
    ) => {
      const id = crypto.randomUUID();
      const owner = tabId ?? activeTabIdRef.current;
      const reservation = cancellable ? await activityApi.reserve(id) : null;
      if (cancellable) activityStops.current.set(id, "ready");
      setActivities((current) => [...current, { id, label, detail, cancellable, tabId: owner }]);
      try {
        return await fn(id);
      } finally {
        activityStops.current.delete(id);
        setActivities((current) => current.filter((item) => item.id !== id));
        await reservation?.close();
      }
    },
    [activeTabIdRef],
  );

  const beginActivity = useCallback((label: string, detail?: string, progress?: number, tabId?: string) => {
    const id = crypto.randomUUID();
    const owner = tabId ?? activeTabIdRef.current;
    setActivities((current) => [...current, { id, label, detail, progress, tabId: owner }]);
    return id;
  }, [activeTabIdRef]);

  const patchActivity = useCallback(
    (id: string, patch: Partial<Pick<Activity, "label" | "detail" | "progress" | "cancelling">>) => {
      setActivities((current) =>
        current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      );
    },
    [],
  );

  const cancelActivity = useCallback(async (id: string) => {
    if (activityStops.current.get(id) !== "ready") return;
    activityStops.current.set(id, "requested");
    patchActivity(id, { cancelling: true });
    const accepted = await activityApi.cancel(id).catch(() => false);
    if (accepted || !activityStops.current.has(id)) return;
    activityStops.current.set(id, "ready");
    patchActivity(id, { cancelling: false });
    toast.warning(t("desktop.activityMeter.cancelUnavailable"));
  }, [patchActivity]);

  const endActivity = useCallback((id: string) => {
    setActivities((current) =>
      current.some((item) => item.id === id) ? current.filter((item) => item.id !== id) : current,
    );
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let frame = 0;
    const latest = new Map<string, string>();
    const flush = () => {
      frame = 0;
      const batch = new Map(latest);
      latest.clear();
      setActivities((current) =>
        current.map((item) => {
          const line = batch.get(item.id);
          if (line === undefined) return item;
          const progress = progressFromGitLine(line);
          return { ...item, detail: line, progress: progress ?? item.progress };
        }),
      );
    };
    void listen<{ id: string; line: string }>("git-progress", (event) => {
      latest.set(event.payload.id, event.payload.line);
      if (!frame) frame = requestAnimationFrame(flush);
    }).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      unlisten?.();
    };
  }, []);

  const actions = useMemo(() => ({runActivity, beginActivity, patchActivity, cancelActivity, endActivity}),
    [runActivity, beginActivity, patchActivity, cancelActivity, endActivity]);
  return {activities, actions};
}

export function ActivityProvider({owner, children}: {owner: RefObject<string>; children: ReactNode}) {
  const {actions, activities} = useActivityController(owner);
  return <ActionContext.Provider value={actions}><ActivityContext.Provider value={activities}>{children}</ActivityContext.Provider></ActionContext.Provider>;
}

export function useActivityActions() {
  const actions = useContext(ActionContext);
  if (!actions) throw new Error("Activities require an ActivityProvider");
  return actions;
}

export function useActivities() {
  return useContext(ActivityContext);
}
