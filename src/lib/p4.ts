import { p4ComparisonDiff, type P4Comparison } from "@/lib/p4-comparison";
import { invoke } from "@tauri-apps/api/core";
import { t } from "@/i18n";
import type {
  P4FilePropertiesView,
  P4FileTypeRequest,
  P4UnshelveRequest,
  P4StreamRequest,
  P4StreamPreview,
  P4ReconcilePreview,
  P4ManualResolve,
  P4Auth,
  P4WorkspaceEdit,
  P4SwitchRequest,
  P4SwitchPreview,
  P4SwitchOutcome,
  P4WorkspaceSettings,
  P4ChangePage,
  P4Changelist,
  P4CheckedConnection,
  P4Connection,
  P4CreateRequest,
  P4DepotEntry,
  P4StreamOption,
  P4Describe,
  P4DirEntry,
  P4EntryStatus,
  P4FileSearch,
  P4GetRevision,
  P4IntegrateRequest,
  P4UndoRequest,
  P4OperationPreview,
  P4Location,
  P4Executables,
  P4OpenResult,
  P4ResolveView,
  P4CompareRequest,
  P4BlameLine,
  P4ImageSource,
  P4RevisionPage,
  P4HistoryCursor,
  RepoDetection,
} from "@/types/p4";
import type { FileDiff, ImagePair } from "@/types/git";
import { errorMessage } from "@/lib/git";
import { pathsIgnoreCase } from "@/lib/format";
import type { P4IntegrationRequest, P4IntegrationPreview } from "@/types/p4-integration";
import type { P4SpecKind, P4SpecEdit, P4Spec, P4SpecPage, P4LabelFiles, P4LabelTagRequest, P4LabelTagPreview } from "@/types/p4-specs";

/** Matches `P4_MISSING` in the Rust backend. */
export const P4_MISSING = "p4 executable was not found. Choose one in Settings.";

/** Matches `P4_LOGIN` in the Rust backend. */
export const P4_LOGIN = "Perforce login is required.";

let missingP4 = false;
const availabilityListeners = new Set<() => void>();

function reportP4Availability(available: boolean) {
  if (missingP4 === !available) return;
  missingP4 = !available;
  for (const listener of availabilityListeners) listener();
}

export function isP4Missing() {
  return missingP4;
}

export function subscribeP4Availability(listener: () => void) {
  availabilityListeners.add(listener);
  return () => { availabilityListeners.delete(listener); };
}

function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args).then((result) => {
    if (command === "p4_open") reportP4Availability(true);
    return result;
  }).catch((error: unknown) => {
    if (errorMessage(error) === P4_MISSING) reportP4Availability(false);
    throw error;
  });
}

