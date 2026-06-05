// Query state: QueryContext class + context stack.
//
// All per-query and per-turn mutable state lives here. Reentrant queries
// (subagents) push the parent context onto a stack and get a fresh instance.
// Adding a new field = one property on the class.
//
// Extracted from index.ts so tests can import without activating the extension.

import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Model,
} from "@earendil-works/pi-ai";
import type { McpResult } from "./extract-tool-results.js";

export interface PendingToolCall {
	toolName: string;
	resolve: (result: McpResult) => void;
}

export class QueryContext {
	// Query-scoped (fully isolated per query)
	activeQuery: unknown | null = null;
	currentPiStream: AssistantMessageEventStream | null = null;
	latestCursor = 0;
	pendingToolCalls = new Map<string, PendingToolCall>();
	pendingResults = new Map<string, McpResult>();
	turnToolCallIds: string[] = [];
	nextHandlerIdx = 0;
	deferredUserMessages: string[] = [];

	// Per-turn (reset together)
	turnOutput: AssistantMessage | null = null;
	turnStarted = false;
	turnSawStreamEvent = false;
	turnSawToolCall = false;

	get turnBlocks(): Array<any> {
		if (!this.turnOutput)
			throw new Error("turnBlocks accessed before resetTurnState");
		return this.turnOutput.content;
	}

	resetTurnState(model: Model<any>): void {
		this.turnOutput = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		this.turnStarted = false;
		this.turnSawStreamEvent = false;
		this.turnSawToolCall = false;
		// turnToolCallIds and nextHandlerIdx are NOT reset — they persist across
		// tool-result delivery callbacks within the same assistant message.
	}
}

let _ctx = new QueryContext();
const contextStack: QueryContext[] = [];

export function ctx(): QueryContext {
	return _ctx;
}

export function stackDepth(): number {
	return contextStack.length;
}

export function pushContext(): void {
	if (!_ctx.activeQuery)
		throw new Error("pushContext() called with no active query");
	contextStack.push(_ctx);
	_ctx = new QueryContext();
}

export function popContext(): void {
	if (contextStack.length === 0)
		throw new Error("popContext() called with empty stack");
	const parent = contextStack[contextStack.length - 1];
	parent.deferredUserMessages.push(..._ctx.deferredUserMessages);
	_ctx = contextStack.pop()!;
}

// Cheap structural check for "this provider call is a fresh standalone prompt
// (e.g. compaction/summarization or a new user turn), not a within-query
// tool-result/steer callback". Used to detect a *stale* activeQuery: when this
// shape holds while a query is still marked active, the active query is no longer
// live (its cleanup raced, or the CC subprocess wedged) and entering the
// tool-result-delivery path would return a stream nothing ever finalizes -> hang.
//
// A genuine within-query callback always carries pi's ongoing conversation, so
// its length is >= the shared-session cursor; a summarization context is a single
// synthetic message (length << cursor). Steers/followUps arrive alongside a tool
// result (caller additionally requires zero tool results before acting).
//
// Pure (no I/O) so it can be unit-tested. Caller still gates on `hasActiveQuery`
// and a separate zero-tool-results check to preserve short-circuiting.
export function isStaleForeignPromptShape(args: {
	lastMsgRole: string | undefined;
	pendingToolCalls: number;
	contextLength: number;
	sharedCursor: number;
}): boolean {
	return (
		args.lastMsgRole === "user" &&
		args.pendingToolCalls === 0 &&
		args.sharedCursor > 0 &&
		args.contextLength < args.sharedCursor
	);
}

// Test-only: drop all state so test files can start from a clean module.
// Not called from production.
export function resetStack(): void {
	_ctx = new QueryContext();
	contextStack.length = 0;
}
