# Desktop client parity audit

This audit tracks local version-control workflows against P4V and mainstream
Git clients. Hosted review, pull requests, issue-provider integrations and server
administration are outside the iteration. Server-backed P4 file operations and
version-control objects remain in scope.

Sources: [P4V navigation](https://help.perforce.com/helix-core/server-apps/p4v/current/Content/P4V/using.navigating.html),
[P4V labels](https://help.perforce.com/helix-core/server-apps/p4v/2026.1/Content/P4V/branches.labels.html),
[P4V branch mappings](https://help.perforce.com/helix-core/server-apps/p4v/current/Content/P4V/branches.mapping.html),
[Fork feature overview](https://git-fork.com/), and the corresponding Git/P4
command references. A source implementation is inventory evidence, not runtime
verification of every option or platform.

## Git

| Workflow | Current implementation | Remaining audit or work |
| --- | --- | --- |
| Initialize, clone, recent repositories | `git/initialize.rs`, `git/remote.rs` | Verify edge cases and UI |
| Fetch, pull, push and upstreams | `git/remote.rs`, `git/refs.rs` | Remote rename is implemented and repository-tested; audit prune, separate push URL editing and push options |
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
| Submodules | `git/structure.rs` | Add, remove, URL changes, sync and branch updates are missing |
| Patch import/export | `git/operations.rs` | Audit format-patch/am recovery and selected changes |
| Bisect | No command surface found | Implement interactive diagnosis and reset |
| Git LFS | No dedicated command surface found | Inspect installed-tool integration, tracking and locks |
| Git-flow | No dedicated command surface found | Inspect branch workflow coverage and explicit operations |
| Sparse checkout | No command surface found | Audit mainstream-client coverage and working-tree controls |

## Perforce

| Workflow | Current implementation | Remaining audit or work |
| --- | --- | --- |
| Connect, authenticate, create/select workspace | `p4/workspace.rs` | Audit connection switching and workspace lifecycle |
| Workspace root, mappings and options | `p4/client.rs` | Audit advanced fields and safe mapping changes |
| Depot/workspace browser and search | `p4/workspace.rs` | Audit deleted files, filters, file properties and status freshness |
| Add, edit, delete, move, reopen, lock | `p4/workspace.rs` | File-type changes and richer properties are missing |
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
