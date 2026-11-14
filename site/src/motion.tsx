import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";

type Motion = "auto" | "paused" | "reduced";
const KEY = "rebaseraven-site-motion";
const CHANGE = "rebaseraven-site-motion-change";
let preference: "auto" | "paused" = "auto";

function snapshot(): Motion {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return "reduced";
  try { return localStorage.getItem(KEY) === "paused" ? "paused" : preference; } catch { return preference; }
}

function subscribe(onChange: () => void) {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  const update = () => { document.documentElement.dataset.siteMotion = snapshot(); onChange(); };
  const storage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) { preference = event.newValue === "paused" ? "paused" : "auto"; update(); } };
  update();
  media.addEventListener("change", update);
  window.addEventListener(CHANGE, update);
  window.addEventListener("storage", storage);
  return () => { media.removeEventListener("change", update); window.removeEventListener(CHANGE, update); window.removeEventListener("storage", storage); };
}

function setPaused(paused: boolean) {
  preference = paused ? "paused" : "auto";
  try { localStorage.setItem(KEY, preference); } catch { /* Keep the current page usable without storage. */ }
  window.dispatchEvent(new Event(CHANGE));
}

const serverSnapshot = (): Motion => "auto";
const MotionContext = createContext<{ status: Motion; setPaused: typeof setPaused } | null>(null);

export function SiteMotionProvider({ children }: { children: ReactNode }) {
  const status = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return <MotionContext.Provider value={{ status, setPaused }}>{children}</MotionContext.Provider>;
}

export function useSiteMotion() {
  const value = useContext(MotionContext);
  if (!value) throw new Error("SiteMotionProvider is required");
  return value;
}
