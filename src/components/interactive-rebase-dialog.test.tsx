// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InteractiveRebaseDialog } from "./interactive-rebase-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { chooseChoice } from "@/test/choose-choice";
import { setLanguagePreference } from "@/i18n";
import type { RebaseCommit } from "@/types/git";

const actions=vi.hoisted(() => ({plan:vi.fn(),start:vi.fn(),close:vi.fn()}));
let head:string;
vi.mock("@/lib/git", () => ({gitApi:{rebasePlan:actions.plan},errorMessage:(error:unknown) => String(error)}));
vi.mock("@/state/git-context", () => ({useGitPick:() => ({activeTabId:"repo:project",snapshot:{repo:{path:"/workspace",headId:head,operation:null}},rebaseInteractive:actions.start})}));
const commits:RebaseCommit[]=[{id:"first",shortId:"aaa111",summary:"First subject",message:"First subject\n\nFirst body\n"},{id:"second",shortId:"bbb222",summary:"Second subject",message:"Second subject\n\nSecond body\n\nTrailer: value\n"}];
let root:Root,container:HTMLDivElement;
beforeEach(() => {Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});setLanguagePreference("en");vi.resetAllMocks();head="second";actions.plan.mockResolvedValue(commits);actions.start.mockResolvedValue(true);container=document.createElement("div");document.body.append(container);root=createRoot(container);});
afterEach(async () => {await act(async () => root.unmount());container.remove();});
async function render() {await act(async () => root.render(<TooltipProvider><InteractiveRebaseDialog onto={{id:"base",label:"main"}} onOpenChange={actions.close} /></TooltipProvider>));}
function button(text:string) {const found=[...document.querySelectorAll<HTMLButtonElement>('button:not([aria-haspopup])')].find(node => node.textContent?.trim() === text);expect(found,`Missing button: ${text}`).toBeDefined();return found!;}
async function click(text:string) {await act(async () => button(text).click());}
async function action(shortId:string,value:string) {await chooseChoice(document.querySelector<HTMLElement>(`button[aria-label="Action for ${shortId}"]`)!,value);}

it("edits the full message in a separate panel and submits the chosen order and actions", async () => {
  await render();await action("bbb222","reword");const textarea=document.querySelector<HTMLTextAreaElement>('textarea[aria-label="New message"]')!;expect(textarea.value).toBe(commits[1].message);
  await act(async () => {Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,"Updated subject\n\nRetained details\n");textarea.dispatchEvent(new Event("input",{bubbles:true}));});
  await act(async () => document.querySelector<HTMLButtonElement>('[data-rebase-step="second"] button[aria-label="Move up"]')!.click());
  await click("Start rebase");expect(actions.start).toHaveBeenCalledExactlyOnceWith("base",[{id:"second",action:"reword",message:"Updated subject\n\nRetained details\n"},{id:"first",action:"pick",message:commits[0].message}]);expect(actions.close).toHaveBeenCalledWith(false);
});

it("blocks a leading squash or fixup, empty edited messages, and dropping everything", async () => {
  await render();await action("aaa111","squash");expect(button("Start rebase").disabled).toBe(true);expect(document.querySelector('[role="alert"]')?.textContent).toContain("preceding commit");
  await action("aaa111","pick");await action("bbb222","reword");const textarea=document.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => {Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,"  ");textarea.dispatchEvent(new Event("input",{bubbles:true}));});expect(button("Start rebase").disabled).toBe(true);
  await action("aaa111","drop");await action("bbb222","drop");expect(button("Start rebase").disabled).toBe(true);expect(document.querySelector('[role="alert"]')?.textContent).toContain("at least one");expect(actions.start).not.toHaveBeenCalled();
  await click("Reset plan");expect(button("Start rebase").disabled).toBe(false);
});

it("requires a reload after HEAD changes and preserves the edited plan until then", async () => {
  await render();await action("bbb222","drop");head="new-head";await render();expect(button("Start rebase").disabled).toBe(true);expect(document.querySelector('[role="alert"]')?.textContent).toContain("revision changed");
  expect(document.querySelector('button[aria-label="Action for bbb222"]')?.textContent).toContain("Drop");await click("Reload plan");expect(actions.plan).toHaveBeenCalledTimes(2);expect(button("Start rebase").disabled).toBe(false);
});

it("offers retry when loading fails and prevents duplicate submission", async () => {
  actions.plan.mockRejectedValueOnce(new Error("Could not read commits"));await render();expect(document.querySelector('[role="alert"]')?.textContent).toContain("Could not read commits");await click("Retry");expect(actions.plan).toHaveBeenCalledTimes(2);
  await act(async () => {button("Start rebase").click();button("Start rebase").click();});expect(actions.start).toHaveBeenCalledOnce();
});
