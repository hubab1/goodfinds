#!/usr/bin/env bun
import { runCliMain } from "@goodfinds/server/cli";

await runCliMain(process.argv.slice(2));
