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

export interface P4StreamSpec extends P4StreamSpecEdit { fingerprint: string }

export interface P4StreamSpecActions {
  read: (path: string) => Promise<P4StreamSpec>;
  template: (setup: P4StreamSetup) => Promise<P4StreamSpec>;
  save: (edit: P4StreamSpecEdit, fingerprint: string | null) => Promise<P4StreamSpec>;
  remove: (path: string, fingerprint: string) => Promise<void>;
}
