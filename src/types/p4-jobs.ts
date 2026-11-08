export interface P4JobField {
  code: number;
  name: string;
  kind: string;
  required: boolean;
  readOnly: boolean;
  choices: string[];
  hint: string;
  value: string;
}
export interface P4Job {
  name: string;
  fields: P4JobField[];
  schemaFingerprint: string;
  fingerprint: string;
}
export interface P4JobEdit {
  name: string;
  values: Record<string, string>;
  schemaFingerprint: string;
}
export interface P4JobSummary { name: string; status: string; user: string; description: string }
export interface P4JobPage { items: P4JobSummary[]; truncated: boolean }
export interface P4Fix { job: string; change: string; status: string; user: string; client: string }
export interface P4FixPage { items: P4Fix[]; truncated: boolean }
export interface P4FixRequest { job: string; change: string; status: string; remove: boolean }
export interface P4FixPreview {
  request: P4FixRequest;
  changeStatus: string;
  currentStatus: string;
  fixStatus: string;
  existingStatus: string | null;
  fingerprint: string;
}
export interface P4JobActions {
  list: (query: string) => Promise<P4JobPage>;
  read: (job: string | null) => Promise<P4Job>;
  save: (edit: P4JobEdit, fingerprint: string | null) => Promise<P4Job>;
  remove: (job: string, fingerprint: string) => Promise<void>;
  fixes: (job: string, change: string) => Promise<P4FixPage>;
  previewFix: (request: P4FixRequest) => Promise<P4FixPreview>;
  applyFix: (request: P4FixRequest, fingerprint: string) => Promise<void>;
}
