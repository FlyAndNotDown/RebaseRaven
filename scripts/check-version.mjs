import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function cargoVersion(text, array) {
  const header = array ? "[[package]]" : "[package]";
  const sections = [...text.matchAll(/^\[.*\][ \t]*\r?$/gm)];
  const versions = sections.flatMap((section, index) => {
    if (section[0].trimEnd() !== header) return [];
    const block = text.slice(section.index, sections[index + 1]?.index ?? text.length);
    if (!/^name[ \t]*=[ \t]*"rebaseraven"[ \t]*\r?$/m.test(block)) return [];
    const match = block.match(/^version[ \t]*=[ \t]*"([^"]+)"[ \t]*\r?$/m);
    if (!match) throw new Error(`Missing RebaseRaven version in Cargo ${header} section.`);
    return [match[1]];
  });
  if (versions.length !== 1) throw new Error(`Expected one RebaseRaven Cargo ${header} section.`);
  return versions[0];
}

export async function checkVersions(directory = root) {
  const names = ["package.json", "package-lock.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"];
  const texts = await Promise.all(names.map((name) => readFile(path.join(directory, name), "utf8")));
  const [pkg, lock, tauri] = texts.slice(0, 3).map((text) => JSON.parse(text));
  const versions = [pkg.version, lock.version, lock.packages?.[""]?.version, tauri.version, cargoVersion(texts[3], false), cargoVersion(texts[4], true)];
  const version = versions[0];
  if (typeof version !== "string" || version !== version.trim() || !versionPattern.test(version)
    || version.split(".").some((part) => BigInt(part) > 65535n)) {
    throw new Error("Application versions must use X.Y.Z with components at most 65535.");
  }
  if (versions.some((value) => value !== version)) {
    throw new Error("Version mismatch between package.json, package-lock.json, tauri.conf.json, Cargo.toml, and Cargo.lock.");
  }
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error("Usage: node scripts/check-version.mjs");
    console.log(`Version files agree on v${await checkVersions()}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
