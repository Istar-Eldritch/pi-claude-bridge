/**
 * Tests for QueryContext class and context stack infrastructure.
 * Exercises isolation, guards, deferred message merging, and context pinning
 * using the real module — no API calls, no extension activation.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ctx, pushContext, popContext, resetStack, stackDepth, isStaleForeignPromptShape, isEmptyAssistantOutput, EMPTY_RESPONSE_ERROR } from "../src/query-state.js";

const fakeModel = { api: "anthropic", provider: "anthropic", id: "test-model" };

// Shape of a completed turn whose visible output is empty: the model ended the
// turn after thinking (or nothing at all) with no text and no tool calls.
// Seen with claude-sonnet-5 via the Agent SDK — thinking off (empty signed
// thinking block) and effort=medium (visible thinking, then silence).
describe("isEmptyAssistantOutput", () => {
	it("flags empty content", () => {
		assert.strictEqual(isEmptyAssistantOutput({ content: [] }), true);
	});

	it("flags thinking-only output, empty or not", () => {
		assert.strictEqual(isEmptyAssistantOutput({ content: [{ type: "thinking", thinking: "", thinkingSignature: "sig" }] }), true);
		assert.strictEqual(isEmptyAssistantOutput({ content: [{ type: "thinking", thinking: "I pondered greatly" }] }), true);
	});

	it("flags whitespace-only text", () => {
		assert.strictEqual(isEmptyAssistantOutput({ content: [{ type: "text", text: "  \n\t" }] }), true);
	});

	it("accepts non-empty text", () => {
		assert.strictEqual(isEmptyAssistantOutput({ content: [{ type: "text", text: "hello" }] }), false);
	});

	it("accepts tool calls (even alongside empty thinking)", () => {
		assert.strictEqual(isEmptyAssistantOutput({ content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }] }), false);
		assert.strictEqual(isEmptyAssistantOutput({ content: [{ type: "thinking", thinking: "" }, { type: "toolCall", id: "t1", name: "bash", arguments: {} }] }), false);
	});

	it("EMPTY_RESPONSE_ERROR matches pi's retryable-provider-error pattern (enables auto-retry)", () => {
		// pi-ai isRetryableAssistantError retries only messages matching
		// RETRYABLE_PROVIDER_ERROR_PATTERN; "server error" keeps empty-response
		// turns eligible for pi's built-in auto-retry.
		assert.strictEqual(EMPTY_RESPONSE_ERROR, "Model returned an empty response (upstream server error)");
		assert.match(EMPTY_RESPONSE_ERROR, /server.?error/i);
	});
});

describe("QueryContext class", () => {
	beforeEach(() => resetStack());

	it("turnBlocks throws before resetTurnState", () => {
		assert.throws(() => ctx().turnBlocks, /turnBlocks accessed before resetTurnState/);
	});

	it("turnBlocks reflects turnOutput.content after resetTurnState", () => {
		ctx().resetTurnState(fakeModel);
		assert.ok(Array.isArray(ctx().turnBlocks));
		assert.strictEqual(ctx().turnBlocks.length, 0);

		ctx().turnBlocks.push({ type: "text", text: "hello" });
		assert.strictEqual(ctx().turnOutput.content.length, 1);
		assert.strictEqual(ctx().turnOutput.content[0].text, "hello");
		// Same array reference
		assert.strictEqual(ctx().turnBlocks, ctx().turnOutput.content);
	});

	it("resetTurnState preserves turnToolCallIds and nextHandlerIdx", () => {
		ctx().turnToolCallIds = ["id1", "id2"];
		ctx().nextHandlerIdx = 5;
		ctx().resetTurnState(fakeModel);

		assert.deepStrictEqual(ctx().turnToolCallIds, ["id1", "id2"]);
		assert.strictEqual(ctx().nextHandlerIdx, 5);
	});
});

describe("context stack guards", () => {
	beforeEach(() => resetStack());

	it("pushContext throws with no active query", () => {
		assert.throws(() => pushContext(), /no active query/);
	});

	it("popContext throws on empty stack", () => {
		assert.throws(() => popContext(), /empty stack/);
	});
});

describe("stack isolation and restore", () => {
	beforeEach(() => resetStack());

	it("push/pop isolates state and restores parent", () => {
		// Parent setup
		ctx().activeQuery = { id: "parent" };
		ctx().pendingToolCalls.set("t1", { toolName: "read", resolve: () => {} });
		ctx().latestCursor = 42;
		ctx().deferredUserMessages = ["parent-msg"];

		// Push — child should be clean
		pushContext();
		assert.strictEqual(ctx().activeQuery, null);
		assert.strictEqual(ctx().pendingToolCalls.size, 0);
		assert.strictEqual(ctx().pendingResults.size, 0);
		assert.strictEqual(ctx().latestCursor, 0);
		assert.deepStrictEqual(ctx().deferredUserMessages, []);

		// Mutate child
		ctx().activeQuery = { id: "child" };
		ctx().pendingToolCalls.set("t2", { toolName: "write", resolve: () => {} });
		ctx().latestCursor = 99;

		// Pop — parent restored
		popContext();
		assert.deepStrictEqual(ctx().activeQuery, { id: "parent" });
		assert.strictEqual(ctx().pendingToolCalls.size, 1);
		assert.ok(ctx().pendingToolCalls.has("t1"));
		assert.strictEqual(ctx().latestCursor, 42);
	});

	it("deferred messages merge on pop in FIFO order", () => {
		ctx().activeQuery = { id: "parent" };
		ctx().deferredUserMessages = ["parent-1", "parent-2"];

		pushContext();
		ctx().deferredUserMessages = ["child-1", "child-2"];

		popContext();
		assert.deepStrictEqual(
			ctx().deferredUserMessages,
			["parent-1", "parent-2", "child-1", "child-2"],
		);
	});

	it("triple-nested isolation — each level independent, pop restores", () => {
		// Level 0 (root)
		ctx().activeQuery = { id: "L0" };
		ctx().latestCursor = 10;
		ctx().deferredUserMessages = ["L0-msg"];

		// Level 1
		pushContext();
		assert.strictEqual(stackDepth(), 1);
		ctx().activeQuery = { id: "L1" };
		ctx().latestCursor = 20;
		ctx().deferredUserMessages = ["L1-msg"];

		// Level 2
		pushContext();
		assert.strictEqual(stackDepth(), 2);
		ctx().activeQuery = { id: "L2" };
		ctx().latestCursor = 30;
		ctx().deferredUserMessages = ["L2-msg"];

		// Pop L2 → L1 (L2's deferred merge into L1)
		popContext();
		assert.strictEqual(stackDepth(), 1);
		assert.deepStrictEqual(ctx().activeQuery, { id: "L1" });
		assert.strictEqual(ctx().latestCursor, 20);
		assert.deepStrictEqual(ctx().deferredUserMessages, ["L1-msg", "L2-msg"]);

		// Pop L1 → L0 (L1+L2's deferred merge into L0)
		popContext();
		assert.strictEqual(stackDepth(), 0);
		assert.deepStrictEqual(ctx().activeQuery, { id: "L0" });
		assert.strictEqual(ctx().latestCursor, 10);
		assert.deepStrictEqual(ctx().deferredUserMessages, ["L0-msg", "L1-msg", "L2-msg"]);
	});
});

describe("context pinning (MCP handler closure pattern)", () => {
	beforeEach(() => resetStack());

	it("captured context ref stays valid across push/pop", () => {
		ctx().activeQuery = { id: "parent" };
		ctx().pendingToolCalls.set("t1", { toolName: "read", resolve: () => {} });

		// Simulate handler capturing parent context before push
		const capturedCtx = ctx();

		pushContext();
		// After push, ctx() is the child — but capturedCtx still points to parent
		assert.notStrictEqual(ctx(), capturedCtx);
		assert.strictEqual(capturedCtx.pendingToolCalls.size, 1);
		assert.ok(capturedCtx.pendingToolCalls.has("t1"));

		// Mutate child — captured parent unaffected
		ctx().pendingToolCalls.set("t2", { toolName: "write", resolve: () => {} });
		assert.strictEqual(capturedCtx.pendingToolCalls.size, 1);

		// Pop restores parent as current
		popContext();
		assert.strictEqual(ctx(), capturedCtx);
	});
});

describe("isStaleForeignPromptShape (stale activeQuery detection)", () => {
	// Regression: a fresh standalone prompt (compaction/summarization) arriving
	// while a stale activeQuery is still set must be recognized so the provider
	// can tear it down and treat the call as a fresh query, instead of returning
	// a tool-result-delivery stream that nothing ever finalizes (-> hang on
	// /compact and auto-compaction). See pi-claude-bridge compaction-hang fix.

	it("detects a summarization-style single-message context (length << cursor)", () => {
		assert.strictEqual(
			isStaleForeignPromptShape({ lastMsgRole: "user", pendingToolCalls: 0, contextLength: 1, sharedCursor: 287 }),
			true,
		);
	});

	it("rejects a genuine within-query callback (context length >= cursor)", () => {
		assert.strictEqual(
			isStaleForeignPromptShape({ lastMsgRole: "user", pendingToolCalls: 0, contextLength: 287, sharedCursor: 287 }),
			false,
		);
		assert.strictEqual(
			isStaleForeignPromptShape({ lastMsgRole: "user", pendingToolCalls: 0, contextLength: 300, sharedCursor: 287 }),
			false,
		);
	});

	it("rejects when handlers are still waiting (real tool-result delivery in flight)", () => {
		assert.strictEqual(
			isStaleForeignPromptShape({ lastMsgRole: "user", pendingToolCalls: 1, contextLength: 1, sharedCursor: 287 }),
			false,
		);
	});

	it("rejects a tool-result callback (last message is not a user message)", () => {
		assert.strictEqual(
			isStaleForeignPromptShape({ lastMsgRole: "toolResult", pendingToolCalls: 0, contextLength: 1, sharedCursor: 287 }),
			false,
		);
	});

	it("rejects when there is no shared session yet (cursor 0 / fresh start)", () => {
		assert.strictEqual(
			isStaleForeignPromptShape({ lastMsgRole: "user", pendingToolCalls: 0, contextLength: 1, sharedCursor: 0 }),
			false,
		);
	});
});
