// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RepositorySettingsForm } from "@/components/repository-settings-form";
import { TooltipProvider } from "@/components/ui/tooltip";
import { gitApi } from "@/lib/git";
import { setLanguagePreference } from "@/i18n";
import type { GitRepositorySettings } from "@/types/git";

const initial: GitRepositorySettings = { worktree: false, readOnly: false, fingerprint: "reviewed", fields: [
  { key: "user.name", value: "Local Author", inherited: "Inherited Author", effective: "Local Author", origin: "file:.git/config", editable: true },
  { key: "user.email", value: null, inherited: "author@example.com", effective: "author@example.com", origin: "file:shared.cfg", editable: true },
] };
const close = vi.fn(), busy = vi.fn(); let root: Root, container: HTMLDivElement;
async function render(path = "/work/first") { await act(async () => root.render(<TooltipProvider><RepositorySettingsForm key={path} repoPath={path} onClose={close} onBusyChange={busy} /></TooltipProvider>)); }
function button(text: string) { const found = [...document.querySelectorAll("button")].find(item => item.textContent?.trim() === text || item.getAttribute("aria-label") === text); expect(found, text).toBeDefined(); return found!; }
async function click(text: string) { await act(async () => button(text).click()); }
async function input(key: string, value: string) { await act(async () => { const field = document.getElementById("repo-config-" + key)!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); }); }
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); setLanguagePreference("en"); vi.resetAllMocks(); vi.spyOn(gitApi, "getRepositorySettings").mockResolvedValue(structuredClone(initial)); vi.spyOn(gitApi, "setRepositorySettings").mockResolvedValue(structuredClone(initial)); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

it("shows inherited identity and saves only changed fields", async () => {
  await render(); expect((document.getElementById("repo-config-user.email") as HTMLInputElement).placeholder).toBe("author@example.com"); expect(button("Save").disabled).toBe(true);
  await input("user.email", "local@example.com"); await click("Save"); expect(gitApi.setRepositorySettings).toHaveBeenCalledWith("/work/first", [{ key: "user.email", value: "local@example.com" }], "reviewed"); expect(close).toHaveBeenCalledOnce();
});

it("resets local identity to inheritance without erasing the inherited value", async () => {
  await render(); await click("Reset User name to inherit"); expect((document.getElementById("repo-config-user.name") as HTMLInputElement).value).toBe(""); expect((document.getElementById("repo-config-user.name") as HTMLInputElement).placeholder).toBe("Inherited Author"); await click("Save"); expect(gitApi.setRepositorySettings).toHaveBeenCalledWith("/work/first", [{ key: "user.name", value: null }], "reviewed");
});

it("keeps the draft after a stale save and allows reloading", async () => {
  vi.mocked(gitApi.setRepositorySettings).mockRejectedValueOnce(new Error("Reload before saving")); await render(); await input("user.name", "Draft Author"); await click("Save"); expect(document.querySelector('[role="alert"]')?.textContent).toContain("Reload before saving"); expect(close).not.toHaveBeenCalled(); expect((document.getElementById("repo-config-user.name") as HTMLInputElement).value).toBe("Draft Author"); await click("Reload"); expect((document.getElementById("repo-config-user.name") as HTMLInputElement).value).toBe("Local Author");
});

it("disables identity changes for read-only configuration", async () => {
  vi.mocked(gitApi.getRepositorySettings).mockResolvedValue({ ...initial, readOnly: true }); await render(); expect((document.getElementById("repo-config-user.name") as HTMLInputElement).disabled).toBe(true); expect(button("Reset User name to inherit").disabled).toBe(true); expect(button("Save").disabled).toBe(true);
});

it("ignores a late response from another repository", async () => {
  let finish!: (value: GitRepositorySettings) => void; vi.mocked(gitApi.getRepositorySettings).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); await render(); await render("/work/second"); await input("user.name", "Second Author"); await act(async () => finish({ ...initial, fingerprint: "stale" })); expect((document.getElementById("repo-config-user.name") as HTMLInputElement).value).toBe("Second Author"); await click("Save"); expect(gitApi.setRepositorySettings).toHaveBeenCalledWith("/work/second", [{ key: "user.name", value: "Second Author" }], "reviewed");
});
