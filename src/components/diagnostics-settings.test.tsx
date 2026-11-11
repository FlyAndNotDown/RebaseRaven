// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { DiagnosticsSettings } from "@/components/diagnostics-settings";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setLanguagePreference } from "@/i18n";

const mocks=vi.hoisted(()=>({save:vi.fn(),summary:vi.fn(),export:vi.fn()}));
vi.mock("@tauri-apps/plugin-dialog",()=>({save:mocks.save}));
vi.mock("@/lib/diagnostics",()=>({diagnosticsApi:{summary:mocks.summary,export:mocks.export}}));
let root:Root,container:HTMLDivElement;
beforeEach(async()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});setLanguagePreference("en");vi.resetAllMocks();
  mocks.summary.mockResolvedValue({totalBytes:1024,maxBytes:200*1024*1024,fileCount:1,retentionDays:7});
  mocks.save.mockResolvedValue("/output/diagnostics.zip");mocks.export.mockResolvedValue({fileCount:1,skippedEntries:0});
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
  await act(async()=>root.render(<TooltipProvider><DiagnosticsSettings /></TooltipProvider>));
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();});
async function click(label:string){
  const button=[...document.querySelectorAll("button")].find(button=>button.textContent?.trim()===label);
  expect(button,`Missing button: ${label}`).toBeDefined();await act(async()=>button!.click());
}
it("requires disclosure confirmation before choosing or writing an unencrypted archive",async()=>{
  await click("Export ZIP");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("not encrypted");
  expect(document.body.textContent).toContain("file contents");
  expect(mocks.save).not.toHaveBeenCalled();expect(mocks.export).not.toHaveBeenCalled();
  await click("Cancel");expect(mocks.export).not.toHaveBeenCalled();
  await click("Export ZIP");await click("Continue export");
  expect(mocks.save).toHaveBeenCalledOnce();expect(mocks.export).toHaveBeenCalledWith("/output/diagnostics.zip");
});
it("does not export when file selection is cancelled and requests fresh confirmation next time",async()=>{
  mocks.save.mockResolvedValue(null);
  await click("Export ZIP");await click("Continue export");
  expect(mocks.export).not.toHaveBeenCalled();
  await click("Export ZIP");expect(document.querySelector('[role="dialog"]')).not.toBeNull();expect(mocks.save).toHaveBeenCalledOnce();
});
