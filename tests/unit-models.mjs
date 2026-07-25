/**
 * Tests for MODELS construction + resolveModelId.
 * Pins: opus shortcut resolves to whichever opus is first in MODEL_IDS_IN_ORDER,
 * projection strips pi-ai's baseUrl/api/provider/headers, and ordering is preserved.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	MODEL_IDS_IN_ORDER,
	buildModels,
	resolveModelId,
} from "../src/models.js";

// Simulated pi-ai registry entry — extra fields mimic the ones pi-ai exposes
// that must not leak into the provider-registered MODELS array.
const mockPiAiModel = (id) => ({
	id,
	name: id,
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 1 },
	contextWindow: 200000,
	maxTokens: 8000,
	// Leaky fields that should be stripped by the projection:
	baseUrl: "https://api.anthropic.com",
	api: "anthropic",
	provider: "anthropic",
	headers: { "x-api-key": "LEAK" },
});

// pi-ai only ever ships base (non-[1m]) model ids; the bridge synthesises the
// [1m] variants. It also synthesises base models not yet shipped upstream (e.g.
// claude-sonnet-5), so exclude those here to mirror what pi-ai actually returns.
const SYNTHETIC_BASE_IDS = new Set(["claude-opus-5"]);
const PI_AI_MODEL_IDS = [
	...new Set(MODEL_IDS_IN_ORDER.map((id) => id.replace(/\[1m\]$/, ""))),
].filter((id) => !SYNTHETIC_BASE_IDS.has(id));

describe("MODELS projection", () => {
	it("strips baseUrl/api/provider/headers", () => {
		const models = buildModels(PI_AI_MODEL_IDS.map(mockPiAiModel));
		for (const m of models) {
			assert.equal(m.baseUrl, undefined);
			assert.equal(m.api, undefined);
			assert.equal(m.provider, undefined);
			assert.equal(m.headers, undefined);
		}
	});

	it("preserves MODEL_IDS_IN_ORDER ordering", () => {
		const models = buildModels(PI_AI_MODEL_IDS.map(mockPiAiModel));
		assert.deepEqual(
			models.map((m) => m.id),
			MODEL_IDS_IN_ORDER,
		);
	});

	it("drops IDs with no pi-ai entry and no synthesisable base", () => {
		// [1m] variants are synthesised from their base model. With only haiku
		// present, the [1m] entries have no base to spread from and are dropped.
		const models = buildModels([mockPiAiModel("claude-haiku-4-5")]);
		assert.deepEqual(
			models.map((m) => m.id),
			["claude-haiku-4-5"],
		);
	});

	it("[1m] variants are synthesised when base model is present", () => {
		const base48 = mockPiAiModel("claude-opus-4-8");
		base48.contextWindow = 1_000_000;
		const models = buildModels([base48]);
		const ids = models.map((m) => m.id);
		assert.ok(ids.includes("claude-opus-4-8[1m]"), "[1m] variant present");
		const m1m = models.find((m) => m.id === "claude-opus-4-8[1m]");
		assert.equal(m1m.contextWindow, 1_000_000);
		assert.equal(m1m.name, "Claude Opus 4.8 (1M)");
	});

	it("synthesises claude-opus-5 (+[1m]) from the opus-4-8 donor when pi-ai lacks it", () => {
		// pi-ai doesn't ship claude-opus-5 yet; SYNTHETIC_BASE_MODELS clones the
		// opus-4-8 donor so the model (and its 1M variant) is available early.
		const donor = mockPiAiModel("claude-opus-4-8");
		donor.contextWindow = 1_000_000;
		const models = buildModels([donor]);
		const ids = models.map((m) => m.id);
		assert.ok(ids.includes("claude-opus-5"), "synthetic base present");
		assert.ok(ids.includes("claude-opus-5[1m]"), "[1m] variant present");
		const base = models.find((m) => m.id === "claude-opus-5");
		assert.equal(base.name, "Claude Opus 5");
		assert.equal(base.contextWindow, 200_000); // MODEL_OVERRIDES cap
		const m1m = models.find((m) => m.id === "claude-opus-5[1m]");
		assert.equal(m1m.contextWindow, 1_000_000);
		assert.equal(m1m.name, "Claude Opus 5 (1M)");
	});

	it("synthesises claude-fable-5[1m] from the native pi-ai fable-5 base", () => {
		// pi-ai now ships claude-fable-5 (1M) natively; the [1m] variant is the
		// id-suffixed clone the CC binary needs to route to its 1M context window.
		const fable = mockPiAiModel("claude-fable-5");
		fable.contextWindow = 1_000_000;
		const models = buildModels([fable]);
		const ids = models.map((m) => m.id);
		assert.ok(ids.includes("claude-fable-5[1m]"), "fable [1m] variant present");
		const m1m = models.find((m) => m.id === "claude-fable-5[1m]");
		assert.equal(m1m.contextWindow, 1_000_000);
		assert.equal(m1m.name, "Claude Fable 5 (1M)");
	});

	it("applies 200K override for models capped by CC Qv() on API key auth", () => {
		// CC's Qv() returns WD6=200K for API-key auth on opus-4-8, opus-4-6, and
		// sonnet-4-6. pi-ai advertises 1M for these; MODEL_OVERRIDES caps them to
		// match CC's actual behaviour so pi compacts at the right threshold.
		// opus-4-7 is not overridden — CC falls through to its full API window.
		const make1M = (id) => {
			const m = mockPiAiModel(id);
			m.contextWindow = 1_000_000;
			return m;
		};
		const models = buildModels(
			[
				"claude-opus-4-8",
				"claude-opus-4-7",
				"claude-opus-4-6",
				"claude-sonnet-4-6",
			].map(make1M),
		);
		assert.equal(
			models.find((m) => m.id === "claude-opus-4-8").contextWindow,
			200_000,
		);
		assert.equal(
			models.find((m) => m.id === "claude-opus-4-7").contextWindow,
			1_000_000,
		); // untouched
		assert.equal(
			models.find((m) => m.id === "claude-opus-4-6").contextWindow,
			200_000,
		);
		assert.equal(
			models.find((m) => m.id === "claude-sonnet-4-6").contextWindow,
			200_000,
		);
	});

	it("zeros out cost regardless of pi-ai pricing", () => {
		const models = buildModels(PI_AI_MODEL_IDS.map(mockPiAiModel));
		for (const m of models) {
			assert.deepEqual(m.cost, {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			});
		}
	});
});

describe("resolveModelId", () => {
	const models = buildModels(PI_AI_MODEL_IDS.map(mockPiAiModel));

	it("opus shortcut resolves to claude-opus-5 (newest opus, listed first)", () => {
		assert.equal(resolveModelId(models, "opus"), "claude-opus-5");
	});

	it("sonnet shortcut resolves to claude-sonnet-5 (newest sonnet, listed first)", () => {
		const withSonnet5 = buildModels(
			PI_AI_MODEL_IDS.concat("claude-sonnet-4-6").map(mockPiAiModel),
		);
		assert.equal(resolveModelId(withSonnet5, "sonnet"), "claude-sonnet-5");
	});

	it("haiku shortcut resolves to claude-haiku-4-5", () => {
		assert.equal(resolveModelId(models, "haiku"), "claude-haiku-4-5");
	});

	it("fable shortcut resolves to claude-fable-5[1m]", () => {
		assert.equal(resolveModelId(models, "fable"), "claude-fable-5[1m]");
	});

	it("full ID passes through unchanged", () => {
		assert.equal(resolveModelId(models, "claude-opus-4-6"), "claude-opus-4-6");
	});

	it("falls through to input when no match", () => {
		assert.equal(resolveModelId(models, "gpt-9"), "gpt-9");
	});
});
