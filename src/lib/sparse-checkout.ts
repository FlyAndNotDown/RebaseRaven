import { t } from "@/i18n";
import { errorMessage } from "@/lib/git";

export const SPARSE_CHECKOUT_STALE = "Sparse checkout changed. Reload its settings and preview again.";
const errors: Record<string, string> = {
  [SPARSE_CHECKOUT_STALE]: "stale",
  "Sparse checkout requires UTF-8 paths and rules.": "encoding",
  "Could not read the sparse checkout file list.": "list",
  "The sparse checkout preview exceeds 128 MiB of paths.": "limit",
  "Sparse checkout rules must be smaller than 1 MiB.": "ruleSize",
  "Enable sparse checkout before reapplying its rules.": "inactive",
  "Sparse indexes require directory mode.": "indexMode",
  "Enter at most 10000 sparse checkout rules on separate lines, smaller than 1 MiB.": "rules",
  "Review and confirm ignored files outside the selection before applying sparse checkout.": "ignored",
};

export function sparseCheckoutError(caught: unknown): string {
  const message = errorMessage(caught);
  const key = errors[message];
  if (key) return t(`git.sparse.errors.${key}`);
  const prefix = "Could not check sparse checkout rules. Git 2.42 or newer is required.\n";
  return message.startsWith(prefix) ? `${t("git.sparse.errors.matcher")}\n${message.slice(prefix.length)}` : message;
}
