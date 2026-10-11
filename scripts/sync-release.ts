import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { installerAsset, targets } from "../website/downloads/releases.js";

// Publish a local static manifest so visitors never depend on GitHub API access.
const configured = process.env["GOODFINDS_RELEASE_REPOSITORY"];
const remote =
  configured ?? execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
const repository = remote
  .replace(/^https:\/\/github\.com\//, "")
  .replace(/^git@github\.com:/, "")
  .replace(/\.git$/, "");
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
  throw new Error("Set GOODFINDS_RELEASE_REPOSITORY to the GitHub owner/repository for releases");
const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
  headers: { Accept: "application/vnd.github+json" },
  signal: AbortSignal.timeout(15_000),
});
if (!response.ok) throw new Error(`GitHub release lookup failed (${response.status})`);
const source: unknown = await response.json();
if (
  !source ||
  typeof source !== "object" ||
  !("tag_name" in source) ||
  typeof source.tag_name !== "string" ||
  !/^v\d+\.\d+\.\d+$/.test(source.tag_name) ||
  ("draft" in source && source.draft) ||
  ("prerelease" in source && source.prerelease)
)
  throw new Error("Expected a published stable release");
const html_url = `https://github.com/${repository}/releases/tag/${source.tag_name}`;
const snapshot = { ...source, html_url };
const assets = Object.keys(targets)
  .map((target) => installerAsset(snapshot, target))
  .filter((asset) => asset !== null);
if (!installerAsset(snapshot, "macos-universal"))
  throw new Error("Publish a universal Mac .pkg before generating the download manifest");
await writeFile(
  new URL("../website/downloads/release.json", import.meta.url),
  JSON.stringify({ tag_name: source.tag_name, html_url, assets }, null, 2) + "\n",
);
process.stdout.write(
  `Updated website downloads: ${source.tag_name}, ${assets.length} installer(s)\n`,
);
