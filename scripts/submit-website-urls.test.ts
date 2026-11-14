import { describe, expect, it, vi } from "vitest";
import { publishedWebsiteUrls, submitWebsiteUrls } from "./submit-website-urls.mjs";

const siteUrl = "https://client.example.com/";
const bingSiteUrl = "https://example.com/";
const apiKey = "test-bing-api-key-not-a-real-secret";
const sitemap = (urls = [siteUrl, `${siteUrl}zh-CN/`]) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((url) => `<url><loc>${url}</loc></url>`).join("")}</urlset>`;
const quota = (count = 10_000) => new Response(JSON.stringify({ d: { DailyQuota: count, MonthlyQuota: count } }));
const accepted = () => new Response('{"d":null}');

describe("published website URL submission", () => {
  it("validates the live sitemap, checks quota, then submits only product URLs under the verified parent site", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(sitemap())).mockResolvedValueOnce(quota()).mockResolvedValueOnce(accepted());
    const result = await submitWebsiteUrls({ siteUrl, bingSiteUrl, apiKey, fetcher });
    expect(result.submitted).toBe(2);
    expect(fetcher.mock.calls[0][0]).toBe(`${siteUrl}sitemap.xml`);
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty("headers");
    const quotaUrl = new URL(fetcher.mock.calls[1][0]);
    expect(quotaUrl.origin).toBe("https://ssl.bing.com");
    expect(quotaUrl.pathname).toMatch(/\/GetUrlSubmissionQuota$/);
    expect(quotaUrl.searchParams.get("siteUrl")).toBe(bingSiteUrl);
    expect(quotaUrl.searchParams.get("apikey")).toBe(apiKey);
    expect(fetcher.mock.calls[2][1]).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({ siteUrl: bingSiteUrl, urlList: [siteUrl, `${siteUrl}zh-CN/`] });
  });

  it("supports a dry run without credentials or any request to Bing", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(sitemap()));
    const result = await submitWebsiteUrls({ siteUrl, bingSiteUrl, dryRun: true, fetcher });
    expect(result).toMatchObject({ urls: [siteUrl, `${siteUrl}zh-CN/`], submitted: 0, dryRun: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("deduplicates sitemap URLs before checking quota and respects the 500 URL batch limit", async () => {
    const urls = [siteUrl, ...Array.from({ length: 500 }, (_, index) => `${siteUrl}page-${index}/`)];
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(sitemap([...urls, siteUrl]))).mockResolvedValueOnce(quota(501)).mockResolvedValueOnce(accepted()).mockResolvedValueOnce(accepted());
    expect((await submitWebsiteUrls({ siteUrl, bingSiteUrl, apiKey, fetcher })).submitted).toBe(501);
    expect(JSON.parse(fetcher.mock.calls[2][1].body).urlList).toHaveLength(500);
    expect(JSON.parse(fetcher.mock.calls[3][1].body).urlList).toHaveLength(1);
  });

  it.each([0, 1, -1, "100", null])("does not submit when quota is insufficient or malformed (%s)", async (count) => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(sitemap())).mockResolvedValueOnce(new Response(JSON.stringify({ d: { DailyQuota: count, MonthlyQuota: 100 } })));
    await expect(submitWebsiteUrls({ siteUrl, bingSiteUrl, apiKey, fetcher })).rejects.toThrow("quota");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    sitemap([siteUrl, "https://blog.example.com/"]),
    sitemap([siteUrl, "https://client.example.com.attacker.invalid/"]),
    sitemap([siteUrl, `${siteUrl}?token=private`]),
    sitemap([siteUrl, `${siteUrl}#section`]),
    sitemap([siteUrl, "https://alice:password@client.example.com/"]),
    sitemap([`${siteUrl}zh-CN/`]),
    sitemap([siteUrl, `${siteUrl}&unknown;`]),
    '<sitemapindex><sitemap><loc>https://example.com/other.xml</loc></sitemap></sitemapindex>',
    `<!DOCTYPE urlset [<!ENTITY a SYSTEM "file:///private">]>${sitemap()}`,
    sitemap().replace("</loc>", ""),
    "x".repeat(256 * 1024 + 1),
  ])("refuses invalid or out-of-scope sitemap content before contacting Bing", async (xml) => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(xml));
    await expect(submitWebsiteUrls({ siteUrl, bingSiteUrl, apiKey, fetcher })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["https://elsewhere.example/", "https://example.com/another-project/", "https://example.com:8443/"])("rejects an unrelated verified site before accessing the network", async (selectedSite) => {
    const fetcher = vi.fn();
    await expect(submitWebsiteUrls({ siteUrl, bingSiteUrl: selectedSite, apiKey, fetcher })).rejects.toThrow("outside");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires a key before any network access for a real submission", async () => {
    const fetcher = vi.fn();
    await expect(submitWebsiteUrls({ siteUrl, bingSiteUrl, fetcher })).rejects.toThrow("API key");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([new Response("private response", { status: 403 }), new Response('{"ErrorCode":401,"Message":"private response"}'), new Response("not json")])("redacts Bing error bodies and never retries", async (failure) => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(sitemap())).mockResolvedValueOnce(quota()).mockResolvedValueOnce(failure);
    await expect(submitWebsiteUrls({ siteUrl, bingSiteUrl, apiKey, fetcher })).rejects.toThrow(/^Bing SubmitUrlBatch/);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("reports network failures without leaking a credential-bearing request URL", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(sitemap())).mockRejectedValueOnce(new Error(`request failed ?apikey=${apiKey}`));
    await expect(submitWebsiteUrls({ siteUrl, bingSiteUrl, apiKey, fetcher })).rejects.toThrow("Bing GetUrlSubmissionQuota could not be reached.");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects a missing production sitemap", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("missing", { status: 404 }));
    await expect(publishedWebsiteUrls({ siteUrl, fetcher })).rejects.toThrow("HTTP 404");
  });
});
