// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DiffLines } from "@/components/diff-viewer";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setLanguagePreference } from "@/i18n";
import type { FileDiff } from "@/types/git";

vi.mock("@/state/git-context", () => ({ useGitSelect: () => false }));

it("dismisses pending discard when the same file and line are replaced", async () => {
  setLanguagePreference("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onApply = vi.fn(async () => true);
  async function render(text: string) {
    const diff: FileDiff = { path: "file.txt", oldPath: null, binary: false, truncated: false, fingerprint: text,
      lines: [{ kind: "hunk", content: "@@ -0,0 +1 @@", oldLineno: null, newLineno: null },
        { kind: "add", content: text, oldLineno: null, newLineno: 1 }] };
    await act(async () => root.render(<TooltipProvider><DiffLines diff={diff}
      lineActions={{ staged: false, allowDiscard: true, onApply }} /></TooltipProvider>));
  }
  try {
    await render("reviewed");
    const discard = [...host.querySelectorAll("button")].find(item => item.textContent === "Discard hunk");
    expect(discard).toBeDefined();
    await act(async () => discard!.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await render("later edit");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("stages a changed line selected with the keyboard", async () => {
  setLanguagePreference("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onApply = vi.fn(async () => true);
  const diff: FileDiff = { path: "file.txt", oldPath: null, binary: false, truncated: false,
    lines: [{ kind: "hunk", content: "@@ -0,0 +1 @@", oldLineno: null, newLineno: null },
      { kind: "add", content: "reviewed", oldLineno: null, newLineno: 1 }] };
  try {
    await act(async () => root.render(<TooltipProvider><DiffLines diff={diff} lineActions={{ staged: false, allowDiscard: true, onApply }} /></TooltipProvider>));
    const line = host.querySelector<HTMLElement>('[role="checkbox"]')!;
    expect(line.tabIndex).toBe(0);
    await act(async () => line.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })));
    expect(line.getAttribute("aria-checked")).toBe("true");
    const stage = [...host.querySelectorAll("button")].find(button => button.textContent === "Stage lines")!;
    await act(async () => stage.click());
    expect(onApply).toHaveBeenCalledWith("stage", [{ old: null, new: 1 }]);
    expect(line.getAttribute("aria-checked")).toBe("false");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
