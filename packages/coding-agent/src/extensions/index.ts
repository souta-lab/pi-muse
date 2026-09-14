import type { InlineExtension } from "../core/extensions/types.ts";
import llamaExtension from "./llama/index.ts";
import museExtension from "./muse.ts";
import museSubagentsExtension from "./muse-subagents.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "muse", factory: museExtension, hidden: true },
	{ name: "muse-subagents", factory: museSubagentsExtension, hidden: true },
];
