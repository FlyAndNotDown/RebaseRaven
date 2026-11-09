// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuthorAvatar } from "@/components/author-avatar";

const shared = vi.hoisted(() => ({get:vi.fn(),configure:vi.fn(),state:{prefs:{gitAvatarProvider:"auto",p4AvatarProvider:"builtin",httpProxy:{mode:"system",url:""}},snapshot:{repo:{path:"project"},remotes:[{name:"origin",url:"git@github.com:owner/project.git"}]}}}));
vi.mock("@/state/git-context", () => ({useGitSelect:(select:(state:typeof shared.state) => unknown) => select(shared.state)}));
vi.mock("@/lib/avatars", () => ({authorAvatars:{get:shared.get,configure:shared.configure}}));
let root:Root, container:HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});vi.resetAllMocks();
  shared.state.prefs.gitAvatarProvider="auto";
  shared.state.snapshot.remotes=[{name:"origin",url:"git@github.com:owner/project.git"}];
  shared.get.mockResolvedValue("data:image/png;base64,QQ==");
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
});
afterEach(async () => {await act(async () => root.unmount());container.remove();});
async function render(vcs:"git"|"perforce") {await act(async () => root.render(<AuthorAvatar vcs={vcs} name="Alice" email="alice@example.com" />));}

it("never requests remote avatars for Perforce even when Git uses GitHub", async () => {
  await render("perforce");expect(shared.get).not.toHaveBeenCalled();expect(shared.configure).not.toHaveBeenCalled();
  expect(document.querySelector("svg text")?.textContent).toBe("A");
});

it("uses the repository provider in auto mode and clears remote images for local repositories", async () => {
  await render("git");expect(shared.get).toHaveBeenCalledWith("github","alice@example.com","project");
  expect(document.querySelector("img")).not.toBeNull();
  shared.state.snapshot.remotes=[{name:"origin",url:"https://gitlab.com/group/project.git"}];
  await render("git");expect(shared.get).toHaveBeenLastCalledWith("gitlab","alice@example.com","project");
  shared.state.snapshot.remotes=[];await render("git");expect(document.querySelector("img")).toBeNull();
  expect(shared.get).toHaveBeenCalledTimes(2);
});

it("honors an explicit builtin Git setting", async () => {
  shared.state.prefs.gitAvatarProvider="builtin";await render("git");
  expect(shared.get).not.toHaveBeenCalled();expect(document.querySelector("img")).toBeNull();
});
