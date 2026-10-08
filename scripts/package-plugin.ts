import { checkStateModelDocs } from "./state-model-docs.ts";
import { buildTarget } from "./build-target.ts";

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  copyFileSync,
  chmodSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { z } from "zod";

await checkStateModelDocs();
const root = resolve(import.meta.dir, "..");
const manifest = z
  .object({
    name: z.string(),
    version: z.string(),
    description: z.string(),
    extensions: z.object({
      "com.openai": z.object({ interface: z.record(z.string(), z.unknown()) }),
    }),
  })
  .loose()
  .parse(JSON.parse(readFileSync(resolve(root, "plugin.json"), "utf8")) as unknown);
for (const file of ["dist/build/server/goodfinds", "dist/build/server/build.json"])
  if (!existsSync(resolve(root, file)))
    throw new Error("Build Goodfinds with bun run build before packaging");
const built = z
  .object({ target: z.string() })
  .parse(
    JSON.parse(readFileSync(resolve(root, "dist/build/server/build.json"), "utf8")) as unknown,
  );
if (built.target !== buildTarget)
  throw new Error(`Build Goodfinds for ${buildTarget} before packaging (found ${built.target})`);
const mcp = z
  .object({ mcpServers: z.record(z.string(), z.record(z.string(), z.unknown())) })
  .loose()
  .parse(JSON.parse(readFileSync(resolve(root, "mcp.json"), "utf8")) as unknown);
// These launch settings belong to the Codex launch format. Portable
// MCP manifests reject them and can silently omit the entire server.
function codexServers(servers: Record<string, Record<string, unknown>>) {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      {
        ...Object.fromEntries(Object.entries(server).filter(([key]) => key !== "type")),
        cwd: ".",
        env_vars: [
          "PATH",
          "CODEX_HOME",
          "GOODFINDS_WORKSPACE_DIR",
          "GOODFINDS_EBAY_CLIENT_ID",
          "GOODFINDS_EBAY_CLIENT_SECRET",
        ],
      },
    ]),
  );
}
writeFileSync(
  resolve(root, ".mcp.json"),
  `${JSON.stringify({ mcpServers: codexServers(mcp.mcpServers) }, null, 2)}\n`,
);
mkdirSync(resolve(root, ".codex-plugin"), { recursive: true });
writeFileSync(
  resolve(root, ".codex-plugin/plugin.json"),
  `${JSON.stringify({ name: manifest.name, version: manifest.version, description: manifest.description, author: { name: "Goodfinds development" }, skills: "./skills", mcpServers: ".mcp.json", interface: { ...manifest.extensions["com.openai"].interface, developerName: "Local development", capabilities: ["Interactive", "Read", "Write"] } }, null, 2)}\n`,
);
const local = resolve(root, "dist", manifest.name),
  archive = resolve(root, "dist", `${manifest.name}-${manifest.version}-${buildTarget}.zip`);
rmSync(local, { recursive: true, force: true });
mkdirSync(local, { recursive: true });
const files: { source: string; target: string }[] = [
  { source: "plugin.json", target: "plugin.json" },
  { source: ".codex-plugin/plugin.json", target: ".codex-plugin/plugin.json" },
  { source: "dist/build/server/goodfinds", target: "server/goodfinds" },
  { source: "dist/build/server/build.json", target: "server/build.json" },
  {
    source: "packages/contracts/data/search-templates.json",
    target: "skills/marketplace-shopping/assets/search-templates.json",
  },
  {
    source: "packages/contracts/data/search-cover-sources.json",
    target: "assets/search-covers/sources.json",
  },
];
function walk(folder: string): void {
  for (const entry of readdirSync(resolve(root, folder), { withFileTypes: true })) {
    const path = `${folder}/${entry.name}`;
    if (entry.name === "__pycache__") continue;
    // Runtime assets are embedded; the TypeScript helper is for development only.
    if (path === "assets/search-covers" || path === "skills/marketplace-shopping/scripts") continue;
    if (entry.isDirectory()) walk(path);
    else if (!/\.(?:py|pyc)$/u.test(path)) files.push({ source: path, target: path });
  }
}
walk("skills");
walk("assets");
for (const file of files) {
  const target = resolve(local, file.target);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(resolve(root, file.source), target);
}
chmodSync(resolve(local, "server/goodfinds"), 0o755);
// Installed plugins have a self-contained layout independent of workspace source paths.
const packagedServers = Object.fromEntries(
  Object.entries(mcp.mcpServers).map(([name, server]) => [
    name,
    {
      ...server,
      command: z.string().parse(server["command"]).replace("./dist/build/", "./"),
    },
  ]),
);
writeFileSync(
  resolve(local, "mcp.json"),
  `${JSON.stringify({ ...mcp, mcpServers: packagedServers }, null, 2)}\n`,
);
writeFileSync(
  resolve(local, ".mcp.json"),
  `${JSON.stringify({ mcpServers: codexServers(packagedServers) }, null, 2)}\n`,
);
rmSync(archive, { force: true });
const zip = Bun.spawn(["zip", "-q", "-r", archive, "."], {
  cwd: local,
  stdout: "inherit",
  stderr: "inherit",
});
if ((await zip.exited) !== 0) throw new Error("Could not create the local plugin ZIP");
process.stdout.write(
  `${JSON.stringify({ archive, local_package: local, target: buildTarget, executable_bytes: statSync(resolve(local, "server/goodfinds")).size, files: files.length, status: "local prototype; not submitted or publicly approved", path: relative(root, archive) }, null, 2)}\n`,
);
