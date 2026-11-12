import { createRoot, hydrateRoot } from "react-dom/client";
import { IDENTIFIER_PREFIX, SiteRoot } from "./app-root";
import { localeFromPath, localeHref } from "./i18n";
import { initializeWebsiteAnalytics } from "./website-analytics";
import "./styles.css";

const root = document.getElementById("root")!;
const pathLocale = localeFromPath(window.location.pathname);
const locale = pathLocale ?? "en";
const rootPage = pathLocale === null;
if (pathLocale === "en") {
  const target = new URL(localeHref("en", false), window.location.href);
  target.search = window.location.search;
  target.hash = window.location.hash;
  window.location.replace(target.href);
} else {
  document.documentElement.lang = locale;
  initializeWebsiteAnalytics(window, import.meta.env.VITE_GA_WEBSITE_MEASUREMENT_ID);
  if (root.dataset.prerendered === "true") {
    hydrateRoot(root, <SiteRoot locale={locale} rootPage={rootPage} />, { identifierPrefix: IDENTIFIER_PREFIX });
  } else {
    createRoot(root, { identifierPrefix: IDENTIFIER_PREFIX }).render(<SiteRoot locale={locale} rootPage={rootPage} />);
  }
}
