// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DiffSearchBar, DiffSearchButton, DiffSearchScope } from "@/components/diff-search";
import { DiffCode } from "@/components/diff-code";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setLanguagePreference } from "@/i18n";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  setLanguagePreference("en");
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype,"getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
});
afterEach(async () => {await act(async () => root.unmount());container.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
function scope() {return <DiffSearchScope lines={["alpha Alpha", "omega"]}><DiffSearchButton /><DiffSearchBar /></DiffSearchScope>;}
async function key(target: EventTarget, key: string, options: KeyboardEventInit = {}) {
  const event=new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true,...options});
  await act(async () => {target.dispatchEvent(event);});return event;
}
async function query(text: string) {
  const input=document.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,text);
    input.dispatchEvent(new Event("input",{bubbles:true}));
  });return input;
}

it("opens with Ctrl+F and Cmd+F, navigates with Enter, and closes before a dialog", async () => {
  await act(async () => root.render(<TooltipProvider>{scope()}</TooltipProvider>));
  expect((await key(document.body,"f",{ctrlKey:true})).defaultPrevented).toBe(true);
  const input=await query("alpha");expect(document.activeElement).toBe(input);
  expect(document.querySelector('[role="status"]')?.textContent).toBe("1 / 2");
  await key(input,"Enter");expect(document.querySelector('[role="status"]')?.textContent).toBe("2 / 2");
  await key(input,"Enter");expect(document.querySelector('[role="status"]')?.textContent).toBe("1 / 2");
  await key(input,"Enter",{shiftKey:true});expect(document.querySelector('[role="status"]')?.textContent).toBe("2 / 2");
  expect((await key(input,"Escape")).defaultPrevented).toBe(true);expect(document.querySelector('input')).toBeNull();
  await key(document.body,"f",{metaKey:true});expect(document.querySelector("input")?.value).toBe("alpha");
  await query("absent");expect(document.querySelector('[role="status"]')?.textContent).toBe("No matches");
});

it("routes find to the foremost dialog and leaves unrelated dialogs alone", async () => {
  await act(async () => root.render(<TooltipProvider>{scope()}<div role="dialog">{scope()}</div></TooltipProvider>));
  await key(document.body,"f",{ctrlKey:true});
  expect(document.querySelectorAll("input")).toHaveLength(1);
  expect(document.querySelector('[role="dialog"] input')).not.toBeNull();
  await act(async () => root.render(<TooltipProvider>{scope()}<div role="dialog"><input aria-label="Other field" /></div></TooltipProvider>));
  expect((await key(document.body,"f",{ctrlKey:true})).defaultPrevented).toBe(false);
  expect(document.querySelector('[role="search"]')).toBeNull();
});

it("releases the viewport after locating a virtual row and can revisit a single match", async () => {
  const lines = Array.from({length: 300}, (_, index) => ({
    kind: "context", content: index === 180 ? "needle" : "context", oldLineno: index + 1, newLineno: index + 1,
  }));
  const diff = {path: "notes.txt", oldPath: null, binary: false, truncated: false, lines};
  const render = () => act(async () => root.render(<TooltipProvider>
    <DiffSearchScope lines={lines.map(line => line.content)}><DiffSearchBar /><DiffCode diff={diff} /></DiffSearchScope>
  </TooltipProvider>));
  const align = vi.fn();
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {configurable: true, value: align});
  try {
    await render();
    const viewport = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    Object.defineProperty(viewport, "clientHeight", {value: 160});
    function scroll(top: number) {
      viewport.scrollTop = top;
      viewport.dispatchEvent(new Event("scroll"));
    }
    const jump = vi.fn(({top}: ScrollToOptions) => scroll(top!));
    Object.assign(viewport, {scrollTo: jump});
    await key(document.body, "f", {ctrlKey: true});
    const input = await query("needle");
    expect(jump).toHaveBeenCalledTimes(1);
    expect(align).toHaveBeenCalledTimes(1);
    expect(viewport.scrollTop).toBeGreaterThan(0);

    await act(async () => scroll(0));
    await render();
    expect(viewport.scrollTop).toBe(0);
    expect(jump).toHaveBeenCalledTimes(1);
    expect(viewport.querySelector("mark")).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("1 / 1");

    await key(input, "Enter");
    expect(jump).toHaveBeenCalledTimes(2);
    expect(align).toHaveBeenCalledTimes(2);
    expect(viewport.querySelector("mark")?.textContent).toBe("needle");
  } finally {
    if (original) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
});

it("ignores retained inactive workspaces even when they still have layout rectangles", async () => {
  await act(async () => root.render(<TooltipProvider><div data-active>{scope()}</div><div inert aria-hidden="true" style={{opacity:0}}>{scope()}</div></TooltipProvider>));
  await key(document.body,"f",{ctrlKey:true});
  expect(document.querySelector('[data-active] input')).not.toBeNull();
  expect(document.querySelector('[inert] input')).toBeNull();
});

it("closes search before Radix dismisses the containing dialog", async () => {
  const change=vi.fn();
  await act(async () => root.render(<TooltipProvider><Dialog open onOpenChange={change}><DialogContent><DialogTitle>Compare revisions</DialogTitle>{scope()}</DialogContent></Dialog></TooltipProvider>));
  await key(document.body,"f",{ctrlKey:true}); const input=await query("alpha");
  expect((await key(input,"Escape")).defaultPrevented).toBe(true);
  expect(document.querySelector('[role="search"]')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull(); expect(change).not.toHaveBeenCalled();
  await key(document.querySelector('[role="dialog"]')!,"Escape"); expect(change).toHaveBeenCalledWith(false);
});
