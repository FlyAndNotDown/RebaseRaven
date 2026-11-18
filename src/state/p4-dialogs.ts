import { createContext } from "react";
import type { P4IntegrationInitial } from "@/types/p4-integration";
import type { P4StreamRequest } from "@/types/p4";

type Target<T> = T & { close: () => void };
export interface P4Dialogs {
  integration: Target<{ initial: P4IntegrationInitial }> | null;
  stream: Target<{ initial: Pick<P4StreamRequest, "mode" | "source"> | null }> | null;
  scan: Target<{ operation: "clean" | "reconcile"; scope?: string; key: string }> | null;
  switchStream: Target<{ target: string }> | null;
  update: Target<{ stream: string; disabled: boolean; apply: () => void }> | null;
  login: { open: boolean; client: string; port: string; finish: (password: string | null) => void };
}
export const P4DialogContext = createContext<P4Dialogs | null>(null);
