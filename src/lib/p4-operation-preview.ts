import type { P4Connection, P4IntegrateRequest, P4UndoRequest } from "@/types/p4";
import { t } from "@/i18n";

export const P4_JOB_STALE = "The job or its field definition changed. Reload it before saving or deleting.";

export const P4_STREAM_SPEC_STALE = "The stream definition changed. Reload it before saving or deleting.";

export type P4OperationKind = "integrate" | "undo";

const operationErrors: Record<string, string> = {
  "The stream definition was not removed from the shelf.": "streamWorkShelfDelete",
  "The stream, workspace, or changelist changed. Preview the stream operation again.": "streamWorkStale",
  "The server did not return the stream revision.": "streamWorkRevision",
  "Submit or revert the already opened stream definition first.": "streamWorkOpened",
  "Choose a different parent view supported by this stream type.": "streamWorkView",
  "The stream definition is no longer opened in this workspace.": "streamWorkMissing",
  "Choose a different changelist.": "streamWorkChange",
  "Choose a resolve method for the pending stream conflicts.": "streamWorkResolve",
  "Choose a supported stream operation.": "streamWorkAction",
  "The stream's parent chain is invalid or too deep.": "streamWorkAncestors",
  "The stream operation did not complete. Refresh the pending changes.": "streamWorkIncomplete",
  "Choose a shelved or submitted stream definition.": "streamWorkSource",
  "The stream revision is unavailable.": "streamWorkSourceMissing",
  "Revert or submit the private stream definition before deleting the stream.": "streamWorkDelete",
  "This field is not isolated by the server's stream definition. Submit or revert the private edit first.": "streamWorkField",
  "Submit or revert the opened stream definition first.": "streamWorkChangeDelete",
  "Move the opened stream definition to the selected changelist first.": "streamWorkRestoreChange",
  "This shelf has no definition for the workspace's stream.": "streamWorkShelf",

  "The job association was not updated.": "fixNotUpdated",
  "The job was not deleted.": "jobNotDeleted",
  "Remove the job's changelist links before deleting it.": "jobLinked",
  "This job is no longer linked to the changelist.": "fixMissing",
  "Choose a pending or submitted changelist.": "fixChange",
  "Choose a fix status from the server's job definition.": "fixStatus",
  "Choose one job or changelist.": "jobOrChange",
  "The server did not return the created job name.": "jobCreateResult",
  "This job already exists. Choose another name.": "jobExists",
  "A read-only job field cannot be changed.": "jobReadOnly",
  "The job form contains an unknown field. Reload it.": "jobUnknownField",
  "Enter a single-line job search expression.": "jobFilter",
  "The selected job no longer exists.": "jobMissing",
  "The server's job definition has no Job field.": "jobMissingField",
  "Invalid job field code.": "jobCode",
  "The server returned an invalid job field definition.": "jobSchema",
  "Enter one job name without wildcards or search operators.": "jobName",
  "The job, changelist, or fix changed. Preview the association again.": "fixStale",
  "The job or its field definition changed. Reload it before saving or deleting.": "jobStale",
  [P4_STREAM_SPEC_STALE]: "streamSpecStale",
  "This stream already exists. Choose another path.": "streamSpecExists",
  "Enter one stream path without wildcards or revision suffixes.": "streamSpecPath",
  "Choose a supported stream type.": "streamSpecType",
  "A mainline stream must have no parent.": "streamSpecMainline",
  "Choose a different parent stream.": "streamSpecParent",
  "Choose a parent view supported by this stream type.": "streamSpecView",
  "Convert the parent view before editing this stream definition.": "streamSpecConvert",
  "Enter a stream name, owner and description smaller than 64 KiB.": "streamSpecFields",
  "Enter one stream mapping per line, up to 5000 lines.": "streamSpecMapping",
  "Virtual streams must disable integration to and from their parent.": "streamSpecVirtual",
  "Choose revisions or changelists for the integration range.": "integrationRange",
  "Choose file paths or a named branch mapping.": "integrationMethod",
  "Move integration targets to the selected changelist first.": "integrationChange",
  "Reconcile or preserve offline target changes before integrating.": "integrationOffline",
  "Too many integration targets. Choose a narrower path.": "integrationLimit",
  "Some integrations were not opened in the selected changelist. Review pending files before retrying.": "integrationPartial",

  "Label preview timed out. Choose a narrower path and retry.": "tagTimeout",
  "Enter one Perforce object name without wildcards.": "specName",
  "The selected Perforce object no longer exists.": "specMissing",
  "Enter a single-line search filter.": "specFilter",
  "Enter a description smaller than 64 KiB.": "specDescription",
  "Enter one depot mapping per line.": "specView",
  "Enter a label revision beginning with @ or #, or leave it empty.": "specRevision",
  "Choose depot or workspace paths without revision suffixes.": "tagPaths",
  "Choose a supported label source.": "tagSource",
  "Unlock this static label before changing its tagged files.": "tagLocked",
  "Too many label changes. Choose a narrower path.": "tagLimit",

  "The workspace is not fully synced. Use Get latest to finish.": "switchIncomplete",
  "Refresh and choose a writable stream workspace.": "switchWorkspace",
  "Choose a different stream.": "switchDifferent",
  "Choose a non-virtual stream to switch this workspace.": "switchVirtual",
  "Resolve pending integrations before switching streams.": "switchUnresolved",
  "Shelve local changes or finish them before switching streams.": "switchChanges",

  "Choose a supported line ending.": "workspaceLineEnd",
  "Stream workspace mappings are generated by Perforce.": "workspaceGenerated",
  "Enter one valid workspace mapping per line.": "workspaceMapping",
  "Submit, shelve and revert local changes before changing workspace mappings or root.": "workspaceDirtyMapping",
  "Choose an absolute folder for the workspace.": "workspaceRoot",

  "The file is not a supported image.": "imageInvalid",
  "The image size is unavailable.": "imageSize",
  "Select a live text revision for line history.": "blameText",
  "Line history is limited to 2 MiB and 20000 lines.": "blameSize",
  "Perforce returned incomplete line history.": "blameIncomplete",
  "Enter a non-negative file revision.": "fileRevision",
  "The selected file revision is unavailable.": "fileRevisionMissing",
  "Workspace text comparison is limited to 2 MiB per file.": "compareSize",
  "Workspace text comparison requires UTF-8 files.": "compareEncoding",
  "The text comparison is too complex to preview.": "compareComplex",

  "Too many shelves. Filter by user or open a changelist by number.": "shelfLimit",
  "Choose an installed external merge tool in Perforce settings.": "mergeToolMissing",
  "The external merge tool exited without a successful result.": "mergeToolExit",

  "Choose a Perforce user name.": "shelfUser",
  "This changelist has no shelved files.": "shelfEmpty",
  "Choose files from this shelf.": "shelfFiles",
  "Stream mapping restores the entire shelf. Select all files.": "shelfMapping",
  "No files can be restored into this workspace.": "shelfMappingEmpty",

  "Choose a stream workspace.": "streamWorkspace",
  "Choose a related source stream.": "streamSource",
  "Choose a writable workspace for the current stream.": "streamWritable",
  "Merge from the parent stream or copy from a child stream.": "streamRelation",

  "Manual merge requires UTF-8 text files smaller than 2 MiB.": "manualText",
  "Manual merge requires one text content resolve with a common base.": "manualBase",
  "Remove conflict markers before resolving.": "manualMarkers",

  "The operation or workspace changed. Preview it again before applying.": "stale",
  "Enter a positive revision or changelist number.": "number",
  "The first revision must not exceed the last revision.": "range",
  "Choose your own pending changelist in this workspace.": "pendingChange",
  "Choose one depot file without wildcards or revision suffixes.": "source",
  "Choose one absolute local workspace file.": "target",
  "Choose a regular workspace file, not a folder or symbolic link.": "regularFile",
  "Choose a file mapped once by this workspace view.": "mapping",
  "The file mapping does not match the selected workspace file.": "mappingMismatch",
  "Choose the exact depot file path returned by Perforce.": "exactDepotPath",
  "Choose an absent target or one versioned workspace file.": "versionedTarget",
  "Choose a numbered changelist.": "numberedChange",
  "Unsupported file action.": "unsupportedAction",
  "Choose a file.": "chooseFile",
  "Choose a pending changelist to lock or unlock files.": "lockChange",
  "Choose explicit opened files to lock or unlock.": "lockFiles",
  "Resolve or revert this file's pending action before moving it.": "pendingMoveAction",
  "Choose a local workspace file.": "localFile",
  "Choose a regular workspace file.": "regularLocalFile",
  "Choose a versioned workspace file.": "versionedFile",
  "Enter a relative destination inside this workspace.": "relativeDestination",
  "Enter a file name.": "fileName",
  "The destination already exists. Choose another file name.": "destinationExists",
  "Path is outside the workspace.": "outsideWorkspace",
  "Folder not found.": "folderMissing",
};

