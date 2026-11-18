export const GIT_MISSING = "Git executable was not found. Choose one in Settings.";
export const P4_MISSING = "p4 executable was not found. Choose one in Settings.";
export const P4_LOGIN = "Perforce login is required.";

const legacyCodes: Record<string, string> = {
  [GIT_MISSING]: "gitMissing",
  [P4_MISSING]: "p4Missing",
  [P4_LOGIN]: "p4LoginRequired",
  Cancelled: "cancelled",
  "The operation or workspace changed. Preview it again before applying.": "staleReview",
};

export function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

export function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return legacyCodes[errorMessage(error)];
}

export function isCancelled(error: unknown) {
  return errorCode(error) === "cancelled";
}
