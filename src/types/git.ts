
export type FileKind =
  | "added"
  | "deleted"
  | "modified"
  | "renamed"
  | "untracked"
  | "conflicted"
  | "typechange"
  | "copied";

export interface RepoInfo {
  path: string;
  name: string;
  currentBranch: string | null;
  headId: string | null;
  isDetached: boolean;
  ahead: number | null;
  behind: number | null;
  upstream: string | null;
  rebase: RebaseProgress | null;
  operation: GitOperation | null;
}

export interface GitOperation {
  kind: "merge" | "rebase" | "cherry-pick" | "revert" | string;
  headName: string | null;
  onto: string | null;
  step: number | null;
  total: number | null;
  /** The message git prepared for the commit that finishes this step. */
  message: string | null;
}

export interface RebaseProgress {
  onto: string | null;
  headName: string | null;
  step: number | null;
  total: number | null;
}

export type RebaseAction = "pick" | "reword" | "squash" | "fixup" | "drop";

export interface RebaseCommit {
  id: string;
  shortId: string;
  summary: string;
}

export interface RebaseStep {
  id: string;
  action: RebaseAction;
  message: string;
}

export interface ConflictView {
  path: string;
  binary: boolean;
  text: string;
}

export interface FileStatus {
  path: string;
  oldPath: string | null;
  kind: FileKind | string;
  staged: boolean;
}

export interface StatusSnapshot {
  staged: FileStatus[];
  unstaged: FileStatus[];
}

export interface CommitRef {
  name: string;
  kind: "head" | "branch" | "tag" | string;
}

export interface CommitSummary {
  id: string;
  shortId: string;
  summary: string;
  body: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
  parents: string[];
  refs: CommitRef[];
  onCurrentBranch: boolean;
  onTrackingBranch: boolean;
  /** The file's name at this commit; only set by per-file history. */
  path?: string;
}

export interface DiffLine {
  kind: "add" | "delete" | "context" | "hunk" | "meta" | string;
  content: string;
  oldLineno: number | null;
  newLineno: number | null;
}

/** A changed line picked for staging: an addition by its new number, a removal by its old one. */
export interface LineRef {
  old: number | null;
  new: number | null;
}

export type LineAction = "stage" | "unstage" | "discard";

export interface FileDiff {
  path: string;
  oldPath: string | null;
  binary: boolean;
  truncated: boolean;
  lines: DiffLine[];
}

/** Where the two sides of a file diff come from; mirrors `FileSource` in Rust. */
export type FileSource =
  | { kind: "workdir"; path: string; staged: boolean }
  | { kind: "commit"; oid: string; path: string; oldPath: string | null }
  | { kind: "compare"; base: string; head: string; path: string; oldPath: string | null }
  | { kind: "stash"; oid: string; path: string };

export interface ImageSide {
  dataUrl: string | null;
  size: number;
  /** The stored content is a Git LFS pointer, not the image. */
  lfs: boolean;
  tooLarge: boolean;
}

export interface ImagePair {
  before: ImageSide | null;
  after: ImageSide | null;
}

export interface CommitFile {
  path: string;
  oldPath: string | null;
  kind: FileKind | string;
  binary: boolean;
}

export interface CommitDetails {
  commit: CommitSummary;
  message: string;
  files: CommitFile[];
}

export interface CompareRevision {
  rev: string;
  label: string;
}

export interface BisectRevision {
  id: string;
  shortId: string;
  summary: string;
}

export interface BisectState {
  active: boolean;
  original: string | null;
  current: BisectRevision | null;
  bad: BisectRevision | null;
  goodTerm: string;
  badTerm: string;
  goodCount: number;
  skippedCount: number;
  remainingCount: number | null;
  truncated: boolean;
  found: boolean;
  firstBad: BisectRevision | null;
  ambiguous: boolean;
  candidates: BisectRevision[];
  noCheckout: boolean;
  firstParent: boolean;
  fingerprint: string;
}

export type BisectVerdict = "good" | "bad" | "skip";
export type BisectAction =
  | { kind: "start"; bad: string; good: string[]; paths: string[]; firstParent: boolean }
  | { kind: "mark"; verdict: BisectVerdict; revision?: string }
  | { kind: "checkout"; revision: string }
  | { kind: "reset" };
export interface BisectUpdate {
  state: BisectState;
  report: string;
}
export interface BisectOutcome extends BisectUpdate {
  snapshot: WorkspaceSnapshot;
}

export interface RevisionComparison {
  base: CompareRevision;
  head: CompareRevision;
  files: CommitFile[] | null;
  path: string | null;
}

export interface BranchInfo {
  name: string;
  isHead: boolean;
  isRemote: boolean;
  upstream: string | null;
}

export interface TagInfo {
  name: string;
}

