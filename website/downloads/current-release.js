// Deployment supplies this same-origin manifest from scripts/sync-release.ts.
const empty = { tag_name: "", html_url: "", assets: [] };
async function loadRelease() {
  try {
    const response = await fetch("/downloads/release.json");
    if (!response.ok) return empty;
    /** @type {unknown} */
    const value = await response.json();
    if (
      !value ||
      typeof value !== "object" ||
      !("tag_name" in value) ||
      typeof value.tag_name !== "string" ||
      !("html_url" in value) ||
      typeof value.html_url !== "string" ||
      !("assets" in value) ||
      !Array.isArray(value.assets)
    )
      return empty;
    return { tag_name: value.tag_name, html_url: value.html_url, assets: value.assets };
  } catch {
    return empty;
  }
}
export default await loadRelease();
