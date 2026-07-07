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
import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
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
 *
 * `onGc`, if provided, is invoked with the count whenever the internal GC
 * sweep actually deletes something (never on a 0-deletion sweep). This module
 * deliberately has no logger dependency of its own (so tests can import it
 * without activating the extension) — `onGc` lets a caller with a logger
 * (index.ts's `debug()`) observe GC activity without coupling this module to
 * it directly.
 */
export function ensureOutputStyle(
	body: string | undefined,
	dir = defaultOutputStylesDir(),
	onGc?: (deletedCount: number) => void,
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
		const deleted = gcStaleStyles(dir); // best-effort, inside the try
		if (deleted > 0) {
			// Own try/catch: onGc is caller-supplied observability, not part of this
			// function's own contract — a throwing callback must not make an
			// otherwise-successful write/rename spuriously degrade to undefined.
			try {
				onGc?.(deleted);
			} catch {
				/* caller's observability hook, not our failure */
			}
		}
		return name;
	} catch {
		return undefined;
	}
}

/**
 * Delete pi-bridge-*.md files idle for > 30 days, plus any orphaned
 * .pi-bridge-*.tmp write-in-progress files (left behind if the process died
 * between writeFileSync and renameSync in ensureOutputStyle — rare, but
 * without this they'd accumulate forever since the .md sweep above never
 * matches a dotfile). Best-effort; never throws. Returns the number of files
 * deleted (0 on any error) — not logged from here since this module
 * intentionally has no logger dependency (kept importable by tests without
 * activating the extension); callers with a logger may log the count.
 */
export function gcStaleStyles(
	dir = defaultOutputStylesDir(),
	maxAgeMs = GC_MAX_AGE_MS,
	now = Date.now(),
): number {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return 0;
	}
	let deleted = 0;
	for (const entry of entries) {
		const isStyle = entry.startsWith(OUTPUT_STYLE_PREFIX) && entry.endsWith(".md");
		const isOrphanTmp = entry.startsWith(`.${OUTPUT_STYLE_PREFIX}`) && entry.endsWith(".tmp");
		if (!isStyle && !isOrphanTmp) continue;
		try {
			const full = join(dir, entry);
			if (now - statSync(full).mtimeMs > maxAgeMs) {
				unlinkSync(full);
				deleted++;
			}
		} catch {
			/* concurrent delete / perms — ignore */
		}
	}
	return deleted;
}

/**
 * Union "user" into settingSources when an output style is active (R11) —
 * the style file is resolved from the user-level output-styles directory, so
 * CC needs "user" present in settingSources to find it (§6.3). No-op (same
 * array reference) when no style is active or "user" is already present, so
 * callers can cheaply detect — and debug()-log — whether the union actually
 * changed anything. Pure; shared by every call site to prevent drift.
 */
export function unionUserSource(
	sources: SettingSource[],
	outputStyleActive: boolean,
): SettingSource[] {
	if (!outputStyleActive || sources.includes("user")) return sources;
	return [...sources, "user"];
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
