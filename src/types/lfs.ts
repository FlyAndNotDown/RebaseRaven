import type { WorkspaceSnapshot } from "@/types/git";

export interface LfsPattern {pattern:string; source:string; lockable:boolean; tracked:boolean; editable:boolean}
export interface LfsFile {name:string; size:number; checkout:boolean; downloaded:boolean; oid:string; modified:boolean}
export interface LfsState {
  version:string | null;
  filtersConfigured:boolean;
  patterns:LfsPattern[];
  files:LfsFile[];
  remotes:string[];
  fingerprint:string;
}
export type LfsAction =
  | {kind:"install"}
  | {kind:"track"; pattern:string; literal:boolean; lockable:boolean}
  | {kind:"untrack"; pattern:string; source:string}
  | {kind:"fetch"; remote:string; include:string; exclude:string; recent:boolean}
  | {kind:"pull"; remote:string; include:string; exclude:string}
  | {kind:"checkout"}
  | {kind:"push"; remote:string};
export interface LfsUpdate {state:LfsState; report:string}
export interface LfsOutcome extends LfsUpdate {snapshot:WorkspaceSnapshot}
