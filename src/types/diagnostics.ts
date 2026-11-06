export type DiagnosticLevel = "error" | "warning" | "info" | "verbose";

export interface DiagnosticSummary {
  totalBytes: number;
  fileCount: number;
  maxBytes: number;
  retentionDays: number;
}

export interface DiagnosticExport {
  fileCount: number;
  skippedEntries: number;
}

export interface DiagnosticView {
  summary: DiagnosticSummary;
  text: string;
}
