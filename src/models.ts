// Canonical selection + display order for the model picker.
// `resolveModelId` returns the first partial match, so `opus` resolves to the first-listed opus entry.
// Extracted from index.ts so tests can import without activating the extension.

export const MODEL_IDS_IN_ORDER = [
	"claude-fable-5[1m]",
	"claude-opus-4-8",
	"claude-opus-4-8[1m]",
	"claude-opus-4-7",
	"claude-opus-4-6",
	"claude-opus-4-6[1m]",
	"claude-sonnet-4-6",
	// 1M context variants: Claude Code uses the "[1m]" suffix in the model ID to
	// route to the 1M context window. The CC binary's Qv() function returns 1M when
	// rZ(model) is true (i.e. model ID contains "[1m]"). Without the suffix, Qv()
	// falls through to WD6=200_000 for API-key auth — the 1M path (O$H) only fires
	// for firstParty OAuth, AWS Bedrock, or Mantle plans.
	//
	// opus-4-7 is NOT capped: it falls through to the full API window because it is
	// neither in q4A (200K model-defaults) nor returned by Pq8(). Adding [1m] for it
	// would be redundant but harmless if ever needed.
	"claude-sonnet-4-6[1m]",
	"claude-haiku-4-5",
];

// Per-model field overrides for cases where the pi-ai registry value doesn't
// match the effective limit on the headless/SDK transport we use.
// Key: model id, Value: partial model fields to override after the find.
const MODEL_OVERRIDES: Record<string, Record<string, any>> = {
	// CC's Qv() returns 200K (WD6) for API-key auth on all models except those
	// accessed via OAuth firstParty, Bedrock, or Mantle. In practice every model
	// the bridge uses needs this 200K cap unless the [1m] variant is selected.
	// (opus-4-7 is exempted: CC's Qv() falls to the full API window for it, not
	// WD6, because it matches neither q4A nor Pq8() and O$H returns true for
	// opus-4-7 on firstParty — but on API key it would also fall to WD6. TODO:
	// verify opus-4-7 actual limit and add override + [1m] variant if needed.)
	"claude-opus-4-8": { contextWindow: 200_000 },
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
	"claude-opus-4-8[1m]": {
		id: "claude-opus-4-8[1m]",
		name: "Claude Opus 4.8 (1M)",
		contextWindow: 1_000_000,
	},
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
	"claude-fable-5[1m]": {
		id: "claude-fable-5[1m]",
		name: "Claude Fable 5 (1M)",
		contextWindow: 1_000_000,
	},
};

// Synthetic base models for entries not yet shipped in pi-ai.
// Key: missing model id. Value: donor model id to clone.
const SYNTHETIC_BASE_MODELS: Record<string, string> = {
	"claude-fable-5": "claude-opus-4-8",
};

// Project pi-ai's model entries down to the fields pi's registerProvider expects,
// and keep MODEL_IDS_IN_ORDER ordering. IDs missing from pi-ai AND MODEL_1M_ENTRIES
// are silently dropped.
export function buildModels<T extends { id: string; [key: string]: any }>(
	piAiModels: T[],
) {
	// Augment with synthetic base models so new models work before pi-ai ships them.
	const augmented = [...piAiModels];
	for (const [syntheticId, donorId] of Object.entries(SYNTHETIC_BASE_MODELS)) {
		if (augmented.some((m) => m.id === syntheticId)) continue;
		const donor = augmented.find((m) => m.id === donorId);
		if (donor)
			augmented.push({ ...donor, id: syntheticId, name: syntheticId } as T);
	}

	return (
		MODEL_IDS_IN_ORDER.map((id) => {
			// Synthesised 1M entry — not in pi-ai
			const synth = MODEL_1M_ENTRIES[id];
			if (synth) {
				// [1m] entry: only synthesise if the base model exists in pi-ai or synth base
				const base = augmented.find((m) => m.id === id.replace(/\[1m\]$/, ""));
				if (!base) return undefined;
				return { ...base, ...synth } as T;
			}
			const found = augmented.find((m) => m.id === id);
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
