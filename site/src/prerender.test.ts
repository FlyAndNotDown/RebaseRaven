import { describe, expect, it } from "vitest";
import { render } from "./entry-server";
import { LATEST_RELEASE_URL } from "./release-downloads";
import { siteResources } from "./i18n";
import { SITE_URL, softwareApplication } from "./product";
import { readBundledReleaseDownloads } from "./release-downloads";

describe("website prerender", () => {
  it("renders product facts and working download URLs without a browser", async () => {
    const html = await render();
    expect(html).toContain('<main id="main"');
    expect(html).toContain(siteResources.en["hero.title"].split("\n")[0]);
    expect(html).toContain("macOS Apple Silicon");
    expect(html).toContain("Windows x64");
    expect(html).toContain("Git and Perforce");
    expect(html).toContain("open source under the MIT License.");
    expect(html.split(`href="${LATEST_RELEASE_URL}"`)).toHaveLength(4);
    expect(html).toContain("Enable JavaScript to try the interactive demo.");
    expect(html).toContain('id="demo-commit-message"');
    expect(html).toContain("./assets/raven.svg");
    expect(html).not.toContain("/@fs/");
    expect(html).not.toContain('id="demo-changelist-description"');
    expect(html).not.toContain(siteResources.en["demo.loadingPerforce"]);
    expect(html).not.toMatch(/<script\b/i);
  });

  it("prerenders complete Chinese copy and locale links without leaking locale state", async () => {
    const translated = await render("zh-CN", false);
    expect(translated).toContain(siteResources["zh-CN"]["preview.title"]);
    expect(translated).toContain(siteResources["zh-CN"]["demo.gitIntro"]);
    expect(translated).toContain('href="../"');
    expect(translated).toContain('href="../zh-CN/"');
    expect(translated).toContain("../assets/raven.svg");
    const english = await render("en", true);
    expect(english).toContain(siteResources.en["preview.title"]);
    expect(english).toContain("./assets/raven.svg");
    expect(english).toContain('href="./zh-CN/"');
    expect(english).not.toContain(siteResources["zh-CN"]["preview.title"]);
  });

  it("uses canonical language URLs and the same published release as the download links", () => {
    const release = readBundledReleaseDownloads(JSON.stringify({ tag_name: "v1.2.3", draft: false, prerelease: false, assets: [] }));
    const english = softwareApplication("en", release?.tag);
    expect(english.url).toBe(SITE_URL);
    expect(english.softwareVersion).toBe("1.2.3");
    expect(softwareApplication("zh-CN", release?.tag).url).toBe(`${SITE_URL}zh-CN/`);
    expect(softwareApplication("en")).not.toHaveProperty("softwareVersion");
    expect(english.sameAs).toBe("https://github.com/FlyAndNotDown/RebaseRaven");
  });

  it("keeps the initial platform and generated accessibility IDs deterministic", async () => {
    const first = await render();
    const second = await render();
    expect(first).toContain('data-platform="macos"');
    expect(first).toContain("rebaseraven-");
    expect(second).toBe(first);
  });
});
