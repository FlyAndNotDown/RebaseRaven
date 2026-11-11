// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { P4DirectoryHistory } from "./p4-directory-history";
import type { SubmittedHistoryModel } from "./p4-submitted";
import { setLanguagePreference } from "@/i18n";
import type { P4Changelist, P4ChangePage } from "@/types/p4";

const actions=vi.hoisted(()=>({history:vi.fn(),describe:vi.fn(),globalLoad:vi.fn()}));
let model:SubmittedHistoryModel,scope:string | undefined,root:Root,container:HTMLDivElement;
vi.mock("@/state/p4-context",()=>({useP4:()=>({pathHistory:actions.history,describeSubmitted:actions.describe,loadSubmitted:actions.globalLoad})}));
vi.mock("./p4-submitted",()=>({P4Submitted:({history,historyScope}:{history:SubmittedHistoryModel;historyScope?:string})=>{model=history;scope=historyScope;return <div>{history.submitted.map(change=><span key={change.id}>{change.id}</span>)}<p>{history.submittedDetail?.description}</p></div>;}}));
function change(id:string):P4Changelist {return {id,user:"alice",client:"work",status:"submitted",description:`Change ${id}`,time:1,shelved:false,files:[]};}
function page(ids:string[],hasMore=false):P4ChangePage {return {changes:ids.map(change),hasMore,scannedThrough:ids.length ? Number(ids.at(-1)) : null};}
async function render(path="/workspace/docs",strict=false) {await act(async()=>root.render(strict ? <StrictMode><P4DirectoryHistory key={path} path={path}/></StrictMode> : <P4DirectoryHistory key={path} path={path}/>));}
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});setLanguagePreference("en");vi.resetAllMocks();actions.history.mockResolvedValue(page(["80","70"]));actions.describe.mockImplementation(async id=>change(id));container=document.createElement("div");document.body.append(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();});

it("loads its own scoped history under StrictMode without changing the main History view",async()=>{
  await render("/workspace/docs",true);
  expect(model.submitted.map(change=>change.id)).toEqual(["80","70"]);
  expect(scope).toBe("/workspace/docs");
  expect(actions.history).toHaveBeenLastCalledWith("/workspace/docs",{user:"",client:"",query:"",before:null,limit:50,scanLimit:500});
  expect(actions.globalLoad).not.toHaveBeenCalled();
});

it("keeps filtering, search, and pagination within the selected folder",async()=>{
  actions.history.mockResolvedValueOnce(page(["80","70"],true)).mockResolvedValueOnce(page(["70","60"]));
  await render();await act(async()=>model.loadSubmitted(true));
  expect(model.submitted.map(change=>change.id)).toEqual(["80","70","60"]);
  expect(actions.history).toHaveBeenLastCalledWith("/workspace/docs",expect.objectContaining({before:70}));
  await act(async()=>model.setSubmittedFilter("alice","work"));
  expect(actions.history).toHaveBeenLastCalledWith("/workspace/docs",expect.objectContaining({user:"alice",client:"work",before:null}));
  await act(async()=>{await model.searchSubmitted("42",60,10,100);});
  expect(actions.history).toHaveBeenLastCalledWith("/workspace/docs",{user:"alice",client:"work",query:"42",before:60,limit:10,scanLimit:100});
});

it("discards late pages after switching folders and late details after selecting another change",async()=>{
  let oldPage!:(value:P4ChangePage)=>void;
  actions.history.mockImplementation(path=>path.endsWith("old") ? new Promise<P4ChangePage>(resolve=>{oldPage=resolve;}) : Promise.resolve(page(["80","70"])));
  await render("/workspace/old");await render("/workspace/new");await act(async()=>oldPage(page(["99"])));
  expect(model.submitted.map(change=>change.id)).toEqual(["80","70"]);
  let oldDetail!:(value:P4Changelist)=>void;
  actions.describe.mockImplementation(id=>id==="80" ? new Promise<P4Changelist>(resolve=>{oldDetail=resolve;}) : Promise.resolve(change(id)));
  await act(async()=>{void model.selectSubmitted("80");});await act(async()=>{await model.selectSubmitted("70");});await act(async()=>oldDetail(change("80")));
  expect(model.selectedSubmitted).toBe("70");expect(model.submittedDetail?.id).toBe("70");
});

it("shows a retry for failed folder history without falling back to unscoped history",async()=>{
  actions.history.mockRejectedValueOnce(new Error("History unavailable"));await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("History unavailable");
  await act(async()=>container.querySelector<HTMLButtonElement>('button')!.click());
  expect(model.submitted.map(change=>change.id)).toEqual(["80","70"]);expect(container.querySelector('[role="alert"]')).toBeNull();expect(actions.globalLoad).not.toHaveBeenCalled();
});
