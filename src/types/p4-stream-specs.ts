import type { FileDiff } from "@/types/git";

export type P4StreamKind = "mainline" | "development" | "release" | "virtual" | "task" | "sparsedev" | "sparserel";
export type P4ParentView = "inherit" | "noinherit";

export interface P4StreamSetup {
  path: string;
  kind: P4StreamKind;
  parent: string;
  parentView: P4ParentView | null;
}

export interface P4StreamOptions {
  locked: boolean;
  ownerSubmit: boolean;
  toParent: boolean;
  fromParent: boolean;
  mergeAny: boolean;
}

export interface P4StreamSpecEdit {
  path: string;
  name: string;
  owner: string;
  kind: P4StreamKind;
  parent: string;
  parentView: P4ParentView | "";
  description: string;
  options: P4StreamOptions;
  paths: string[];
  remapped: string[];
  ignored: string[];
}

export interface P4StreamSpec extends P4StreamSpecEdit { fingerprint: string; opened?: boolean; editableFields?: string[] }

export interface P4StreamOpen { change: string; baseChange: string }
export interface P4StreamWork {
  spec: P4StreamSpec;
  opened: P4StreamOpen | null;
  headChange: string;
  currentText: string;
  baseText: string;
  headText: string;
  diff: FileDiff;
  unresolved: boolean;
  resolveOutput: string;
  fingerprint: string;
}
export interface P4StreamWorkRequest { action: "open" | "move" | "revert" | "parentview" | "resolve" | "unshelve" | "deleteShelf"; change: string; mode: string }
export interface P4StreamWorkPreview { request: P4StreamWorkRequest; work: P4StreamWork; convertedText: string | null; output: string; fingerprint: string }
export interface P4StreamDiffRequest { kind: "shelf" | "submitted"; path: string; change: string }

export interface P4StreamSpecActions {
  work: () => Promise<P4StreamWork>;
  previewWork: (request: P4StreamWorkRequest) => Promise<P4StreamWorkPreview>;
  applyWork: (request: P4StreamWorkRequest, fingerprint: string) => Promise<P4StreamWork>;
  changeDiff: (request: P4StreamDiffRequest) => Promise<FileDiff>;
  read: (path: string) => Promise<P4StreamSpec>;
  template: (setup: P4StreamSetup) => Promise<P4StreamSpec>;
  save: (edit: P4StreamSpecEdit, fingerprint: string | null) => Promise<P4StreamSpec>;
  remove: (path: string, fingerprint: string) => Promise<void>;
}
