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

it("streams parallel Responses tool calls for an opted-in model and keeps other models on Chat Completions", async () => {
	const previousFetch = globalThis.fetch;
	const previousKey = process.env.LITELLM_API_KEY;
	process.env.LITELLM_API_KEY = "synthetic-gateway-key";
	const requests: unknown[] = [];
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		assert.equal(request.url, "https://gateway.test/v1/responses");
		assert.equal(request.headers.get("x-session-id"), "parallel-lesson");
		requests.push(await request.json());
		const calls = [
			{ id: "fc_a", type: "function_call", call_id: "call_a", name: "web_search", arguments: '{"query":"first source"}' },
			{ id: "fc_b", type: "function_call", call_id: "call_b", name: "web_search", arguments: '{"query":"second source"}' },
		];
		const events: unknown[] = [];
		for (const [index, item] of calls.entries()) {
			events.push({ type: "response.output_item.added", output_index: index, item: { ...item, status: "in_progress", arguments: "" } });
			events.push({ type: "response.function_call_arguments.delta", output_index: index, delta: item.arguments });
			events.push({ type: "response.output_item.done", output_index: index, item });
		}
		events.push({ type: "response.completed", response: { id: "resp_parallel", status: "completed", output: calls, usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } });
		return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
	};
	try {
		const models = createModels();
		models.setProvider(createLiteLLMProvider({ baseUrl: "https://gateway.test/v1", models: [
			model, { ...model, id: "codex-proxy/gpt-6-luna", api: "openai-responses" },
		] }));
		assert.equal(models.getModel("litellm", "gateway/test-model")?.api, "openai-completions");
		const selected = models.getModel("litellm", "codex-proxy/gpt-6-luna")!;
		const result = await models.streamSimple(selected, {
			messages: [{ role: "user", content: "Search two sources", timestamp: 1 }],
			tools: [{ name: "web_search", description: "Search", parameters: Type.Object({ query: Type.String() }) }],
		}, { sessionId: "parallel-lesson" }).result();
		assert.equal(result.stopReason, "toolUse");
		assert.deepEqual(result.content.filter((part) => part.type === "toolCall").map((part) => part.arguments), [
			{ query: "first source" }, { query: "second source" },
		]);
		const body = z.object({ model: z.string(), stream: z.boolean(), parallel_tool_calls: z.boolean().optional() }).parse(requests[0]);
		assert.equal(body.model, "codex-proxy/gpt-6-luna");
		assert.equal(body.stream, true);
		assert.notEqual(body.parallel_tool_calls, false);
	} finally {
		globalThis.fetch = previousFetch;
		if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
		else process.env.LITELLM_API_KEY = previousKey;
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
