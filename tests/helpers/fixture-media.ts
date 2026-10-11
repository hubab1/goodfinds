import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
// One real, content-addressed PNG for tests that import a saved gallery.
const bytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=",
  "base64",
);
export function fixtureImage(root: string) {
  const id = createHash("sha256").update(bytes).digest("hex");
  mkdirSync(resolve(root, "media"), { recursive: true });
  writeFileSync(resolve(root, "media", id), bytes);
  return id;
}
