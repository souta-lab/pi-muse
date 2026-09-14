import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { MUSE_SYSTEM_PROMPT } from "../src/core/muse-system-prompt.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { MUSE_TOOL_NAMES } from "../src/core/tools/muse.ts";
import { builtInExtensions } from "../src/extensions/index.ts";

describe("pi-muse CLI defaults", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), `pi-muse-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`));
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("exposes only the six Muse tools and uses the Muse system prompt", async () => {
		const settingsManager = SettingsManager.inMemory();
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir,
			settingsManager,
			resourceLoaderOptions: {
				defaultSystemPrompt: MUSE_SYSTEM_PROMPT,
				extensionFactories: builtInExtensions,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(tempDir),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			tools: [...MUSE_TOOL_NAMES],
		});

		expect(session.getActiveToolNames()).toEqual([...MUSE_TOOL_NAMES]);
		expect(session.getActiveToolNames()).not.toContain("read");
		expect(session.getActiveToolNames()).not.toContain("grep");
		expect(session.systemPrompt).toContain("You are Muse Code");
		expect(session.systemPrompt).toContain("Muse Code powered by Meta Muse Spark");
		expect(session.systemPrompt).not.toContain("Available tools:");
		session.dispose();
	});

	it("registers the Meta Muse provider with Muse Spark 1.3", async () => {
		const settingsManager = SettingsManager.inMemory();
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir,
			settingsManager,
			resourceLoaderOptions: {
				defaultSystemPrompt: MUSE_SYSTEM_PROMPT,
				extensionFactories: builtInExtensions,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});

		const model = services.modelRuntime.getModel("muse", "muse-spark-1.3");
		expect(model?.id).toBe("muse-spark-1.3");
		expect(model?.api).toBe("openai-responses");
		expect(model?.reasoning).toBe(true);
	});
});
