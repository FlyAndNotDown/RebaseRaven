import { describe, expect, it } from "vitest";
import { validateSiteDocument, validateSiteRedirect, validateSiteRouting } from "./site-document.mjs";
import { englishRedirectDocument } from "../site/prerender";

const canonical = "https://rebaseraven.flyandnotdown.com/";
const download = "https://github.com/FlyAndNotDown/RebaseRaven/releases/latest";
const product = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "RebaseRaven",
  url: canonical,
  description: "A Git and Perforce GUI client built with Rust.",
  applicationCategory: "DeveloperApplication",
  operatingSystem: ["macOS (Apple Silicon)", "Windows (x64)"],
  license: "https://opensource.org/license/mit",
  downloadUrl: download,
  sameAs: "https://github.com/FlyAndNotDown/RebaseRaven",
};
const content = `<main><h1>A Git and Perforce GUI client built with Rust</h1><p>${"Review changes and follow repository history. ".repeat(5)}</p><p>macOS Apple Silicon and Windows x64. MIT License.</p><a href="${download}"><svg><path /></svg>Download</a></main>`;

function fixture() {
  return {
    html: `<html><head><link rel="alternate" hreflang="en" href="${canonical}"><link rel="alternate" hreflang="zh-CN" href="${canonical}zh-CN/"><link rel="alternate" hreflang="x-default" href="${canonical}"><link href="${canonical}" rel="canonical"><meta content="${canonical}" property="og:url"><script type="application/ld+json">${JSON.stringify(product)}</script></head><body><div id="root" data-prerendered="true"><div>RebaseRaven</div>${content}</div></body></html>`,
    sitemap: `<urlset><url><loc>${canonical}</loc></url></urlset>`,
    files: new Set(["index.html", "sitemap.xml", "assets/index-abc.js", "assets/index-abc.css"]),
  };
}

describe("published website document", () => {
  it("accepts crawlable prerendered content with matching metadata and a real release link", () => {
    expect(validateSiteDocument(fixture())).toEqual([]);
  });

  it("rejects an empty hydration root even when product text exists elsewhere", () => {
    const value = fixture();
    value.html = value.html.replace(`<div id="root" data-prerendered="true"><div>RebaseRaven</div>${content}</div>`, `<div id="root" data-prerendered="true"></div>${content}`);
    expect(validateSiteDocument(value)).toContainEqual(expect.stringContaining("prerendered root"));
  });

  it("rejects duplicate or inconsistent canonical, Open Graph, and sitemap URLs", () => {
    const duplicate = fixture();
    duplicate.html = duplicate.html.replace("</head>", `<link rel="canonical" href="${canonical}"></head>`);
    expect(validateSiteDocument(duplicate)).toContainEqual(expect.stringContaining("exactly one HTTPS canonical"));
    const mismatch = fixture();
    mismatch.html = mismatch.html.replace(`content="${canonical}"`, 'content="https://site.example.com/"');
    mismatch.sitemap = "<urlset><url><loc>https://site.example.com/</loc></url></urlset>";
    expect(validateSiteDocument(mismatch)).toEqual(expect.arrayContaining([
      expect.stringContaining("og:url must match"), expect.stringContaining("sitemap.xml:"),
    ]));
  });

  it("rejects invalid JSON-LD and metadata that advertises an unsupported build", () => {
    const invalid = fixture();
    invalid.html = invalid.html.replace(JSON.stringify(product), "{");
    expect(validateSiteDocument(invalid)).toContainEqual(expect.stringContaining("valid SoftwareApplication"));
    const unsupported = fixture();
    unsupported.html = unsupported.html.replace(JSON.stringify(product), JSON.stringify({ ...product, operatingSystem: ["macOS (Intel)", "Windows (x64)"] }));
    expect(validateSiteDocument(unsupported)).toContainEqual(expect.stringContaining("supported systems"));
  });

  it("requires a download anchor in the main content instead of a JavaScript-only button", () => {
    const value = fixture();
    value.html = value.html.replace(`<a href="${download}"><svg><path /></svg>Download</a>`, "<button>Download</button>");
    expect(validateSiteDocument(value)).toContainEqual(expect.stringContaining("without JavaScript"));
  });

  it("requires reciprocal locale links and a canonical for the actual page", () => {
    const value = fixture();
    value.html = value.html.replace('hreflang="zh-CN"', 'hreflang="fr"');
    expect(validateSiteDocument(value)).toContainEqual(expect.stringContaining("zh-CN language alternate"));
    expect(validateSiteDocument({ ...fixture(), filename: "zh-CN/index.html" })).toContainEqual(expect.stringContaining("canonical must identify this language page"));
  });

  it("rejects leaked SSR code and source maps while allowing the browser assets", () => {
    const value = fixture();
    for (const filename of ["src/entry-server.tsx", "entry-server.js", "assets/index.js.map", "assets/prerender.js", "dist-ssr/index.mjs"]) value.files.add(filename);
    const violations = validateSiteDocument(value);
    expect(violations).toHaveLength(5);
    expect(violations.every((message: string) => message.includes("Static output must not contain"))).toBe(true);
  });
});

describe("English homepage alias", () => {
  it("redirects to the canonical homepage without loading a duplicate product page", () => {
    expect(validateSiteRedirect({ html: englishRedirectDocument(), sitemap: fixture().sitemap })).toEqual([]);
  });

  it("rejects delayed or wrong redirects and sitemap entries for the alias", () => {
    for (const replacement of ["1; url=../", "0; url=../zh-CN/"]) {
      const html = englishRedirectDocument().replace("0; url=../", replacement);
      expect(validateSiteRedirect({ html, sitemap: fixture().sitemap })).toContainEqual(expect.stringContaining("immediate redirect"));
    }
    const sitemap = `<urlset><url><loc>${canonical}en/</loc></url></urlset>`;
    expect(validateSiteRedirect({ html: englishRedirectDocument(), sitemap })).toContainEqual(expect.stringContaining("must not be listed"));
  });
});

describe("published custom-domain routing", () => {
  it("accepts the discoverable canonical sitemap", () => {
    expect(validateSiteRouting({
      robots: `User-agent: *\nAllow: /\n\nSitemap: ${canonical}sitemap.xml\n`,
    })).toEqual([]);
  });

  it("rejects missing, obsolete, or duplicate sitemap locations", () => {
    expect(validateSiteRouting({})).toHaveLength(1);
    expect(validateSiteRouting({
      robots: "Sitemap: https://site.example.com/sitemap.xml\n",
    })).toEqual(expect.arrayContaining([
      expect.stringContaining("robots.txt:"),
    ]));
    expect(validateSiteRouting({
      robots: `Sitemap: ${canonical}sitemap.xml\nSitemap: ${canonical}sitemap.xml\n`,
    })).toContainEqual(expect.stringContaining("advertise the canonical website sitemap once"));
  });
});
