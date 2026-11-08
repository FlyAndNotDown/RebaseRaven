// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CreateTagDialog } from "@/components/create-ref-dialogs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setLanguagePreference } from "@/i18n";

const createTag = vi.hoisted(() => vi.fn());
vi.mock("@/state/git-context", () => ({useGitPick: () => ({createTag})}));
let root: Root, container: HTMLDivElement;
const close = vi.fn();
beforeEach(async()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});setLanguagePreference("en");vi.resetAllMocks();createTag.mockResolvedValue(false);
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
  await act(async()=>root.render(<TooltipProvider><CreateTagDialog open onOpenChange={close} commit={{id:"reviewed",shortId:"reviewed",summary:"Reviewed revision"}}/></TooltipProvider>));
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();});
function submit() {return [...document.querySelectorAll("button")].find(button=>button.textContent==="Create")!;}
async function enter(selector:string,value:string) {
  const input=document.querySelector<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>(selector)!;
  await act(async()=>{Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input),"value")!.set!.call(input,value);input.dispatchEvent(new Event(input.tagName==="SELECT"?"change":"input",{bubbles:true}));});
}

it("requires an annotation for an explicit signature and preserves it after failure",async()=>{
  await enter('[aria-label="Tag name"]',"signed-tag");await enter("#tag-signing","sign");expect(submit().disabled).toBe(true);
  await enter("#tag-annotation","Reviewed tag\n\nRelease details");expect(submit().disabled).toBe(false);await act(async()=>submit().click());
  expect(createTag).toHaveBeenCalledWith("signed-tag","Reviewed tag\n\nRelease details","reviewed","sign");expect(close).not.toHaveBeenCalled();
  expect((document.querySelector("#tag-annotation") as HTMLTextAreaElement).value).toContain("Release details");
  await enter("#tag-signing","unsigned");await act(async()=>submit().click());expect(createTag).toHaveBeenLastCalledWith("signed-tag","Reviewed tag\n\nRelease details","reviewed","unsigned");
});

it("sends an empty annotation as a lightweight tag request",async()=>{
  await enter('[aria-label="Tag name"]',"lightweight");await act(async()=>submit().click());
  expect(createTag).toHaveBeenCalledWith("lightweight",undefined,"reviewed","default");
});

it("submits only once and locks the reviewed tag values until the operation completes",async()=>{
  let finish!:(value:boolean)=>void;createTag.mockImplementation(()=>new Promise<boolean>(resolve=>{finish=resolve;}));
  await enter('[aria-label="Tag name"]',"reviewed-tag");await enter("#tag-annotation","Reviewed annotation");
  await act(async()=>{const form=document.querySelector("form")!;form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));});
  expect(createTag).toHaveBeenCalledOnce();expect((document.querySelector("#tag-signing") as HTMLSelectElement).disabled).toBe(true);expect((document.querySelector("#tag-annotation") as HTMLTextAreaElement).disabled).toBe(true);
  await act(async()=>finish(true));expect(close).toHaveBeenCalledWith(false);
});
