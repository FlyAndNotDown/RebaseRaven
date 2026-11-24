// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { P4Diff } from "./p4-diff";
import { setLanguagePreference, t } from "@/i18n";

vi.mock("@/state/p4-context", () => ({ useP4: () => ({ connection: null }) }));
vi.mock("@/state/git-context", () => ({
  useGitSelect: (select: (state: object) => unknown) =>
    select({ prefs: { diffSplit: false, diffIgnoreWhitespace: true } }),
}));

it("shows the workspace preview status in the current app language", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const node = document.createElement("div");
  const root = createRoot(node);
  try {
    for (const reason of ["missing", "permissionDenied", "unreadable"] as const) {
      await act(async () => {
        setLanguagePreference("en");
        root.render(<P4Diff loading={false} diff={{ unavailable: reason }} empty="No differences" />);
      });
      const english = node.textContent;
      expect(english).toBe(t(`p4.previewUnavailable.${reason}`, { lng: "en" }));
      await act(async () => setLanguagePreference("zh-CN"));
      expect(node.textContent).toBe(t(`p4.previewUnavailable.${reason}`, { lng: "zh-CN" }));
      expect(node.textContent).not.toBe(english);
    }
  } finally {
    await act(async () => root.unmount());
    setLanguagePreference("system");
  }
});
