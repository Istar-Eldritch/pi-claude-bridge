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

describe("MODELS projection", () => {
	it("strips baseUrl/api/provider/headers", () => {
		const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));
		for (const m of models) {
			assert.equal(m.baseUrl, undefined);
			assert.equal(m.api, undefined);
			assert.equal(m.provider, undefined);
			assert.equal(m.headers, undefined);
		}
	});

	it("preserves MODEL_IDS_IN_ORDER ordering", () => {
		const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));
		assert.deepEqual(
			models.map((m) => m.id),
			MODEL_IDS_IN_ORDER,
		);
	});

	it("drops IDs with no pi-ai entry and no synthetic base", () => {
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

	it("synthesises [1m] variant from synthetic base when pi-ai lacks the model", () => {
		// claude-fable-5 is not in pi-ai yet; the bridge clones claude-opus-4-8 as a donor.
		const base48 = mockPiAiModel("claude-opus-4-8");
		base48.contextWindow = 1_000_000;
		const models = buildModels([base48]);
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
		const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));
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
	const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));

	it("opus shortcut resolves to claude-opus-4-8 (first opus in order)", () => {
		assert.equal(resolveModelId(models, "opus"), "claude-opus-4-8");
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
