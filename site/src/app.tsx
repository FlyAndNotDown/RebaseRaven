import { useId, useRef, useState, type MouseEvent, type RefObject } from "react";
import { ArrowDownToLineIcon, ArrowUpRightIcon, LanguagesIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { browserLocale, localeHref, SITE_LOCALES, type SiteLocale } from "./i18n";
import { useSiteTheme } from "./theme";
import { BrandMark } from "@/components/brand-mark";
import { GitHubMark } from "@/components/github-mark";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuCheckboxItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { HoverTip } from "@/components/ui/tooltip";
import { WorkspacePreview } from "./workspace-preview";
import { FeatureStories } from "./feature-stories";
import { PlatformMark } from "./platform-mark";
import { useArtMotion } from "./use-art-motion";
import { useSiteMotion } from "./motion";
import { LATEST_RELEASE_URL, REPOSITORY_URL } from "./release-downloads";
import { trackDemoStart, trackDownloadDialog, trackReleasePageOpen } from "./website-analytics";

const REPOSITORY = REPOSITORY_URL;

export function Site({ rootPage = false }: { rootPage?: boolean }) {
  const { t, i18n } = useTranslation();
  const otherLocales = SITE_LOCALES.filter(locale => locale !== i18n.language);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const downloadTrigger = useRef<HTMLAnchorElement | null>(null);
  const demoStarted = useRef(false);
  const atmosphere = useId();
  const { ref: atmosphereRef, playing: atmospherePlaying } = useArtMotion();
  const mark = `${rootPage ? "./" : "../"}assets/raven.svg`;

  function startDemo() {
    if (demoStarted.current) return;
    demoStarted.current = true;
    trackDemoStart();
  }

  function openDownload(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    downloadTrigger.current = event.currentTarget;
    const source = event.currentTarget.dataset.downloadSource;
    if (source === "header" || source === "hero") trackDownloadDialog(source);
    setDownloadOpen(true);
  }

  return <div className="site-page">
    <a className="site-skip" href="#main">{t("nav.skip")}</a>
    <header className="site-header">
      <div className="site-wrap site-header-inner">
        <a className="site-brand" href={rootPage ? "./" : "../"} aria-label={t("nav.home")}><BrandMark src={mark} className="site-brand-mark" /></a>
        <nav className="site-navigation" aria-label={t("nav.main")}>
          <HoverTip label={t("nav.source")}><Button variant="ghost" size="icon-sm" asChild className="site-source"><a href={REPOSITORY} aria-label={t("nav.source")}><GitHubMark /></a></Button></HoverTip>
          <LanguageMenu rootPage={rootPage} />
          <ThemeMenu />
          <Button asChild size="sm" className="site-download site-header-download"><a href={LATEST_RELEASE_URL} aria-label={t("nav.download")} data-download-source="header" onClick={openDownload}><span className="site-nav-download-label">{t("nav.download")}</span><ArrowDownToLineIcon /></a></Button>
        </nav>
      </div>
    </header>

    <main id="main">
      <section className="site-hero" aria-labelledby="hero-title">
        <div className="site-hero-atmosphere" ref={atmosphereRef} data-playing={atmospherePlaying} aria-hidden="true"><svg viewBox="0 0 1440 500" preserveAspectRatio="xMidYMid slice" fill="none"><defs><linearGradient id={`${atmosphere}-plane`} x1="640" y1="60" x2="1240" y2="460" gradientUnits="userSpaceOnUse"><stop stopColor="var(--hero-fold-light)" /><stop offset=".6" stopColor="var(--hero-fold-dark)" /><stop offset="1" stopColor="var(--background)" stopOpacity="0" /></linearGradient><linearGradient id={`${atmosphere}-edge`} x1="670" y1="0" x2="1240" y2="460" gradientUnits="userSpaceOnUse"><stop stopColor="var(--foreground)" stopOpacity="0" /><stop offset=".5" stopColor="var(--foreground)" stopOpacity=".12" /><stop offset="1" stopColor="var(--foreground)" stopOpacity="0" /></linearGradient></defs><path d="M624 0 1430 0 1012 464 452 464Z" fill={`url(#${atmosphere}-plane)`} /><path d="M954 0 1012 464 1430 0Z" className="hero-fold-face" /><path d="m954 0 58 464L624 0M452 464 954 0" stroke={`url(#${atmosphere}-edge)`} /><g className="hero-light-sweep"><path d="M850 -40 720 500" stroke={`url(#${atmosphere}-edge)`} strokeWidth="100" /></g></svg></div>
        <div className="site-wrap site-hero-layout">
          <div className="site-hero-heading">
            <div className="site-statement">
              <div className="site-wordmark"><h1 id="hero-title" translate="no">RebaseRaven</h1></div>
              <p className="site-description">{t("concept.category")}</p>
            </div>
            <div className="site-download-group">
              <div className="site-actions">
                <Button asChild size="lg"><a href={LATEST_RELEASE_URL} data-download-source="hero" onClick={openDownload}><ArrowDownToLineIcon />{t("nav.download")}</a></Button>
                <Button asChild variant="outline" size="lg"><a href={REPOSITORY}><GitHubMark />GitHub<ArrowUpRightIcon aria-hidden="true" /></a></Button>
              </div>
            </div>
          </div>
          <div id="features" className="site-canvas" role="region" data-nosnippet="" aria-label={t("preview.title")} onPointerDownCapture={startDemo} onKeyDownCapture={startDemo}>
            <noscript className="site-preview-caption">{t("preview.noscript")}</noscript>
            <WorkspacePreview />
          </div>
        </div>
      </section>

      <FeatureStories />

      <div className="site-wrap">
        <footer className="site-footer">
          <nav aria-label={t("nav.footer")}>
            <a href={`${REPOSITORY}/issues`}>{t("nav.feedback")}</a>
            <a href={`${REPOSITORY}/blob/dev/CONTRIBUTING.md`}>{t("nav.contribute")}</a>
            <a href={`${REPOSITORY}/blob/dev/LICENSE`}>{t("nav.license")}</a>
            {otherLocales.map(locale => <a key={locale} href={localeHref(locale, rootPage)} hrefLang={locale} lang={locale}>{t(`language.${locale}`, { lng: locale })}</a>)}
          </nav>
        </footer>
      </div>
    </main>
    <DownloadDialog open={downloadOpen} onOpenChange={setDownloadOpen} returnFocusTo={downloadTrigger} onReleaseOpen={() => {
      const source = downloadTrigger.current?.dataset.downloadSource;
      if (source === "header" || source === "hero") trackReleasePageOpen(source);
    }} />
  </div>;
}

function LanguageMenu({ rootPage }: { rootPage: boolean }) {
  const { t, i18n } = useTranslation();
  const links = SITE_LOCALES.map((locale: SiteLocale) => ({
    locale,
    href: localeHref(locale, rootPage),
    label: t(`language.${locale}`),
    current: i18n.language === locale ? "page" as const : undefined,
  }));
  return (
    <>
      <DropdownMenu>
        <HoverTip label={t("language.label")}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="site-language-trigger" aria-label={t("language.label")}>
              <LanguagesIcon />
            </Button>
          </DropdownMenuTrigger>
        </HoverTip>
        <DropdownMenuContent align="end">
          {links.map(({ locale, href, label, current }) => (
            <DropdownMenuItem key={locale} asChild>
              <a href={href} hrefLang={locale} aria-current={current}>{label}</a>
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onSelect={() => {
            const target = new URL(localeHref(browserLocale(navigator.languages), rootPage), window.location.href);
            target.search = window.location.search;
            target.hash = window.location.hash;
            window.location.assign(target.href);
          }}>
            {t("language.automatic")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <noscript>
        <style>{".site-language-trigger { display: none; }"}</style>
        <details className="relative">
          <Button asChild variant="ghost" size="icon-sm">
            <summary aria-label={t("language.label")} className="list-none [&::-webkit-details-marker]:hidden"><LanguagesIcon /></summary>
          </Button>
          <div className="absolute right-0 z-50 grid min-w-max gap-1 rounded-md border bg-popover p-1 text-sm text-popover-foreground">
            {links.map(({ locale, href, label, current }) => (
              <a key={locale} href={href} hrefLang={locale} aria-current={current} className="rounded-sm px-2 py-1 hover:bg-accent">{label}</a>
            ))}
          </div>
        </details>
      </noscript>
    </>
  );
}

function ThemeMenu() {
  const { theme, setTheme } = useSiteTheme();
  const { status, setPaused } = useSiteMotion();
  const { t } = useTranslation();
  return <DropdownMenu><HoverTip label={t("theme.label")}><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={t("theme.label")}><SunIcon className="hidden dark:block" /><MoonIcon className="dark:hidden" /></Button></DropdownMenuTrigger></HoverTip><DropdownMenuContent align="end" className="w-36"><DropdownMenuRadioGroup value={theme} onValueChange={(value) => { if (value === "light" || value === "dark" || value === "system") setTheme(value); }}>{([{ value: "light", icon: SunIcon }, { value: "dark", icon: MoonIcon }, { value: "system", icon: MonitorIcon }] as const).map(({ value, icon: Icon }) => <DropdownMenuRadioItem key={value} value={value}><Icon /><span>{t(`theme.${value}`)}</span></DropdownMenuRadioItem>)}</DropdownMenuRadioGroup><DropdownMenuSeparator /><DropdownMenuCheckboxItem checked={status === "auto"} disabled={status === "reduced"} onCheckedChange={checked => setPaused(checked !== true)}>{t("motion.enabled")}</DropdownMenuCheckboxItem></DropdownMenuContent></DropdownMenu>;
}

function DownloadDialog({ open, onOpenChange, returnFocusTo, onReleaseOpen }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusTo: RefObject<HTMLAnchorElement | null>;
  onReleaseOpen: () => void;
}) {
  const { t } = useTranslation();
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="site-download-dialog sm:max-w-sm" onCloseAutoFocus={event => { event.preventDefault(); returnFocusTo.current?.focus(); }}>
      <DialogHeader>
        <DialogTitle>{t("download.dialog.title")}</DialogTitle>
        <DialogDescription className="sr-only">{t("download.dialog.body")}</DialogDescription>
      </DialogHeader>
      <ul className="site-download-platforms" aria-label={t("download.supported")}>
        <li><span role="img" aria-label="macOS Apple Silicon" title="macOS Apple Silicon"><PlatformMark platform="macos" width="36" height="36" /></span></li>
        <li><span role="img" aria-label="Windows x64" title="Windows x64"><PlatformMark platform="windows" width="32" height="32" /></span></li>
      </ul>
      <Button variant="outline" asChild className="site-release-link">
        <a href={LATEST_RELEASE_URL} onClick={onReleaseOpen}><GitHubMark className="size-5" /><span>GitHub Releases</span><ArrowUpRightIcon /></a>
      </Button>
    </DialogContent>
  </Dialog>;
}
