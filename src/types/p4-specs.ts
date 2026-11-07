export type P4SpecKind = "label" | "branch";

export interface P4SpecEdit {
  kind: P4SpecKind;
  name: string;
  owner: string;
  description: string;
  view: string[];
  locked: boolean;
  revision: string;
}

export interface P4Spec extends P4SpecEdit { fingerprint: string }
export interface P4SpecSummary { name: string; owner: string; description: string; updated: string }
export interface P4SpecPage { items: P4SpecSummary[]; truncated: boolean }
export interface P4LabelFile { depotPath: string; revision: string; action: string; fileType: string }
export interface P4LabelFiles { files: P4LabelFile[]; truncated: boolean }
export interface P4LabelTagRequest {
  name: string;
  paths: string[];
  mode: "workspace" | "latest" | "changelist" | "revision";
  value: string;
  remove: boolean;
}
export interface P4LabelTagPreview { output: string; fingerprint: string }

export interface P4SpecActions {
  list: (kind: P4SpecKind, query: string, owner: string) => Promise<P4SpecPage>;
  read: (kind: P4SpecKind, name: string) => Promise<P4Spec>;
  save: (edit: P4SpecEdit, fingerprint: string | null) => Promise<P4Spec>;
  remove: (kind: P4SpecKind, name: string, fingerprint: string) => Promise<void>;
  files: (name: string) => Promise<P4LabelFiles>;
  previewTag: (request: P4LabelTagRequest) => Promise<P4LabelTagPreview>;
  applyTag: (request: P4LabelTagRequest, fingerprint: string) => Promise<string>;
}
