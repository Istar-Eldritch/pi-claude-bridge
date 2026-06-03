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
		// Only haiku present — opus/sonnet vanish; 4-8 is NOT synthesized
		// because pi-ai 0.78+ defines it officially.
		const models = buildModels([mockPiAiModel("claude-haiku-4-5")]);
		assert.deepEqual(
			models.map((m) => m.id),
			["claude-haiku-4-5"],
		);
	});

	it("applies 200K contextWindow override for claude-opus-4-8", () => {
		// pi-ai 0.78 defines 4-8 with contextWindow: 1_000_000, but the
		// effective limit on the headless/SDK transport is 200K (gated behind
		// CC Statsig experiment tengu_amber_redwood2). The MODEL_OVERRIDES
		// patch ensures pi compacts at the correct threshold.
		// See issue #22.
		const v48 = mockPiAiModel("claude-opus-4-8");
		v48.contextWindow = 1_000_000;
		const v47 = mockPiAiModel("claude-opus-4-7");
		v47.contextWindow = 1_000_000;
		const models = buildModels([v48, v47]);
		const found48 = models.find((m) => m.id === "claude-opus-4-8");
		const found47 = models.find((m) => m.id === "claude-opus-4-7");
		assert.equal(found48.contextWindow, 200_000); // overridden
		assert.equal(found47.contextWindow, 1_000_000); // untouched
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

	it("full ID passes through unchanged", () => {
		assert.equal(resolveModelId(models, "claude-opus-4-6"), "claude-opus-4-6");
	});

	it("falls through to input when no match", () => {
		assert.equal(resolveModelId(models, "gpt-9"), "gpt-9");
	});
});
