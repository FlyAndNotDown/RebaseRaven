import { ANALYTICS_BRIDGE_URL, type AnalyticsEvent, type AnalyticsInit, type AnalyticsPane } from "../../src/lib/analytics-protocol";
import type { AnalyticsTag } from "./analytics-bridge";
import { createGoogleTag } from "./google-tag";

export const DESKTOP_ANALYTICS_NAME = "RebaseRavenApp";
const SCREEN_NAMES = {
  welcome: "Welcome",
  git_changes: "Git changes",
  git_history: "Git history",
  git_stash: "Git stashes",
  git_files: "Git files",
  p4_pending: "Perforce pending changes",
  p4_files: "Perforce workspace files",
  p4_history: "Perforce history",
  p4_depot: "Perforce depot",
  p4_shelves: "Perforce shelves",
} satisfies Record<AnalyticsPane, string>;

export function analyticsConfiguration(init: AnalyticsInit) {
  return {
    client_id: init.clientId,
    session_id: init.sessionId,
    send_page_view: false,
    app_name: DESKTOP_ANALYTICS_NAME,
    app_version: init.appVersion,
    app_platform: init.platform,
    content_group: "Desktop application",
    page_title: DESKTOP_ANALYTICS_NAME,
    page_location: ANALYTICS_BRIDGE_URL,
    page_referrer: "",
    ignore_referrer: true,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    cookie_flags: "SameSite=None;Secure",
    cookie_prefix: "rebaseraven_app",
    cookie_domain: "none",
    cookie_path: new URL(ANALYTICS_BRIDGE_URL).pathname,
    // Keep first-visit and session metadata across native application restarts.
    cookie_expires: 63_072_000,
    cookie_update: true,
  } as const;
}

export function analyticsEventParameters(init: AnalyticsInit, event: AnalyticsEvent, measurementId: string, currentPane: AnalyticsPane | null = null) {
  const pane = event.event === "pane_view" ? event.pane : currentPane;
  return {
    send_to: measurementId,
    client_id: init.clientId,
    session_id: init.sessionId,
    app_name: DESKTOP_ANALYTICS_NAME,
    app_version: init.appVersion,
    app_platform: init.platform,
    screen_schema: init.screenSchema === 2 ? "2" : "legacy",
    content_group: "Desktop application",
    ...(pane === null ? {} : {
      screen_name: SCREEN_NAMES[pane],
      screen_class: pane,
      pane,
      version_control: pane.startsWith("git_") ? "git" : pane.startsWith("p4_") ? "perforce" : "none",
    }),
    // GA4 uses the web title in its combined Pages and screens report.
    page_title: pane === null ? DESKTOP_ANALYTICS_NAME : SCREEN_NAMES[pane],
    page_location: ANALYTICS_BRIDGE_URL,
    page_referrer: "",
    ...(event.event === "app_engagement" ? {
      engagement_time_msec: event.engagementTimeMsec,
      foreground_time_sec: event.engagementTimeMsec / 1_000,
    } : {}),
  };
}

export function createGoogleAnalyticsTag(host: Window, measurementId: string | undefined, init: AnalyticsInit): AnalyticsTag {
  const tag = createGoogleTag(host, measurementId, analyticsConfiguration(init));
  let pane: AnalyticsPane | null = null;
  let screenSchema = init.screenSchema;
  return {
    ready: tag.ready,
    setScreenSchema(schema) { screenSchema = schema; },
    send(event) {
      if (event.event === "pane_view") pane = event.pane;
      tag.send(event.event === "pane_view" ? "screen_view" : event.event, analyticsEventParameters({ ...init, screenSchema }, event, measurementId!, pane));
    },
    disable: tag.disable,
  };
}
