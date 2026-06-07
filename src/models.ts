// Canonical selection + display order for the model picker.
// `resolveModelId` returns the first partial match, so `opus` resolves to the first-listed opus entry.
// Extracted from index.ts so tests can import without activating the extension.

export const MODEL_IDS_IN_ORDER = [
	"claude-opus-4-8",
	"claude-opus-4-7",
	"claude-opus-4-6",
	"claude-opus-4-6[1m]",
	"claude-sonnet-4-6",
	// 1M context variants: Claude Code uses the "[1m]" suffix in the model ID to
	// route to the 1M context window. The CC binary's kn() function has an explicit
	// 200K model-default set (q4A) for sonnet-4-6 and opus-4-6; the [1m] suffix
	// bypasses that and lets the full API window through. These are NOT beta-header
	// tricks — the underlying Anthropic model ID sent to the API is the same.
	//
	// opus-4-7 and opus-4-8 are NOT in CC's 200K q4A set, so they already use
	// the full API context window (1M) by default — no [1m] suffix needed for them.
	"claude-sonnet-4-6[1m]",
	"claude-haiku-4-5",
];

// Per-model field overrides for cases where the pi-ai registry value doesn't
// match the effective limit on the headless/SDK transport we use.
// Key: model id, Value: partial model fields to override after the find.
const MODEL_OVERRIDES: Record<string, Record<string, any>> = {
	// sonnet-4-6 and opus-4-6 are in CC's internal q4A set which applies a 200K
	// model-default context window. pi-ai advertises 1M for both, so we cap them
	// here to match CC's actual behaviour; otherwise pi won't compact in time and
	// CC returns "Prompt is too long". Use the [1m] model variants for true 1M.
	//
	// opus-4-7 and opus-4-8 are NOT in q4A — CC falls through to the full API
	// window (1M) for them, so no override is needed.
	"claude-sonnet-4-6": { contextWindow: 200_000 },
	"claude-opus-4-6": { contextWindow: 200_000 },
};

// Synthesised model entries for CC's [1m] model-ID variants.
// These aren't in pi-ai; we construct them by copying the base model and
// patching the id, name, and contextWindow.
const MODEL_1M_ENTRIES: Record<
	string,
	{ id: string; name: string; contextWindow: number }
> = {
	"claude-sonnet-4-6[1m]": {
		id: "claude-sonnet-4-6[1m]",
		name: "Claude Sonnet 4.6 (1M)",
		contextWindow: 1_000_000,
	},
	"claude-opus-4-6[1m]": {
		id: "claude-opus-4-6[1m]",
		name: "Claude Opus 4.6 (1M)",
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
				? ({
						...piAiModels.find((m) => m.id === id.replace(/\[1m\]$/, "")),
						...synth,
					} as T)
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
