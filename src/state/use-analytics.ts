import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getIdentifier, getVersion } from "@tauri-apps/api/app";
import { identifier } from "../../src-tauri/tauri.conf.json";
import { analyticsInstallId, analyticsSessionAllowed, ANALYTICS_PULSE_MS, createAnalyticsController, registerAnalyticsStop, subscribeAnalyticsSession } from "@/lib/analytics";
import { createAnalyticsFrame } from "@/lib/analytics-frame";
import { isAnalyticsVersion } from "@/lib/analytics-protocol";
import { desktopPlatform } from "@/lib/desktop-platform";
import { useGitPick } from "./git-context";
import { useP4View } from "./p4-context";
import { analyticsPane, analyticsP4FilesMode, subscribeAnalyticsP4FilesMode } from "./analytics-screen";

export function useAnalyticsSessionAllowed() {
  return useSyncExternalStore(subscribeAnalyticsSession, analyticsSessionAllowed, analyticsSessionAllowed);
}

export function useAnalytics() {
  const { prefs, prefsReady, activeTab, view } = useGitPick(["prefs", "prefsReady", "activeTab", "view"]);
  const p4View = useP4View();
  const allowed = useAnalyticsSessionAllowed();
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const filesMode = useSyncExternalStore(subscribeAnalyticsP4FilesMode, analyticsP4FilesMode, analyticsP4FilesMode);
  const controller = useRef<ReturnType<typeof createAnalyticsController> | null>(null);
  const pane = analyticsPane(activeTab.kind === "repo" ? activeTab.vcs : null, view, p4View, filesMode);

  useEffect(() => {
    // Only the production native package belongs in application usage reports.
    if (!isTauri() || import.meta.env.DEV) return;
    let current = true;
    void Promise.all([getIdentifier(), getVersion()]).then(([id, version]) => {
      if (current && id === identifier && isAnalyticsVersion(version)) setAppVersion(version);
    }).catch(() => {});
    return () => { current = false; };
  }, []);

  useEffect(() => {
    if (appVersion === null) return;
    const current = createAnalyticsController({
      installId: () => analyticsInstallId(localStorage, () => crypto.randomUUID()),
      randomUUID: () => crypto.randomUUID(),
      now: () => performance.now(),
      sessionId: () => Math.floor(Date.now() / 1_000),
      platform: desktopPlatform(),
      appVersion,
      createBridge: createAnalyticsFrame,
    });
    controller.current = current;
    const foreground = () => current.setForeground(!document.hidden && document.hasFocus());
    const stop = registerAnalyticsStop(() => current.stop());
    foreground();
    window.addEventListener("focus", foreground);
    window.addEventListener("blur", foreground);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      window.removeEventListener("focus", foreground);
      window.removeEventListener("blur", foreground);
      document.removeEventListener("visibilitychange", foreground);
      stop();
      current.stop();
      controller.current = null;
    };
  }, [appVersion]);

  useEffect(() => { controller.current?.setPane(pane); }, [appVersion, pane]);
  useEffect(() => { controller.current?.configure(prefsReady, prefs.analyticsEnabled && allowed); }, [appVersion, prefsReady, prefs.analyticsEnabled, allowed]);
  useEffect(() => {
    if (appVersion === null || !prefsReady || !prefs.analyticsEnabled || !allowed) return;
    const timer = window.setInterval(() => controller.current?.pulse(), ANALYTICS_PULSE_MS);
    return () => { window.clearInterval(timer); };
  }, [appVersion, prefsReady, prefs.analyticsEnabled, allowed]);
}
