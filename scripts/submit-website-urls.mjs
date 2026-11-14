import { pathToFileURL } from "node:url";
import { sitemapSubmission } from "./submit-sitemap.mjs";

class UrlSubmissionError extends Error {}

async function boundedText(response, label) {
  const reader = response.body?.getReader();
  if (!reader) throw new UrlSubmissionError(`${label} returned an empty response.`);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256 * 1024) throw new UrlSubmissionError(`${label} exceeds the response limit.`);
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString("utf8");
}

function xmlText(value) {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-f]+;)/i.test(value)) throw new UrlSubmissionError("Invalid sitemap entity.");
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
    if (named[entity]) return named[entity];
    const code = entity.toLowerCase().startsWith("&#x") ? Number.parseInt(entity.slice(3), 16) : Number.parseInt(entity.slice(2), 10);
    if (!Number.isSafeInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new UrlSubmissionError("Invalid sitemap character reference.");
    return String.fromCodePoint(code);
  });
}

export async function publishedWebsiteUrls({ siteUrl, fetcher = fetch }) {
  const { site, sitemap } = sitemapSubmission(siteUrl);
  const response = await fetcher(sitemap, { redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (response.status !== 200) throw new UrlSubmissionError(`Published sitemap returned HTTP ${response.status}.`);
  const xml = await boundedText(response, "Published sitemap");
  if (!/<urlset(?:\s[^>]*)?>/.test(xml) || !/<\/urlset>\s*$/.test(xml) || /<!DOCTYPE|<!ENTITY|<sitemapindex\b/i.test(xml)) {
    throw new UrlSubmissionError("The published sitemap must be a URL set without external entities.");
  }
  const locations = [...xml.matchAll(/<loc>\s*([^<]*?)\s*<\/loc>/g)].map((match) => xmlText(match[1]));
  if (!locations.length || locations.length > 10_000 || locations.length !== (xml.match(/<loc\b/g) ?? []).length || locations.some((location) => !location)) {
    throw new UrlSubmissionError("The published sitemap has invalid URL locations.");
  }
  const urls = [...new Set(locations.map((location) => {
    let url;
    try { url = new URL(location); } catch { throw new UrlSubmissionError("The published sitemap contains an invalid URL."); }
    if (!url.href.startsWith(site) || url.username || url.password || url.hash || url.search || /[\s\p{Cc}]/u.test(location)) {
      throw new UrlSubmissionError("Sitemap URLs must stay within the deployed website without credentials, queries, or fragments.");
    }
    return url.href;
  }))];
  if (!urls.includes(site)) throw new UrlSubmissionError("The published sitemap must contain the deployed homepage.");
  return { site, sitemap, urls };
}

function verifiedSite(siteUrl, bingSiteUrl) {
  const site = new URL(sitemapSubmission(siteUrl).site);
  const verified = new URL(sitemapSubmission(bingSiteUrl).site);
  const hostMatches = site.hostname === verified.hostname || site.hostname.endsWith(`.${verified.hostname}`);
  if (!hostMatches || site.port !== verified.port || !site.pathname.startsWith(verified.pathname)) {
    throw new UrlSubmissionError("The deployed website is outside the selected Bing site.");
  }
  return verified.href;
}

async function bingRequest(method, { apiKey, site, urls, fetcher }) {
  const endpoint = new URL(`https://ssl.bing.com/webmaster/api.svc/json/${method}`);
  endpoint.searchParams.set("apikey", apiKey);
  if (!urls) endpoint.searchParams.set("siteUrl", site);
  let response;
  try {
    response = await fetcher(endpoint.href, {
      method: urls ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(20_000),
      ...(urls ? { headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ siteUrl: site, urlList: urls }) } : {}),
    });
  } catch { throw new UrlSubmissionError(`Bing ${method} could not be reached.`); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new UrlSubmissionError(`Bing ${method} returned HTTP ${response.status}.`);
  }
  let result;
  try { result = JSON.parse(await boundedText(response, "Bing")); }
  catch { throw new UrlSubmissionError(`Bing ${method} returned an invalid response.`); }
  if (!Object.hasOwn(result ?? {}, "d") || result.ErrorCode !== undefined || result.error !== undefined) {
    throw new UrlSubmissionError(`Bing ${method} rejected the request.`);
  }
  return result.d;
}

export async function submitWebsiteUrls({ siteUrl, bingSiteUrl, apiKey, dryRun = false, fetcher = fetch }) {
  const site = verifiedSite(siteUrl, bingSiteUrl);
  if (!dryRun && (typeof apiKey !== "string" || !/^[a-zA-Z0-9_-]{20,256}$/.test(apiKey))) {
    throw new UrlSubmissionError("A Bing Webmaster API key is required.");
  }
  const published = await publishedWebsiteUrls({ siteUrl, fetcher });
  if (dryRun) return { ...published, submitted: 0, dryRun: true };
  const quota = await bingRequest("GetUrlSubmissionQuota", { apiKey, site, fetcher });
  if (![quota?.DailyQuota, quota?.MonthlyQuota].every((value) => Number.isSafeInteger(value) && value >= published.urls.length)) {
    throw new UrlSubmissionError("Bing has insufficient or invalid URL submission quota; no URLs were submitted.");
  }
  for (let offset = 0; offset < published.urls.length; offset += 500) {
    const result = await bingRequest("SubmitUrlBatch", { apiKey, site, urls: published.urls.slice(offset, offset + 500), fetcher });
    if (result !== null) throw new UrlSubmissionError("Bing returned an unexpected URL submission result.");
  }
  return { ...published, submitted: published.urls.length, dryRun: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.env.DRY_RUN && !["true", "false"].includes(process.env.DRY_RUN)) throw new UrlSubmissionError("DRY_RUN must be true or false.");
    const result = await submitWebsiteUrls({ siteUrl: process.env.SITE_URL, bingSiteUrl: process.env.BING_WEBMASTER_SITE_URL, apiKey: process.env.BING_WEBMASTER_API_KEY, dryRun: process.env.DRY_RUN === "true" });
    console.log(result.dryRun ? `Validated ${result.urls.length} sitemap URLs; no submission was sent.` : `Submitted ${result.submitted} website URLs to Bing. Acceptance does not guarantee indexing.`);
  } catch (error) {
    console.error(error instanceof UrlSubmissionError ? error.message : "URL submission failed. Check the published sitemap and Bing configuration.");
    process.exitCode = 1;
  }
}
