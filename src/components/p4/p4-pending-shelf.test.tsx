// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { setLanguagePreference } from "@/i18n";
import type { PendingShelf } from "@/state/p4-session";
import { PendingShelfGroup } from "./p4-pending-shelf";

it("reads an expanded shelf on demand, exposes failures and retries the affected change", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  setLanguagePreference("en");
  const el = document.createElement("div");
  const root = createRoot(el);
  const load = vi.fn(async () => {});
  const noop = () => {};
  const render = (open: boolean, shelf?: PendingShelf) => act(async () => {
    root.render(<PendingShelfGroup id="241" exists open={open} busy={false} shelf={shelf} load={load}
      onToggle={noop} onStream={noop} onUnshelve={noop} onDelete={noop}>Files</PendingShelfGroup>);
  });
  try {
    await render(false);
    expect(load).not.toHaveBeenCalled();
    expect(el.querySelector("button")?.textContent).not.toContain("0");
    await render(true);
    expect(load.mock.calls).toEqual([["241"]]);
    expect(el.querySelector('[role="status"]')).not.toBeNull();
    await render(true, { status: "error", message: "Shelf unavailable" });
    expect(el.querySelector('[role="alert"]')?.textContent).toContain("Shelf unavailable");
    await act(async () => el.querySelector<HTMLButtonElement>('[role="alert"] button')?.click());
    expect(load).toHaveBeenLastCalledWith("241", true);
    const detail = { id: "241", user: "", client: "", description: "", status: "pending", time: 0,
      files: [], shelved: true, shelvedStream: { path: "//streams/main", baseChange: "7" } };
    await render(true, { status: "ready", detail });
    expect(el.textContent).toContain("main");
    expect(el.querySelector("button")?.textContent).toContain("1");
    expect(load).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
  }
});
