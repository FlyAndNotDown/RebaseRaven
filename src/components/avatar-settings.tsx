import { t, useTranslation } from "@/i18n";
import { useId, useRef, useState } from "react";
import { ChevronDownIcon, InfoIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { HoverTip } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import type { GitAvatarProvider } from "@/lib/avatar";

const PROVIDERS: { value: GitAvatarProvider; label: string }[] = [
  { value: "auto", get label() { return t("desktop.avatarSettings.auto"); } },
  { value: "builtin", get label() { return t("desktop.avatarSettings.built_in"); } },
  { value: "github", label: "GitHub" },
  { value: "gitlab", label: "GitLab" },
];

type Props = ({vcs:"git"; provider:GitAvatarProvider; onSave:(provider:GitAvatarProvider) => Promise<unknown>}
  | {vcs:"perforce"; provider:"builtin"; onSave:(provider:"builtin") => Promise<unknown>}) & {ready?:boolean};

export function AvatarSettings(props: Props) {
  useTranslation();
  const {provider, vcs, ready = true} = props;
  const providers = vcs === "git" ? PROVIDERS : PROVIDERS.filter(item => item.value === "builtin");
  const labelId = useId();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const busy = useRef(false);
  const errorText = error ? t("desktop.avatarSettings.could_not_save_the_avatar_provider_try_again") : "";

  async function select(next: GitAvatarProvider) {
    if (busy.current || next === provider) return;
    busy.current = true;
    setSaving(true);
    setError(false);
    try {
      if (props.vcs === "git") await props.onSave(next);
      else if (next === "builtin") await props.onSave(next);
    } catch { setError(true); }
    finally { busy.current = false; setSaving(false); }
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <span id={labelId} className="text-sm">{t("desktop.avatarSettings.author_avatars")}</span>
          <HoverTip label={t(vcs === "git" ? "desktop.avatarSettings.git_hint" : "desktop.avatarSettings.p4_hint")}>
            <Button variant="ghost" size="icon-xs" aria-label={t("desktop.avatarSettings.about_author_avatar_providers")}><InfoIcon /></Button>
          </HoverTip>
        </div>
        {!ready ? <Skeleton className="h-8 w-32" role="status" aria-label={t("common.loadingNamed", {name:t("desktop.avatarSettings.author_avatars")})} /> : <DropdownMenu>
          <HoverTip label={errorText}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="min-w-32 justify-between" aria-labelledby={`${labelId} ${labelId}-choice`} aria-describedby={error ? `${labelId}-error` : undefined} disabled={saving}>
                <span id={`${labelId}-choice`}>{saving ? t("desktop.networkSettings.saving") : providers.find((item) => item.value === provider)?.label}</span>
                {saving ? <LoaderCircleIcon className="motion-safe:animate-spin" aria-hidden="true" /> : error ? <XIcon className="text-destructive" aria-hidden="true" /> : <ChevronDownIcon aria-hidden="true" />}
              </Button>
            </DropdownMenuTrigger>
          </HoverTip>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={provider} onValueChange={(value) => {
              if (providers.some(item => item.value === value) && (value === "auto" || value === "builtin" || value === "github" || value === "gitlab")) void select(value);
            }}>
              {providers.map((item) => <DropdownMenuRadioItem key={item.value} value={item.value} disabled={saving}>{item.label}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>}
      </div>
      <p id={`${labelId}-error`} role="alert" className="sr-only">{errorText}</p>
    </>
  );
}
