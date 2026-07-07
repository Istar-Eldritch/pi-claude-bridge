/**
 * Tests for output-style file management (systemPromptMode: "output-style").
 * Verifies content-addressed naming, frontmatter rendering, write-once /
 * touch-on-reuse semantics, race safety, GC, mode resolution, and the pure
 * systemPrompt-options builder shared by all provider call sites — no fs
 * access outside mkdtemp sandboxes, no extension activation.
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	outputStyleName,
	renderOutputStyle,
	ensureOutputStyle,
	gcStaleStyles,
	resetEnsuredCache,
	buildSystemPromptOptions,
	unionUserSource,
	OUTPUT_STYLE_PREFIX,
} from "../src/output-style.js";
import { resolveSystemPromptMode } from "../src/config.js";

let tmpDirs = [];
function makeTmpDir() {
	const dir = mkdtempSync(join(tmpdir(), "pi-bridge-test-"));
	tmpDirs.push(dir);
	return dir;
}

after(() => {
	for (const dir of tmpDirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
});

beforeEach(() => resetEnsuredCache());

describe("outputStyleName", () => {
	it("is deterministic for identical content", () => {
		assert.strictEqual(outputStyleName("hello world"), outputStyleName("hello world"));
	});

	it("differs for different bodies", () => {
		assert.notStrictEqual(outputStyleName("body one"), outputStyleName("body two"));
	});

	it("has the pi-bridge- prefix and 16 hex chars", () => {
		const name = outputStyleName("some content");
		assert.ok(name.startsWith(OUTPUT_STYLE_PREFIX));
		const hash = name.slice(OUTPUT_STYLE_PREFIX.length);
		assert.strictEqual(hash.length, 16);
		assert.ok(/^[0-9a-f]{16}$/.test(hash));
	});
});

describe("renderOutputStyle", () => {
	it("includes required frontmatter fields", () => {
		const rendered = renderOutputStyle("pi-bridge-abc123", "my body content");
		assert.ok(rendered.startsWith("---\n"));
		assert.ok(rendered.includes("name: pi-bridge-abc123"));
		assert.ok(rendered.includes("description:"));
		assert.ok(rendered.includes("keep-coding-instructions: false"));
	});

	it("places body verbatim after the closing frontmatter delimiter + blank line", () => {
		const body = "Line one.\nLine two.";
		const rendered = renderOutputStyle("pi-bridge-abc123", body);
		const parts = rendered.split("---\n");
		// parts[0] === "" (before first ---), parts[1] = frontmatter body, parts[2] = "\n" + content
		assert.ok(rendered.includes(`\n\n${body}`));
		assert.ok(rendered.endsWith(body));
	});

	it("handles a body that itself contains --- lines without corrupting frontmatter", () => {
		const body = "Some content\n---\nMore content after a horizontal rule\n---\nEnd.";
		const rendered = renderOutputStyle("pi-bridge-xyz", body);
		assert.ok(rendered.endsWith(body));
		assert.ok(rendered.includes("keep-coding-instructions: false"));
		// The frontmatter's own closing delimiter is the third "---" occurrence overall
		// (1: open, 2: close, 3+: inside body) — verify open+close still parse as expected.
		const lines = rendered.split("\n");
		assert.strictEqual(lines[0], "---");
		const closeIdx = lines.indexOf("---", 1);
		assert.ok(closeIdx > 0);
		assert.strictEqual(lines[closeIdx + 1], "");
	});
});

describe("ensureOutputStyle", () => {
	it("creates the dir and file on first call, returns the content-addressed name", () => {
		const dir = makeTmpDir();
		const styleDir = join(dir, "output-styles");
		const body = "pi's system prompt body";
		const name = ensureOutputStyle(body, styleDir);
		assert.strictEqual(name, outputStyleName(body));
		const target = join(styleDir, `${name}.md`);
		assert.ok(existsSync(target));
		const content = readFileSync(target, "utf-8");
		assert.ok(content.includes(body));
		assert.ok(content.includes(`name: ${name}`));
	});

	it("write-once: second call with identical content does not rewrite, but touches mtime", () => {
		const dir = makeTmpDir();
		const body = "stable content";
		const name1 = ensureOutputStyle(body, dir);
		const target = join(dir, `${name1}.md`);
		const contentBefore = readFileSync(target, "utf-8");

		// Force the mtime far into the past, then re-ensure via a fresh process
		// cache (simulating a new pi process / new call) and confirm the mtime
		// advances (touch-on-reuse) while content is unchanged.
		const old = new Date(Date.now() - 1000 * 60 * 60 * 24 * 40); // 40 days ago
		utimesSync(target, old, old);
		resetEnsuredCache();

		const name2 = ensureOutputStyle(body, dir);
		assert.strictEqual(name2, name1);
		const contentAfter = readFileSync(target, "utf-8");
		assert.strictEqual(contentAfter, contentBefore);

		const mtimeAfter = statSync(target).mtimeMs;
		assert.ok(mtimeAfter > old.getTime());
	});

	it("empty or whitespace-only body returns undefined", () => {
		const dir = makeTmpDir();
		assert.strictEqual(ensureOutputStyle(undefined, dir), undefined);
		assert.strictEqual(ensureOutputStyle("", dir), undefined);
		assert.strictEqual(ensureOutputStyle("   \n\t  ", dir), undefined);
	});

	it("unwritable dir (parent is a file, not a directory) returns undefined without throwing", () => {
		const dir = makeTmpDir();
		const blockerFile = join(dir, "blocker-file");
		writeFileSync(blockerFile, "i am a file, not a directory");
		const impossibleDir = join(blockerFile, "output-styles");

		assert.doesNotThrow(() => {
			const result = ensureOutputStyle("some body", impossibleDir);
			assert.strictEqual(result, undefined);
		});
	});

	it("concurrency smoke: interleaved ensure calls for identical content leave exactly one valid file, no .tmp residue", () => {
		const dir = makeTmpDir();
		const body = "concurrent body content";
		const results = [];
		for (let i = 0; i < 10; i++) {
			resetEnsuredCache();
			results.push(ensureOutputStyle(body, dir));
		}
		const expectedName = outputStyleName(body);
		assert.ok(results.every((name) => name === expectedName));

		const entries = readdirSync(dir);
		const mdFiles = entries.filter((e) => e.endsWith(".md"));
		const tmpFiles = entries.filter((e) => e.endsWith(".tmp"));
		assert.strictEqual(mdFiles.length, 1);
		assert.strictEqual(tmpFiles.length, 0);
		assert.strictEqual(readFileSync(join(dir, mdFiles[0]), "utf-8"), readFileSync(join(dir, `${expectedName}.md`), "utf-8"));
	});
});

describe("gcStaleStyles", () => {
	it("deletes only pi-bridge-*.md files older than the TTL, leaving fresh and non-matching files alone, and returns the count deleted", () => {
		const dir = makeTmpDir();
		const now = Date.now();
		const maxAgeMs = 30 * 24 * 60 * 60 * 1000;

		const staleBridge = join(dir, "pi-bridge-aaaaaaaaaaaaaaaa.md");
		const freshBridge = join(dir, "pi-bridge-bbbbbbbbbbbbbbbb.md");
		const customStyle = join(dir, "custom-style.md");
		const nonMdBridge = join(dir, "pi-bridge-x.txt");

		writeFileSync(staleBridge, "stale");
		writeFileSync(freshBridge, "fresh");
		writeFileSync(customStyle, "custom");
		writeFileSync(nonMdBridge, "not markdown");

		const staleTime = new Date(now - maxAgeMs - 1000 * 60);
		utimesSync(staleBridge, staleTime, staleTime);

		const deleted = gcStaleStyles(dir, maxAgeMs, now);

		assert.strictEqual(deleted, 1, "should report exactly one deletion");
		assert.strictEqual(existsSync(staleBridge), false, "stale pi-bridge- .md should be deleted");
		assert.strictEqual(existsSync(freshBridge), true, "fresh pi-bridge- .md should survive");
		assert.strictEqual(existsSync(customStyle), true, "non pi-bridge- file should never be touched");
		assert.strictEqual(existsSync(nonMdBridge), true, "non-.md file should never be touched even with prefix");
	});

	it("also sweeps orphaned .pi-bridge-*.tmp write-in-progress files past the TTL, leaving fresh ones alone", () => {
		const dir = makeTmpDir();
		const now = Date.now();
		const maxAgeMs = 30 * 24 * 60 * 60 * 1000;

		// Mirrors the temp filename shape ensureOutputStyle uses before renameSync:
		// `.${name}.${pid}.${rand}.tmp` where name already carries the prefix.
		const staleTmp = join(dir, ".pi-bridge-aaaaaaaaaaaaaaaa.12345.deadbeef.tmp");
		const freshTmp = join(dir, ".pi-bridge-bbbbbbbbbbbbbbbb.12345.deadbeef.tmp");
		const otherDotfile = join(dir, ".unrelated-dotfile.tmp");

		writeFileSync(staleTmp, "partial write");
		writeFileSync(freshTmp, "partial write");
		writeFileSync(otherDotfile, "not ours");

		const staleTime = new Date(now - maxAgeMs - 1000 * 60);
		utimesSync(staleTmp, staleTime, staleTime);

		const deleted = gcStaleStyles(dir, maxAgeMs, now);

		assert.strictEqual(deleted, 1);
		assert.strictEqual(existsSync(staleTmp), false, "stale orphan .tmp should be swept");
		assert.strictEqual(existsSync(freshTmp), true, "fresh .tmp (write still in flight) should survive");
		assert.strictEqual(existsSync(otherDotfile), true, "unrelated dotfile should never be touched");
	});

	it("is best-effort, never throws, and returns 0 when the dir does not exist", () => {
		let result;
		assert.doesNotThrow(() => {
			result = gcStaleStyles(join(tmpdir(), "pi-bridge-test-does-not-exist-xyz"));
		});
		assert.strictEqual(result, 0);
	});
});

describe("unionUserSource (R11)", () => {
	it("no-op (same reference) when no output style is active", () => {
		const sources = ["project"];
		const result = unionUserSource(sources, false);
		assert.strictEqual(result, sources, "should return the identical array reference, not a copy");
	});

	it("no-op (same reference) when \"user\" is already present and a style is active", () => {
		const sources = ["user", "project"];
		const result = unionUserSource(sources, true);
		assert.strictEqual(result, sources);
	});

	it("unions \"user\" in when a style is active and it's missing", () => {
		const sources = ["project"];
		const result = unionUserSource(sources, true);
		assert.deepStrictEqual(result, ["project", "user"]);
		assert.notStrictEqual(result, sources, "should return a new array, not mutate the input");
		assert.deepStrictEqual(sources, ["project"], "input array must be unmutated");
	});

	it("unions into an empty settingSources array (replace-mode shape) when active", () => {
		const result = unionUserSource([], true);
		assert.deepStrictEqual(result, ["user"]);
	});

	it("leaves an empty settingSources array alone when inactive", () => {
		const sources = [];
		const result = unionUserSource(sources, false);
		assert.strictEqual(result, sources);
	});
});

describe("resolveSystemPromptMode (regression matrix incl. output-style)", () => {
	it("resolves the new output-style literal", () => {
		assert.strictEqual(resolveSystemPromptMode({ systemPromptMode: "output-style" }), "output-style");
	});

	it("resolves existing literals unchanged", () => {
		assert.strictEqual(resolveSystemPromptMode({ systemPromptMode: "append" }), "append");
		assert.strictEqual(resolveSystemPromptMode({ systemPromptMode: "replace" }), "replace");
		assert.strictEqual(resolveSystemPromptMode({ systemPromptMode: false }), false);
	});

	it("defaults to append when unset", () => {
		assert.strictEqual(resolveSystemPromptMode(undefined), "append");
		assert.strictEqual(resolveSystemPromptMode({}), "append");
	});

	it("deprecated appendSystemPrompt boolean still maps to append/false, taking precedence", () => {
		assert.strictEqual(resolveSystemPromptMode({ appendSystemPrompt: true }), "append");
		assert.strictEqual(resolveSystemPromptMode({ appendSystemPrompt: false }), false);
		assert.strictEqual(
			resolveSystemPromptMode({ appendSystemPrompt: true, systemPromptMode: "output-style" }),
			"append",
		);
	});
});

describe("buildSystemPromptOptions", () => {
	it("append mode: preset shape with append content, no settings", () => {
		const result = buildSystemPromptOptions("append", "AGENTS+skills content", undefined);
		assert.deepStrictEqual(result, {
			systemPrompt: { type: "preset", preset: "claude_code", append: "AGENTS+skills content" },
		});
		assert.strictEqual(result.settings, undefined);
	});

	it("output-style mode with a name: unchanged preset+append shape, plus settings.outputStyle", () => {
		const result = buildSystemPromptOptions("output-style", "AGENTS+skills content", "pi-bridge-deadbeefdeadbeef");
		assert.deepStrictEqual(result, {
			systemPrompt: { type: "preset", preset: "claude_code", append: "AGENTS+skills content" },
			settings: { outputStyle: "pi-bridge-deadbeefdeadbeef" },
		});
	});

	it("output-style mode with undefined name (degradation, R9/R13): identical to append", () => {
		const outputStyleResult = buildSystemPromptOptions("output-style", "AGENTS+skills content", undefined);
		const appendResult = buildSystemPromptOptions("append", "AGENTS+skills content", undefined);
		assert.deepStrictEqual(outputStyleResult, appendResult);
		assert.strictEqual(outputStyleResult.settings, undefined);
	});

	it("replace mode: plain string, ignores outputStyleName entirely", () => {
		const result = buildSystemPromptOptions("replace", "AGENTS+skills content", "pi-bridge-shouldbeignored");
		assert.deepStrictEqual(result, { systemPrompt: "AGENTS+skills content" });
	});

	it("replace mode with undefined append content: empty string", () => {
		const result = buildSystemPromptOptions("replace", undefined, undefined);
		assert.deepStrictEqual(result, { systemPrompt: "" });
	});

	it("false mode: plain string, same as replace", () => {
		const result = buildSystemPromptOptions(false, "AGENTS+skills content", "pi-bridge-shouldbeignored");
		assert.deepStrictEqual(result, { systemPrompt: "AGENTS+skills content" });
	});
});
