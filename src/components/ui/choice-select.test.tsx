// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChoiceSelect } from "./choice-select";
import { chooseChoice } from "@/test/choose-choice";

let root:Root,container:HTMLDivElement;
const change=vi.fn(),submit=vi.fn();
function Field({disabled=false}:{disabled?:boolean}) {
  const [value,setValue]=useState("origin");
  return <form onSubmit={submit}><ChoiceSelect id="remote" aria-label="Remote" value={value} disabled={disabled} onValueChange={next => {change(next);setValue(next);}} options={[{value:"",label:"None"},{value:"origin",label:"Origin"},{value:"blocked",label:"Blocked",disabled:true}]} /></form>;
}
beforeEach(() => {Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});vi.clearAllMocks();container=document.createElement("div");document.body.append(container);root=createRoot(container);});
afterEach(async () => {await act(async () => root.unmount());container.remove();});

it("supports an empty selection through the styled menu without submitting its form", async () => {
  await act(async () => root.render(<Field />));const trigger=document.getElementById("remote")!;
  await chooseChoice(trigger,"");expect(change).toHaveBeenLastCalledWith("");expect(trigger.textContent).toContain("None");expect(submit).not.toHaveBeenCalled();
  await chooseChoice(trigger,"origin");expect(change).toHaveBeenLastCalledWith("origin");expect(trigger.textContent).toContain("Origin");
});

it("opens through accessibility activation without toggling a normal pointer click twice", async () => {
  await act(async () => root.render(<Field />));const trigger=document.getElementById("remote")!;
  await act(async () => trigger.click());expect(document.querySelector('[role="menu"]')).not.toBeNull();
  await act(async () => trigger.dispatchEvent(new MouseEvent("click",{bubbles:true,detail:1})));expect(document.querySelector('[role="menu"]')).not.toBeNull();
  await act(async () => trigger.click());expect(document.querySelector('[role="menu"]')).toBeNull();
});

it("respects disabled options and disables the field as a whole", async () => {
  await act(async () => root.render(<Field />));const trigger=document.getElementById("remote")!;
  await chooseChoice(trigger,"blocked");expect(change).not.toHaveBeenCalled();
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
  await act(async () => root.render(<Field disabled />));expect((document.getElementById("remote") as HTMLButtonElement).disabled).toBe(true);
});
