import { t, useTranslation } from "@/i18n";
import { useId, useRef, useState } from "react";
import { CableIcon, CheckIcon, ChevronDownIcon, InfoIcon, LoaderCircleIcon, MonitorIcon, SaveIcon, SlidersHorizontalIcon, XIcon, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HoverTip } from "@/components/ui/tooltip";
import { normalizeHttpProxy, proxyValidationError, type HttpProxy } from "@/lib/network";
import { acceptProxyDraft, createProxyDraft, editProxyDraft, proxyDraftChanged, reconcileProxyDraft } from "@/lib/proxy-draft";

const modes: { id: HttpProxy["mode"]; label: string; icon: LucideIcon }[] = [
  { id: "system", icon: MonitorIcon, get label() { return t("desktop.networkSettings.system_proxy"); } },
  { id: "none", icon: CableIcon, get label() { return t("desktop.networkSettings.no_proxy"); } },
  { id: "manual", icon: SlidersHorizontalIcon, get label() { return t("desktop.networkSettings.manual_proxy"); } },
];

export function NetworkSettings({ value, onSave }: { value: HttpProxy; onSave: (proxy: HttpProxy) => Promise<boolean> }) {
  useTranslation();
  const id = useId();
  const [state, setState] = useState(() => createProxyDraft(value));
  const current = reconcileProxyDraft(state, value);
  if (current !== state) setState(current);
  const draft = current.value;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const busy = useRef(false);
  const urlInput = useRef<HTMLInputElement>(null);
  const next = normalizeHttpProxy(draft);
  const changed = proxyDraftChanged(current);
  const selectedMode = modes.find((mode) => mode.id === draft.mode) ?? modes[0];
  const ModeIcon = selectedMode.icon;
  const feedback = saving ? t("desktop.networkSettings.saving")
    : error ?? (saved ? t("desktop.networkSettings.proxy_saved") : "");

  function edit(patch: Partial<HttpProxy>) {
    setState((current) => editProxyDraft(current, patch));
    setError(null);
    setSaved(false);
  }

  async function apply() {
    if (busy.current) return;
    const validation = proxyValidationError(next);
    if (validation) { setError(validation); urlInput.current?.focus(); return; }
    busy.current = true;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const submitted = { ...next, url: next.mode === "manual" ? new URL(next.url.trim()).toString() : "" };
      if (await onSave(submitted)) { setState((current) => acceptProxyDraft(current, submitted)); setSaved(true); }
      else setError(t("desktop.networkSettings.could_not_save_the_proxy_your_entries_are"));
    } catch {
      setError(t("desktop.networkSettings.could_not_save_the_proxy_your_entries_are"));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-3">
      <div className="flex items-center gap-1.5">
        <h3 id={`${id}-title`} className="text-sm font-medium">{t("desktop.networkSettings.client_network")}</h3>
        <HoverTip label={t("desktop.networkSettings.applies_to_application_http_requests_git_and_perforce")}>
          <Button variant="ghost" size="icon-xs" aria-label={t("desktop.networkSettings.about_client_network_settings")}><InfoIcon /></Button>
        </HoverTip>
      </div>
      <form className="grid gap-4" noValidate onSubmit={(event) => { event.preventDefault(); if (changed) void apply(); }}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Label id={`${id}-mode-label`} htmlFor={`${id}-mode`}>{t("desktop.networkSettings.proxy")}</Label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                id={`${id}-mode`}
                variant="outline"
                size="sm"
                className="w-44 max-w-full justify-between font-normal"
                aria-labelledby={`${id}-mode-label ${id}-mode-choice`}
                disabled={saving}
              >
                <span id={`${id}-mode-choice`} className="flex min-w-0 items-center gap-2">
                  <ModeIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{selectedMode.label}</span>
                </span>
                <ChevronDownIcon className="size-3.5 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-(--radix-dropdown-menu-trigger-width)">
              <DropdownMenuRadioGroup value={draft.mode} onValueChange={(mode) => {
                if (!busy.current && (mode === "system" || mode === "none" || mode === "manual")) edit({ mode });
              }}>
                {modes.map(({ id: mode, label, icon: Icon }) => (
                  <DropdownMenuRadioItem key={mode} value={mode} disabled={saving}>
                    <Icon aria-hidden="true" className="size-3.5" />{label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {draft.mode === "manual" ? (
          <div className="grid gap-2">
            <Label htmlFor={`${id}-url`}>{t("desktop.networkSettings.proxy_url")}</Label>
            <Input ref={urlInput} id={`${id}-url`} type="url" className="font-mono text-xs" autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="http://127.0.0.1:8080" value={draft.url} disabled={saving} onChange={(event) => edit({ url: event.target.value })} aria-invalid={!!error} aria-describedby={`${id}-hint${error ? ` ${id}-feedback` : ""}`} />
            <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">{t("desktop.networkSettings.http_https_socks5_or_socks5h_credentials_are_not")}</p>
          </div>
        ) : draft.mode === "system" ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{t("desktop.networkSettings.uses_operating_system_proxy_settings_on_windows_and")}</p>
        ) : null}
        <div className="flex min-h-7 items-center justify-end gap-3">
          <HoverTip label={feedback || t("desktop.networkSettings.apply_proxy")}>
            <span className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50" tabIndex={!changed && saved ? 0 : undefined} role={!changed && saved ? "group" : undefined} aria-label={!changed && saved ? feedback : undefined}>
              <Button type="submit" size="sm" disabled={saving || !changed} aria-busy={saving} aria-describedby={feedback ? `${id}-feedback` : undefined}>
                {saving ? <LoaderCircleIcon className="motion-safe:animate-spin" aria-hidden="true" />
                  : error ? <XIcon aria-hidden="true" />
                  : saved ? <CheckIcon aria-hidden="true" /> : <SaveIcon aria-hidden="true" />}
                {t("desktop.networkSettings.apply_proxy")}
              </Button>
            </span>
          </HoverTip>
        </div>
        <span id={`${id}-feedback`} role="status" aria-atomic="true" className="sr-only">{feedback}</span>
      </form>
    </section>
  );
}
