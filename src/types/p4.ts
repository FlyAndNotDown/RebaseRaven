import type { FileDiff } from "@/types/git";

export interface P4Connection {
  root: string;
  port: string;
  user: string;
  client: string;
  charset: string;
  stream: string | null;
  server: string;
}

export interface P4File {
  depotPath: string;
  localPath: string;
  action: string;
  rev: string;
  shelved: boolean;
  binary: boolean;
  status: string;
  detail: string;
}

export interface P4StreamChange { path: string; baseChange: string }

export interface P4Changelist {
  id: string;
  user: string;
  client: string;
  status: string;
  description: string;
  time: number;
  shelved: boolean;
  files: P4File[];
  stream?: P4StreamChange | null;
  shelvedStream?: P4StreamChange | null;
}

export interface P4ChangePage {
  changes: P4Changelist[];
  hasMore: boolean;
  scannedThrough: number | null;
}

export interface P4Describe {
  change: P4Changelist;
  diffs: FileDiff[];
}

export interface P4ResolveView {
  path: string;
  summary: string;
  content: boolean;
  comparable: boolean;
  workingCopy: boolean;
  pendingResolves: number;
  diff: FileDiff;
}

export interface P4Revision {
  depotPath: string;
  rev: string;
  change: string;
  action: string;
  user: string;
  time: number;
  description: string;
}

export interface P4Location {
  depot: string;
  local: string;
}

export interface P4DirEntry {
  name: string;
  path: string;
  dir: boolean;
  status: string;
  detail: string;
}

export interface P4EntryStatus {
  path: string;
  status: string;
  detail: string;
}

export interface P4FileSearch {
  hits: P4DirEntry[];
  truncated: boolean;
  scope: string;
}

export type P4RevisionMode = "latest" | "revision" | "changelist" | "beforeChangelist" | "datetime" | "label" | "workspace";

export interface P4RevisionPath { path: string; recursive: boolean }

export interface P4GetRevision {
  paths: string[];
  changeId?: string;
  recursive?: boolean;
  targets?: P4RevisionPath[];
  mode: P4RevisionMode;
  value: string;
  force: boolean;
  safe: boolean;
  changelistFilesOnly: boolean;
  removeNotInLabel: boolean;
  preview: boolean;
}

export interface P4RevisionRange {
  from: string;
  to: string;
}

export interface P4IntegrateRequest {
  source: string;
  target: string;
  range: P4RevisionRange | null;
  changeId: string;
}

export type P4UndoSelector =
  | { mode: "revision"; revision: string }
  | { mode: "range"; from: string; to: string }
  | { mode: "changelist"; change: string };

export interface P4UndoRequest {
  path: string;
  selector: P4UndoSelector;
  changeId: string;
}

export interface P4OperationPreview {
  output: string;
  fingerprint: string;
  target: string;
}

export interface P4Auth {
  port: string;
  user: string;
  password: string;
  charset: string;
}

export interface P4ClientOption {
  name: string;
  root: string;
  stream: string;
  description: string;
}

export interface P4StreamOption {
  parent?: string;
  path: string;
  kind: string;
}

export interface P4DepotEntry {
  path: string;
  dir: boolean;
}

export interface P4CheckedConnection {
  server: string;
  clients: P4ClientOption[];
}

export interface P4CreateRequest {
  port: string;
  user: string;
  password: string;
  client: string;
  root: string;
  stream: string;
  depotPath: string;
  charset: string;
}

export type P4OpenResult =
  | { status: "ready"; connection: P4Connection; pending: P4Changelist[] }
  | { status: "login"; connection: P4Connection };

export type RepoDetection =
  | { kind: "git"; path: string }
  | { kind: "perforce"; connection: P4Connection }
  | { kind: "ambiguous"; path: string; gitPath: string; connection: P4Connection }
  | { kind: "none"; path: string };

export interface P4Executables {
  pathP4: string | null;
  active: string | null;
}

export interface P4ManualResolve {
  base: string;
  yours: string;
  theirs: string;
  fingerprint: string;
}

export interface P4ReconcilePreview {
  files: { path: string; depotPath: string; action: string }[];
  fingerprint: string;
}

export interface P4StreamRequest {
  mode: "merge" | "copy";
  source: string;
  changeId: string;
}
export type P4StreamPreview = P4ReconcilePreview;

export interface P4UnshelveRequest {
  changeId: string;
  target: string;
  files: string[];
  stream: string;
}

export interface P4HistoryCursor { depotPath: string; beforeRevision: number }
export interface P4RevisionPage { revisions: P4Revision[]; next: P4HistoryCursor | null }

export type P4FileVersion = { kind: "revision"; depotPath: string; revision: string } | { kind: "workspace" };
export interface P4CompareRequest { path: string; base: P4FileVersion; head: P4FileVersion }

export interface P4BlameLine { line: number; change: string; user: string; time: string; content: string }

export type P4FileSource =
  | { kind: "opened"; path: string }
  | { kind: "shelf"; path: string; changeId: string }
  | { kind: "revision"; path: string; revision: string }
  | { kind: "compare"; request: P4CompareRequest }
  | { kind: "resolve"; path: string }
  | { kind: "stream"; request: import("./p4-stream-specs").P4StreamDiffRequest };

export interface P4WorkspaceOptions { allwrite: boolean; clobber: boolean; compress: boolean; modtime: boolean; rmdir: boolean }
export interface P4WorkspaceEdit { root: string; view: string[]; lineEnd: "local" | "unix" | "mac" | "win" | "share"; options: P4WorkspaceOptions }
export interface P4WorkspaceSettings extends P4WorkspaceEdit { stream: string; fingerprint: string }

export interface P4SwitchRequest { target: string; shelve: boolean }
export interface P4SwitchFile { path: string; depotPath: string; action: string; change: string | null }
export interface P4SwitchPreview { current: string; target: string; view: string[]; limitView: string[]; changes: P4SwitchFile[]; unresolved: boolean; fingerprint: string }
export interface P4SwitchOutcome { connection: P4Connection; source: string; target: string; stage: "shelve" | "switch" | "sync" | "done"; backupShelf: string | null; output: string }

export interface P4FileProperties {
  depotPath: string;
  localPath: string;
  headType: string;
  openType: string;
  haveRev: string;
  headRev: string;
  headChange: string;
  headTime: number;
  headModTime: number;
  size: number | null;
  digest: string;
  action: string;
  changeId: string;
  owner: string;
  locked: boolean;
  otherOpen: { owner: string; action: string; change: string; locked: boolean }[];
  blocked: string;
}
export interface P4FilePropertiesView { files: P4FileProperties[]; fingerprint: string }
export interface P4FileTypeRequest { paths: string[]; selected: string[]; fileType: string; changeId: string }
export interface P4CleanRequest {
  scope: string;
  restoreModified: boolean;
  restoreMissing: boolean;
  removeUntracked: boolean;
  includeIgnored: boolean;
}
export interface P4CleanFile {path: string; depotPath: string; action: "restoreModified" | "restoreMissing" | "removeUntracked"; revision: string | null}
export interface P4CleanPreview {files: P4CleanFile[]; fingerprint: string}
