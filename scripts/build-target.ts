import { z } from "zod";

// Each archive contains one executable for the selected operating system and CPU.
export const buildTarget = z
  .enum([
    "bun-darwin-arm64",
    "bun-darwin-x64",
    "bun-linux-arm64",
    "bun-linux-x64",
    "bun-linux-arm64-musl",
    "bun-linux-x64-musl",
  ])
  .parse(process.env["GOODFINDS_BUILD_TARGET"] ?? `bun-${process.platform}-${process.arch}`);
