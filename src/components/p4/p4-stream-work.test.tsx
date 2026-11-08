// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { P4StreamWorkDialog } from "@/components/p4/p4-stream-work";
import { P4ChangeDialog } from "@/components/p4/p4-change-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setLanguagePreference } from "@/i18n";
import type { P4StreamWork, P4StreamWorkRequest } from "@/types/p4-stream-specs";

const actions = vi.hoisted(() => ({work:vi.fn(), previewWork:vi.fn(), applyWork:vi.fn(), read:vi.fn(), selectChange:vi.fn(), setView:vi.fn(), setShelvesOpen:vi.fn()}));
vi.mock("@/state/p4-context", () => ({useP4: () => ({streamSpecs:actions, busy:false, connection:{stream:"//project/dev"}, pending:[{id:"default",description:""},{id:"42",description:"Stream edits"}], selectChange:actions.selectChange, setView:actions.setView, setShelvesOpen:actions.setShelvesOpen})}));
vi.mock("@/components/p4/p4-diff", () => ({P4Diff:({diff}: {diff?: {lines:{content:string}[]}}) => <div>{diff?.lines.map(line=>line.content).join("\n")}</div>}));
let root: Root, container: HTMLDivElement;
const closed = vi.fn();
function work(opened = false): P4StreamWork {
  return {spec:{path:"//project/dev",name:"Development",owner:"alice",kind:"development",parent:"//project/main",parentView:"inherit",description:"Development",options:{locked:false,ownerSubmit:false,toParent:true,fromParent:true,mergeAny:false},paths:["share ..."],remapped:[],ignored:[],fingerprint:"form",opened,editableFields:["Paths"]},opened:opened?{change:"42",baseChange:"40"}:null,headChange:"40",currentText:"Stream: //project/dev\nParentView: inherit\n",headText:"",diff:{path:"//project/dev",oldPath:null,binary:false,truncated:false,lines:[]},unresolved:false,resolveOutput:"",fingerprint:"workspace"};
}
beforeEach(() => {
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});setLanguagePreference("en");vi.resetAllMocks();
  actions.work.mockResolvedValue(work());actions.applyWork.mockResolvedValue(work(true));
  actions.previewWork.mockImplementation(async (request:P4StreamWorkRequest) => ({request,work:await actions.work(),convertedText:request.action==="parentview"?"Stream: //project/dev\nParentView: noinherit\n":null,output:"",fingerprint:"reviewed-operation"}));
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();});
async function render(element:React.ReactNode=<P4StreamWorkDialog onClose={closed}/>) {await act(async()=>root.render(<TooltipProvider>{element}</TooltipProvider>));}
function button(text:string) {const value=[...document.querySelectorAll("button")].find(item=>item.textContent?.trim()===text);if(!value)throw new Error(`Missing button: ${text}`);return value;}
async function click(text:string) {await act(async()=>button(text).click());}
async function enter(id:string,value:string) {
  const element=document.getElementById(id) as HTMLInputElement|HTMLSelectElement;
  expect(element).not.toBeNull();
  await act(async()=>{Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element),"value")!.set!.call(element,value);element.dispatchEvent(new Event(element.tagName==="SELECT"?"change":"input",{bubbles:true}));});
}

it("opens a private edit only after a reviewed preview and pins it to the chosen changelist",async()=>{
  await render();expect(actions.applyWork).not.toHaveBeenCalled();
  await enter("p4-stream-change","42");await click("Preview");expect(actions.applyWork).not.toHaveBeenCalled();
  await click("Open for private editing");expect(actions.applyWork).toHaveBeenCalledWith({action:"open",change:"42",mode:"merge"},"reviewed-operation");
  expect(document.body.textContent).toContain("Private · #42");expect(button("Edit private definition").disabled).toBe(false);
});

it("invalidates approval when the destination changes",async()=>{
  await render();await click("Preview");await enter("p4-stream-change","42");
  expect([...document.querySelectorAll("button")].some(item=>item.textContent?.trim()==="Open for private editing")).toBe(false);
  await click("Preview");await click("Open for private editing");
  expect(actions.previewWork).toHaveBeenCalledTimes(2);expect(actions.applyWork).toHaveBeenCalledWith(expect.objectContaining({change:"42"}),"reviewed-operation");
});

it("shows the server-generated parent-view mapping changes before conversion",async()=>{
  await render();await enter("p4-stream-operation","parentview");await click("Preview");
  expect(actions.previewWork).toHaveBeenCalledWith({action:"parentview",change:"default",mode:"noinherit"});
  expect(document.body.textContent).toContain("ParentView: noinherit");expect(actions.applyWork).not.toHaveBeenCalled();
  await click("Convert parent view");expect(actions.applyWork).toHaveBeenCalledWith(expect.objectContaining({action:"parentview"}),"reviewed-operation");
});

it("requires the full stream path before reverting and clears it after a rejected approval",async()=>{
  actions.work.mockResolvedValue(work(true));actions.applyWork.mockRejectedValueOnce(new Error("The stream, workspace, or changelist changed. Preview the stream operation again."));
  await render();await enter("p4-stream-operation","revert");await click("Preview");
  expect(button("Revert private edit").disabled).toBe(true);await enter("p4-stream-revert","//project/dev ");expect(button("Revert private edit").disabled).toBe(true);
  await enter("p4-stream-revert","//project/dev");await click("Revert private edit");
  expect(actions.applyWork).toHaveBeenCalledOnce();expect(document.querySelector('[role="alert"]')?.textContent).toContain("Preview");
  await click("Preview");expect((document.getElementById("p4-stream-revert") as HTMLInputElement).value).toBe("");
});

