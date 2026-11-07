import type { P4ReconcilePreview } from "@/types/p4";

export interface P4IntegrationInitial { branch?: string; source?: string; target?: string }
export interface P4IntegrationRequest {
  method: "paths" | "branch";
  source: string;
  target: string;
  branch: string;
  reverse: boolean;
  range: {kind:"revision"|"changelist";from:string;to:string}|null;
  force: boolean;
  changeId: string;
}
export interface P4IntegrationPreview { files: P4ReconcilePreview["files"]; fingerprint: string }
