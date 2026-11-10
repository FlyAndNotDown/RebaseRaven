import type { WorkspaceSnapshot } from "@/types/git";

/** Text requested by an operation such as undoing a commit. */
export type CommitDraft = { text: string; nonce: number };

export interface CommitEditorState {
  text: string;
  amend: boolean;
  headId: string | null;
  preparedMessage: string;
  draftNonce: number;
}

type EditorSession = {
  snapshot: WorkspaceSnapshot | null;
  commitEditor: CommitEditorState | null;
  commitDraft: CommitDraft | null;
};

export function preparedCommitMessage(snapshot: WorkspaceSnapshot | null) {
  const operation = snapshot?.repo.operation;
  return operation?.kind === "bisect" ? "" : operation?.message ?? "";
}

/** Resolve native messages without replacing a user's edited or explicitly cleared text. */
export function resolveCommitEditor(session: EditorSession): CommitEditorState {
  const { commitEditor: editor, commitDraft: draft, snapshot } = session;
  const preparedMessage = preparedCommitMessage(snapshot);
  let text = editor?.text ?? preparedMessage;
  if (editor && preparedMessage !== editor.preparedMessage
    && (!text.trim() || text === editor.preparedMessage)) {
    text = preparedMessage;
  }
  if (draft && draft.nonce !== editor?.draftNonce && !text.trim()) text = draft.text;
  const headId = snapshot?.repo.headId ?? null;
  return {
    text,
    amend: Boolean(editor?.amend && headId && headId === editor.headId && !snapshot?.repo.operation),
    headId,
    preparedMessage,
    draftNonce: draft?.nonce ?? editor?.draftNonce ?? 0,
  };
}

/** A user edit also consumes pending programmatic drafts, including an explicit clear. */
export function editCommitEditor(session: EditorSession, edit: CommitEditorState): CommitEditorState {
  const current = resolveCommitEditor(session);
  return {
    ...current,
    text: edit.text,
    amend: Boolean(edit.amend && current.headId && edit.headId === current.headId && !session.snapshot?.repo.operation),
  };
}

export type CommitMessageMode = "replace" | "append";
export type CommitDraftReview = {
  editor: CommitEditorState | null;
  draft: CommitDraft | null;
  headId: string | null;
  branch: string | null;
  text: string;
};

export function reviewCommitDraft(session: EditorSession): CommitDraftReview {
  return {
    editor: session.commitEditor,
    draft: session.commitDraft,
    headId: session.snapshot?.repo.headId ?? null,
    branch: session.snapshot?.repo.currentBranch ?? null,
    text: resolveCommitEditor(session).text,
  };
}

export function sameReviewedCommitDraft(session: EditorSession, review: CommitDraftReview) {
  return Boolean(session.snapshot) && !session.snapshot?.repo.operation
    && session.commitEditor === review.editor && session.commitDraft === review.draft
    && (session.snapshot?.repo.headId ?? null) === review.headId
    && (session.snapshot?.repo.currentBranch ?? null) === review.branch;
}

export function reusedCommitMessage(draft: string, source: string, mode: CommitMessageMode) {
  return mode === "append" && draft.trim() ? `${draft.trimEnd()}\n\n${source.trimStart()}` : source;
}

/** Reusing text starts a new commit and consumes any earlier Undo draft. */
export function reuseCommitEditor(session: EditorSession, review: CommitDraftReview, message: string, mode: CommitMessageMode): CommitEditorState | null {
  if (!sameReviewedCommitDraft(session, review) || !message.trim()) return null;
  return editCommitEditor(session, {
    ...resolveCommitEditor(session),
    text: reusedCommitMessage(review.text, message, mode),
    amend: false,
  });
}

export function commitEditorSubmission(session: EditorSession | undefined, message?: string) {
  const current = session ? resolveCommitEditor(session) : null;
  const submitted = message ?? preparedCommitMessage(session?.snapshot ?? null);
  return {
    editor: session?.commitEditor ?? null,
    draftNonce: session?.commitDraft?.nonce ?? 0,
    matches: Boolean(current && current.text.trim() === submitted.trim()),
  };
}

/** Object identity distinguishes fresh input even when the user re-enters the same text. */
export function canClearCommitEditor(session: EditorSession | undefined, submission: ReturnType<typeof commitEditorSubmission>) {
  return Boolean(session && submission.matches && session.commitEditor === submission.editor
    && (session.commitDraft?.nonce ?? 0) === submission.draftNonce);
}