export interface BranchList {
  current: string | null;
  isDetached: boolean;
  local: BranchInfo[];
  remote: BranchInfo[];
  tags: TagInfo[];
}

export interface GitIdentity {
  name: string;
  email: string;
}

export type GitSigningMode = "default" | "sign" | "unsigned";
export type GitRepositoryKey = "user.name" | "user.email" | "gpg.format" | "user.signingkey" | "commit.gpgsign" | "tag.gpgsign" | "gpg.ssh.allowedsignersfile" | "gpg.ssh.revocationfile";
export interface GitRepositoryField {
  key: GitRepositoryKey;
  value: string | null;
  inherited: string | null;
  effective: string | null;
  origin: string | null;
  editable: boolean;
}
export interface GitRepositorySettings {
  fields: GitRepositoryField[];
  worktree: boolean;
  readOnly: boolean;
  fingerprint: string;
}
export interface GitRepositoryChange {key: GitRepositoryKey; value: string | null}
export type GitSignatureTarget = {kind: "commit" | "tag"; value: string};
export type GitSignatureStatus = "verified" | "untrusted" | "expiredSignature" | "expiredKey" | "revoked" | "invalid" | "failed" | "unsigned" | "lightweight" | "changed";
export interface GitSignatureVerification {
  oid: string;
  status: GitSignatureStatus;
  output: string;
  truncated: boolean;
}
export interface CommitOptions {
  signing: GitSigningMode;
  signoff: boolean;
}

export interface TerminalOption {
  id: string;
  name: string;
  available: boolean;
}

export type PanelLayout = Record<string, number>;

export type PanelLayoutId =
  | "historyShell"
  | "history"
  | "historyDetails"
  | "changes"
  | "stash"
  | "stashDetails"
  | "files"
  | "fileHistory";

export interface PanelLayouts {
  historyShell: PanelLayout;
  history: PanelLayout;
  historyDetails: PanelLayout;
  changes: PanelLayout;
  stash: PanelLayout;
  stashDetails: PanelLayout;
  files: PanelLayout;
  fileHistory: PanelLayout;
}

export interface DirEntry {
  name: string;
  path: string;
  dir: boolean;
  ignored: boolean;
}

export interface FileSearchHit {
  path: string;
  dir: boolean;
}

export interface FileSearch {
  hits: FileSearchHit[];
  truncated: boolean;
}

export interface FileText {
  binary: boolean;
  text: string;
}

export interface BlameHunk {
  start: number;
  count: number;
  commitId: string;
  author: string;
  time: number;
}

export interface SubmoduleInfo {
  name: string;
  path: string;
  url: string | null;
  branch: string | null;
  state: "clean" | "uninitialized" | "modified" | "conflicted" | string;
  commit: string | null;
}

export interface SubmoduleSettings { module: SubmoduleInfo; fingerprint: string }
export interface SubmoduleCatalog { modules: SubmoduleInfo[]; fingerprint: string }
export interface SubmoduleAdd { url: string; path: string; name: string | null; branch: string | null; depth: number | null; force: boolean }
export type SubmoduleRemovalKind = "deinit" | "remove";
export interface SubmoduleRemovalPreview { module: SubmoduleInfo; files: number; bytes: number; dirty: boolean; fingerprint: string }
export interface SubmoduleUpdateOptions { remote: boolean; recursive: boolean; fetch: boolean; strategy: "checkout" | "merge" | "rebase" }
export type SubmoduleChange =
  | { kind: "add"; request: SubmoduleAdd; fingerprint: string }
  | { kind: "edit"; path: string; url: string; branch: string | null; fingerprint: string }
  | { kind: "sync"; paths: string[]; recursive: boolean }
  | { kind: "remove"; path: string; mode: SubmoduleRemovalKind; force: boolean; fingerprint: string };

export interface WorktreeInfo {
  bare: boolean;
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  lockReason: string | null;
  pruneReason: string | null;
  missing: boolean;
  fingerprint: string;
  prunable: boolean;
  current: boolean;
  main: boolean;
}

export interface ReflogEntry {
  /** `HEAD@{n}` */
  selector: string;
  id: string;
  shortId: string;
  /** What moved HEAD, e.g. `commit: Fix the build`. */
  message: string;
  timestamp: number;
  /** The subject of the commit HEAD moved to. */
  summary: string;
}

export interface UndoneCommit {
  snapshot: WorkspaceSnapshot;
  message: string;
}

export interface ToolConfig {
  diffTool: string;
  mergeTool: string;
}

