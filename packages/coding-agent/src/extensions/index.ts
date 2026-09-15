import type { InlineExtension } from "../core/extensions/types.ts";
import llamaExtension from "./llama/index.ts";
import museExtension from "./muse.ts";
import museCronExtension from "./muse-cron.ts";
import museGoalsExtension from "./muse-goals.ts";
import museRsiExtension from "./muse-rsi.ts";
import museSubagentsExtension from "./muse-subagents.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "muse", factory: museExtension, hidden: true },
	{ name: "muse-goals", factory: museGoalsExtension, hidden: true },
	{ name: "muse-cron", factory: museCronExtension, hidden: true },
	{ name: "muse-subagents", factory: museSubagentsExtension, hidden: true },
	{ name: "muse-rsi", factory: museRsiExtension, hidden: true },
];
