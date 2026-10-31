import { t, useTranslation } from "@/i18n";
import { useId, useRef, useState } from "react";
import { CableIcon, InfoIcon, MonitorIcon, SlidersHorizontalIcon, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HoverTip } from "@/components/ui/tooltip";
import { normalizeHttpProxy, proxyValidationError, type HttpProxy } from "@/lib/network";

const modes: { id: HttpProxy["mode"]; label: string; icon: LucideIcon }[] = [
  { id: "system", icon: MonitorIcon, get label() { return t("desktop.networkSettings.system_proxy"); } },
  { id: "none", icon: CableIcon, get label() { return t("desktop.networkSettings.no_proxy"); } },
  { id: "manual", icon: SlidersHorizontalIcon, get label() { return t("desktop.networkSettings.manual_proxy"); } },
];

export function NetworkSettings({ value, onSave }: { value: HttpProxy; onSave: (proxy: HttpProxy) => Promise<boolean> }) {
  useTranslation();
  const id = useId();
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const busy = useRef(false);
  const next = normalizeHttpProxy(draft);
  const changed = next.mode !== value.mode || next.url.trim() !== value.url;

  function edit(patch: Partial<HttpProxy>) {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
    setSaved(false);
  }

  async function apply() {
    if (busy.current) return;
    const validation = proxyValidationError(next);
    if (validation) { setError(validation); return; }
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      const submitted = { ...next, url: next.mode === "manual" ? new URL(next.url.trim()).toString() : "" };
      if (await onSave(submitted)) { setDraft(submitted); setSaved(true); }
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
        <fieldset disabled={saving} className="min-w-0">
          <legend className="mb-2 text-sm">{t("desktop.networkSettings.proxy")}</legend>
          <div className="grid grid-cols-3 gap-1 rounded-lg border bg-muted/40 p-1">
            {modes.map(({ id: mode, label, icon: Icon }) => (
              <label key={mode} className="relative min-w-0 cursor-pointer has-disabled:cursor-default has-disabled:opacity-50">
                <input type="radio" className="peer sr-only" name={`${id}-mode`} value={mode} checked={draft.mode === mode} onChange={() => edit({ mode })} />
                <span className="flex min-h-12 items-center justify-center gap-2 rounded-md px-2 py-2 text-xs text-muted-foreground transition-colors hover:bg-background/60 peer-checked:bg-background peer-checked:text-foreground peer-checked:shadow-xs peer-checked:ring-1 peer-checked:ring-border peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50">
                  <Icon aria-hidden="true" className="size-4 shrink-0" /><span>{label}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {draft.mode === "manual" ? (
          <div className="grid gap-2">
            <Label htmlFor={`${id}-url`}>{t("desktop.networkSettings.proxy_url")}</Label>
            <Input id={`${id}-url`} type="url" className="font-mono text-xs" autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="http://127.0.0.1:8080" value={draft.url} disabled={saving} onChange={(event) => edit({ url: event.target.value })} aria-invalid={!!error} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`} />
            <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">{t("desktop.networkSettings.http_https_socks5_or_socks5h_credentials_are_not")}</p>
          </div>
        ) : draft.mode === "system" ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{t("desktop.networkSettings.uses_operating_system_proxy_settings_on_windows_and")}</p>
        ) : null}
        {error ? <p id={`${id}-error`} role="alert" className="text-xs text-destructive">{error}</p> : null}
        <div className="flex min-h-7 items-center justify-end gap-3">
          {saved ? <span role="status" className="text-xs text-muted-foreground">{t("desktop.networkSettings.proxy_saved")}</span> : null}
          <Button type="submit" size="sm" disabled={saving || !changed}>{saving ? t("desktop.networkSettings.saving") : t("desktop.networkSettings.apply_proxy")}</Button>
        </div>
      </form>
    </section>
  );
}
