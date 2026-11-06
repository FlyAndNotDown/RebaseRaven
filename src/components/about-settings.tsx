import { ExternalLinkIcon, MailIcon } from "lucide-react";
import { toast } from "sonner";
import { version } from "../../package.json";
import { AppMark } from "@/components/app-mark";
import { UpdatesSettings } from "@/components/app-updates";
import { Button } from "@/components/ui/button";
import { t, useTranslation } from "@/i18n";
import { errorMessage, gitApi } from "@/lib/git";

const REPOSITORY_URL = "https://github.com/FlyAndNotDown/Rebasely";
const AUTHOR = "FlyAndNotDown";
const EMAIL = "johnkindem@qq.com";

export function AboutSettings() {
  useTranslation();
  return (
    <div className="grid gap-6">
      <section aria-label="Rebasely" className="grid gap-5">
        <div className="flex items-center gap-4">
          <AppMark className="size-14" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-2xl leading-none font-medium tracking-tight">Rebasely</h2>
              <span className="rounded-md border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">v{version}</span>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{t("desktop.aboutSettings.a_unified_version_control_client")}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
          <p><span className="mr-2 text-muted-foreground">{t("desktop.aboutSettings.developer")}</span>{AUTHOR}</p>
          <Button variant="ghost" size="sm" className="min-w-0 text-muted-foreground" onClick={() => void sendMail()}>
            <MailIcon /><span className="truncate font-mono text-xs">{EMAIL}</span>
          </Button>
        </div>
        <Button
          variant="outline"
          className="h-auto w-full justify-start gap-3 px-3 py-3 text-left"
          aria-label={t("desktop.aboutSettings.open_github_repository")}
          onClick={() => void openRepository()}
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor" className="size-5 shrink-0 text-muted-foreground">
            <path d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656" />
          </svg>
          <span className="grid min-w-0 flex-1 gap-1 whitespace-normal">
            <span className="text-sm font-medium">{t("desktop.aboutSettings.github_repository")}</span>
            <span className="break-all font-mono text-[11px] leading-relaxed text-muted-foreground">{REPOSITORY_URL}</span>
          </span>
          <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </section>
      <div className="border-t pt-6"><UpdatesSettings /></div>
    </div>
  );
}

async function openRepository() {
  try {
    await gitApi.openExternalUrl(REPOSITORY_URL);
  } catch (error) {
    toast.error(errorMessage(error));
  }
}

async function sendMail() {
  try {
    await gitApi.openMailto(EMAIL);
  } catch (error) {
    toast.error(errorMessage(error));
  }
}
