const REPOSITORY_URL = "https://github.com/FlyAndNotDown/RebaseRaven";
const DOWNLOAD_URL = `${REPOSITORY_URL}/releases/latest`;
const SUPPORTED_SYSTEMS = ["macOS (Apple Silicon)", "Windows (x64)"];
const SITE_URL = "https://rebaseraven.flyandnotdown.com/";

export function sitemapEntries(sitemap) {
  return [...sitemap.matchAll(/<url>\s*([\s\S]*?)\s*<\/url>/g)].map(([xml, content]) => ({
    xml,
    location: /<loc>\s*([^<]+?)\s*<\/loc>/.exec(content)?.[1],
    lastModified: /<lastmod>([^<]+)<\/lastmod>/.exec(content)?.[1],
  }));
}

export function validSitemapDate(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) && timestamp <= Date.now()
    && new Date(timestamp).toISOString() === value;
}

export function validateSiteSitemap(sitemap) {
  const entries = sitemapEntries(sitemap);
  const locations = [SITE_URL, `${SITE_URL}zh-CN/`];
  if (!sitemap.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
    || entries.length !== locations.length
    || locations.some((location) => entries.filter((entry) => entry.location === location).length !== 1)) {
    return ["sitemap.xml: list each canonical language page exactly once"];
  }
  return entries.filter((entry) => !validSitemapDate(entry.lastModified)
    || [...entry.xml.matchAll(/<lastmod>/g)].length !== 1)
    .map((entry) => `sitemap.xml: ${entry.location} must have one valid lastmod timestamp that is not in the future`);
}