export const p4Api = {
  previewIntegration: (connection: P4Connection, request: P4IntegrationRequest) => call<P4IntegrationPreview>("p4_preview_integration", {connection, request}),
  applyIntegration: (connection: P4Connection, request: P4IntegrationRequest, fingerprint: string) => call<string>("p4_apply_integration", {connection, request, fingerprint}),
  listSpecs: (connection: P4Connection, kind: P4SpecKind, query: string, owner: string) => call<P4SpecPage>("p4_list_specs", {connection, kind, query, owner}),
  readSpec: (connection: P4Connection, kind: P4SpecKind, name: string) => call<P4Spec>("p4_read_spec", {connection, kind, name}),
  saveSpec: (connection: P4Connection, edit: P4SpecEdit, fingerprint: string | null) => call<P4Spec>("p4_save_spec", {connection, edit, fingerprint}),
  deleteSpec: (connection: P4Connection, kind: P4SpecKind, name: string, fingerprint: string) => call<void>("p4_delete_spec", {connection, kind, name, fingerprint}),
  labelFiles: (connection: P4Connection, name: string) => call<P4LabelFiles>("p4_label_files", {connection, name}),
  previewLabelTag: (connection: P4Connection, request: P4LabelTagRequest) => call<P4LabelTagPreview>("p4_preview_label_tag", {connection, request}),
  applyLabelTag: (connection: P4Connection, request: P4LabelTagRequest, fingerprint: string) => call<string>("p4_apply_label_tag", {connection, request, fingerprint}),
  detectRepository: (path: string) => call<RepoDetection>("detect_repository", { path }),
  open: (path: string) => call<P4OpenResult>("p4_open", { path }),
  refreshPending: (connection: P4Connection) =>
    call<P4Changelist[]>("p4_refresh_pending", { connection }),
  submitted: (
    connection: P4Connection,
    user: string,
    client: string,
    limit = 50,
    before?: number | null,
  ) => call<P4ChangePage>("p4_submitted", { connection, user, client, limit, before: before ?? null }),
  searchSubmitted: (
    connection: P4Connection,
    user: string,
    client: string,
    query: string,
    before: number | null,
    matchLimit: number,
    scanLimit: number,
  ) =>
    call<P4ChangePage>("p4_search_submitted", {
      connection,
      user,
      client,
      query,
      before,
      matchLimit,
      scanLimit,
    }),
  listUsers: (connection: P4Connection) => call<string[]>("p4_list_users", { connection }),
  listClients: (connection: P4Connection, user: string) =>
    call<string[]>("p4_list_clients", { connection, user }),
  describe: (connection: P4Connection, changeId: string) =>
    call<P4Describe>("p4_describe", { connection, changeId }),
  openedDiff: (connection: P4Connection, path: string) =>
    call<FileDiff>("p4_opened_diff", { connection, path }),
  shelfDiff: (connection: P4Connection, depotPath: string, changeId: string) =>
    call<FileDiff>("p4_shelf_diff", { connection, depotPath, changeId }),
  imagePair: (connection: P4Connection, source: P4ImageSource) => call<ImagePair>("p4_image_pair", {connection, source}),
  annotate: (connection: P4Connection, depotPath: string, revision: string) => call<P4BlameLine[]>("p4_annotate", { connection, depotPath, revision }),
  compareFiles: (connection: P4Connection, request: P4CompareRequest) => call<P4Comparison>("p4_compare_files", { connection, request }).then(p4ComparisonDiff),
  revisionDiff: (connection: P4Connection, depotPath: string, rev: string) =>
    call<FileDiff>("p4_revision_diff", { connection, depotPath, rev }),
  filelog: (connection: P4Connection, path: string, cursor: P4HistoryCursor | null = null) =>
    call<P4RevisionPage>("p4_filelog", { connection, path, cursor }),
  locate: (connection: P4Connection, path: string) =>
    call<P4Location>("p4_locate", { connection, path }),
  listDir: (connection: P4Connection, relative: string) =>
    call<P4DirEntry[]>("p4_list_dir", { connection, relative }),
  listDepot: (connection: P4Connection, path: string) =>
    call<P4DirEntry[]>("p4_list_depot", { connection, path }),
  listingStatus: (connection: P4Connection, directory: string, depot: boolean) =>
    call<P4EntryStatus[]>("p4_listing_status", { connection, directory, depot }),
  searchDepot: (connection: P4Connection, query: string) =>
    call<P4FileSearch>("p4_search_depot", { connection, query }),
  cancelDepotSearch: (connection: P4Connection) => call<void>("p4_cancel_depot_search", { connection }),
  searchFiles: (connection: P4Connection, query: string) =>
    call<P4FileSearch>("p4_search_files", { connection, query }),
  previewSwitch: (connection: P4Connection, request: P4SwitchRequest) => call<P4SwitchPreview>("p4_preview_switch", {connection, request}),
  applySwitch: (connection: P4Connection, request: P4SwitchRequest, fingerprint: string) => call<P4SwitchOutcome>("p4_apply_switch", {connection, request, fingerprint}),
  workspaceSettings: (connection: P4Connection) => call<P4WorkspaceSettings>("p4_workspace_settings", {connection}),
  saveWorkspace: (connection: P4Connection, edit: P4WorkspaceEdit, fingerprint: string) =>
    call<P4Connection>("p4_save_workspace", { connection, edit, fingerprint }),
  submit: (connection: P4Connection, changeId: string, description: string) =>
    call<void>("p4_submit", { connection, changeId, description }),
  saveChange: (connection: P4Connection, changeId: string, description: string) =>
    call<string>("p4_save_change", { connection, changeId, description }),
  newChange: (connection: P4Connection, description: string) =>
    call<string>("p4_new_change", { connection, description }),
  deleteChange: (connection: P4Connection, changeId: string) =>
    call<void>("p4_delete_change", { connection, changeId }),
  moveFile: (connection: P4Connection, source: string, destination: string) =>
    call<void>("p4_move_file", { connection, source, destination }),
  fileProperties: (connection: P4Connection, paths: string[]) => call<P4FilePropertiesView>("p4_file_properties", { connection, paths }),
  changeFileTypes: (connection: P4Connection, request: P4FileTypeRequest, fingerprint: string) => call<void>("p4_change_file_types", { connection, request, fingerprint }),
  reopen: (connection: P4Connection, changeId: string, files: string[]) =>
    call<void>("p4_reopen", { connection, changeId, files }),
  revert: (connection: P4Connection, files: string[], wipe?: string[]) =>
    call<void>("p4_revert", { connection, files, wipe: wipe ?? null }),
  revertUnchanged: (connection: P4Connection) => call<void>("p4_revert_unchanged", { connection }),
  shelve: (connection: P4Connection, changeId: string, files?: string[]) =>
    call<void>("p4_shelve", { connection, changeId, files: files ?? null }),
  unshelve: (connection: P4Connection, changeId: string, target?: string, files?: string[]) =>
    call<void>("p4_unshelve", { connection, changeId, target: target ?? null, files: files ?? null }),
  deleteShelf: (connection: P4Connection, changeId: string) =>
    call<void>("p4_delete_shelf", { connection, changeId }),
  manualResolveView: (connection: P4Connection, path: string) =>
    call<P4ManualResolve>("p4_manual_resolve_view", { connection, path }),
  manualResolveExternal: (connection: P4Connection, path: string, text: string, fingerprint: string, tool: string) => call<string>("p4_manual_resolve_external", { connection, path, text, fingerprint, tool }),
  manualResolveApply: (connection: P4Connection, path: string, text: string, fingerprint: string) =>
    call<void>("p4_manual_resolve_apply", { connection, path, text, fingerprint }),
  resolveView: (connection: P4Connection, path: string) =>
    call<P4ResolveView>("p4_resolve_view", { connection, path }),
  resolveAccept: (connection: P4Connection, path: string, mode: "yours" | "theirs" | "merge") =>
    call<void>("p4_resolve_accept", { connection, path, mode }),
  sync: (connection: P4Connection, paths: string[], activityId?: string) =>
    call<string>("p4_sync", { connection, paths, activityId: activityId ?? null }),
  getRevision: (connection: P4Connection, request: P4GetRevision, activityId?: string) =>
    call<string>("p4_get_revision", { connection, request, activityId: activityId ?? null }),
  listShelves: (connection: P4Connection, user: string, before: number | null) => call<P4ChangePage>("p4_list_shelves", { connection, user, before }),
  shelfDetail: (connection: P4Connection, changeId: string) => call<P4Changelist>("p4_shelf_detail", { connection, changeId }),
  previewUnshelve: (connection: P4Connection, request: P4UnshelveRequest) => call<P4OperationPreview>("p4_preview_unshelve", { connection, request }),
  restoreShelf: (connection: P4Connection, request: P4UnshelveRequest, fingerprint: string) => call<string>("p4_restore_shelf", { connection, request, fingerprint }),
  previewStream: (connection: P4Connection, request: P4StreamRequest) => call<P4StreamPreview>("p4_preview_stream", { connection, request }),
  applyStream: (connection: P4Connection, request: P4StreamRequest, fingerprint: string) => call<string>("p4_apply_stream", { connection, request, fingerprint }),
  previewIntegrate: (connection: P4Connection, request: P4IntegrateRequest) =>
    call<P4OperationPreview>("p4_preview_integrate", { connection, request }),
  applyIntegrate: (connection: P4Connection, request: P4IntegrateRequest, fingerprint: string) =>
    call<string>("p4_apply_integrate", { connection, request, fingerprint }),
  previewUndo: (connection: P4Connection, request: P4UndoRequest) =>
    call<P4OperationPreview>("p4_preview_undo", { connection, request }),
  applyUndo: (connection: P4Connection, request: P4UndoRequest, fingerprint: string) =>
    call<string>("p4_apply_undo", { connection, request, fingerprint }),
  previewReconcile: (connection: P4Connection) => call<P4ReconcilePreview>("p4_preview_reconcile", { connection }),
  applyReconcile: (connection: P4Connection, paths: string[], changeId: string, fingerprint: string) =>
    call<string>("p4_apply_reconcile", { connection, paths, changeId, fingerprint }),
  fileAction: (connection: P4Connection, action: "edit" | "add" | "delete" | "lock" | "unlock", paths: string[], changeId?: string) =>
    call<void>("p4_file_action", { connection, action, paths, changeId: changeId ?? null }),
  login: (connection: P4Connection, password: string) =>
    call<void>("p4_login", { connection, password }),
  checkConnection: (auth: P4Auth) => call<P4CheckedConnection>("p4_check_connection", { auth }),
  listStreams: (auth: P4Auth) => call<P4StreamOption[]>("p4_list_streams", { auth }),
  listDepotDirs: (auth: P4Auth, path: string) =>
    call<P4DepotEntry[]>("p4_list_depot_dirs", { auth, path }),
  prepareClient: (auth: P4Auth, client: string) =>
    call<string>("p4_prepare_client", { auth, client }),
  createWorkspace: (request: P4CreateRequest, activityId?: string) =>
    call<P4Connection>("p4_create_workspace", { request, activityId: activityId ?? null }),
  executables: async () => {
    const executables = await call<P4Executables>("p4_executables");
    if (executables.active !== null) reportP4Availability(true);
    return executables;
  },
  checkExecutable: (path: string) => call<void>("check_p4_executable", { path }),
};

