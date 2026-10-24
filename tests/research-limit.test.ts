import assert from "node:assert/strict";
import { it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { runResearcherAgent } from "../src/agent/subagents/researcher.ts";

it("reports the research step limit instead of an empty brief after repeated tool calls", async () => {
	const faux = createFauxCore({});
	faux.setResponses(Array.from({ length: 12 }, () => () =>
		fauxAssistantMessage([fauxToolCall("web_search", { query: "source" })], { stopReason: "toolUse" })));
	await assert.rejects(runResearcherAgent("Find sources", {
		engine: { model: faux.getModel(), streamFn: faux.streamSimple },
		search: () => ({ id: "exa", search: async () => [] }),
	}), /Research reached its 12-step limit before producing a final brief/);
});

it("accepts a final brief produced on the last permitted step", async () => {
	const faux = createFauxCore({});
	faux.setResponses([
		...Array.from({ length: 11 }, () => () =>
			fauxAssistantMessage([fauxToolCall("web_search", { query: "source" })], { stopReason: "toolUse" })),
		() => fauxAssistantMessage([fauxText("A sourced brief.")], { stopReason: "stop" }),
	]);
	assert.equal(await runResearcherAgent("Find sources", {
		engine: { model: faux.getModel(), streamFn: faux.streamSimple },
		search: () => ({ id: "exa", search: async () => [] }),
	}), "A sourced brief.");
});
