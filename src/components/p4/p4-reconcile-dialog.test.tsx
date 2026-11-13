// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { P4ReconcileDialog } from "./p4-reconcile-dialog";
import { setLanguagePreference } from "@/i18n";

const calls = vi.hoisted(() => ({previewReconcile: vi.fn(), applyReconcile: vi.fn()}));
vi.mock("@/state/p4-context", () => ({useP4: () => ({
  ...calls, busy:false, selectedChange:"default", pending:[],
  connection:{root:"/workspace", client:"example", user:"alice"},
})}));

it("keeps directory scope through scanning, refreshing and applying a selected subset", async () => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT:true});
  setLanguagePreference("en");
  const scope = "/workspace/assets";
  const paths = [`${scope}/texture.png`, `${scope}/material.txt`];
  calls.previewReconcile.mockResolvedValue({fingerprint:"reviewed", files:paths.map(path => ({path, depotPath:"//depot/file", action:"edit"}))});
  calls.applyReconcile.mockResolvedValue(undefined);
  const close = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function button(label: string) {
    return [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === label)!;
  }
  try {
    await act(async () => root.render(<P4ReconcileDialog scope={scope} onClose={close} />));
    expect(calls.previewReconcile).toHaveBeenCalledWith(scope);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("assets");
    await act(async () => button("Refresh").click());
    expect(calls.previewReconcile).toHaveBeenLastCalledWith(scope);
    const checkbox = [...document.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')].at(-1)!;
    await act(async () => checkbox.click());
    await act(async () => button("Reconcile 1 files").click());
    expect(calls.applyReconcile).toHaveBeenCalledExactlyOnceWith([paths[0]], "default", "reviewed", scope);
    expect(close).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
