// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { P4Header } from "@/components/p4/p4-header";
import { TooltipProvider } from "@/components/ui/tooltip";
import { defaultPrefs } from "@/lib/prefs";
import { setLanguagePreference } from "@/i18n";
let prefs = { ...defaultPrefs };
const updatePrefs = vi.fn(async (next: typeof prefs) => { prefs = next; });
const sync = vi.fn();
vi.mock("@/state/git-context", () => ({ useGitPick: () => ({ prefs, updatePrefs }) }));
vi.mock("@/state/p4-context", () => ({ useP4: () => ({ connection: { client: "example" }, busy: false, sync }) }));
let root: Root, container: HTMLDivElement;
async function render() { await act(async () => root.render(<TooltipProvider><P4Header /></TooltipProvider>)); }
async function open() { await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Get latest"]')!.click()); }
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); setLanguagePreference("en"); vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); vi.clearAllMocks(); prefs = { ...defaultPrefs }; container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it("opens the panel without its option tooltip and keeps focus and hover help available", async () => {
  vi.useFakeTimers();
  await render(); await open();
  const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const checkbox = document.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
  expect(panel.getAttribute("aria-label")).toBe("Get latest");
  expect(document.activeElement).toBe(panel);
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await act(async () => checkbox.focus());
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("After updating");
  await act(async () => panel.focus());
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await act(async () => checkbox.closest("label")!.dispatchEvent(new MouseEvent("pointermove", { bubbles: true })));
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("After updating");
});
it("saves the automatic resolve choice independently of running a sync and restores it on remount", async () => {
  await render(); await open(); const check = document.querySelector<HTMLButtonElement>('[role="checkbox"]')!; expect(check.getAttribute("data-state")).toBe("unchecked");
  await act(async () => check.click()); expect(updatePrefs).toHaveBeenCalledWith({ ...defaultPrefs, p4AutoResolveAfterSync: true }); expect(sync).not.toHaveBeenCalled();
  await act(async () => root.render(null)); await render(); await open(); expect(document.querySelector('[role="checkbox"]')?.getAttribute("data-state")).toBe("checked");
  const run = [...document.querySelectorAll("button")].find(item => item.textContent?.trim() === "Get latest")!; await act(async () => run.click()); expect(sync).toHaveBeenCalledOnce(); expect(document.querySelector('[role="checkbox"]')).toBeNull();
});
