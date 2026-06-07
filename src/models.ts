// Canonical selection + display order for the model picker.
// `resolveModelId` returns the first partial match, so `opus` resolves to the first-listed opus entry.
// Extracted from index.ts so tests can import without activating the extension.

export const MODEL_IDS_IN_ORDER = [
	"claude-opus-4-8",
	"claude-opus-4-7",
	"claude-opus-4-6",
	"claude-sonnet-4-6",
	// 1M context variants: Claude Code uses the "[1m]" suffix in the model ID to
	// route to the 1M context window entitlement. These are NOT beta-header tricks —
	// the CC binary has explicit model-ID checks (includes("[1m]")) that gate the
	// extended window. The underlying Anthropic API model is the same; only the
	// CC subprocess's internal context-management limit changes.
	"claude-sonnet-4-6[1m]",
	"claude-haiku-4-5",
];

// Per-model field overrides for cases where the pi-ai registry value doesn't
// match the effective limit on the headless/SDK transport we use.
// Key: model id, Value: partial model fields to override after the find.
const MODEL_OVERRIDES: Record<string, Record<string, any>> = {
	// opus-4-8 and sonnet-4-6 advertise 1M in pi-ai, but the CC subprocess's
	// default context-management caps them at 200K (you need the [1m] model
	// variant to get 1M). Without this override pi won't compact in time and
	// CC returns "Prompt is too long".
	"claude-opus-4-8": { contextWindow: 200_000 },
	"claude-sonnet-4-6": { contextWindow: 200_000 },
	// [1m] variants: synthesised entries (not in pi-ai); we supply all fields
	// manually via MODEL_1M_ENTRIES below.
};

// Synthesised model entries for CC's [1m] model-ID variants.
// These aren't in pi-ai; we construct them by copying the base model and
// patching the id, name, and contextWindow.
const MODEL_1M_ENTRIES: Record<string, { id: string; name: string; contextWindow: number }> = {
	"claude-sonnet-4-6[1m]": {
		id: "claude-sonnet-4-6[1m]",
		name: "Claude Sonnet 4.6 (1M)",
		contextWindow: 1_000_000,
	},
};

// Project pi-ai's model entries down to the fields pi's registerProvider expects,
// and keep MODEL_IDS_IN_ORDER ordering. IDs missing from pi-ai AND MODEL_1M_ENTRIES
// are silently dropped.
export function buildModels<T extends { id: string; [key: string]: any }>(
	piAiModels: T[],
) {
	return (
		MODEL_IDS_IN_ORDER.map((id) => {
			// Synthesised 1M entry — not in pi-ai
			const synth = MODEL_1M_ENTRIES[id];
			const found = synth
				? ({ ...piAiModels.find((m) => m.id === id.replace(/\[1m\]$/, "")), ...synth } as T)
				: piAiModels.find((m) => m.id === id);
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
