// Resolve the tool set a provider call should expose, from whichever channel
// the running pi version actually delivers tools through.
//
// pi ≤0.8x passed the active tools as Context.tools on every streamSimple call.
// Newer pi (agent-loop rework) builds the provider context via
// normalizeContext({ messages }) — context.tools is no longer populated; tools
// travel as `toolsAdded` arrays on system messages in the transcript instead
// (see pi-ai utils/transcript.ts: getCurrentTools replays them in order,
// toolsRemoved wins over earlier adds). Native providers read that transcript
// field; providers that only looked at context.tools silently see zero tools.
//
// Resolution order: explicit context.tools when non-empty (legacy shape,
// also the cheapest path), else transcript replay. Pure function — unit-testable
// without activating the extension.

import type { Tool } from "@earendil-works/pi-ai";

interface SystemLikeMessage {
	role: string;
	toolsAdded?: Tool[];
	toolsRemoved?: Array<{ name: string }>;
}

export function toolsFromTranscript(messages: unknown): Tool[] {
	const tools = new Map<string, Tool>();
	if (!Array.isArray(messages)) return [];
	for (const message of messages as SystemLikeMessage[]) {
		if (!message || message.role !== "system") continue;
		for (const removed of message.toolsRemoved ?? []) tools.delete(removed.name);
		for (const added of message.toolsAdded ?? []) {
			if (added && typeof added.name === "string" && added.name) tools.set(added.name, added);
		}
	}
	return [...tools.values()];
}

export function resolveContextTools(context: { tools?: Tool[]; messages?: unknown }): Tool[] {
	if (context.tools && context.tools.length > 0) return context.tools;
	return toolsFromTranscript(context.messages);
}
