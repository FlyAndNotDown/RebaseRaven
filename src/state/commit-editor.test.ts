import { describe, expect, it } from "vitest";
import type { WorkspaceSnapshot } from "@/types/git";
import { emptySession } from "./session";
import { canClearCommitEditor, commitEditorSubmission, editCommitEditor, resolveCommitEditor, reviewCommitDraft, reuseCommitEditor, reusedCommitMessage } from "./commit-editor";

function snapshot(headId = "first", message?: string, kind = "merge") {
  return { repo: { headId, operation: message === undefined ? null : { kind, message } } } as WorkspaceSnapshot;
}

function session() {
  return { ...emptySession("/work/repository"), snapshot: snapshot() };
}

function typeText(current: ReturnType<typeof session>, text: string, amend = false) {
  return { ...current, commitEditor: editCommitEditor(current, { ...resolveCommitEditor(current), text, amend }) };
}

describe("repository commit editor", () => {
  it("restores independent drafts and amend choices after view and repository remounts", () => {
    const first = typeText(session(), "First repository\n\nKeep these details", true);
    const second = typeText({ ...session(), path: "/work/another" }, "Second repository");
    const switched = { ...first, view: "history" as const };
    expect(resolveCommitEditor(second).text).toBe("Second repository");
    expect(resolveCommitEditor(switched)).toMatchObject({ text: "First repository\n\nKeep these details", amend: true });
    expect(resolveCommitEditor(first)).toEqual(resolveCommitEditor(switched));
  });

  it("keeps an explicit clear through remounts until the native message changes", () => {
    const native = { ...session(), snapshot: snapshot("first", "Merge feature") };
    expect(resolveCommitEditor(native).text).toBe("Merge feature");
    const cleared = typeText(native, "");
    expect(resolveCommitEditor({ ...cleared }).text).toBe("");
    expect(resolveCommitEditor({ ...cleared, snapshot: snapshot("first", "Next step", "rebase") }).text).toBe("Next step");
  });

  it("updates native messages and removes them after abort without discarding custom text", () => {
    const native = { ...session(), snapshot: snapshot("first", "Merge feature") };
    const unedited = typeText(native, "Merge feature");
    const edited = typeText(native, "Custom merge explanation");
    expect(resolveCommitEditor({ ...unedited, snapshot: snapshot("first", "New merge") }).text).toBe("New merge");
    expect(resolveCommitEditor({ ...unedited, snapshot: snapshot() }).text).toBe("");
    expect(resolveCommitEditor({ ...edited, snapshot: snapshot() }).text).toBe("Custom merge explanation");
  });

  it("restores an Undo message on the first render without replacing typed text", () => {
    const draft = { text: "Undone commit\n\nIts original details", nonce: 1 };
    expect(resolveCommitEditor({ ...session(), commitDraft: draft }).text).toBe(draft.text);
    expect(resolveCommitEditor({ ...typeText(session(), "My next commit"), commitDraft: draft }).text).toBe("My next commit");
  });

  it("does not resurrect a consumed Undo message after the user clears it", () => {
    const undone = { ...session(), commitDraft: { text: "Original commit", nonce: 1 } };
    const cleared = typeText(undone, "");
    expect(resolveCommitEditor({ ...cleared }).text).toBe("");
    expect(resolveCommitEditor({ ...cleared, commitDraft: { text: "Another commit", nonce: 2 } }).text).toBe("Another commit");
  });

  it("consumes a programmatic message that races with an explicit user edit", () => {
    const beforeUndo = resolveCommitEditor(session());
    const undone = { ...session(), commitDraft: { text: "Original commit", nonce: 1 } };
    const next = { ...undone, commitEditor: editCommitEditor(undone, { ...beforeUndo, text: "" }) };
    expect(resolveCommitEditor(next).text).toBe("");
  });

  it("pins amend to the reviewed HEAD and disables it during every native operation", () => {
    const amended = typeText(session(), "Reword this commit", true);
    expect(resolveCommitEditor(amended).amend).toBe(true);
    expect(resolveCommitEditor({ ...amended, snapshot: snapshot("second") }).amend).toBe(false);
    for (const kind of ["merge", "rebase", "cherry-pick", "revert", "bisect"]) {
      expect(resolveCommitEditor({ ...amended, snapshot: snapshot("first", "Native message", kind) }).amend).toBe(false);
    }
    expect(resolveCommitEditor({ ...session(), snapshot: snapshot("first", "Ignore bisect text", "bisect") }).text).toBe("");
  });

  it("rejects a stale amend toggle when a newer repository snapshot already changed HEAD", () => {
    const reviewed = { ...resolveCommitEditor(session()), text: "Reviewed message", amend: true };
    const changed = { ...session(), snapshot: snapshot("second") };
    const edited = editCommitEditor(changed, reviewed);
    expect(edited.text).toBe("Reviewed message");
    expect(edited.amend).toBe(false);
  });
});

