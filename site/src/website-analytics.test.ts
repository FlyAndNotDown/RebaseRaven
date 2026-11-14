import { describe, expect, it, vi } from "vitest";
import { createGoogleTag } from "./google-tag";
import { createWebsiteAnalytics, websiteAnalyticsLocale } from "./website-analytics";
import { LATEST_RELEASE_URL } from "./release-downloads";

const ORIGIN = "https://rebaseraven.flyandnotdown.com";

function fixture(pathname = "/", origin = ORIGIN) {
  const script = { onload: null as (() => void) | null, onerror: null as (() => void) | null, src: "", remove: vi.fn() };
  const host = {
    location: { origin, pathname },
    document: { createElement: vi.fn(() => script), head: { appendChild: vi.fn() } },
    setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(), parent: null as unknown,
  };
  host.parent = host;
  return { host: host as unknown as Window, script, globals: host as unknown as Record<string, unknown> };
}

describe("website analytics isolation", () => {
  it("counts canonical pages while excluding redirects, the desktop bridge and preview origins", () => {
    for (const [path, locale] of [["/", "en"], ["/index.html", "en"], ["/zh-CN/", "zh-CN"], ["/zh-CN/index.html", "zh-CN"]]) {
      expect(websiteAnalyticsLocale({ origin: ORIGIN, pathname: path })).toBe(locale);
    }
    for (const path of ["/en/", "/en/index.html", "/analytics/", "/analytics/en/", "/en/private", "/unsupported/"]) {
      const { host } = fixture(path);
      expect(createWebsiteAnalytics(host, "G-WEBSITE42")).toBeNull();
      expect(host.document.createElement).not.toHaveBeenCalled();
    }
    const { host } = fixture("/", "https://example.com");
    expect(createWebsiteAnalytics(host, "G-WEBSITE42")).toBeNull();
    expect(host.document.createElement).not.toHaveBeenCalled();
  });

  it("uses an independent web identity and leaves page views, referrers and acquisition to the web tag", () => {
    const { host, script, globals } = fixture("/zh-CN/");
    const analytics = createWebsiteAnalytics(host, "G-WEBSITE42");
    script.onload?.();
    expect(analytics).not.toBeNull();
    const commands = (globals.dataLayer as IArguments[]).map((args) => Array.from(args));
    expect(commands[2]).toEqual(["config", "G-WEBSITE42", {
      send_page_view: true, content_group: "Website", site_language: "zh-CN",
      cookie_prefix: "rebaseraven_website", cookie_domain: "none",
      allow_google_signals: false, allow_ad_personalization_signals: false,
    }]);
    for (const name of ["client_id", "session_id", "app_name", "app_version", "page_referrer", "ignore_referrer"]) {
      expect(commands[2][2]).not.toHaveProperty(name);
    }
    expect(script.src).toBe("https://www.googletagmanager.com/gtag/js?id=G-WEBSITE42");
  });

  it("routes download intent, release page visits and demo usage exclusively to the website property", () => {
    const { host, script, globals } = fixture();
    const analytics = createWebsiteAnalytics(host, "G-WEBSITE42")!;
    script.onload?.();
    analytics.downloadDialog("hero");
    analytics.releasePage("hero");
    analytics.demoStart();
    const commands = (globals.dataLayer as IArguments[]).slice(3).map((args) => Array.from(args));
    expect(commands.map((command) => command[1])).toEqual(["download_dialog_open", "release_page_open", "demo_start"]);
    expect(commands[0][2]).toMatchObject({ entry_point: "hero", site_language: "en" });
    expect(commands[1][2]).toEqual({
      entry_point: "hero", link_url: LATEST_RELEASE_URL, site_language: "en", send_to: "G-WEBSITE42",
    });
    expect(commands.every((command) => (command[2] as Record<string, unknown>).send_to === "G-WEBSITE42")).toBe(true);
  });

  it("does not initialize inside another page, with missing configuration or after a blocked tag", async () => {
    const embedded = fixture();
    Object.assign(embedded.host, { parent: {} });
    expect(createWebsiteAnalytics(embedded.host, "G-WEBSITE42")).toBeNull();
    expect(embedded.host.document.createElement).not.toHaveBeenCalled();
    const { host, script, globals } = fixture();
    expect(createWebsiteAnalytics(host, undefined)).toBeNull();
    const analytics = createWebsiteAnalytics(host, "G-WEBSITE42")!;
    script.onerror?.();
    await Promise.resolve();
    analytics.demoStart();
    expect(globals["ga-disable-G-WEBSITE42"]).toBe(true);
    expect(globals.dataLayer).toEqual([]);
    expect(script.remove).toHaveBeenCalledOnce();
  });
});

describe("tag routing boundaries", () => {
  it("cannot override the configured property using event parameters", async () => {
    const { host, script, globals } = fixture();
    const tag = createGoogleTag(host, "G-WEBSITE42", { send_page_view: true });
    script.onload?.();
    await tag.ready;
    tag.send("demo_start", { send_to: "G-OTHER123" });
    const command = Array.from((globals.dataLayer as IArguments[])[3]);
    expect(command[2]).toEqual({ send_to: "G-WEBSITE42" });
    tag.disable();
  });
});
