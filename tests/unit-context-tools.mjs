/**
 * Tests for context tool resolution.
 * Newer pi's agent loop rebuilds the provider context with
 * normalizeContext({messages}) — context.tools stays empty and the active tool
 * set travels as toolsAdded on system messages. resolveContextTools must handle
 * both channels. No API calls, no extension activation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveContextTools, toolsFromTranscript } from "../src/context-tools.js";

const read = { name: "read", description: "read", parameters: { type: "object", properties: {} } };
const bash = { name: "bash", description: "bash", parameters: { type: "object", properties: {} } };
const askClaude = { name: "AskClaude", description: "ask", parameters: { type: "object", properties: {} } };

describe("toolsFromTranscript", () => {
	it("replays toolsAdded from system messages", () => {
		const tools = toolsFromTranscript([
			{ role: "system", toolsAdded: [read, bash] },
			{ role: "user", content: "hi" },
		]);
		assert.deepStrictEqual(tools.map((t) => t.name), ["read", "bash"]);
	});

	it("later toolsAdded wins over earlier (same name re-declared)", () => {
		const readV2 = { ...read, description: "read v2" };
		const tools = toolsFromTranscript([
			{ role: "system", toolsAdded: [read] },
			{ role: "system", toolsAdded: [readV2] },
		]);
		assert.strictEqual(tools.length, 1);
		assert.strictEqual(tools[0].description, "read v2");
	});

	it("toolsRemoved drops earlier adds", () => {
		const tools = toolsFromTranscript([
			{ role: "system", toolsAdded: [read, bash] },
			{ role: "system", toolsRemoved: [{ name: "read" }] },
		]);
		assert.deepStrictEqual(tools.map((t) => t.name), ["bash"]);
	});

	it("ignores non-system messages and malformed entries", () => {
		const tools = toolsFromTranscript([
			{ role: "user", toolsAdded: [read] },
			null,
			{ role: "system", toolsAdded: [null, { name: "" }, bash] },
		]);
		assert.deepStrictEqual(tools.map((t) => t.name), ["bash"]);
	});

	it("returns [] for non-array input", () => {
		assert.deepStrictEqual(toolsFromTranscript(undefined), []);
		assert.deepStrictEqual(toolsFromTranscript(null), []);
	});
});

describe("resolveContextTools", () => {
	it("prefers non-empty context.tools (legacy pi shape)", () => {
		const tools = resolveContextTools({ tools: [askClaude], messages: [{ role: "system", toolsAdded: [read] }] });
		assert.deepStrictEqual(tools.map((t) => t.name), ["AskClaude"]);
	});

	it("falls back to transcript replay when context.tools is empty (new pi shape)", () => {
		const tools = resolveContextTools({ tools: [], messages: [{ role: "system", toolsAdded: [read, askClaude] }] });
		assert.deepStrictEqual(tools.map((t) => t.name), ["read", "AskClaude"]);
	});

	it("falls back when context.tools is undefined", () => {
		const tools = resolveContextTools({ messages: [{ role: "system", toolsAdded: [bash] }] });
		assert.deepStrictEqual(tools.map((t) => t.name), ["bash"]);
	});

	it("returns [] when neither channel has tools (side queries)", () => {
		assert.deepStrictEqual(resolveContextTools({ messages: [{ role: "user", content: "summarize" }] }), []);
		assert.deepStrictEqual(resolveContextTools({}), []);
	});
});
