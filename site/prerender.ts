import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer, type Plugin } from "vite";
import { SITE_URL, sitePageUrl, softwareApplication } from "./src/product.ts";
import { localeFromPath, SITE_LOCALES, siteResources, type SiteLocale } from "./src/i18n.ts";
import { readBundledReleaseDownloads } from "./src/release-downloads.ts";

function escapeAttribute(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function metadata(locale: SiteLocale, releaseTag: string | null) {
  const copy = siteResources[locale];
  const url = sitePageUrl(locale);
  const title = escapeAttribute(copy["meta.title"]);
  const description = escapeAttribute(copy["meta.description"]);
  return `<!--site-meta-start-->
    <title>${title}</title>
    <meta name="description" content="${description}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="RebaseRaven">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:image" content="${SITE_URL}assets/social.png">
    <meta property="og:image:type" content="image/png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:alt" content="RebaseRaven — Rust-powered Git and Perforce client">
    <meta property="og:url" content="${url}">
    <meta property="og:locale" content="${locale === "en" ? "en_US" : "zh_CN"}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${description}">
    <meta name="twitter:image" content="${SITE_URL}assets/social.png">
    <meta name="twitter:image:alt" content="RebaseRaven — Rust-powered Git and Perforce client">
    <link rel="canonical" href="${url}">
    ${SITE_LOCALES.map((language) => `<link rel="alternate" hreflang="${language}" href="${sitePageUrl(language)}">`).join("\n    ")}
    <link rel="alternate" hreflang="x-default" href="${SITE_URL}">
    <script type="application/ld+json">${JSON.stringify(softwareApplication(locale, releaseTag)).replace(/</g, "\\u003c")}</script>
    <!--site-meta-end-->`;
}

export function englishRedirectDocument() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeAttribute(siteResources.en["meta.title"])}</title>
    <link rel="canonical" href="${SITE_URL}">
    <meta http-equiv="refresh" content="0; url=../">
    <script>
      const target = new URL("../", window.location.href);
      target.search = window.location.search;
      target.hash = window.location.hash;
      window.location.replace(target.href);
    </script>
  </head>
  <body><a href="../">Continue to RebaseRaven</a></body>
</html>`;
}

export function productMetadata(): Plugin {
  let releaseTag: string | null = null;
  return {
    name: "rebaseraven-product-metadata",
    configResolved(config) {
      releaseTag = readBundledReleaseDownloads(config.env.VITE_RELEASE_DOWNLOADS)?.tag ?? null;
    },
    transformIndexHtml(html, context) {
      const locale = localeFromPath(context.path);
      if (locale === "en") return englishRedirectDocument();
      return html.replace("<!--site-metadata-->", metadata(locale ?? "en", releaseTag))
        .replace('<html lang="en"', `<html lang="${locale ?? "en"}"`);
    },
  };
}

export function prerender(root: string): Plugin {
  let outputDirectory: string;
  let cacheDirectory: string;
  let releaseTag: string | null = null;
  let mode: string;
  return {
    name: "rebaseraven-prerender",
    apply: "build",
    configResolved(config) {
      outputDirectory = path.resolve(config.root, config.build.outDir);
      cacheDirectory = config.cacheDir;
      releaseTag = readBundledReleaseDownloads(config.env.VITE_RELEASE_DOWNLOADS)?.tag ?? null;
      mode = config.mode;
    },
    async closeBundle() {
      const server = await createServer({
        configFile: path.join(root, "vite.config.ts"),
        cacheDir: cacheDirectory,
        mode,
        server: { middlewareMode: true, hmr: false },
        appType: "custom",
      });
      try {
        const { render } = await server.ssrLoadModule("/src/entry-server.tsx") as { render: (locale: SiteLocale, rootPage: boolean) => Promise<string> };
        const filename = path.join(outputDirectory, "index.html");
        const template = await readFile(filename, "utf8");
        const placeholder = '<div id="root"></div>';
        if (!template.includes(placeholder)) throw new Error("Website template is missing its hydration root.");
        for (const locale of SITE_LOCALES) {
          const rootPage = locale === "en";
          const content = await render(locale, rootPage);
          if (!content.includes("<main")) throw new Error(`Website prerender failed for ${locale}.`);
          const localized = template
            .replace(/<!--site-meta-start-->[\s\S]*?<!--site-meta-end-->/, () => metadata(locale, releaseTag))
            .replace('<html lang="en"', `<html lang="${locale}"`)
            .replace(placeholder, () => `<div id="root" data-prerendered="true">${content}</div>`);
          const directory = rootPage ? outputDirectory : path.join(outputDirectory, locale);
          await mkdir(directory, { recursive: true });
          await writeFile(path.join(directory, "index.html"), rootPage ? localized : localized.replace(/((?:src|href)=")\.\/assets\//g, "$1../assets/"));
        }
        await mkdir(path.join(outputDirectory, "en"), { recursive: true });
        await writeFile(path.join(outputDirectory, "en/index.html"), englishRedirectDocument());
      } finally {
        await server.close();
      }
    },
  };
}
