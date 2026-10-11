/** @type {Record<string, {label: string, suffixes: string[], requirement: string}>} */
export const targets = {
  "macos-universal": {
    label: "Download for Mac",
    suffixes: ["-macos-universal.pkg"],
    requirement: "macOS 13 or later · Apple silicon and Intel",
  },
  "windows-x64": {
    label: "Download for Windows",
    suffixes: ["-windows-x64.exe"],
    requirement: "Windows 10 or later · Intel / AMD 64-bit",
  },
};

/**
 * @typedef {{name: string, state: string, size: number, browser_download_url: string, digest?: string | null}} InstallerAsset
 * @param {unknown} release
 * @param {string} target
 * @returns {InstallerAsset | null}
 */
export function installerAsset(release, target) {
  const definition = targets[target];
  if (
    !release ||
    typeof release !== "object" ||
    ("draft" in release && release.draft) ||
    ("prerelease" in release && release.prerelease) ||
    !("assets" in release) ||
    !Array.isArray(release.assets) ||
    !definition
  )
    return null;
  const version =
    "tag_name" in release && typeof release.tag_name === "string"
      ? release.tag_name.replace(/^v/, "")
      : "";
  if (!("html_url" in release) || typeof release.html_url !== "string") return null;
  const repository = release.html_url.match(
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/releases\/tag\/v\d+\.\d+\.\d+$/,
  )?.[1];
  if (!repository) return null;
  /** @type {unknown[]} */
  const assets = release.assets;
  for (const suffix of definition.suffixes) {
    const match = assets.find(
      /** @returns {asset is InstallerAsset} */ (asset) => {
        if (
          !asset ||
          typeof asset !== "object" ||
          !("name" in asset) ||
          typeof asset.name !== "string" ||
          ![`Goodfinds${suffix}`, `Goodfinds-${version}${suffix}`].includes(asset.name)
        )
          return false;
        if (
          !("state" in asset) ||
          asset.state !== "uploaded" ||
          !("size" in asset) ||
          typeof asset.size !== "number" ||
          !(asset.size > 0) ||
          !("browser_download_url" in asset) ||
          typeof asset.browser_download_url !== "string" ||
          ("digest" in asset && asset.digest !== null && typeof asset.digest !== "string")
        )
          return false;
        try {
          const url = new URL(asset.browser_download_url);
          return (
            url.protocol === "https:" &&
            url.hostname === "github.com" &&
            !url.username &&
            !url.password &&
            url.pathname === `/${repository}/releases/download/v${version}/${asset.name}` &&
            !url.search &&
            !url.hash
          );
        } catch {
          return false;
        }
      },
    );
    if (match) return match;
  }
  return null;
}

/** @param {string} target */
export function installerOpenStep(target) {
  return target === "macos-universal"
    ? "Open the downloaded .pkg file. In the installer, choose Continue, then Install."
    : "Open the Goodfinds installer in your Downloads folder.";
}

export function installerFilmBase() {
  return "/media/install-goodfinds-package";
}
