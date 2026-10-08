import { writeFile } from "node:fs/promises";
import { checkStateModelDocs, formattedStateModel, stateModelPath } from "./state-model-docs.ts";
if (process.argv.includes("--check")) {
  await checkStateModelDocs();
  process.stdout.write("State model documentation is current.\n");
} else {
  await writeFile(stateModelPath, await formattedStateModel());
  process.stdout.write(`Generated ${stateModelPath}\n`);
}
