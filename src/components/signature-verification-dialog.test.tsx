// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SignatureVerificationDialog, type SignatureDialogTarget } from "@/components/signature-verification-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { gitApi } from "@/lib/git";
import { setLanguagePreference } from "@/i18n";
import type { GitSignatureVerification } from "@/types/git";

const target: SignatureDialogTarget = {tabId:"first",path:"/work/first",object:{kind:"commit",value:"a".repeat(40)}};
const valid: GitSignatureVerification = {oid:target.object.value,status:"verified",output:'Good "git" signature for test@example.com\n',truncated:false};
const close=vi.fn();
let root: Root, container: HTMLDivElement;
async function render(next=target) {await act(async()=>root.render(<TooltipProvider><SignatureVerificationDialog key={`${next.path}:${next.object.value}`} target={next} onClose={close}/></TooltipProvider>));}
function button(text: string) {const found=[...document.querySelectorAll("button")].find(button=>button.textContent?.trim()===text);expect(found, `Missing button: ${text}`).toBeDefined();return found!;}
async function click(text:string) {await act(async()=>button(text).click());}
beforeEach(()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});setLanguagePreference("en");vi.resetAllMocks();
  vi.spyOn(gitApi,"verifySignature").mockResolvedValue(valid);
  vi.spyOn(gitApi,"cancelActivity").mockResolvedValue(true);
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.restoreAllMocks();vi.useRealTimers();});

it("shows the native result for an immutable commit and can verify again",async()=>{
  await render();expect(gitApi.verifySignature).toHaveBeenCalledWith(target.path,target.object,expect.any(String));
  expect(document.querySelector('[role="status"]')?.textContent).toContain("Signature verified");
  expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe(valid.output);
  await click("Verify again");expect(gitApi.verifySignature).toHaveBeenCalledTimes(2);
  expect(vi.mocked(gitApi.verifySignature).mock.calls[0][2]).not.toBe(vi.mocked(gitApi.verifySignature).mock.calls[1][2]);
});

it("keeps lightweight tags distinct from their signed target commit",async()=>{
  vi.mocked(gitApi.verifySignature).mockResolvedValue({...valid,status:"lightweight",output:""});
  const tag={...target,object:{kind:"tag" as const,value:"release/example"}};
  await render(tag);expect(gitApi.verifySignature).toHaveBeenCalledWith(tag.path,tag.object,expect.any(String));
  expect(document.querySelector('[role="status"]')?.textContent).toContain("Its target’s signature is separate");
  expect(document.querySelector("textarea")).toBeNull();expect(document.body.textContent).toContain(valid.oid);
});

it.each(["untrusted","invalid","revoked","expiredKey","expiredSignature","failed","unsigned","changed"] as const)("does not show a success label for %s",async status=>{
  vi.mocked(gitApi.verifySignature).mockResolvedValue({...valid,status});await render();
  expect(document.querySelector('[role="status"]')?.textContent).not.toContain("Signature verified");
});

it("retries a native failure without preserving a previous success",async()=>{
  await render();vi.mocked(gitApi.verifySignature).mockRejectedValueOnce(new Error("Object unavailable"));
  await click("Verify again");expect(document.querySelector('[role="alert"]')?.textContent).toBe("Object unavailable");
  expect(document.body.textContent).not.toContain("Signature verified");await click("Verify again");expect(document.querySelector('[role="status"]')?.textContent).toContain("Signature verified");
});

it("cancels a closed dialog even when the worker registers late and discards its response",async()=>{
  vi.useFakeTimers();let finish!:(result:GitSignatureVerification)=>void;
  vi.mocked(gitApi.verifySignature).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  vi.mocked(gitApi.cancelActivity).mockResolvedValueOnce(false).mockResolvedValue(true);
  await render();expect(button("Verify again").disabled).toBe(true);await click("Cancel");expect(close).toHaveBeenCalledOnce();
  await act(async()=>root.render(null));const id=vi.mocked(gitApi.verifySignature).mock.calls[0][2];
  expect(gitApi.cancelActivity).toHaveBeenCalledWith(id);await act(async()=>vi.advanceTimersByTimeAsync(100));expect(gitApi.cancelActivity).toHaveBeenCalledTimes(2);
  await act(async()=>finish(valid));expect(document.querySelector('[role="dialog"]')).toBeNull();expect(vi.getTimerCount()).toBe(0);
});

it("does not let an old repository response replace the current verification",async()=>{
  let finish!:(result:GitSignatureVerification)=>void;
  vi.mocked(gitApi.verifySignature).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValueOnce({...valid,status:"unsigned",output:""});
  await render();await render({...target,path:"/work/second"});await act(async()=>finish(valid));
  expect(document.querySelector('[role="status"]')?.textContent).toContain("Not signed");expect(gitApi.cancelActivity).toHaveBeenCalledOnce();
});
