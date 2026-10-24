import { localLiteLLMConfig } from "../agent/litellm-provider.ts";
import { keyValue } from "./keys.ts";

interface TranscriptionDependencies {
	configuration: () => { baseUrl: string; transcriptionModel?: string } | undefined;
	key: () => string | undefined;
	send: typeof fetch;
}

export function createTranscriptionService(deps: TranscriptionDependencies) {
	const unavailable = () => Response.json({ message: "Dictation needs the LiteLLM connection" }, { status: 503 });
	return {
		GET() {
			const config = deps.configuration();
			return config?.transcriptionModel && deps.key() ? Response.json({ available: true }) : unavailable();
		},
		async POST(request: Request) {
			const config = deps.configuration();
			const key = deps.key();
			if (!config?.transcriptionModel || !key) return unavailable();
			if (Number(request.headers.get("content-length")) > 25 * 1024 * 1024) {
				return Response.json({ message: "Recording is too large" }, { status: 413 });
			}
			let form: FormData;
			try { form = await request.formData(); } catch {
				return Response.json({ message: "Expected an audio upload" }, { status: 400 });
			}
			const file = form.get("file");
			if (!(file instanceof File) || file.size === 0 || file.size > 25 * 1024 * 1024) {
				return Response.json({ message: "Expected a nonempty audio file under 25 MiB" }, { status: 400 });
			}
			const upload = new FormData();
			upload.set("file", file);
			// The server owns the model and credential; neither comes from the renderer.
			upload.set("model", config.transcriptionModel);
			try {
				const response = await deps.send(`${config.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
					method: "POST", headers: { Authorization: `Bearer ${key}` }, body: upload,
					signal: AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]),
				});
				if (!response.ok) return Response.json({ message: `Dictation service failed (${response.status})` }, { status: 502 });
				const raw: unknown = await response.json();
				if (!raw || typeof raw !== "object" || !("text" in raw) || typeof raw.text !== "string") {
					return Response.json({ message: "Dictation service returned an invalid transcript" }, { status: 502 });
				}
				return Response.json({ text: raw.text.trim() });
			} catch {
				return Response.json({ message: "Dictation service is unavailable" }, { status: 502 });
			}
		},
	};
}

export const transcription = createTranscriptionService({
	configuration: localLiteLLMConfig,
	key: () => keyValue("LITELLM_API_KEY"),
	send: (...args) => fetch(...args),
});
