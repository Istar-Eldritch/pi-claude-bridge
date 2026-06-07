// Canonical selection + display order for the model picker.
// `resolveModelId` returns the first partial match, so `opus` resolves to the first-listed opus entry.
// Extracted from index.ts so tests can import without activating the extension.

export const MODEL_IDS_IN_ORDER = [
	"claude-opus-4-8",
	"claude-opus-4-7",
	"claude-opus-4-6",
	"claude-sonnet-4-6",
	"claude-haiku-4-5",
];

// Per-model field overrides for cases where the pi-ai registry value doesn't
// match the effective limit on the headless/SDK transport we use.
// Key: model id, Value: partial model fields to override after the find.
// When use1MContext is enabled, models that support 1M are left at their
// advertised window so pi compacts at the correct (higher) threshold.
const MODEL_OVERRIDES_200K: Record<string, Record<string, any>> = {
	// These models advertise a 1M context window in pi-ai, but the CC SDK
	// (headless/SDK) transport caps them at 200K by default.
	// Advertising 1M without the beta would prevent pi from compacting,
	// leading to "Prompt is too long" server-side rejections.
	"claude-opus-4-8": { contextWindow: 200_000 },
	"claude-sonnet-4-6": { contextWindow: 200_000 },
};

// Models that support 1M context via context-1m-2025-08-07 beta.
const MODELS_WITH_1M_SUPPORT = new Set(["claude-sonnet-4-6"]);

// Project pi-ai's model entries down to the fields pi's registerProvider expects,
// and keep MODEL_IDS_IN_ORDER ordering. IDs missing from pi-ai are silently dropped.
export function buildModels<T extends { id: string; [key: string]: any }>(
	piAiModels: T[],
	{ use1MContext = false }: { use1MContext?: boolean } = {},
) {
	return (
		MODEL_IDS_IN_ORDER.map((id) => {
			const found = piAiModels.find((m) => m.id === id);
			if (!found) return undefined;
			// Skip the 200K cap override for models that have 1M support when
			// the user has opted in, so pi compacts at the correct threshold.
			const skip1MCap = use1MContext && MODELS_WITH_1M_SUPPORT.has(id);
			const overrides = skip1MCap ? undefined : MODEL_OVERRIDES_200K[id];
			return overrides ? ({ ...found, ...overrides } as T) : found;
		})
			.filter((m) => m != null)
			// Forward thinkingLevelMap so per-model overrides (e.g. opus-4-7 mapping
			// xhigh→xhigh instead of xhigh→max) are visible to the effort lookup.
			.map(
				({
					id,
					name,
					reasoning,
					input,
					contextWindow,
					maxTokens,
					thinkingLevelMap,
				}) => ({
					id,
					name,
					reasoning,
					input,
					contextWindow,
					maxTokens,
					thinkingLevelMap,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				}),
			)
	);
}

export function resolveModelId(
	models: Array<{ id: string }>,
	input: string,
): string {
	const lower = input.toLowerCase();
	const match = models.find((m) => m.id === lower || m.id.includes(lower));
	return match ? match.id : input;
}
