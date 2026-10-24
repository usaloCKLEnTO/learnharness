import assert from "node:assert/strict";
import { it } from "node:test";
import { createTranscriptionService } from "../src/server/transcription.ts";
import { pcmWave } from "../src/core/dictation.ts";

it("encodes every PCM sample, including the partial final frame, as mono WAV", async () => {
	const blob = pcmWave([new Int16Array([32767, -32768]), new Int16Array([123])], 16000);
	const view = new DataView(await blob.arrayBuffer());
	assert.equal(blob.type, "audio/wav");
	assert.equal(blob.size, 50);
	assert.equal(view.getUint32(24, true), 16000);
	assert.equal(view.getUint32(40, true), 6);
	assert.equal(view.getInt16(44, true), 32767);
	assert.equal(view.getInt16(46, true), -32768);
	assert.equal(view.getInt16(48, true), 123);
});

it("keeps the model and bearer server-owned and returns only the transcript", async () => {
	const service = createTranscriptionService({
		configuration: () => ({ baseUrl: "https://gateway.test/v1", transcriptionModel: "stt/qwen" }),
		key: () => "synthetic-private-key",
		send: async (url, options) => {
			assert.equal(url, "https://gateway.test/v1/audio/transcriptions");
			assert.equal(new Headers(options?.headers).get("authorization"), "Bearer synthetic-private-key");
			assert.ok(options?.body instanceof FormData);
			assert.equal(options.body.get("model"), "stt/qwen");
			assert.equal((options.body.get("file") as File).name, "dictation.wav");
			return Response.json({ text: "  Hello Qwen.  ", private_metadata: "not returned" });
		},
	});
	const form = new FormData();
	form.set("file", pcmWave([new Int16Array([1, 2, 3])], 16000), "dictation.wav");
	form.set("model", "client-cannot-override");
	const response = await service.POST(new Request("http://local/api/stt/transcribe", { method: "POST", body: form }));
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { text: "Hello Qwen." });
	assert.deepEqual(await service.GET().json(), { available: true });
});

it("refuses missing configuration, missing keys, and invalid uploads before transport", async () => {
	for (const configuration of [undefined, { baseUrl: "https://gateway.test/v1", transcriptionModel: "stt/qwen" }]) {
		const service = createTranscriptionService({
			configuration: () => configuration, key: () => undefined,
			send: async () => { throw new Error("must not call transport"); },
		});
		assert.equal(service.GET().status, 503);
		assert.equal((await service.POST(new Request("http://local", { method: "POST" }))).status, 503);
	}
	const service = createTranscriptionService({
		configuration: () => ({ baseUrl: "https://gateway.test/v1", transcriptionModel: "stt/qwen" }),
		key: () => "synthetic-key", send: async () => { throw new Error("must not call transport"); },
	});
	const form = new FormData(); form.set("file", "not an audio file");
	assert.equal((await service.POST(new Request("http://local", { method: "POST", body: form }))).status, 400);
});

it("does not expose upstream error bodies or accept malformed transcripts", async () => {
	for (const upstream of [Response.json({ error: "sensitive details" }, { status: 403 }), Response.json({ text: 123 })]) {
		const service = createTranscriptionService({
			configuration: () => ({ baseUrl: "https://gateway.test/v1", transcriptionModel: "stt/qwen" }),
			key: () => "synthetic-key", send: async () => upstream,
		});
		const form = new FormData(); form.set("file", pcmWave([new Int16Array([1])], 16000), "audio.wav");
		const response = await service.POST(new Request("http://local", { method: "POST", body: form }));
		assert.equal(response.status, 502);
		assert.ok(!(await response.text()).includes("sensitive details"));
	}
});
