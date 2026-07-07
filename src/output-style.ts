// Output-style file management for systemPromptMode: "output-style".
//
// Delivers pi's full system prompt to Claude Code as an output style
// (~/.claude/output-styles/pi-bridge-<hash>.md). Content-addressed so identical
// content is written at most once; atomic rename for cross-process safety;
// touch-on-reuse + 30-day GC so stale styles don't accumulate.
// Extracted from index.ts so tests can import without activating the extension.

import { createHash, randomBytes } from "crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";
import type { SystemPromptMode } from "./config.js";

export const OUTPUT_STYLE_PREFIX = "pi-bridge-";
const GC_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function defaultOutputStylesDir(): string {
	return join(homedir(), ".claude", "output-styles");
}

/** Content-addressed style name: pi-bridge-<sha256[0..16)>. Pure. */
export function outputStyleName(body: string): string {
	return (
		OUTPUT_STYLE_PREFIX +
		createHash("sha256").update(body, "utf-8").digest("hex").slice(0, 16)
	);
}

/** Render the style file: YAML frontmatter + verbatim body. Pure. */
export function renderOutputStyle(name: string, body: string): string {
	return [
		"---",
		`name: ${name}`,
		"description: pi system prompt (managed by pi-claude-bridge; auto-cleaned after 30 days idle)",
		"keep-coding-instructions: false",
		"---",
		"",
		body,
	].join("\n");
}

// Names ensured by THIS process (skip all fs work on repeat calls).
const ensuredNames = new Set<string>();

/**
 * Ensure an output style containing `body` exists; return its name, or
 * undefined when body is empty or any fs operation fails (caller degrades
 * to plain "append" behavior — never throws).
 */
export function ensureOutputStyle(
	body: string | undefined,
	dir = defaultOutputStylesDir(),
): string | undefined {
	if (!body || body.trim().length === 0) return undefined;
	const name = outputStyleName(body);
	const cacheKey = `${dir}\u0000${name}`;
	if (ensuredNames.has(cacheKey)) return name;
	try {
		mkdirSync(dir, { recursive: true });
		const target = join(dir, `${name}.md`);
		if (existsSync(target)) {
			const now = new Date();
			try {
				utimesSync(target, now, now); // mark in-use for GC
			} catch {
				/* best-effort touch; ignore */
			}
		} else {
			const tmp = join(
				dir,
				`.${name}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
			);
			writeFileSync(tmp, renderOutputStyle(name, body), "utf-8");
			renameSync(tmp, target); // atomic; content-addressed so any winner is identical
		}
		ensuredNames.add(cacheKey);
		gcStaleStyles(dir); // best-effort, inside the try
		return name;
	} catch {
		return undefined;
	}
}

/** Delete pi-bridge-*.md files idle for > 30 days. Best-effort; never throws. */
export function gcStaleStyles(
	dir = defaultOutputStylesDir(),
	maxAgeMs = GC_MAX_AGE_MS,
	now = Date.now(),
): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.startsWith(OUTPUT_STYLE_PREFIX) || !entry.endsWith(".md"))
			continue;
		try {
			const full = join(dir, entry);
			if (now - statSync(full).mtimeMs > maxAgeMs) unlinkSync(full);
		} catch {
			/* concurrent delete / perms — ignore */
		}
	}
}

// Test-only: reset the process-level ensured cache.
export function resetEnsuredCache(): void {
	ensuredNames.clear();
}

export type SystemPromptOptions = {
	systemPrompt:
		| string
		| { type: "preset"; preset: "claude_code"; append?: string };
	settings?: { outputStyle: string };
};

/**
 * Pure helper shared by all provider call sites: builds the SDK `systemPrompt`
 * (and, when applicable, `settings.outputStyle`) option for a given mode.
 *
 * - "append" / "output-style": preset + append content (unchanged shape/content
 *   between the two modes — R2). "output-style" additionally selects the style
 *   via `settings.outputStyle` when `outputStyleName` is provided.
 * - "replace" / false: plain string system prompt (append content or "").
 *
 * Passing `outputStyleName: undefined` for an "output-style" mode call
 * degrades to exact "append" behavior (R9, R13 — e.g. promptAndWait / AskClaude
 * intentionally never passes a name here).
 */
export function buildSystemPromptOptions(
	mode: SystemPromptMode,
	appendContent: string | undefined,
	outputStyleName: string | undefined,
): SystemPromptOptions {
	if (mode === "append" || mode === "output-style") {
		return {
			systemPrompt: {
				type: "preset",
				preset: "claude_code",
				append: appendContent,
			},
			...(mode === "output-style" && outputStyleName
				? { settings: { outputStyle: outputStyleName } }
				: {}),
		};
	}
	return { systemPrompt: appendContent ?? "" };
}
