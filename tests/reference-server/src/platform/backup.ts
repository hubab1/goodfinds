import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import { storage } from "../workspace/errors.ts";
import { WORKSPACE_SCHEMA_VERSION } from "./database-schema.ts";

const fileSchema = z.object({
  path: z
    .string()
    .refine(
      (path) =>
        ["workspace.sqlite", "connections.sqlite"].includes(path) ||
        /^media\/[a-f0-9]{64}$/u.test(path),
    ),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  bytes: z.number().int().nonnegative(),
});
const manifestSchema = z
  .object({
    format: z.literal(1),
    schema_version: z.number().int().nonnegative(),
    created_at: z.iso.datetime(),
    files: z.array(fileSchema).min(1),
  })
  .strict();
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function regular(path: string) {
  if (!lstatSync(path).isFile()) throw new Error("Backup files must be regular files");
}
function verifyDatabase(path: string, workspace = true) {
  regular(path);
  const db = new Database(path, { readonly: true });
  try {
    const version =
      db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    if (workspace && version !== WORKSPACE_SCHEMA_VERSION)
      throw new Error("Unsupported workspace backup schema");
    if (
      db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check !==
      "ok"
    )
      throw new Error("The backup database failed its integrity check");
    return version;
  } finally {
    db.close();
  }
}
function snapshotDatabase(source: string, target: string) {
  regular(source);
  const db = new Database(source, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout=10000");
    // SQLite snapshots a live database, including committed WAL contents.
    db.run("VACUUM INTO ?", [target]);
  } finally {
    db.close();
  }
}
function stage(output: string, work: (folder: string) => void) {
  if (existsSync(output))
    throw new Error("Choose a new output directory; existing workspaces and backups are preserved");
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const folder = mkdtempSync(resolve(dirname(output), ".goodfinds-backup-"));
  try {
    work(folder);
    if (existsSync(output))
      throw new Error("The output directory was created elsewhere; choose a new directory");
    renameSync(folder, output);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

export const backupWorkspace = (database: string, output: string) =>
  storage("back up workspace", () => {
    const source = resolve(database),
      destination = resolve(output),
      workspace = dirname(source);
    const media = resolve(
      basename(workspace) === "sample" ? dirname(workspace) : workspace,
      "media",
    );
    if (destination === workspace || !relative(media, destination).startsWith(".."))
      throw new Error("Choose a separate backup directory outside the media cache");
    let files: z.infer<typeof fileSchema>[] = [];
    stage(destination, (folder) => {
      snapshotDatabase(source, resolve(folder, "workspace.sqlite"));
      const schemaVersion = verifyDatabase(resolve(folder, "workspace.sqlite"));
      const diagnostics = resolve(workspace, "connections.sqlite");
      if (existsSync(diagnostics))
        snapshotDatabase(diagnostics, resolve(folder, "connections.sqlite"));

      if (existsSync(media)) {
        if (!lstatSync(media).isDirectory() || lstatSync(media).isSymbolicLink())
          throw new Error("The media cache must be a local directory");
        mkdirSync(resolve(folder, "media"), { mode: 0o700 });
        for (const name of readdirSync(media).filter((entry) => /^[a-f0-9]{64}$/u.test(entry))) {
          const path = resolve(media, name);
          regular(path);
          const bytes = readFileSync(path);
          if (digest(bytes) !== name)
            throw new Error("A cached media file failed its content-hash check");
          writeFileSync(resolve(folder, "media", name), bytes, { flag: "wx", mode: 0o600 });
        }
      }
      const names = ["workspace.sqlite", "connections.sqlite"].filter((name) =>
        existsSync(resolve(folder, name)),
      );
      if (existsSync(resolve(folder, "media")))
        names.push(...readdirSync(resolve(folder, "media")).map((name) => `media/${name}`));
      files = names.toSorted().map((path) => {
        const bytes = readFileSync(resolve(folder, path));
        return { path, bytes: bytes.length, sha256: digest(bytes) };
      });
      writeFileSync(
        resolve(folder, "manifest.json"),
        JSON.stringify(
          { format: 1, schema_version: schemaVersion, created_at: new Date().toISOString(), files },
          null,
          2,
        ) + "\n",
        { flag: "wx", mode: 0o600 },
      );
    });
    return { backup: destination, files: files.length };
  });

export const restoreWorkspace = (input: string, output: string) =>
  storage("restore workspace", () => {
    const source = resolve(input),
      destination = resolve(output);
    regular(resolve(source, "manifest.json"));
    const manifest = manifestSchema.parse(
      JSON.parse(readFileSync(resolve(source, "manifest.json"), "utf8")) as unknown,
    );
    if (manifest.schema_version !== WORKSPACE_SCHEMA_VERSION)
      throw new Error("This backup uses an unsupported workspace schema");
    if (
      !manifest.files.some((file) => file.path === "workspace.sqlite") ||
      new Set(manifest.files.map((file) => file.path)).size !== manifest.files.length
    )
      throw new Error("Invalid backup file manifest");
    stage(destination, (folder) => {
      for (const file of manifest.files) {
        const path = resolve(source, file.path);
        regular(path);
        if (file.path.startsWith("media/") && lstatSync(resolve(source, "media")).isSymbolicLink())
          throw new Error("Backup media cannot use a symbolic link");
        const bytes = readFileSync(path);
        if (
          bytes.length !== file.bytes ||
          digest(bytes) !== file.sha256 ||
          (file.path.startsWith("media/") && basename(file.path) !== file.sha256)
        )
          throw new Error("The backup file failed its checksum");
        mkdirSync(dirname(resolve(folder, file.path)), { recursive: true, mode: 0o700 });
        writeFileSync(resolve(folder, file.path), bytes, { flag: "wx", mode: 0o600 });
      }
      if (verifyDatabase(resolve(folder, "workspace.sqlite")) !== manifest.schema_version)
        throw new Error("Backup schema version does not match its manifest");
      verifyDatabase(resolve(folder, "workspace.sqlite"), true);
      if (existsSync(resolve(folder, "connections.sqlite")))
        verifyDatabase(resolve(folder, "connections.sqlite"), false);
    });
    return { workspace: destination, database: resolve(destination, "workspace.sqlite") };
  }).pipe(Effect.withSpan("restoreWorkspace"));
