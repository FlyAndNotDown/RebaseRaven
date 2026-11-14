import { useRef, useState, type MouseEvent, type RefObject } from "react";
import { ArrowDownToLineIcon, ArrowUpRightIcon, ChevronRightIcon, LanguagesIcon, LaptopIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { browserLocale, localeHref, SITE_LOCALES, type SiteLocale } from "./i18n";
import { useSiteTheme } from "./theme";
import { BrandMark } from "@/components/brand-mark";
import { GitHubMark } from "@/components/github-mark";
import { VcsIcon } from "@/components/vcs-icon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { HoverTip } from "@/components/ui/tooltip";
import { WorkspacePreview } from "./workspace-preview";
import { LATEST_RELEASE_URL, readBundledReleaseDownloads, REPOSITORY_URL } from "./release-downloads";
import { trackDemoStart, trackDownloadDialog, trackInstallerDownload } from "./website-analytics";

const REPOSITORY = REPOSITORY_URL;
const downloads = readBundledReleaseDownloads(import.meta.env.VITE_RELEASE_DOWNLOADS);

export function Site({ rootPage = false }: { rootPage?: boolean }) {
  const { t } = useTranslation();
  const [downloadOpen, setDownloadOpen] = useState(false);
  const downloadTrigger = useRef<HTMLAnchorElement | null>(null);
  const demoStarted = useRef(false);
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
    if (source === "header" || source === "hero" || source === "footer") trackDownloadDialog(source);
    setDownloadOpen(true);
  }

  return <div className="site-page">
    <a className="site-skip" href="#main">{t("nav.skip")}</a>
    <header className="site-header">
      <div className="site-wrap site-header-inner">
        <a className="site-brand" href={rootPage ? "./" : "../"} aria-label={t("nav.home")}><BrandMark src={mark} className="site-brand-mark" /><span translate="no">RebaseRaven</span></a>
        <nav className="site-navigation" aria-label={t("nav.main")}>
          <a className="site-nav-link" href="#features">{t("concept.preview")}</a>
          <a className="site-nav-link" href="#workflows">{t("concept.features")}</a>
          <HoverTip label={t("nav.source")}><Button variant="ghost" size="icon-sm" asChild className="site-source"><a href={REPOSITORY} aria-label={t("nav.source")}><GitHubMark /></a></Button></HoverTip>
          <LanguageMenu rootPage={rootPage} />
          <ThemeMenu />
          <Button asChild size="sm" className="site-download site-header-download"><a href={LATEST_RELEASE_URL} aria-label={t("nav.download")} data-download-source="header" onClick={openDownload}><span className="site-nav-download-label">{t("nav.download")}</span><ArrowDownToLineIcon /></a></Button>
        </nav>
      </div>
    </header>

    <main id="main">
      <section className="site-hero" aria-labelledby="hero-title">
        <div className="site-wrap site-hero-layout">
          <div className="site-hero-heading">
            <div className="site-statement">
              <div className="site-wordmark"><BrandMark className="site-emblem" src={mark} /><h1 id="hero-title" translate="no">RebaseRaven</h1></div>
              <p className="site-description">{t("concept.category")}</p>
            </div>
            <div className="site-download-group">
              <div className="site-actions">
                <Button asChild size="lg"><a href={LATEST_RELEASE_URL} data-download-source="hero" onClick={openDownload}><ArrowDownToLineIcon />{t("nav.download")}</a></Button>
                <Button asChild variant="outline" size="lg"><a href={REPOSITORY}><GitHubMark />GitHub<ArrowUpRightIcon aria-hidden="true" /></a></Button>
              </div>
              <p className="site-platforms">{t("hero.platforms")}</p>
            </div>
          </div>
          <div id="features" className="site-canvas" role="region" aria-label={t("preview.title")} onPointerDownCapture={startDemo} onKeyDownCapture={startDemo}>
            <div className="site-preview-label"><span>{t("demo.interactive")}</span><span>{t("demo.sampleData")}</span></div>
            <noscript className="site-preview-caption">{t("preview.noscript")}</noscript>
            <WorkspacePreview />
          </div>
        </div>
      </section>

      <section id="workflows" className="site-wrap site-workflows" aria-label={t("concept.features")}>
        {(["git", "p4"] as const).map((kind) => <div className="site-feature-row" key={kind}>
          <h2><VcsIcon vcs={kind === "git" ? "git" : "perforce"} />{kind === "git" ? "Git" : "Perforce"}</h2>
          <ul>{[1, 2, 3].map((item) => <li key={item}>{t(`concept.${kind}.${item}`)}</li>)}</ul>
        </div>)}
      </section>

      <div className="site-wrap">
        <details className="site-details">
          <summary>{t("concept.details")}<ChevronRightIcon aria-hidden="true" /></summary>
          <div className="site-faq">{["what", "systems", "tools", "gitServers", "bridge", "license", "accounts", "demo", "rust"].map((key) => <details key={key}><summary>{t(`faq.${key}.question`)}<ChevronRightIcon aria-hidden="true" /></summary><p>{t(`faq.${key}.answer`)}</p></details>)}</div>
        </details>
        <section id="start" className="site-bottom" aria-label={t("download.dialog.title")}>
          <div><BrandMark src={mark} className="site-bottom-mark" /><p>{t("concept.opensource")}</p></div>
          <Button asChild size="lg" className="site-download"><a href={LATEST_RELEASE_URL} data-download-source="footer" onClick={openDownload}>{t("hero.download")}<ArrowDownToLineIcon /></a></Button>
        </section>
        <footer className="site-footer"><span translate="no">RebaseRaven</span><nav aria-label={t("nav.footer")}><a href={`${REPOSITORY}/issues`}>{t("nav.feedback")}</a><a href={`${REPOSITORY}/blob/dev/CONTRIBUTING.md`}>{t("nav.contribute")}</a><a href={`${REPOSITORY}/blob/dev/LICENSE`}>{t("nav.license")}</a></nav></footer>
      </div>
    </main>
    <DownloadDialog open={downloadOpen} onOpenChange={setDownloadOpen} returnFocusTo={downloadTrigger} />
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
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => {
            const target = new URL(localeHref(browserLocale(navigator.languages), rootPage), window.location.href);
            target.search = window.location.search;
            target.hash = window.location.hash;
            window.location.assign(target.href);
          }}>
            <LanguagesIcon />{t("language.automatic")}
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
  const { t } = useTranslation();
  return <DropdownMenu><HoverTip label={t("theme.label")}><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={t("theme.label")}><SunIcon className="hidden dark:block" /><MoonIcon className="dark:hidden" /></Button></DropdownMenuTrigger></HoverTip><DropdownMenuContent align="end" className="w-36"><DropdownMenuRadioGroup value={theme} onValueChange={(value) => { if (value === "light" || value === "dark" || value === "system") setTheme(value); }}>{([{ value: "light", icon: SunIcon }, { value: "dark", icon: MoonIcon }, { value: "system", icon: MonitorIcon }] as const).map(({ value, icon: Icon }) => <DropdownMenuRadioItem key={value} value={value}><Icon /><span>{t(`theme.${value}`)}</span></DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>;
}

function DownloadDialog({ open, onOpenChange, returnFocusTo }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusTo: RefObject<HTMLAnchorElement | null>;
}) {
  const { t } = useTranslation();
  const platforms = [
    { platform: "macos" as const, label: "macOS", detail: "Apple Silicon", format: "DMG", icon: LaptopIcon, url: downloads?.macos },
    { platform: "windows" as const, label: "Windows", detail: "x64", format: t("download.installer"), icon: MonitorIcon, url: downloads?.windows },
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="site-download-dialog max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain sm:max-w-md"
        onCloseAutoFocus={(event) => { event.preventDefault(); returnFocusTo.current?.focus(); }}
      >
        <DialogHeader>
          <DialogTitle>{t("download.dialog.title")}</DialogTitle>
          <DialogDescription>{t("download.dialog.body")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1">
          {platforms.map(({ platform, label, detail, format, icon: Icon, url }) => (
            <Button key={label} variant="ghost" asChild className="h-auto justify-start gap-3 px-2 py-3">
              <a href={url ?? LATEST_RELEASE_URL} onClick={() => { if (url && downloads) trackInstallerDownload(platform, url, downloads.tag); }}>
                <Icon className="size-5 text-muted-foreground" />
                <span className="grid min-w-0 flex-1 gap-1 text-left">
                  <span>{label}<span className="ml-1 text-xs text-muted-foreground">{detail}</span></span>
                  <span className="text-xs font-normal text-muted-foreground">{url ? format : t("download.viewLatest")}</span>
                </span>
                {url ? <ArrowDownToLineIcon className="text-muted-foreground" /> : <ChevronRightIcon className="text-muted-foreground" />}
              </a>
            </Button>
          ))}
        </div>
        {downloads ? <p className="text-xs text-muted-foreground">{t("download.version", { version: downloads.tag })}</p> : null}
        <DialogFooter className="items-center sm:justify-between">
          <Button variant="ghost" size="sm" asChild><a href={`${REPOSITORY}/blob/dev/docs/development.md`}>{t("download.build")}</a></Button>
          <Button size="sm" asChild><a href={LATEST_RELEASE_URL}>{t("download.latest")}<ArrowUpRightIcon /></a></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