export interface AppPrefs {
  language: "system" | "en" | "zh-CN";
  analyticsEnabled: boolean;
  httpProxy: { mode: "none" | "system" | "manual"; url: string };
  avatarProvider: "builtin" | "github" | "gitlab";
  terminalId: string;
  /** "system", or an id from `list_editors`. */
  editorId: string;
  sidebarOrder: string[];
  panelLayouts: PanelLayouts;
  pullRebase: boolean;
  /** Group changed files by folder instead of listing them flat. */
  changesTree: boolean;
  /** Show diffs side by side. */
  diffSplit: boolean;
  /** Hide whitespace-only changes in diffs; line staging is off while set. */
  diffIgnoreWhitespace: boolean;
  /** Minutes between background fetches of the open repository; 0 turns them off. */
  autoFetchMinutes: number;
  /** Remove remote-tracking branches that are gone from the remote when fetching. */
  fetchPrune: boolean;
  /** Empty uses the git executable on PATH. Otherwise an absolute path. */
  gitPath: string;
  /** User-added git executables. The PATH entry is not included. */
  extraGitPaths: string[];
  /** Empty uses the p4 executable on PATH. Otherwise an absolute path. */
  p4Path: string;
  p4MergeTool: string;
  p4DiffTool: string;
  /** User-added p4 executables. The PATH entry is not included. */
  extraP4Paths: string[];
  /** Default P4PORT for a new workspace. */
  p4Port: string;
  /** Default P4USER for a new workspace. */
  p4User: string;
  /** Empty leaves charset unset. */
  p4Charset: string;
  /** Minutes between background refreshes of an open Perforce workspace; 0 turns them off. */
  p4RefreshMinutes: number;
}

export interface GitExecutables {
  /** Full path of `git` on PATH, or null when PATH has none. */
  pathGit: string | null;
  /** Full path RebaseRaven will run, or null when none is usable. */
  active: string | null;
}

export interface PushOptions {
  remote?: string;
  force?: boolean;
  setUpstream?: boolean;
  expectedBranch?: string;
}

export interface RemoteInfo {
  name: string;
  url: string | null;
  pushUrl: string | null;
}

export interface RemotePushSettings {
  urls: string[];
  fallbackUrls: string[];
  inherited: boolean;
  fingerprint: string;
}

export interface RemoteProbe {
  heads: number;
}

export interface StashInfo {
  index: number;
  message: string;
  id: string;
}

export interface StashDetails {
  id: string;
  message: string;
  files: CommitFile[];
}

export interface WorkspaceSnapshot {
  repo: RepoInfo;
  status: StatusSnapshot;
  branches: BranchList;
  remotes: RemoteInfo[];
  stashes: StashInfo[];
  headCommit: CommitSummary | null;
}

export interface Activity {
  id: string;
  /** Tab that started the work. Each tab's meter shows only its own activities. */
  tabId: string;
  label: string;
  detail?: string;
  progress?: number;
  /** The activity id was handed to a git process that `cancel_activity` can stop. */
  cancellable?: boolean;
}

export interface RecentRepo {
  path: string;
  name: string;
  lastOpened: number;
  /** Missing on lists saved before Perforce support; those are Git repositories. */
  vcs?: "git" | "perforce" | string;
}

export interface OpenRepo {
  path: string;
  vcs?: "git" | "perforce" | string;
}

export interface AppSession {
  openPaths: string[];
  openRepos?: OpenRepo[];
  active: string;
  historyRevs?: Record<string, string[]>;
  historyExpanded?: Record<string, string[]>;
}

export interface SshKeyInfo {
  name: string;
  /** `ed25519`, `rsa`, `ecdsa`, `dsa`, or empty when the public key is missing. */
  algorithm: string;
  bits: number | null;
  /** `SHA256:…`, or empty when the public key is missing. */
  fingerprint: string;
  comment: string;
  /** One-line OpenSSH public key. Empty when there is no `.pub` file. */
  publicKey: string;
  encrypted: boolean;
  /** OpenSSH tries this file name without an entry in `~/.ssh/config`. */
  defaultIdentity: boolean;
}

export interface SshKeyList {
  directory: string;
  directoryExists: boolean;
  /** `ssh-keygen` can be run, so new keys can be created. */
  keygenAvailable: boolean;
  keys: SshKeyInfo[];
}

export interface SshKeyPreview {
  fileName: string;
  encrypted: boolean;
  inSshFolder: boolean;
  hasPublic: boolean;
}

export type Selection =
  | { type: "change"; path: string; staged: boolean }
  | { type: "commit"; id: string; path?: string };

export interface WorktreeRequest {
  kind: "lock" | "unlock" | "move" | "repair" | "repairAll";
  path: string;
  destination: string;
  reason: string;
}
export interface WorktreePreview { tree: WorktreeInfo | null; destination: string; fingerprint: string }
export interface WorktreeChange { previousPath: string | null; path: string | null; snapshot: WorkspaceSnapshot }
