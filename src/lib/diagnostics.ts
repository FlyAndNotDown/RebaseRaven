import { invoke } from "@tauri-apps/api/core";
import type { DiagnosticExport, DiagnosticLevel, DiagnosticView } from "@/types/diagnostics";

export const diagnosticsApi = {
  view: (level: DiagnosticLevel) => invoke<DiagnosticView>("get_diagnostic_view", { level }),
  export: (destination: string) => invoke<DiagnosticExport>("export_diagnostic_logs", { destination }),
  openDirectory: () => invoke<void>("open_diagnostic_directory"),
  openIssues: () => invoke<void>("open_diagnostic_issues"),
};
