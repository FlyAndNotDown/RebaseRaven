import type { WorkspaceSnapshot } from "@/types/git";

export interface SparseCheckoutState {
  enabled: boolean;
  cone: boolean;
  sparseIndex: boolean;
  rules: string[];
  patterns: string[];
  fingerprint: string;
}

export type SparseCheckoutRequest =
  | {kind:"set"; cone:boolean; sparseIndex:boolean; rules:string[]}
  | {kind:"reapply"}
  | {kind:"disable"};

export interface SparseCheckoutPreview {
  fingerprint: string;
  selected: number;
  outside: number;
  selectedPaths: string[];
  ignoredCount: number;
  ignoredPaths: string[];
  dirtyCount: number;
  dirtyPaths: string[];
}

export interface SparseCheckoutUpdate {state: SparseCheckoutState; report:string}
export interface SparseCheckoutOutcome extends SparseCheckoutUpdate {snapshot: WorkspaceSnapshot}
