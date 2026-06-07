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
// See https://github.com/elidickinson/pi-claude-bridge/issues/22
const MODEL_OVERRIDES: Record<string, Record<string, any>> = {
	// These models advertise a 1M context window in pi-ai, but the CC SDK
	// (headless/SDK) transport caps them at 200K. Advertising 1M would prevent
	// pi from compacting, leading to "Prompt is too long" server-side rejections.
	// See https://github.com/elidickinson/pi-claude-bridge/issues/22
	"claude-opus-4-8": { contextWindow: 200_000 },
	"claude-sonnet-4-6": { contextWindow: 200_000 },
};

// Project pi-ai's model entries down to the fields pi's registerProvider expects,
// and keep MODEL_IDS_IN_ORDER ordering. IDs missing from pi-ai are silently dropped.
export function buildModels<T extends { id: string; [key: string]: any }>(
	piAiModels: T[],
) {
	return (
		MODEL_IDS_IN_ORDER.map((id) => {
			const found = piAiModels.find((m) => m.id === id);
			if (!found) return undefined;
			const overrides = MODEL_OVERRIDES[id];
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
