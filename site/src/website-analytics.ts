import { createGoogleTag } from "./google-tag";
import { SITE_URL } from "./product";
import { LATEST_RELEASE_URL } from "./release-downloads";

export type DownloadEntryPoint = "header" | "hero";

export function websiteAnalyticsLocale(location: Pick<Location, "origin" | "pathname">) {
  if (location.origin !== new URL(SITE_URL).origin) return null;
  if (location.pathname === "/" || location.pathname === "/index.html") return "en";
  return /^\/zh-CN\/(?:index\.html)?$/.test(location.pathname) ? "zh-CN" : null;
}

export function createWebsiteAnalytics(host: Window, measurementId: string | undefined) {
  const locale = websiteAnalyticsLocale(host.location);
  // Count only canonical product pages. Redirects, previews and the desktop bridge
  // must never create website visits or share the app's installation identity.
  if (!locale || host.parent !== host) return null;
  let tag;
  try {
    tag = createGoogleTag(host, measurementId, {
      send_page_view: true,
      content_group: "Website",
      site_language: locale,
      cookie_prefix: "rebaseraven_website",
      cookie_domain: "none",
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
    });
  } catch {
    return null;
  }
  void tag.ready.catch(() => tag.disable());
  return {
    downloadDialog(entryPoint: DownloadEntryPoint) {
      tag.send("download_dialog_open", { entry_point: entryPoint, site_language: locale });
    },
    releasePage(entryPoint: DownloadEntryPoint) {
      tag.send("release_page_open", { entry_point: entryPoint, link_url: LATEST_RELEASE_URL, site_language: locale });
    },
    demoStart() {
      tag.send("demo_start", { site_language: locale });
    },
  };
}

let websiteAnalytics: ReturnType<typeof createWebsiteAnalytics> = null;

export function initializeWebsiteAnalytics(host: Window, measurementId: string | undefined) {
  websiteAnalytics ??= createWebsiteAnalytics(host, measurementId);
}

export const trackDownloadDialog = (entryPoint: DownloadEntryPoint) => websiteAnalytics?.downloadDialog(entryPoint);
export const trackReleasePageOpen = (entryPoint: DownloadEntryPoint) => websiteAnalytics?.releasePage(entryPoint);
export const trackDemoStart = () => websiteAnalytics?.demoStart();