function decodeText(value) {
  return value.replace(/&(?:#(x[\da-f]+|\d+)|(amp|quot|apos|lt|gt|nbsp));/gi, (entity, numeric, named) => {
    if (numeric) {
      const code = numeric.toLowerCase().startsWith("x") ? Number.parseInt(numeric.slice(1), 16) : Number(numeric);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " }[named.toLowerCase()];
  });
}

function attributes(source) {
  return new Map([...source.matchAll(/([^\s=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)]
    .map((match) => [match[1].toLowerCase(), decodeText(match[2] ?? match[3] ?? match[4] ?? "")]));
}

function elements(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)<\\/${name}\\s*>`, "gi"))]
    .map((match) => ({ attributes: attributes(match[1]), content: match[2] }));
}

function rootContent(html) {
  const opening = [...html.matchAll(/<div\b([^>]*)>/gi)].find((match) => attributes(match[1]).get("id") === "root");
  if (!opening || attributes(opening[1]).get("data-prerendered") !== "true") return "";
  const start = opening.index + opening[0].length;
  let depth = 1;
  for (const match of html.slice(start).matchAll(/<(\/?)div\b[^>]*>/gi)) {
    depth += match[1] ? -1 : 1;
    if (!depth) return html.slice(start, start + match.index);
  }
  return "";
}

function readableText(html) {
  return decodeText(html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ").trim();
}

function validSiteUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname.endsWith("/");
  } catch { return false; }
}

export function validateSiteRouting({ robots = "" }) {
  const violations = [];
  const sitemaps = [...robots.matchAll(/^sitemap:[\t ]*(\S+)[\t ]*$/gim)].map((match) => match[1]);
  if (sitemaps.length !== 1 || sitemaps[0] !== `${SITE_URL}sitemap.xml`) {
    violations.push("robots.txt: advertise the canonical website sitemap once");
  }
  return violations;
}

export function validateSiteDocument({ html, sitemap, files, filename = "index.html" }) {
  const violations = [];
  const fail = (message) => violations.push(`${filename}: ${message}`);
  const head = elements(html, "head")[0]?.content ?? "";
  const language = filename === "zh-CN/index.html" ? "zh-CN" : "en";
  if (attributes(/<html\b([^>]*)>/i.exec(html)?.[1] ?? "").get("lang") !== language) fail("declare the language of this page");
  const titles = elements(head, "title");
  const metas = [...head.matchAll(/<meta\b([^>]*)>/gi)].map(match => attributes(match[1]));
  const descriptions = metas.filter(attrs => attrs.get("name")?.toLowerCase() === "description");
  if (titles.length !== 1 || !readableText(titles[0].content)) fail("provide one readable page title");
  if (descriptions.length !== 1 || !descriptions[0].get("content")?.trim()) fail("provide one meta description");
  if (metas.some(attrs => ["robots", "googlebot", "bingbot"].includes(attrs.get("name")?.toLowerCase())
    && attrs.get("content")?.toLowerCase().split(/[\s,]+/).some(rule => ["noindex", "none", "nosnippet"].includes(rule)))) {
    fail("allow the product page to be indexed and quoted");
  }
  const content = rootContent(html);
  const mains = elements(content, "main");
  const headings = elements(content, "h1");
  const main = mains[0]?.content ?? "";
  if (mains.length !== 1 || headings.length !== 1 || !readableText(headings[0]?.content ?? "") || readableText(main).length < 200) {
    fail("prerendered root must contain one main, one readable h1, and product content without JavaScript");
  }

  const canonicals = [...html.matchAll(/<link\b([^>]*)>/gi)].map((match) => attributes(match[1]))
    .filter((attrs) => attrs.get("rel")?.toLowerCase().split(/\s+/).includes("canonical"));
  const canonical = canonicals[0]?.get("href");
  if (canonicals.length !== 1 || !validSiteUrl(canonical)) fail("provide exactly one HTTPS canonical project URL ending in a slash");
  const expectedCanonical = new URL(filename.replace(/index\.html$/, ""), SITE_URL).href;
  if (canonical !== expectedCanonical) fail("canonical must identify this language page within the public project");
  const links = [...html.matchAll(/<link\b([^>]*)>/gi)].map((match) => attributes(match[1]));
  for (const [language, url] of [["en", SITE_URL], ["zh-CN", `${SITE_URL}zh-CN/`], ["x-default", SITE_URL]]) {
    const alternates = links.filter((attrs) => attrs.get("rel") === "alternate" && attrs.get("hreflang") === language);
    if (alternates.length !== 1 || alternates[0].get("href") !== url) fail(`provide one reciprocal ${language} language alternate`);
  }
  const ogUrls = metas.filter((attrs) => attrs.get("property") === "og:url");
  if (ogUrls.length !== 1 || ogUrls[0].get("content") !== canonical) fail("og:url must match the unique canonical URL");

  const schemas = elements(head, "script").filter((entry) => entry.attributes.get("type")?.toLowerCase() === "application/ld+json");
  let nodes = [];
  try {
    nodes = schemas.map(entry => JSON.parse(entry.content));
  } catch { fail("provide valid JSON-LD"); }
  const products = nodes.filter(node => node?.["@type"] === "SoftwareApplication");
  if (products.length !== 1) fail("provide one valid SoftwareApplication JSON-LD document");
  const [product] = products;
  if (filename === "index.html") {
    const sites = nodes.filter(node => node?.["@type"] === "WebSite");
    if (sites.length !== 1 || sites[0]["@context"] !== "https://schema.org" || sites[0].url !== SITE_URL
      || sites[0].name !== "RebaseRaven" || !product?.["@id"] || sites[0].about?.["@id"] !== product["@id"]) {
      fail("identify the canonical WebSite and link it to the application");
    }
  }
  if (product) {
    if (product["@context"] !== "https://schema.org" || product["@type"] !== "SoftwareApplication" || product.name !== "RebaseRaven" ||
      product.url !== canonical || product.applicationCategory !== "DeveloperApplication" ||
      typeof product.description !== "string" || !product.description.trim() ||
      product.license !== "https://opensource.org/license/mit" || product.downloadUrl !== DOWNLOAD_URL || product.sameAs !== REPOSITORY_URL ||
      !Array.isArray(product.operatingSystem) || product.operatingSystem.length !== SUPPORTED_SYSTEMS.length ||
      !SUPPORTED_SYSTEMS.every((system) => product.operatingSystem.includes(system))) {
      fail("SoftwareApplication metadata must describe the public product, supported systems, MIT license, and stable release link");
    }
    const visible = readableText(main).toLowerCase();
    if (!/\bmit\b/.test(visible)) {
      fail("the MIT license must also be readable in the page content");
    }
  }

  if (!elements(main, "a").some((link) => link.attributes.get("href") === DOWNLOAD_URL && readableText(link.content) &&
    !link.attributes.has("hidden") && link.attributes.get("aria-hidden") !== "true")) {
    fail("main must include a readable release download link that works without JavaScript");
  }

  const locations = [...(sitemap ?? "").matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((match) => decodeText(match[1]));
  if (!/<urlset[\s>]/.test(sitemap ?? "") || !canonical || locations.filter((url) => url === canonical).length !== 1 ||
    locations.some((value) => {
      try {
        const url = new URL(value);
        return !url.href.startsWith(SITE_URL) || Boolean(url.username || url.password || url.search || url.hash);
      } catch { return true; }
    })) violations.push("sitemap.xml: include the canonical homepage once and keep every URL within the canonical project");

  for (const filename of files) {
    if (/\.(?:tsx?|jsx|map)$/i.test(filename) || /(?:^|\/)(?:src|server|dist-ssr|node_modules|\.vite)(?:\/|$)/i.test(filename) ||
      /(?:^|\/)(?:entry-server|prerender|vite\.config|tsconfig)(?:[.-]|$)/i.test(filename) ||
      (/\.(?:mjs|cjs|js)$/i.test(filename) && !filename.startsWith("assets/"))) {
      violations.push(`${filename}: Static output must not contain server bundles, source files, or source maps`);
    }
  }
  return violations;
}

export function validateSiteRedirect({ html, sitemap }) {
  const violations = [];
  const fail = (message) => violations.push(`en/index.html: ${message}`);
  const links = [...html.matchAll(/<link\b([^>]*)>/gi)].map((match) => attributes(match[1]));
  const canonicals = links.filter((attrs) => attrs.get("rel") === "canonical");
  if (canonicals.length !== 1 || canonicals[0].get("href") !== SITE_URL) fail("canonical must point to the English homepage");
  const refreshes = [...html.matchAll(/<meta\b([^>]*)>/gi)].map((match) => attributes(match[1]))
    .filter((attrs) => attrs.get("http-equiv")?.toLowerCase() === "refresh");
  const refresh = /^0;\s*url=(.+)$/i.exec(refreshes[0]?.get("content") ?? "");
  try {
    if (refreshes.length !== 1 || !refresh || new URL(refresh[1], `${SITE_URL}en/`).href !== SITE_URL) throw new Error();
  } catch { fail("provide an immediate redirect to the English homepage without JavaScript"); }
  if (!elements(html, "a").some((link) => {
    try {
      return new URL(link.attributes.get("href"), `${SITE_URL}en/`).href === SITE_URL && Boolean(readableText(link.content));
    } catch { return false; }
  })) fail("provide a readable fallback link to the English homepage");
  if (elements(html, "script").some((script) => script.attributes.has("src"))) fail("redirect must not load an application bundle");
  if (/<loc>\s*[^<]*\/en\/\s*<\/loc>/.test(sitemap ?? "")) fail("redirect must not be listed in the sitemap");
  return violations;
}
