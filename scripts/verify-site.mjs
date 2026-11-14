import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export async function verifySite({ baseUrl, directory, request = fetch }) {
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  for (const [route, filename] of [
    ["", "index.html"], ["zh-CN/", "zh-CN/index.html"],
    ["analytics/", "analytics/index.html"], ["updates/latest.json", "updates/latest.json"],
  ]) {
    const response = await request(new URL(route, baseUrl), { signal: AbortSignal.timeout(20000), cache: "no-store" });
    if (response.status !== 200) throw new Error(`Website route ${route || "/"} returned ${response.status}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (digest(bytes) !== digest(await readFile(path.join(directory, filename)))) {
      throw new Error(`Website route ${route || "/"} does not match the selected release.`);
    }
    if (route.endsWith(".json") && (!response.headers.get("content-type")?.includes("application/json")
      || !response.headers.get("cache-control")?.includes("must-revalidate"))) {
      throw new Error("The update source must return JSON without a stale cache policy.");
    }
  }
}
