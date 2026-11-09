import { invoke } from "@tauri-apps/api/core";
import { gitApi } from "@/lib/git";
import type { FileSource } from "@/types/git";
import type { P4Connection, P4FileSource } from "@/types/p4";

export type TextPair = { path: string; before: string; after: string };
export type DiffToolSource =
  | { kind: "git"; repoPath: string; source: FileSource }
  | { kind: "perforce"; connection: P4Connection; source: P4FileSource }
  | ({ kind: "text" } & TextPair);

export function openDiffEditor(source: DiffToolSource, line: number | null) {
  return source.kind === "git"
    ? gitApi.openFileInEditor(source.repoPath, source.source, line)
    : invoke<void>("open_diff_document", { source, line, externalDiff: false });
}

export function openExternalDiff(source: DiffToolSource) {
  return source.kind === "git"
    ? gitApi.openDifftool(source.repoPath, source.source)
    : invoke<void>("open_diff_document", { source, line: null, externalDiff: true });
}

export function diffDocumentText(source: Exclude<DiffToolSource, { kind: "git" }>) {
  return source.kind === "text" ? Promise.resolve(source) : invoke<TextPair>("diff_document_text", { source });
}
