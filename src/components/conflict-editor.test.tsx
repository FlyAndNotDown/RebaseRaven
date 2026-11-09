// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConflictTextEditor } from "@/components/conflict-editor";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setLanguagePreference } from "@/i18n";

const prefs = { diffSplit: false };
const setDiffOptions = vi.fn(async ({ split }: { split: boolean }) => { prefs.diffSplit = split; });
vi.mock("@/state/git-context", () => ({ useGitPick: () => ({ prefs, setDiffOptions }) }));
let root: Root, container: HTMLDivElement;
const save = vi.fn(); const external = vi.fn();
const initial = "header\n<<<<<<< current\nlocal\n=======\nincoming\n>>>>>>> incoming\ntail\n";
async function render() { await act(async () => root.render(<TooltipProvider><ConflictTextEditor path="src/app.ts" initialText={initial} current="Current" incoming="Incoming" onSave={save} onExternal={external} /></TooltipProvider>)); }
function button(label: string) { const result = [...document.querySelectorAll("button")].find(item => item.textContent?.trim() === label || item.getAttribute("aria-label") === label); expect(result, label).toBeDefined(); return result!; }
async function click(label: string) { await act(async () => button(label).click()); }
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); setLanguagePreference("en"); vi.clearAllMocks(); prefs.diffSplit = false; Object.assign(HTMLElement.prototype, { scrollIntoView: vi.fn() }); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

it("keeps conflict choices and undo history when switching between single and split layouts", async () => {
  await render(); expect(button("Mark resolved").disabled).toBe(true); await click("Side by side"); await render(); expect(button("Side by side").getAttribute("aria-pressed")).toBe("true");
  await click("Current"); expect(button("Mark resolved").disabled).toBe(false); await click("Side by side"); await render();
  await click("Undo"); expect(button("Mark resolved").disabled).toBe(true); await click("Redo"); await click("Mark resolved"); expect(save).toHaveBeenCalledWith("header\nlocal\ntail\n");
});

it("keeps full editing results across layout changes and imports external output without saving", async () => {
  external.mockResolvedValue("external result\n"); await render(); await click("Open in merge tool"); expect(save).not.toHaveBeenCalled();
  await click("Edit full text"); await click("Side by side"); await render(); expect(document.body.textContent).toContain("Before edits");
  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Merged result"]')?.value).toBe("external result\n");
  await click("Side by side"); await render(); await click("Mark resolved"); expect(save).toHaveBeenCalledWith("external result\n");
});