export function p4OperationErrorKey(message: string): string | null {
  const key = operationErrors[message];
  return key ? `p4-operations.errors.${key}` : null;
}

/** Localize only exact application messages; native command diagnostics stay intact. */
export function p4DisplayError(message: string, language?: string): string {
  const field = /^Enter a valid value for (.+)\.$/.exec(message)?.[1];
  if (field) return t("p4-operations.errors.jobFieldValue", {field, lng: language});
  const key = p4OperationErrorKey(message);
  return key ? t(key, { lng: language }) : message;
}

export function p4OperationKey(kind: P4OperationKind, connection: P4Connection, request: P4IntegrateRequest | P4UndoRequest): string {
  return JSON.stringify([kind, connection, request]);
}

/** A changed form or closed dialog cannot approve an earlier asynchronous preview. */
export function createP4PreviewGate() {
  let generation = 0;
  let approved: { key: string; fingerprint: string } | null = null;
  return {
    begin(key: string) {
      approved = null;
      return { generation: ++generation, key };
    },
    complete(request: { generation: number; key: string }, fingerprint: string): boolean {
      if (request.generation !== generation || !fingerprint) return false;
      approved = { key: request.key, fingerprint };
      return true;
    },
    accepts(key: string, fingerprint: string): boolean {
      return approved?.key === key && approved.fingerprint === fingerprint;
    },
    invalidate() {
      generation += 1;
      approved = null;
    },
  };
}
