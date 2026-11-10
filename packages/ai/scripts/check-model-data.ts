#!/usr/bin/env node

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateGeneratedModelData } from "./model-data.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

try {
	validateGeneratedModelData(packageRoot);
	console.log("Generated model data is valid.");
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	console.error(
		"\nModel data is missing or stale. The snapshot under src/providers/data/ is version-controlled: restore it from git, or refresh it with `npm run hydrate:model-data` from the repository root and commit the result.",
	);
	process.exitCode = 1;
}
