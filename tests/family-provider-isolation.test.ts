import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-family-keys-"));
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
process.env.LH_PROVIDER_FILE = path.join(dir, "providers.json");
process.env.LH_IGNORE_ENV_KEYS = "1";
process.env.OPENAI_API_KEY = "synthetic-inherited-openai";
process.env.ANTHROPIC_API_KEY = "synthetic-inherited-anthropic";
fs.writeFileSync(process.env.LH_AUTH_FILE, JSON.stringify({ LITELLM_API_KEY: "synthetic-saved-gateway" }));
fs.writeFileSync(process.env.LH_PROVIDER_FILE, JSON.stringify({
	baseUrl: "https://gateway.test/v1", transcriptionModel: "stt/qwen",
	models: [{ id: "codex-proxy/selected", name: "Codex", contextWindow: 8192, maxTokens: 1024,
		reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
}));
const { modelCatalog } = await import("../src/server/model-catalog.ts");
const { piModels } = await import("../src/agent/models.ts");
after(() => fs.rmSync(dir, { recursive: true }));

it("drops inherited vendor credentials and offers only models reachable through the saved gateway", async () => {
	const catalog = modelCatalog();
	assert.deepEqual(catalog.models.map(({ provider, id }) => ({ provider, id })), [
		{ provider: "litellm", id: "codex-proxy/selected" },
	]);
	assert.equal(process.env.OPENAI_API_KEY, undefined);
	assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
	assert.equal(await piModels().getAuth("openai"), undefined);
	assert.equal(await piModels().getAuth("anthropic"), undefined);
	assert.equal((await piModels().getAuth("litellm"))?.auth.apiKey, "synthetic-saved-gateway");
});
