/** The recorder keeps PCM locally until Stop; the final partial frame is included. */
export const MAX_DICTATION_PCM_BYTES = 20 * 1024 * 1024;

export function pcmWave(frames: readonly Int16Array[], sampleRate: number): Blob {
	const bytes = frames.reduce((total, frame) => total + frame.byteLength, 0);
	if (!Number.isInteger(sampleRate) || sampleRate <= 0 || bytes > MAX_DICTATION_PCM_BYTES) {
		throw new Error("Invalid or oversized dictation recording");
	}
	const buffer = new ArrayBuffer(44 + bytes);
	const view = new DataView(buffer);
	const ascii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};
	ascii(0, "RIFF"); view.setUint32(4, 36 + bytes, true); ascii(8, "WAVE");
	ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
	view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true);
	view.setUint16(34, 16, true); ascii(36, "data"); view.setUint32(40, bytes, true);
	let offset = 44;
	for (const frame of frames) {
		for (const sample of frame) { view.setInt16(offset, sample, true); offset += 2; }
	}
	return new Blob([buffer], { type: "audio/wav" });
}

export function dictationResponse(raw: unknown): { text?: string; message?: string } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid dictation response");
	const value = raw as Record<string, unknown>;
	if (typeof value.text === "string") return { text: value.text };
	if (typeof value.message === "string") return { message: value.message };
	throw new Error("Invalid dictation response");
}
