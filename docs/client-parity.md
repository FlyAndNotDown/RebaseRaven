# Desktop client parity audit

This audit tracks local version-control workflows against P4V and mainstream
Git clients. Hosted review, pull requests, issue-provider integrations and server
administration are outside the iteration. Server-backed P4 file operations and
version-control objects remain in scope.

Sources: [P4V navigation](https://help.perforce.com/helix-core/server-apps/p4v/current/Content/P4V/using.navigating.html),
[P4V labels](https://help.perforce.com/helix-core/server-apps/p4v/2026.1/Content/P4V/branches.labels.html),
[P4V branch mappings](https://help.perforce.com/helix-core/server-apps/p4v/current/Content/P4V/branches.mapping.html),
[Fork feature overview](https://git-fork.com/), and the corresponding Git/P4
command references, including [Git bisect](https://git-scm.com/docs/git-bisect)
and [TortoiseGit bisect](https://tortoisegit.org/docs/tortoisegit/tgit-dug-bisect.html).
A source implementation is inventory evidence, not runtime
verification of every option or platform.

## Git

| Workflow | Current implementation | Remaining audit or work |
| --- | --- | --- |
| Initialize, clone, recent repositories | `git/initialize.rs`, `git/remote.rs` | Verify edge cases and UI |
| Fetch, pull, push and upstreams | `git/remote.rs`, `git/refs.rs` | Remote rename and explicit push URL lists are implemented and repository-tested; audit remaining fetch/push options and cross-platform UI |
| Stage, unstage, discard, ignore | `git/changes.rs`, `git/partial.rs` | Audit selective stash, clean preview and ignored files |
| Commit and amend | `git/changes.rs` | Audit signing and message reuse |
| Branches and tags | `git/refs.rs` | Audit annotated/signed tags and multiple selection |
| Merge, revert, reset, cherry-pick | `git/operations.rs` | Audit range/sequenced actions, merge options and operation recovery |
| Rebase and interactive rebase | `git/operations.rs` | Audit editing, reordering, squashing and recovery end to end |
| Conflict resolution | `git/conflicts.rs`, shared text editor | Audit binary, deletion and rename conflicts |
| Stashes | `git/stash.rs` | Audit selected paths and branch creation from stash |
| History, graph, file history and blame | `git/history.rs`, `git/files.rs` | Arbitrary revision tree browsing and branch/range comparison need inspection |
| Reflog and lost-commit recovery | `git/reflog.rs` | Verify recovery without overwriting local work |
| Worktrees | `git/structure.rs` | Audit lock/unlock, move and repair |
| Submodules | `git/submodules.rs`, shared sidebar and dialogs: add, edit, sync, update, deinitialize and remove | Repository and component checks pass; native/provider transitions, long-running cancellation and large checkouts remain to audit |
| Patch import/export | `git/operations.rs` | Audit format-patch/am recovery and selected changes |
| Bisect | `git/bisect.rs`, shared operation banner and bisect dialog: start, classify, skip, retest, inspect and reset | Repository and component checks pass; native/provider transitions, automation, log import/export and large-session behavior remain to audit |
| Git LFS | No dedicated command surface found | Inspect installed-tool integration, tracking and locks |
| Git-flow | No dedicated command surface found | Inspect branch workflow coverage and explicit operations |
| Sparse checkout | No command surface found | Audit mainstream-client coverage and working-tree controls |

## Perforce

| Workflow | Current implementation | Remaining audit or work |
| --- | --- | --- |
| Connect, authenticate, create/select workspace | `p4/workspace.rs` | Audit connection switching and workspace lifecycle |
| Workspace root, mappings and options | `p4/client.rs` | Audit advanced fields and safe mapping changes |
| Depot/workspace browser and search | `p4/workspace.rs` | Audit deleted files, filters and status freshness |
| Add, edit, delete, move, reopen, lock | `p4/workspace.rs`; `p4/properties.rs` adds file inspection and pending type changes | Live file-type checks pass; native dialog/provider transitions and larger batches remain to audit |
| Pending/submitted changelists and submit | `p4/workspace.rs` | Audit submit options and changelist editing |
| Sync and get revision | `p4/workspace.rs` | Audit preview, safe/forced updates and label removal behavior |
| Offline reconcile and revert unchanged | `p4/review.rs`, `p4/workspace.rs` | Clean/restore workspace preview needs inspection |
| Shelves and restore | `p4/shelves.rs` | Audit selective shelf replacement/deletion and cross-stream behavior |
| Resolve and internal/external merge | `p4/workspace.rs` | Audit non-content resolve types and interactive choices |
| Integrate and undo | `p4/operations.rs`; `p4/integration.rs` adds folder and named mapping integration | Live P4 checks pass; native QA of the new integration dialog is pending while the host is locked |
| Stream merge/copy and switch | `p4/streams.rs`, `p4/switch.rs` | Audit stream create/edit/delete and stream-spec changes |
| Stream relationships | `p4-streams.tsx` | Audit flow rules and visualization consistency |
| File history, comparisons, blame, images | `p4/history.rs`, `p4/images.rs` | Audit integration lineage graph and folder comparison |
| Labels | `p4/specs.rs`, `p4-specs.tsx`: browse, filters, CRUD, automatic/static revisions, previewed tag updates, files, sync entry | Live P4 and native macOS verified; global/edge label options and larger datasets remain to audit |
| Classic branch mappings | `p4/specs.rs`, shared specification browser/editor | CRUD verified against live P4 and native macOS; named mapping integration is implemented and live P4 verified, with new-dialog native QA pending |
| Jobs and changelist fixes | No command surface found | Native P4 job/fix operations remain to be audited |

## Verification contract

Each feature needs command validation, stale async-result protection, localized
copy, existing mutation ownership, bounded browsing, meaningful tests and real
repository checks. Native visual QA uses isolated application data, shells,
executables, working directories and build products in the designated temporary
area. Do not infer full parity from a passing test suite or this inventory.

## Verification log

### Label and branch specification management

- Source, website, version, type, lint and 422 frontend tests pass.
- Rust formatting, Clippy and 292 tests pass; one unrelated integration test is
  ignored by the existing suite. This is local macOS evidence, not Windows/Linux
  native verification.
- Live P4 checks cover empty and wildcard searches, owner filters, static label
  creation, duplicate/missing objects, concurrent form edits, read-only previews,
  rejected stale approvals, tagging workspace/latest/explicit revisions, removing
  tags, locked and automatic labels, branch mapping CRUD and stale deletion.
- Native macOS checks cover the same entry points, editing an automatic label,
  preview invalidation, applying and displaying a new revision, preselected label
  sync, and creating/deleting a disposable label. Existing workspace files,
  opened changes and have-list were preserved.
- Two issues found through live/native QA are covered by regression tests:
  empty searches must not generate adjacent `**` wildcards, and `#1` must be
  quoted in a Perforce form to avoid becoming a comment.
- Label previews stop at 512 KiB of output or 30 seconds. Browsing returns an
  explicit truncation state after 200 specifications or 500 label files.

### Folder and named mapping integration

- Source/target patterns, named branch mappings, reverse mappings, source file
  revision/changelist ranges, reintegration and pending-changelist selection are
  implemented. Entry points include folder context menus, the command palette
  and the branch mapping inspector.
- Preview and apply bind the source revisions, branch/client forms, target file
  state and selected changelist. Offline edits, missing tracked files and local
  collisions block the operation; opened edits in the selected changelist enter
  the existing resolve workflow. A successful process exit is followed by an
  explicit check that all planned targets were opened in that changelist.
- Ten live P4 check groups cover both mapping methods, branch/edit/delete,
  read-only previews, stale approvals, argument validation, local collisions,
  changelist ownership, concurrent map/source/local changes, range selection,
  reverse/reintegration previews, application, resolve and restoring the baseline.
- Frontend checks and 422 tests pass. Rust formatting, Clippy and 294 tests pass,
  with the existing unrelated test ignored.
- The integration file preview is shared with stream merge/copy, virtualized,
  and uses localized action labels. Native visual checks of these new screens
  remain pending because the host locked during the iteration. A clean build
  alone is not evidence that these visual checks passed.

### Git remote rename and diagnostics locking

- Git remote rename preserves fetch/push URLs, tracking branches, symbolic remote
  HEAD, local upstream configuration, the active branch, index and working files.
  History filters, expanded remote folders and affected comparison references
  follow the new name, retaining ownership when tabs change during the operation.
- Remote and local branch rename share the same dialog and save handling. New
  native dialog checks remain pending while the host is locked.
- A diagnostics test exposed a transient lock lifetime problem during concurrent
  process creation. A deterministic inherited-descriptor regression test failed
  before the fix. Stores now explicitly unlock when dropped, so another handle
  can open the logs while a forked child's inherited descriptor is still alive.
- Frontend checks and 424 tests pass. Rust formatting, Clippy and 297 tests pass,
  with the existing unrelated test ignored. Remote rename tests use real Git
  repositories and verify preservation and failure behavior, not a mocked CLI.

### Explicit Git push destinations and component QA

- Remotes support a complete list of explicit push URLs. Clearing the list restores
  Git's fetch-URL fallback. Remote summaries retain the first fetch/push address,
  matching Git's primary destination instead of accidentally retaining the last.
- Edits use Git's repository configuration lock, a separate temporary config and
  atomic replacement. They preserve unrelated settings, reject stale snapshots
  and existing locks, and work through linked worktrees. Included/global push URL
  definitions are visible as inherited and read-only rather than being partially
  overwritten or silently combined with new addresses.
- Six real-Git test groups cover list round trips, multiple fetch fallbacks,
  inherited sources, malformed/empty values, locks, concurrent changes, linked
  worktrees and actual pushes to multiple local bare repositories. Clearing the
  list was verified by pushing a different ref exclusively to the fetch endpoint.
- The production React dialogs were tested in an isolated browser harness using
  real Rust commands. UI-driven P4 range integration, remote rename, multiple push
  URLs, stale-edit rejection/reload, inherited read-only display and clearing
  overrides all pass. Dialogs were checked at the application's 1280x840 default
  and 960x640 minimum sizes. Native application context menus, provider state
  transitions and stream preview regression checks are still pending unlock.
- Component QA found and corrected a remote rename field/action that still used
  branch labels and an integration apply button that used a dialog-opening label.
  Long push addresses now remain readable in a wider, wrapping editor.
- Current checks: 424 frontend tests and 303 Rust tests pass; formatting, Clippy,
  source, website, version and type checks pass. The existing unrelated test
  remains ignored. These checks do not establish complete client parity.

### Interactive Git bisect

- The history toolbar and command palette open an interactive session. Starting
  accepts a bad revision, multiple good revisions, optional path filters and
  first-parent traversal. Active sessions have their own operation banner and
  cannot accidentally enter the generic continue/commit workflow.
- Users can classify or skip the checked-out candidate, classify another known
  revision, inspect a result, test an ambiguous candidate, and end the session to
  restore its original branch or detached HEAD. External custom terms and
  no-checkout sessions are recognized rather than silently reinterpreted.
- Actions bind the session files, native refs and current HEAD. Tracked local
  edits, staged changes, stale decisions and nested operations are rejected.
  Git protects untracked checkout collisions. A per-worktree advisory lock
  serializes application bisect actions; failures refresh actual repository
  state instead of assuming an operation was atomic.
- Candidate analysis explicitly preserves the session's Git-quoted paths and
  first-parent mode. A sole untested candidate is not presented as a proven
  result. Retesting a skipped revision clears its skip ref and replay-log entry;
  the resulting native log was replayed successfully in a real repository test.
- Eleven focused tests cover linear diagnosis, ambiguous skips and retesting,
  invalid/stale/dirty requests, untracked collisions, action locking, linked
  worktrees, detached restoration, custom terms, no-checkout sessions, path
  quoting, first-parent merges and generic operation guards. A separate real
  reftable repository also completes the full diagnosis and reset flow.
- Production dialog and banner checks against real Rust/Git commands cover
  start, classification, reopening, unique and ambiguous results, candidate
  checkout, focus/scroll recovery, retesting, external command changes and dirty
  mark/reset rejection. The minimum 960x640 window remains usable, and fixture
  branches and worktrees were restored after testing.
- Checks: 424 frontend tests and 314 Rust tests pass, with the existing unrelated
  test ignored. Source, website, version, type, lint, formatting and Clippy pass.
  Native application entry points and provider transitions remain unverified
  while the host is locked. Candidate inspection is bounded to 500 revisions;
  larger ambiguous sessions and automation/log management remain in the audit.


### Git submodule management

- The sidebar and command palette can add submodules with an optional tracking
  branch, configuration name and shallow depth. Adding requires a named branch
  or the remote default; inherited `.` tracking can be set after adding.
  Existing entries support URL and
  branch edits, URL synchronization, recorded or remote updates, checkout/merge/
  rebase strategies, recursive updates, deinitialization and removal.
- Configuration edits remain unstaged for review. Add and remove use native Git
  staging, and reject unstaged metadata edits to avoid staging unrelated work.
  Paths are literal, remain inside the repository and cannot traverse symlinks.
  Definitions cannot change during another parent operation.
- Configuration actions reject stale repository state. Removal previews bind
  the module configuration and checkout metadata, show local file counts and
  size, require explicit force for local changes, and retain selected Git
  history outside the checkout, including old embedded Git directories.
  Application actions share a per-worktree advisory lock. Failed operations
  refresh actual state; multi-step native commands are not assumed atomic.
- Windows dispatch prefers a detected public native submodule builtin and
  otherwise uses the native helper behind Git's legacy shell wrapper. Tests
  exercise that helper with literal sibling paths and quoted URLs, and verify
  that user-only file transports remain blocked. Compatibility with older Git
  releases remains in the audit.
- Seven new repository tests cover custom names, URL/branch edits, stale and
  dirty guards, recorded/remote update strategies, literal paths, recursive
  modules, relative URLs, shallow clones, stored Git directories and retained
  unpublished history. The three existing submodule tests still pass.
- Production component checks against real Rust/Git commands cover adding,
  stale settings rejection, URL/branch edits, synchronization, remote updates,
  recorded checkout restoration, stale removal rejection, forced deinitialization,
  reinitialization and staged removal. The 960x640 minimum window remains usable.
  Native application entry points and provider transitions remain unverified
  while the host is locked; long-running background cancellation and very large
  checkout previews remain in the audit.
- Source, website, version, type, lint and frontend build checks pass, with
  424 frontend tests passing. Rust formatting, Clippy and tests pass: 321 passed
  and one existing unrelated test ignored. These checks do not establish
  complete client parity.


### Perforce file properties and types

- Workspace/depot files and opened pending files expose a shared properties
  dialog. It shows depot/local paths, pending and head types, have/head revisions,
  changelists, depot size/digest/timestamps, and other-client opens and locks.
- Single or selected pending files can change type. Full types replace omitted
  flags, while partial modifiers extend the current type. Opened files retain
  their changelists; unopened mapped files are checked out in a chosen own pending
  changelist. Changes remain pending and never submit automatically.
- Inspection is bounded to 200 exact files. Connection, client form, server
  metadata and local file metadata bind an apply to its inspected state. Unmapped,
  missing, unsynced, unresolved, deleted or differently owned files cannot be
  retyped. Native acknowledgements and refreshed properties confirm the result,
  including default storage modifiers omitted by fstat. Partial failures refresh
  actual pending state without attempting an unsafe rollback.
- Seven Rust tests cover validation, stale state, blocked files, changelist
  preservation, native acknowledgement and storage normalization. Eight live P4
  scenarios cover reserved file names, mixed batches, full/partial modifiers,
  local/server changes, other-client opens/locks, unchanged bytes and no submit.
- Source, website, version, type, lint and frontend build checks pass, with 424
  frontend tests passing. Rust formatting, Clippy and tests pass: 328 passed and
  one existing unrelated test ignored. Browser control timed out, so visual UI
  checks and native/provider transitions remain unverified for this dialog.
