import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const directory = resolve(root, "dist/build/ui");
let html = await readFile(resolve(directory, "index.html"), "utf8");
const replacements = await Promise.all([
  ...Array.from(html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/gu), async (match) => {
    const filename = match[1];
    if (!filename) throw new Error("Missing script path");
    const source = await readFile(resolve(directory, filename.replace(/^\//u, "")), "utf8");
    return {
      original: match[0],
      inline: `<script type="module">${source.replaceAll("</script", "<\\/script")}</script>`,
    };
  }),
  ...Array.from(
    html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/gu),
    async (match) => {
      const filename = match[1];
      if (!filename) throw new Error("Missing stylesheet path");
      const source = await readFile(resolve(directory, filename.replace(/^\//u, "")), "utf8");
      return {
        original: match[0],
        inline: `<style>${source.replaceAll("</style", "<\\/style")}</style>`,
      };
    },
  ),
]);
for (const replacement of replacements)
  html = html.replace(replacement.original, () => replacement.inline);
if (/<(?:script|link)\b[^>]*(?:src|href)=/u.test(html))
  throw new Error("The plugin panel must contain all its assets");
await mkdir(resolve(root, "dist/build/web"), { recursive: true });
await writeFile(resolve(root, "dist/build/web/panel.html"), html);
