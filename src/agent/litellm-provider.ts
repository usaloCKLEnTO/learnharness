import fs from "node:fs";
import { createProvider, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { z } from "zod";
import { PROVIDER_FILE } from "../../config.ts";

const level = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const modelSchema = z.object({
	id: z.string().min(1),
	api: z.enum(["openai-completions", "openai-responses"]).default("openai-completions"),
	name: z.string().min(1),
	contextWindow: z.number().int().positive(),
	maxTokens: z.number().int().positive(),
	reasoning: z.boolean(),
	input: z.array(z.enum(["text", "image"])).min(1),
	cost: z.object({
		input: z.number().nonnegative(), output: z.number().nonnegative(),
		cacheRead: z.number().nonnegative(), cacheWrite: z.number().nonnegative(),
	}).strict(),
	thinkingLevelMap: z.partialRecord(level, z.string().nullable()).optional(),
	compat: z.object({
		supportsStore: z.boolean().optional(),
		supportsDeveloperRole: z.boolean().optional(),
		supportsReasoningEffort: z.boolean().optional(),
		sendSessionAffinityHeaders: z.boolean().optional(),
		sessionAffinityFormat: z.enum(["openai", "openai-nosession", "openrouter"]).optional(),
		maxTokensField: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
		requiresReasoningContentOnAssistantMessages: z.boolean().optional(),
	}).strict().optional(),
}).strict();

const gatewaySchema = z.object({
	baseUrl: z.url().refine((url) => {
		const parsed = new URL(url);
		return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password
			&& !parsed.search && !parsed.hash;
	}, "Expected an HTTP(S) base URL without credentials, query, or fragment"),
	models: z.array(modelSchema).min(1),
	transcriptionModel: z.string().min(1).optional(),
}).strict().refine((config) => new Set(config.models.map((model) => model.id)).size === config.models.length,
	"Model IDs must be unique");

export function createLiteLLMProvider(raw: unknown) {
	const config = gatewaySchema.parse(raw);
	const baseUrl = config.baseUrl.replace(/\/+$/, "");
	const models: Model<"openai-completions" | "openai-responses">[] = config.models.map((model) => ({
		...model, provider: "litellm", baseUrl,
	}));
	return createProvider({
		id: "litellm", name: "LiteLLM", baseUrl,
		auth: { apiKey: envApiKeyAuth("LiteLLM API key", ["LITELLM_API_KEY"]) },
		models, api: {
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
		},
	});
}

/** Missing is optional. Invalid configuration fails visibly instead of routing elsewhere. */
export function localLiteLLMProvider(file = PROVIDER_FILE) {
	const config = localLiteLLMConfig(file);
	return config ? createLiteLLMProvider(config) : undefined;
}

export function localLiteLLMConfig(file = PROVIDER_FILE) {
	if (!fs.existsSync(file)) return undefined;
	return gatewaySchema.parse(JSON.parse(fs.readFileSync(file, "utf-8")));
}
