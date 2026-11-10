// @vitest-environment jsdom
import { chooseChoice } from "@/test/choose-choice";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { P4GetRevisionDialog, type P4RevisionTarget } from "@/components/p4/p4-get-revision-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setLanguagePreference } from "@/i18n";

const actions = vi.hoisted(() => ({getRevision:vi.fn(),revisionTargets:vi.fn(),closed:vi.fn(),connection:{root:"/workspace"}}));
vi.mock("@/state/p4-context", () => ({useP4:() => ({connection:actions.connection,busy:false,getRevision:actions.getRevision})}));
vi.mock("@/lib/p4", () => ({p4Api:{revisionTargets:actions.revisionTargets},relativeToRoot:(_root:string,path:string) => path}));
vi.mock("@/components/p4/p4-revision-picker", () => ({P4RevisionPicker:() => null}));
let root:Root, container:HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});setLanguagePreference("en");vi.resetAllMocks();
  actions.getRevision.mockResolvedValue("Preview result");actions.revisionTargets.mockResolvedValue(["//depot/a.txt"]);
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
});
afterEach(async () => {await act(async () => root.unmount());container.remove();});
async function render(target:P4RevisionTarget) {await act(async () => root.render(<TooltipProvider><P4GetRevisionDialog target={target} onClose={actions.closed} /></TooltipProvider>));}
function button(label:string) {return [...document.querySelectorAll("button")].find(item => item.textContent?.trim() === label)!;}
async function click(label:string) {await act(async () => button(label).click());}
async function change(label:string,value:string,select=false) {
  const element=document.querySelector(`${select ? "button" : "input"}[aria-label="${label}"]`)!;
  if (select) {await chooseChoice(element as HTMLElement,value);return;}
  await act(async () => {Object.getOwnPropertyDescriptor(select ? HTMLSelectElement.prototype : HTMLInputElement.prototype,"value")!.set!.call(element,value);element.dispatchEvent(new Event(select ? "change" : "input",{bubbles:true}));});
}

it("preselects a changelist and previews mixed file and folder targets before syncing", async () => {
  await render({changeId:"1200"});
  expect((document.querySelector('input[aria-label="Revision"]') as HTMLInputElement).value).toBe("1200");
  await click("Add");await change("File or folder path","folder",true);await change("File or folder path","//depot/docs");
  const add=[...document.querySelectorAll("button")].filter(item => item.textContent?.trim() === "Add").at(-1)!;
  await act(async () => add.click());
  await click("Preview");
  expect(actions.getRevision).toHaveBeenLastCalledWith(expect.objectContaining({targets:[{path:"//depot/a.txt",recursive:false},{path:"//depot/docs",recursive:true}],paths:[],mode:"changelist",value:"1200",preview:true}));
  expect(actions.closed).not.toHaveBeenCalled();expect(document.querySelector('[role="status"]')?.textContent).toBe("Preview result");
  await change("At changelist","before",true);
  expect(document.querySelector('[role="status"]')).toBeNull();
  await click("Get revision");
  expect(actions.getRevision).toHaveBeenLastCalledWith(expect.objectContaining({mode:"beforeChangelist",value:"1200",changelistFilesOnly:false,preview:false}));
  expect(actions.closed).toHaveBeenCalledOnce();
});

it("disables preview and sync after the last target is removed", async () => {
  await render({path:"//depot/a.txt",recursive:false});
  await act(async () => (document.querySelector('button[aria-label="Remove"]') as HTMLButtonElement).click());
  expect(button("Preview").disabled).toBe(true);expect(button("Get revision").disabled).toBe(true);expect(actions.getRevision).not.toHaveBeenCalled();
});

it("opens file revisions directly and keeps force and safe update mutually exclusive", async () => {
  await render({path:"//depot/a.txt",recursive:false,revision:"4"});
  const checks=() => [...document.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];
  await act(async () => checks()[0].click());await act(async () => checks()[1].click());
  await click("Preview");expect(actions.getRevision).toHaveBeenCalledWith(expect.objectContaining({mode:"revision",value:"4",safe:true,force:false}));
});
