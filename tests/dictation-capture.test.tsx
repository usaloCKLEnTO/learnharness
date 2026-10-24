import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { useDictation, type Dictation } from "../components/dictation.tsx";

const dom = parseHTML("<html><body></body></html>");
let stopped = 0;
let worklet: FakeWorklet;
class FakeWorklet {
	port = {
		onmessage: null as ((event: { data: unknown }) => void) | null,
		postMessage: (_message: unknown) => queueMicrotask(() => {
			this.port.onmessage?.({ data: { type: "audio", buffer: new Int16Array([3]) } });
			this.port.onmessage?.({ data: { type: "flushed" } });
		}),
	};
	constructor() { worklet = this; }
	connect() {}
	disconnect() {}
}
class FakeContext {
	sampleRate = 16000;
	state = "running";
	destination = {};
	audioWorklet = { addModule: async () => {} };
	createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
}
Object.assign(globalThis, {
	React, window: dom.window, document: dom.document,
	AudioContext: FakeContext, AudioWorkletNode: FakeWorklet,
	IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
	mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => { stopped++; } }] }) },
} });
const originalFetch = globalThis.fetch;
let root: Root | null = null;
let host: HTMLElement;
let driver: Dictation;
let resolveTranscript: (response: Response) => void;
let received: FormData | undefined;
const appended: string[] = [];

async function mount() {
	stopped = 0; appended.length = 0; received = undefined;
	globalThis.fetch = async (url, options) => {
		assert.equal(url, "/api/stt/transcribe");
		if (!options?.method) return Response.json({ available: true });
		assert.equal(options.method, "POST");
		assert.ok(stopped > 0, "microphone stops before uploading");
		assert.ok(options.body instanceof FormData);
		received = options.body;
		return new Promise((resolve) => { resolveTranscript = resolve; });
	};
	host = document.createElement("div"); document.body.appendChild(host);
	root = createRoot(host);
	function Harness() { driver = useDictation({ append: (text) => appended.push(text) }); return null; }
	await act(async () => { root!.render(<Harness />); });
	await act(async () => { driver.toggle(); });
	assert.equal(driver.phase, "recording");
	worklet.port.onmessage?.({ data: { type: "audio", buffer: new Int16Array([1, 2]) } });
}

afterEach(async () => {
	await act(async () => { root?.unmount(); });
	host?.remove(); root = null; globalThis.fetch = originalFetch;
});

it("finish waits for the transcription and includes the recorder's final partial frame", async () => {
	await mount();
	let finished = false;
	let finish: Promise<void>;
	await act(async () => { finish = driver.finish().then(() => { finished = true; }); });
	assert.equal(driver.phase, "stopping");
	assert.equal(finished, false);
	assert.deepEqual(appended, []);
	const wav = received?.get("file"); assert.ok(wav instanceof File);
	const bytes = new DataView(await wav.arrayBuffer());
	assert.equal(bytes.getUint32(40, true), 6);
	assert.deepEqual([bytes.getInt16(44, true), bytes.getInt16(46, true), bytes.getInt16(48, true)], [1, 2, 3]);
	await act(async () => { resolveTranscript(Response.json({ text: "The final words." })); await finish; });
	assert.equal(finished, true);
	assert.equal(driver.phase, "idle");
	assert.deepEqual(appended, ["The final words."]);
});

it("cancel during transcription discards a late result instead of inserting it", async () => {
	await mount();
	await act(async () => { driver.stop(); });
	assert.equal(driver.phase, "stopping");
	await act(async () => { driver.cancel(); });
	assert.equal(driver.phase, "idle");
	await act(async () => { resolveTranscript(Response.json({ text: "Discarded words." })); });
	assert.deepEqual(appended, []);
});
