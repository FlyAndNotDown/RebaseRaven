import { errorCode } from "@/lib/native-error";
import { p4Api } from "@/lib/p4";
import type { P4Changelist, P4Connection } from "@/types/p4";

export async function withP4Login<T>(request: () => Promise<T>, login: () => Promise<void>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (errorCode(error) !== "p4LoginRequired") throw error;
    await login();
    return request();
  }
}

export function pendingDiffRequest(connection: P4Connection, change: string, file: string, shelved: boolean, ignoreWhitespace = false) {
  return () => shelved
    ? p4Api.shelfDiff(connection, file, change, ignoreWhitespace)
    : p4Api.openedDiff(connection, file, ignoreWhitespace);
}

/** Passive reads must never turn an expired ticket into a login prompt. */
export function p4ReadRequest<T>(
  request: () => Promise<T>,
  quiet: boolean,
  interactive: (request: () => Promise<T>) => Promise<T>,
) {
  return quiet ? request() : interactive(request);
}

export function pendingRefreshRequest(
  connection: P4Connection,
  quiet: boolean,
  interactive: (request: () => Promise<P4Changelist[]>) => Promise<P4Changelist[]>,
  preview?: (partial: P4Changelist[]) => void,
) {
  return p4ReadRequest(() => p4Api.refreshPending(connection, preview), quiet, interactive);
}
