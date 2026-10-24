import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { createModels, Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import { createLiteLLMProvider, localLiteLLMProvider } from "../src/agent/litellm-provider.ts";

const model = {
	id: "gateway/test-model", name: "Gateway test", contextWindow: 8192, maxTokens: 1024,
	reasoning: true, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
	compat: { supportsReasoningEffort: true, sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" },
};

it("rejects invalid endpoints, duplicate IDs, and malformed limits before registering a provider", () => {
	for (const baseUrl of ["file:///tmp/provider", "https://user:secret@example.test/v1", "https://example.test/v1?key=secret"]) {
		assert.throws(() => createLiteLLMProvider({ baseUrl, models: [model] }));
	}
	assert.throws(() => createLiteLLMProvider({ baseUrl: "https://example.test/v1", models: [model, model] }));
	assert.throws(() => createLiteLLMProvider({ baseUrl: "https://example.test/v1", models: [{ ...model, maxTokens: -1 }] }));
});

it("loads optional local configuration and refuses corrupt configuration", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "lh-gateway-"));
	try {
		const file = path.join(dir, "providers.json");
		assert.equal(localLiteLLMProvider(file), undefined);
		writeFileSync(file, JSON.stringify({ baseUrl: "https://example.test/v1/", models: [model] }));
		assert.equal(localLiteLLMProvider(file)?.getModels()[0]?.baseUrl, "https://example.test/v1");
		writeFileSync(file, "{bad json");
		assert.throws(() => localLiteLLMProvider(file));
	} finally {
		rmSync(dir, { recursive: true });
	}
});

it("uses only the gateway key and URL, preserves session identity, and parses streamed tool calls", async () => {
	const previousKey = process.env.LITELLM_API_KEY;
	process.env.LITELLM_API_KEY = "synthetic-gateway-key";
	const previousFetch = globalThis.fetch;
	const bodies: unknown[] = [];
	const headers: Headers[] = [];
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		assert.equal(request.url, "https://gateway.test/v1/chat/completions");
		headers.push(request.headers);
		bodies.push(await request.json());
		const delta = { tool_calls: [{ index: 0, id: "call_test", type: "function", function: { name: "confirm", arguments: '{"value":"READY"}' } }] };
		const data = [
			{ choices: [{ index: 0, delta, finish_reason: null }] },
			{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
		].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
		return new Response(data, { headers: { "content-type": "text/event-stream" } });
	};
	try {
		const models = createModels();
		models.setProvider(createLiteLLMProvider({ baseUrl: "https://gateway.test/v1", models: [model] }));
		const selected = models.getModel("litellm", "gateway/test-model")!;
		for (let turn = 0; turn < 2; turn++) {
			const result = await models.streamSimple(selected, {
				messages: [{ role: "user", content: "Confirm READY", timestamp: 1 }],
				tools: [{ name: "confirm", description: "Confirm the value", parameters: Type.Object({ value: Type.String() }) }],
			}, { sessionId: "lesson-42", reasoning: "high" }).result();
			assert.equal(result.stopReason, "toolUse");
			assert.deepEqual(result.content, [{ type: "toolCall", id: "call_test", name: "confirm", arguments: { value: "READY" } }]);
		}
		const bodySchema = z.object({ model: z.string(), reasoning_effort: z.string(), stream: z.boolean() });
		for (const raw of bodies) {
			assert.deepEqual(bodySchema.parse(raw), { model: "gateway/test-model", reasoning_effort: "high", stream: true });
		}
		for (const received of headers) {
			assert.equal(received.get("authorization"), "Bearer synthetic-gateway-key");
			assert.equal(received.get("x-session-id"), "lesson-42");
		}
	} finally {
		globalThis.fetch = previousFetch;
		if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
		else process.env.LITELLM_API_KEY = previousKey;
	}
});
