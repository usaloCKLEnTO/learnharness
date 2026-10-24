import assert from "node:assert/strict";
import { it } from "node:test";
import { exaProvider, resolveSearchEngineFor } from "../src/server/search.ts";

it("offers Exa, preserves Brave automatic preference, and requires the pinned key", () => {
	assert.equal(resolveSearchEngineFor(undefined, { exa: "synthetic" }).engine, "exa");
	assert.equal(resolveSearchEngineFor(undefined, { brave: "synthetic", exa: "synthetic" }).engine, "brave");
	assert.equal(resolveSearchEngineFor("exa", { brave: "synthetic", exa: "synthetic" }).engine, "exa");
	const unavailable = resolveSearchEngineFor("exa", { brave: "synthetic" });
	assert.equal(unavailable.available, false);
	assert.match(unavailable.reason, /EXA_API_KEY/);
});

it("authenticates with a header and converts Exa highlights to search snippets", async () => {
	const provider = exaProvider("synthetic-exa-key", async (url, init) => {
		assert.equal(url, "https://api.exa.ai/search");
		assert.equal(init.method, "POST");
		assert.equal(new Headers(init.headers).get("x-api-key"), "synthetic-exa-key");
		assert.deepEqual(JSON.parse(String(init.body)), {
			query: "test", numResults: 5, type: "auto", contents: { highlights: true },
		});
		return Response.json({ results: [{ title: "Example", url: "https://example.com", highlights: ["First\nline", "Second"] }] });
	});
	assert.deepEqual(await provider.search("test", 5), [{ title: "Example", url: "https://example.com", snippet: "First line Second" }]);
});

it("rejects malformed Exa responses and excludes upstream error bodies", async () => {
	const malformed = exaProvider("synthetic-exa-key", async () => Response.json({ results: [{ url: 123 }] }));
	await assert.rejects(malformed.search("q", 5), /invalid results/);
	const denied = exaProvider("synthetic-exa-key", async () => Response.json({ message: "private details" }, { status: 403 }));
	await assert.rejects(denied.search("q", 5), { message: "Exa search API 403" });
});