it("restores only a stream definition with an explicit shelf and destination",async()=>{
  await render(<P4StreamWorkDialog restore="50" onClose={closed}/>);await enter("p4-stream-change","42");await click("Preview");
  expect(actions.previewWork).toHaveBeenCalledWith({action:"unshelve",change:"42",mode:"50"});
  await click("Restore stream definition");expect(actions.applyWork).toHaveBeenCalledWith({action:"unshelve",change:"42",mode:"50"},"reviewed-operation");
});

it("compares the shelf with the workspace snapshot returned by the preview",async()=>{
  actions.work.mockResolvedValue({...work(),currentText:"Name: Old workspace\n"});
  actions.previewWork.mockImplementation(async(request:P4StreamWorkRequest)=>({request,work:{...work(),currentText:"Name: Current workspace\n"},convertedText:"Name: Shelved version\n",output:"",fingerprint:"fresh-shelf"}));
  await render(<P4StreamWorkDialog restore="50" onClose={closed}/>);await click("Preview");
  expect(document.body.textContent).toContain("Current workspace");expect(document.body.textContent).toContain("Shelved version");expect(document.body.textContent).not.toContain("Old workspace");expect(document.body.textContent).toContain("workspace → shelf #50");expect(actions.applyWork).not.toHaveBeenCalled();
});

it("reviews the actual shelved definition before removal rather than the private edit",async()=>{
  actions.work.mockResolvedValue({...work(true),currentText:"Name: Unrelated private work\n"});
  actions.previewWork.mockImplementation(async(request:P4StreamWorkRequest)=>({request,work:await actions.work(),convertedText:"Name: Shelved definition\n",output:"",fingerprint:"shelved-definition"}));
  await render(<P4StreamWorkDialog removeShelf="50" onClose={closed}/>);await click("Preview");
  expect(document.body.textContent).toContain("Shelved definition");expect(document.body.textContent).not.toContain("Unrelated private work");expect(actions.applyWork).not.toHaveBeenCalled();
});

it("allows a stream-only changelist through the existing submit dialog",async()=>{
  const submit=vi.fn(async()=>true);
  await render(<P4ChangeDialog request={{id:"42",description:"Update mappings",mode:"submit"}} openedCount={0} openedStream available busy={false} onConfirm={submit} onClose={closed}/>);
  expect(button("Submit changelist").disabled).toBe(false);await click("Submit changelist");
  expect(submit).toHaveBeenCalledWith("Update mappings");expect(closed).toHaveBeenCalledOnce();
});

it("returns from a nested shelf restoration to the owning pending changelist",async()=>{
  actions.work.mockResolvedValue(work(true)); const navigate=vi.fn();
  await render(<P4StreamWorkDialog restore="50" onClose={closed} onNavigate={navigate}/>);
  await click("Show pending changelist");
  expect(actions.selectChange).toHaveBeenCalledWith("42");expect(actions.setView).toHaveBeenCalledWith("pending");expect(actions.setShelvesOpen).toHaveBeenCalledWith(false);expect(navigate).toHaveBeenCalledOnce();expect(closed).not.toHaveBeenCalled();
});

it("shows both private and public values when reviewing stream conflicts",async()=>{
  const conflict={...work(true),unresolved:true,currentText:"Name: Private work\n",headText:"Name: Public update\n",resolveOutput:"Name requires resolving"};
  actions.work.mockResolvedValue(conflict);
  actions.previewWork.mockImplementation(async(request:P4StreamWorkRequest)=>({request,work:conflict,convertedText:null,output:conflict.resolveOutput,fingerprint:"conflict-preview"}));
  await render();await enter("p4-stream-operation","resolve");await click("Preview");
  expect(document.body.textContent).toContain("Private work");expect(document.body.textContent).toContain("Public update");expect(document.body.textContent).toContain("Version comparison");expect(actions.applyWork).not.toHaveBeenCalled();
});

it("requires a fresh path confirmation for stream-only shelf removal",async()=>{
  await render(<P4StreamWorkDialog removeShelf="50" onClose={closed}/>);await click("Preview");
  expect(actions.previewWork).toHaveBeenCalledWith({action:"deleteShelf",change:"default",mode:"50"});
  expect(button("Remove definition from shelf").disabled).toBe(true);await enter("p4-stream-revert","//project/dev");await click("Back");await click("Preview");
  expect((document.getElementById("p4-stream-revert") as HTMLInputElement).value).toBe("");await enter("p4-stream-revert","//project/dev");await click("Remove definition from shelf");
  expect(actions.applyWork).toHaveBeenCalledWith({action:"deleteShelf",change:"default",mode:"50"},"reviewed-operation");
});

it.each([false,true])("explains the shelf submit restriction with openedStream=%s before attempting a submit",async(openedStream)=>{
  const submit=vi.fn(async()=>true),manage=vi.fn();
  await render(<P4ChangeDialog request={{id:"42",description:"Update mappings",mode:"submit"}} openedCount={1} openedStream={openedStream} shelved available busy={false} onConfirm={submit} onClose={closed} onManageShelf={manage}/>);
  expect(button("Submit changelist").disabled).toBe(true);expect(document.querySelector('[role="alert"]')?.textContent).toContain("shelved content");
  await click("Delete shelf");expect(manage).toHaveBeenCalledOnce();expect(submit).not.toHaveBeenCalled();
});