/** Counts `p4 sync` file lines into one short result. */
export function syncSummary(output: string): string {
  let updated = 0;
  let added = 0;
  let deleted = 0;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.includes(" - updating ") || line.includes(" - refreshing ") || line.includes(" - moved ")) {
      updated += 1;
    } else if (line.includes(" - added ")) {
      added += 1;
    } else if (line.includes(" - deleted ")) {
      deleted += 1;
    }
  }
  if (updated + added + deleted === 0) return t("p4.status.current");
  const parts: string[] = [];
  if (updated > 0) parts.push(t("p4.sync.updated", { count: updated }));
  if (added > 0) parts.push(t("p4.sync.added", { count: added }));
  if (deleted > 0) parts.push(t("p4.sync.deleted", { count: deleted }));
  const [first, ...rest] = parts;
  const head = first.charAt(0).toUpperCase() + first.slice(1);
  return [head, ...rest].join(t("p4.sync.separator")) + t("p4.sync.punctuation");
}

export function changeSummary(description: string): string {
  return description
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";
}

export function p4ActionStatus(action: string): string {
  const value = action.toLowerCase();
  if (value.includes("delete")) return "delete";
  if (value.includes("integrate") || value.includes("move") || value.includes("rename") || value.includes("branch")) {
    return "integrate";
  }
  if (value.includes("add")) return "add";
  if (value.includes("edit")) return "edit";
  return "";
}

export function depotBase(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

export function relativeToRoot(root: string, path: string, ignoreCase = pathsIgnoreCase()): string {
  if (!root) return "";
  const parts = (value: string) => (ignoreCase ? value.replace(/\\/g, "/") : value).replace(/\/+$/, "").split("/");
  const rootParts = parts(root);
  const pathParts = parts(path);
  if (rootParts.includes("..") || pathParts.includes("..")) return "";
  const fold = (part: string) => ignoreCase ? part.toLowerCase() : part;
  let index = 0;
  while (
    index < rootParts.length &&
    index < pathParts.length &&
    fold(rootParts[index]) === fold(pathParts[index])
  ) {
    index += 1;
  }
  if (index !== rootParts.length) return "";
  return pathParts.slice(index).join("/");
}
