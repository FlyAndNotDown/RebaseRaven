import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { releaseAssets } from "./release-github.mjs";
import { prepareSiteUpdate, publishSite, validateSiteUpdate } from "./site-publish.mjs";
import { verifySite } from "./verify-site.mjs";

const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function directory() {
  const root = await mkdtemp(path.join(tmpdir(), "website-publication-"));
  temporary.push(root);
  return root;
}

function fixture() {
  const keys = generateKeyPairSync("ed25519");
  const packet = Buffer.alloc(74);
  packet.write("ED", "ascii");
  const publicPacket = Buffer.concat([Buffer.from("Ed"), packet.subarray(2, 10), keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32)]);
  const publicKey = Buffer.from(`untrusted comment: fixture public key\n${publicPacket.toString("base64")}\n`).toString("base64");
  const comment = "timestamp:1\tfile:fixture\tversion:0.0.1";
  const signature = Buffer.from(`untrusted comment: fixture signature\n${packet.toString("base64")}\ntrusted comment: ${comment}\n${sign(null, Buffer.concat([packet.subarray(10), Buffer.from(comment)]), keys.privateKey).toString("base64")}\n`).toString("base64");
  const tag = "v0.0.1";
  const repository = "maintainer/sample-app";
  const assets = ["latest.json", ...releaseAssets(tag).flatMap((target: { name: string; installer?: string }) => [target.name, `${target.name}.sig`, ...(target.installer ? [target.installer] : [])])]
    .map((name: string) => ({ name, size: 100, state: "uploaded", browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${name}` }));
  const platforms = Object.fromEntries(releaseAssets(tag).map((target: { platform: string; name: string }) => [target.platform, { signature, url: `https://github.com/${repository}/releases/download/${tag}/${target.name}` }]));
  return {
    tag, repository, publicKey,
    release: { tag_name: tag, draft: false, prerelease: false, assets },
    manifest: { version: "0.0.1", pub_date: "2026-01-01T00:00:00Z", notes: "Release notes", platforms },
  };
}

describe("website update publication", () => {
  it("copies the signed release manifest byte for byte and deploys only the publication branch", async () => {
    const input = fixture();
    const root = await directory();
    const manifestBytes = Buffer.from(`${JSON.stringify(input.manifest, null, 2)}\n`);
    await prepareSiteUpdate({ ...input, directory: root, manifestBytes });
    expect(await readFile(path.join(root, "updates/latest.json"))).toEqual(manifestBytes);
    const config = JSON.parse(await readFile(path.join(root, "vercel.json"), "utf8"));
    expect(config.git.deploymentEnabled).toEqual({ "*": false, website: true });
    expect(config.headers[0].headers).toContainEqual({ key: "Vercel-CDN-Cache-Control", value: "no-store" });
  });

  it("rejects mismatched, incomplete, redirected, or incorrectly signed updates", () => {
    const invalid = [
      (input: ReturnType<typeof fixture>) => { input.manifest.version = "0.0.2"; },
      (input: ReturnType<typeof fixture>) => { input.release.draft = true; },
      (input: ReturnType<typeof fixture>) => { input.release.assets[0].state = "pending"; },
      (input: ReturnType<typeof fixture>) => { input.manifest.platforms["windows-x86_64"].url = "https://example.test/update.exe"; },
      (input: ReturnType<typeof fixture>) => { input.manifest.platforms["windows-x86_64"].signature = "invalid"; },
      (input: ReturnType<typeof fixture>) => { input.publicKey = fixture().publicKey; },
    ];
    for (const mutate of invalid) {
      const input = fixture();
      mutate(input);
      expect(() => validateSiteUpdate(input)).toThrow();
    }
  });
});

async function publication() {
  vi.stubEnv("GITHUB_TRIGGERING_ACTOR", "maintainer");
  const root = await directory();
  for (const filename of ["index.html", "zh-CN/index.html", "analytics/index.html", "updates/latest.json", "vercel.json"]) {
    await mkdir(path.dirname(path.join(root, filename)), { recursive: true });
    await writeFile(path.join(root, filename), filename);
  }
  const context = { eventName: "workflow_dispatch", ref: "refs/heads/master", actor: "maintainer", repo: { owner: "maintainer", repo: "sample-app" } };
  const github = { rest: {
    repos: { getLatestRelease: vi.fn(async () => ({ data: { tag_name: "v0.0.1", draft: false, prerelease: false } })) },
    git: {
      getRef: vi.fn(async () => ({ data: { object: { sha: "previous" } } })),
      createBlob: vi.fn(async () => ({ data: { sha: "blob" } })),
      createTree: vi.fn(async () => ({ data: { sha: "tree" } })),
      createCommit: vi.fn(async () => ({ data: { sha: "commit" } })),
      updateRef: vi.fn(async () => ({})), createRef: vi.fn(async () => ({})),
    },
  } };
  return { github, context, directory: root, tag: "v0.0.1" };
}

describe("atomic website branch", () => {
  it("updates only the website branch and preserves its parent without force pushing", async () => {
    const input = await publication();
    await expect(publishSite(input)).resolves.toBe("commit");
    expect(input.github.rest.git.createCommit).toHaveBeenCalledWith(expect.objectContaining({ parents: ["previous"] }));
    expect(input.github.rest.git.updateRef).toHaveBeenCalledExactlyOnceWith({ ...input.context.repo, ref: "heads/website", sha: "commit", force: false });
    expect(input.github.rest.git.createRef).not.toHaveBeenCalled();
  });

  it("does not publish a stale release or an upload interrupted by a newer release", async () => {
    for (const late of [false, true]) {
      const input = await publication();
      const next = { data: { tag_name: "v0.0.2", draft: false, prerelease: false } };
      if (late) input.github.rest.repos.getLatestRelease.mockResolvedValueOnce({ data: { tag_name: "v0.0.1", draft: false, prerelease: false } });
      input.github.rest.repos.getLatestRelease.mockResolvedValue(next);
      await expect(publishSite(input)).rejects.toThrow("latest public stable release");
      expect(input.github.rest.git.updateRef).not.toHaveBeenCalled();
      expect(input.github.rest.git.createRef).not.toHaveBeenCalled();
    }
  });

  it("rejects non-owner and source-branch publication before uploading assets", async () => {
    const input = await publication();
    input.context.ref = "refs/heads/dev";
    await expect(publishSite(input)).rejects.toThrow("Only the repository owner");
    expect(input.github.rest.git.createBlob).not.toHaveBeenCalled();
  });
});

describe("production website verification", () => {
  it("checks deployed HTML, the analytics bridge, and the exact JSON with a revalidation policy", async () => {
    const input = await publication();
    const routes: Record<string, string> = { "/": "index.html", "/zh-CN/": "zh-CN/index.html", "/analytics/": "analytics/index.html", "/updates/latest.json": "updates/latest.json" };
    const request = async (url: URL) => new Response(await readFile(path.join(input.directory, routes[url.pathname])), {
      headers: { "content-type": url.pathname.endsWith(".json") ? "application/json" : "text/html", "cache-control": "no-cache, must-revalidate" },
    });
    await expect(verifySite({ baseUrl: "https://site.example.test/", directory: input.directory, request })).resolves.toBeUndefined();
    await expect(verifySite({ baseUrl: "https://site.example.test/", directory: input.directory, request: async () => new Response("outdated") })).rejects.toThrow("does not match");
  });
});