describe("commit completion ownership", () => {
  it("can clear the submitted draft after the commit refreshes HEAD", () => {
    const current = typeText(session(), "Ship this change", true);
    const submission = commitEditorSubmission(current, "Ship this change");
    expect(canClearCommitEditor({ ...current, snapshot: snapshot("new commit") }, submission)).toBe(true);
    expect(canClearCommitEditor(undefined, submission)).toBe(false);
  });

  it("preserves fresh input, even when the user re-enters exactly the submitted text", () => {
    const current = typeText(session(), "Ship this change");
    const submission = commitEditorSubmission(current, "Ship this change");
    expect(canClearCommitEditor(typeText(current, "My next change"), submission)).toBe(false);
    expect(canClearCommitEditor(typeText(current, ""), submission)).toBe(false);
    expect(canClearCommitEditor(typeText(current, "Ship this change"), submission)).toBe(false);
    expect(canClearCommitEditor(typeText(session(), "Ship this change"), submission)).toBe(false);
  });

  it("preserves an Undo request that arrives while a commit is pending", () => {
    const current = typeText(session(), "Ship this change");
    const submission = commitEditorSubmission(current, "Ship this change");
    expect(canClearCommitEditor({ ...current, commitDraft: { text: "Recovered change", nonce: 2 } }, submission)).toBe(false);
  });

  it("clears an unchanged programmatic draft together with its consumed Undo request", () => {
    const current = { ...session(), commitDraft: { text: "Recovered change", nonce: 1 } };
    expect(canClearCommitEditor(current, commitEditorSubmission(current, "Recovered change"))).toBe(true);
    expect(canClearCommitEditor(current, commitEditorSubmission(current, "Another change"))).toBe(false);
  });

  it("preserves custom text when a banner continues with Git's native message", () => {
    const native = { ...session(), snapshot: snapshot("first", "Merge feature") };
    const custom = typeText(native, "Explain the resolution");
    expect(canClearCommitEditor(custom, commitEditorSubmission(custom))).toBe(false);
    expect(canClearCommitEditor(custom, commitEditorSubmission(custom, "Explain the resolution"))).toBe(true);
    const unedited = typeText(native, "Merge feature\n");
    expect(canClearCommitEditor(unedited, commitEditorSubmission(unedited))).toBe(true);
  });
});

describe("reviewed message reuse", () => {
  it("starts a new commit without preserving amend mode", () => {
    const current = typeText(session(), "Existing draft", true);
    const next = reuseCommitEditor(current, reviewCommitDraft(current), "Original subject\ncontinued\n\nBody\n", "replace");
    expect(next).toMatchObject({text:"Original subject\ncontinued\n\nBody\n",amend:false});
    expect(current.commitEditor.text).toBe("Existing draft");
  });

  it("shows the exact appended result without folding paragraphs or dropping trailers", () => {
    const source="Subject\ncontinued\n\nSigned-off-by: Original <original@example.com>\n";
    expect(reusedCommitMessage("Keep my draft\n\n",source,"append")).toBe(`Keep my draft\n\n${source}`);
    expect(reusedCommitMessage("  ",source,"append")).toBe(source);
  });

  it("rejects fresh input even if it repeats the reviewed text", () => {
    const current=typeText(session(),"My draft");const review=reviewCommitDraft(current);
    expect(reuseCommitEditor(typeText(current,"My draft"),review,"Imported message","replace")).toBeNull();
    expect(reuseCommitEditor({...current,commitDraft:{text:"Undo arrived",nonce:3}},review,"Imported message","replace")).toBeNull();
    expect(reuseCommitEditor(current,review," \n","replace")).toBeNull();
  });

  it("rejects a changed HEAD, branch, or operation without replacing the draft", () => {
    const current=typeText(session(),"My draft");const review=reviewCommitDraft(current);
    expect(reuseCommitEditor({...current,snapshot:snapshot("changed")},review,"Imported message","replace")).toBeNull();
    const branchChanged={...current,snapshot:{...current.snapshot!,repo:{...current.snapshot!.repo,currentBranch:"different"}}};
    expect(reuseCommitEditor(branchChanged,review,"Imported message","replace")).toBeNull();
    expect(reuseCommitEditor({...current,snapshot:snapshot("first","Merge message")},review,"Imported message","replace")).toBeNull();
  });

  it("consumes the previous Undo message so clearing imported text keeps it cleared", () => {
    const current={...session(),commitDraft:{text:"Undone message",nonce:3}};
    const editor=reuseCommitEditor(current,reviewCommitDraft(current),"Imported message","replace")!;
    expect(editor.draftNonce).toBe(3);
    expect(resolveCommitEditor(typeText({...current,commitEditor:editor},"")).text).toBe("");
  });
});
