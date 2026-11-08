import { t } from "@/i18n";
import { errorMessage } from "@/lib/git";

const errors: Record<string,string> = {
  "Git LFS settings changed. Refresh before trying again.": "stale",
  "Git LFS is not installed.": "missing",
  "Could not read Git LFS data.": "read",
  "Could not read Git LFS data. Check your Git LFS installation.": "read",
  "Could not read Git LFS JSON data. Update Git LFS and try again.": "json",
  "Git LFS data exceeds 32 MiB.": "limit",
  "Git LFS attribute files must be smaller than 2 MiB.": "attributes",
  "Only repository attribute files can be edited here.": "source",
  "Linked attribute files cannot be edited here.": "linked",
  "Enter a single Git LFS pattern smaller than 8 KiB.": "pattern",
  "Enter a Git LFS pattern.": "empty",
  "Refresh and select an editable Git LFS rule.": "rule",
  "Choose an existing Git remote.": "remote",
};
export function lfsError(caught: unknown): string {
  const message=errorMessage(caught), key=errors[message];
  return key ? t(`git.lfs.errors.${key}`) : message;
}
