// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsDialog } from "@/components/settings-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { defaultPrefs } from "@/lib/prefs";
import { setLanguagePreference } from "@/i18n";
import type { loadSettingsData } from "@/lib/settings-data";

const actions = vi.hoisted(() => ({load:vi.fn(),update:vi.fn()}));
const prefs = {...defaultPrefs,editorId:"vscode",terminalId:"terminal"};
vi.mock("@/state/git-context", () => ({useGitPick:() => ({prefs,updatePrefs:actions.update})}));
vi.mock("@/lib/settings-data", () => ({loadSettingsData:actions.load}));
vi.mock("next-themes", () => ({useTheme:() => ({theme:"dark",setTheme:vi.fn()})}));
vi.mock("@/state/use-analytics", () => ({useAnalyticsSessionAllowed:() => false}));
let root:Root,container:HTMLDivElement,resolve:(data:Awaited<ReturnType<typeof loadSettingsData>>) => void;
function data(editorAvailable=true): Awaited<ReturnType<typeof loadSettingsData>> {
  return {prefs,identity:{name:"Alice",email:"alice@example.com"},editors:[{id:"system",name:"System default app",available:true},{id:"vscode",name:"Visual Studio Code",available:editorAvailable}],terminals:[{id:"auto",name:"System default",available:true},{id:"terminal",name:"Terminal",available:true}],tools:{diffTool:"",mergeTool:""},guiTools:[],gitExecutables:{pathGit:null,active:null},p4Executables:{pathP4:null,active:null},incomplete:false};
}
beforeEach(() => {
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});setLanguagePreference("en");vi.resetAllMocks();
  vi.stubGlobal("ResizeObserver",class {observe(){} unobserve(){} disconnect(){}});
  actions.load.mockReturnValue(new Promise(done => {resolve=done;}));
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
});
afterEach(async () => {await act(async () => root.unmount());container.remove();vi.unstubAllGlobals();});
async function render(section:"general"|"git"|"perforce"="general") {await act(async () => root.render(<TooltipProvider><SettingsDialog open initialSection={section} onOpenChange={() => {}} /></TooltipProvider>));}
async function click(text:string) {await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent?.trim() === text)!.click());}

it("shows loading placeholders instead of temporary application and preference values", async () => {
  await render();
  expect(document.querySelector('#editor-app')).toBeNull();expect(document.querySelector('#terminal-app')).toBeNull();
  expect(document.querySelector('#language-choice')).toBeNull();expect(document.querySelector('#theme-choice')).toBeNull();
  expect(document.querySelectorAll('[role="status"][aria-label="Loading Application"]')).toHaveLength(2);
  expect(document.body.textContent).not.toContain("System default app");
  await act(async () => resolve(data()));
  expect(document.querySelector('#editor-app')?.textContent).toContain("Visual Studio Code");
  expect(document.querySelector('#terminal-app')?.textContent).toContain("Terminal");
  expect(document.body.textContent).not.toContain("Author avatars");expect(actions.update).not.toHaveBeenCalled();
});

it("preserves the configured application label when it is unavailable", async () => {
  await render();await act(async () => resolve(data(false)));
  expect(document.querySelector('#editor-app')?.textContent).toContain("Visual Studio Code");
  expect(document.querySelector('#editor-app')?.textContent).not.toContain("System default app");
});

it("keeps provider choices in their Git and Perforce settings sections", async () => {
  await render("git");expect(document.querySelector('[aria-label="Loading Author avatars"]')).not.toBeNull();
  await act(async () => resolve(data()));
  const avatars = document.querySelector('button[aria-labelledby]') as HTMLButtonElement;
  expect(avatars.textContent).toContain("Auto");await act(async () => avatars.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true})));
  expect([...document.querySelectorAll('[role="menuitemradio"]')].map(item => item.textContent)).toEqual(["Auto","Built-in","GitHub","GitLab"]);
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
  await click("Perforce");
  const choice = document.querySelector('button[aria-labelledby]') as HTMLButtonElement;
  expect(choice.textContent).toContain("Built-in");await act(async () => choice.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true})));
  expect([...document.querySelectorAll('[role="menuitemradio"]')].map(item => item.textContent)).toEqual(["Built-in"]);
});
