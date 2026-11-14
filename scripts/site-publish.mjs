import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertReleaseOwner, releaseAssets, validateUpdaterSignature } from "./release-github.mjs";
import { parseReleaseTag } from "./release-version.mjs";

export const WEBSITE_BRANCH = "website";

export function validateSiteUpdate({ release, manifest, publicKey, repository, tag }) {
  const version = parseReleaseTag(tag);
  if (release.tag_name !== tag || release.draft !== false || release.prerelease !== false
    || manifest.version !== version || !Number.isFinite(Date.parse(manifest.pub_date))
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Website updates must describe the selected public stable release.");
  }
  const targets = releaseAssets(tag);
  const expectedNames = ["latest.json", ...targets.flatMap((target) => [
    target.name, `${target.name}.sig`, ...(target.installer ? [target.installer] : []),
  ])];
  for (const name of expectedNames) {
    const assets = release.assets.filter((asset) => asset.name === name);
    if (assets.length !== 1 || assets[0].state !== "uploaded" || !(assets[0].size > 0)) {
      throw new Error(`The public release is missing a complete asset: ${name}.`);
    }
  }
  if (!manifest.platforms || Object.keys(manifest.platforms).length !== targets.length) {
    throw new Error("The website update manifest has unexpected platforms.");
  }
  for (const target of targets) {
    const update = manifest.platforms[target.platform];
    const expected = `https://github.com/${repository}/releases/download/${tag}/${target.name}`;
    if (!update || update.url !== expected
      || release.assets.find((asset) => asset.name === target.name).browser_download_url !== expected) {
      throw new Error(`Unexpected website update address for ${target.platform}.`);
    }
    validateUpdaterSignature(update.signature ?? "", { version, publicKey });
  }
}

export async function prepareSiteUpdate({ directory, release, manifestBytes, publicKey, repository, tag }) {
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  validateSiteUpdate({ release, manifest, publicKey, repository, tag });
  await mkdir(path.join(directory, "updates"), { recursive: true });
  await writeFile(path.join(directory, "updates/latest.json"), manifestBytes);
  await writeFile(path.join(directory, "vercel.json"), await readFile(new URL("../vercel.json", import.meta.url)));
}

async function siteFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const filename = path.posix.join(prefix, entry.name);
    if (entry.isSymbolicLink() || entry.name.startsWith(".")) throw new Error(`Invalid website asset: ${filename}.`);
    if (entry.isDirectory()) files.push(...await siteFiles(directory, filename));
    else if (entry.isFile()) files.push(filename);
  }
  return files.sort();
}

export async function publishSite({ github, context, directory, tag }) {
  assertReleaseOwner({
    eventName: context.eventName, ref: context.ref, actor: context.actor,
    triggeringActor: process.env.GITHUB_TRIGGERING_ACTOR, owner: context.repo.owner,
  });
  parseReleaseTag(tag);
  const assertLatest = async () => {
    const { data: latest } = await github.rest.repos.getLatestRelease(context.repo);
    if (latest.tag_name !== tag || latest.draft || latest.prerelease) {
      throw new Error("Only the latest public stable release may update the website.");
    }
  };
  await assertLatest();
  const files = await siteFiles(directory);
  for (const required of ["index.html", "zh-CN/index.html", "analytics/index.html", "updates/latest.json", "vercel.json"]) {
    if (!files.includes(required)) throw new Error(`Missing website asset: ${required}.`);
  }
  let previous;
  try {
    previous = (await github.rest.git.getRef({ ...context.repo, ref: `heads/${WEBSITE_BRANCH}` })).data.object.sha;
  } catch (error) { if (error.status !== 404) throw error; }
  const tree = [];
  // Limit upload concurrency while preserving a single atomic branch update.
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
    while (index < files.length) {
      const filename = files[index++];
      const content = await readFile(path.join(directory, filename));
      const { data: blob } = await github.rest.git.createBlob({ ...context.repo, content: content.toString("base64"), encoding: "base64" });
      tree.push({ path: filename, mode: "100644", type: "blob", sha: blob.sha });
    }
  }));
  const { data: snapshot } = await github.rest.git.createTree({ ...context.repo, tree: tree.sort((a, b) => a.path.localeCompare(b.path)) });
  const { data: commit } = await github.rest.git.createCommit({
    ...context.repo, message: `chore(site): publish ${tag}`, tree: snapshot.sha, parents: previous ? [previous] : [],
  });
  await assertLatest();
  if (previous) {
    await github.rest.git.updateRef({ ...context.repo, ref: `heads/${WEBSITE_BRANCH}`, sha: commit.sha, force: false });
  } else {
    await github.rest.git.createRef({ ...context.repo, ref: `refs/heads/${WEBSITE_BRANCH}`, sha: commit.sha });
  }
  return commit.sha;
}
