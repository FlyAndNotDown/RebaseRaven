import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkVersions } from "./check-version.mjs";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(version = "1.2.3") {
  const directory = await mkdtemp(path.join(tmpdir(), "manifest-check-"));
  directories.push(directory);
  await mkdir(path.join(directory, "src-tauri"));
  const files = {
    "package.json": JSON.stringify({ name: "rebaseraven", version }),
    "package-lock.json": JSON.stringify({ version, packages: { "": { version }, "node_modules/library": { version: "9.0.0" } } }),
    "src-tauri/tauri.conf.json": JSON.stringify({ version }),
    "src-tauri/Cargo.toml": `[package]\nname = "rebaseraven"\nversion = "${version}"\n`,
    "src-tauri/Cargo.lock": `version = 4\n\n[[package]]\nname = "library"\nversion = "9.0.0"\n\n[[package]]\nname = "rebaseraven"\nversion = "${version}"\n`,
  };
  await Promise.all(Object.entries(files).map(([name, text]) => writeFile(path.join(directory, name), text)));
  return { directory, files };
}

describe("application version consistency", () => {
  it("checks application manifests without changing files or dependency versions", async () => {
    const { directory, files } = await fixture();
    expect(await checkVersions(directory)).toBe("1.2.3");
    for (const [name, text] of Object.entries(files)) {
      expect(await readFile(path.join(directory, name), "utf8")).toBe(text);
    }
  });

  it("rejects a mismatch in each application manifest", async () => {
    const { directory, files } = await fixture();
    for (const [name, text] of Object.entries(files)) {
      await writeFile(path.join(directory, name), text.replaceAll("1.2.3", "1.2.4"));
      await expect(checkVersions(directory)).rejects.toThrow("Version mismatch");
      await writeFile(path.join(directory, name), text);
    }
  });

  it("rejects ambiguous Cargo packages and unsupported version formats", async () => {
    const { directory, files } = await fixture();
    const lock = path.join(directory, "src-tauri/Cargo.lock");
    await writeFile(lock, `${files["src-tauri/Cargo.lock"]}\n[[package]]\nname = "rebaseraven"\nversion = "1.2.3"\n`);
    await expect(checkVersions(directory)).rejects.toThrow("Expected one");
    for (const version of ["01.2.3", "1.2", "1.2.3-beta", "65536.0.0"]) {
      const invalid = await fixture(version);
      await expect(checkVersions(invalid.directory)).rejects.toThrow("X.Y.Z");
    }
  });
});
