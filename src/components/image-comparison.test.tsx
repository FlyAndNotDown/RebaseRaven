// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ImageComparison } from "./image-diff";
import { TooltipProvider } from "./ui/tooltip";
import { setLanguagePreference } from "@/i18n";

let root: Root, host: HTMLDivElement;
const pair = {
  before: { dataUrl: "data:image/png;base64,AA==", size: 1, lfs: false, tooLarge: false },
  after: { dataUrl: "data:image/png;base64,AQ==", size: 1, lfs: false, tooLarge: false },
};
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); setLanguagePreference("en");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render(single: boolean) {
  await act(async () => root.render(<TooltipProvider><ImageComparison pair={pair} busy={false} error={null} identity="preview" onReload={() => {}} single={single} captions={["Old revision", "Selected file"]} /></TooltipProvider>));
}

it("uses only the selected image for a file preview", async () => {
  await render(true);
  expect(host.querySelectorAll("img")).toHaveLength(1);
  expect(host.querySelector("img")?.alt).toBe("Selected file");
  expect(host.textContent).not.toContain("Old revision");
  expect(host.textContent).not.toContain("Side by side");
});

it("preserves both images and comparison controls for a normal image diff", async () => {
  await render(false);
  expect(host.querySelectorAll("img")).toHaveLength(2);
  expect(host.textContent).toContain("Old revision");
  expect(host.textContent).toContain("Selected file");
  expect(host.querySelectorAll('button[aria-pressed]')).toHaveLength(3);
});
