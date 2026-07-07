# Spec: Output-Style System Prompt Mode (`systemPromptMode: "output-style"`)

- **Date**: 2026-07-07
- **Status**: Draft (ready for implementation)
- **Repo**: `pi-claude-bridge`
- **Doc**: `docs/2607072219_spec_output_styles.md`

## 1. Problem Statement

pi-claude-bridge drives Claude through the Claude Agent SDK, authenticated with a Claude
Pro/Max **OAuth subscription token** (not an API key). On premium models (Sonnet/Opus,
confirmed on `claude-sonnet-5`), Anthropic only bills tool-bearing OAuth-subscription
requests against the *included* subscription quota (`anthropic-ratelimit-unified-status:
allowed`) when the request is recognized as genuine Claude Code. Unrecognized requests are
routed to the overage/"extra usage" pool, which returns
`400 invalid_request_error: "You're out of extra usage..."` when overage is disabled.

The bridge's existing `provider.systemPromptMode` options each fail one side of this
trade-off (all facts below were verified live this session via a logging proxy between the
SDK/CC binary and `api.anthropic.com`, using real pi and OAuth credentials from
`~/.claude/.credentials.json`; corroborated by NousResearch/hermes-agent#15080 which a
maintainer closed as "intended behavior"):

| Mode | System prompt sent | Subscription-lane admission | pi's prompt delivered? |
|---|---|---|---|
| `"append"` (default) | `claude_code` preset + small append (AGENTS.md + skills, ~35k total observed) | ✅ admitted (200, `allowed`) | ❌ only AGENTS.md + skills block; pi's real system prompt is discarded |
| `"append"` with pi's *full* prompt in `append` (~52k total) | preset + large append | ❌ 400 extra-usage — the preset+`append` path has a **size ceiling** | — |
| `"replace"` | fully custom string (pi's prompt) | ❌ 400 extra-usage, reproduced deterministically with real pi + real MCP tools | ✅ |
| `false` | none | (untested for admission; irrelevant here) | ❌ |

**The escape hatch — output styles.** The Agent SDK supports output styles
(`settings: { outputStyle: "<name>" }`, resolved from a markdown file with YAML
frontmatter under a `.claude/output-styles/` directory at a level enabled by
`settingSources`; docs: <https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts>).
A style with `keep-coding-instructions: false` (or omitted) **replaces** the preset's
software-engineering instructions block (~3.3k chars) with the style's own content, while
the preset's identity/tool-guidance/safety scaffolding — and, critically, its Claude Code
recognition — remains. Empirically confirmed this session: ~30k chars of custom style body
(~52k total system chars — the same size that failed via `append`) with the `claude_code`
preset active and MCP tools attached on `claude-sonnet-5` returned **200 with
`anthropic-ratelimit-unified-status: allowed`**. Output-style content is **not** subject
to the size ceiling / recognition penalty that `append` and `replace` hit. The preset
visibly restructures around it ("...helps users according to your Output Style...").

This spec adds a fourth mode, `systemPromptMode: "output-style"`, that delivers **pi's
full system prompt** as an output style while keeping the `claude_code` preset (and thus
subscription-lane admission) and keeping today's append content in the preset's `append`
field.

### Ground truth (do not re-derive during implementation)

1. Recognition/overage behavior as described above (facts G1–G3 in the table).
2. Output styles carry large custom content without tripping the overage lane (verified
   to ~30k style body / ~52k total system chars).
3. Output styles affect **only the system prompt**. CLAUDE.md/memory is injected into the
   *conversation* (not the system prompt) and is controlled entirely by `settingSources`,
   independent of the preset or any output style.
4. Manual live-API verification costs real subscription usage. It is a documented manual
   step (§9.3), **never** an automated CI test.

## 2. Goals

- G1: New opt-in mode `"output-style"` that keeps the `claude_code` preset active and
  delivers pi's per-request system prompt (`context.systemPrompt`) as an output style.
- G2: Today's `append` content (AGENTS.md + skills, i.e. `systemPromptContent`) continues
  to flow through the preset's `append` field, unchanged.
- G3: No per-session/per-turn filesystem churn — identical style content is never
  regenerated; concurrent pi processes never corrupt each other's style files.
- G4: Full backward compatibility with `"append"`, `"replace"`, `false`, and the
  deprecated `appendSystemPrompt` boolean.

## 3. Non-Goals

- Changing the default mode (stays `"append"`).
- Resolving the pre-existing CLAUDE.md double-injection concern (`extractAgentsAppend`
  reads AGENTS.md → `# CLAUDE.md` header into the append, while
  `settingSources: ["user","project"]` may also let CC load CLAUDE.md files itself).
  This work does not touch that path; note it, leave it (§10, risk V).
- Changing AskClaude (`promptAndWait`) semantics beyond a defined degradation (§6.6).
- Deleting or altering the `"replace"` mode.
- Any automated test that hits the live Anthropic API.

## 4. Requirements (numbered, independently verifiable)

Each requirement states its verification method: **[unit]** = automated unit test,
**[type]** = `npm run typecheck`, **[int]** = local integration run (real CC subprocess,
alt/cheap model), **[manual]** = live-API manual verification (§9.3), **[review]** = code
inspection.

- **R1** — `Config.provider.systemPromptMode` accepts a new literal `"output-style"`;
  `SystemPromptMode` and `resolveSystemPromptMode` pass it through. Existing values
  (`"append"`, `"replace"`, `false`, absent → `"append"`, deprecated
  `appendSystemPrompt`) resolve exactly as before. **[unit]**
- **R2** — In `"output-style"` mode, the SDK `systemPrompt` option remains
  `{ type: "preset", preset: "claude_code", append: systemPromptContent }` — i.e. the
  same object shape and the same `append` content (AGENTS.md + skills) as `"append"`
  mode. The append content MUST NOT move into the style body. **[unit]** (via extracted
  pure builder, §6.5) **[manual]**
- **R3** — In `"output-style"` mode, the output style body is **pi's own system prompt
  for that request** — the verbatim `context.systemPrompt` string the bridge receives —
  not a subset, not the append content, not re-derived. **[unit]** **[review]**
- **R4** — The style file is **content-addressed**: filename (and selected style name) is
  `pi-bridge-<first 16 hex chars of sha256(body)>`, written to
  `~/.claude/output-styles/pi-bridge-<hash>.md`. Same content ⇒ same name ⇒ file written
  at most once. **[unit]**
- **R5** — The style file has YAML frontmatter with `name` (equal to the filename stem),
  `description`, and `keep-coding-instructions: false`, followed by the verbatim body.
  **[unit]**
- **R6** — Writes are race-safe across concurrent pi processes: write to a unique temp
  file in the same directory, then `renameSync` (atomic on POSIX). Since the name is
  content-addressed, any concurrent winner is byte-identical. **[unit]** (concurrent
  ensure calls yield one valid file) **[review]**
- **R7** — No churn: if the target file already exists, its content is not rewritten;
  instead its mtime is touched (`utimesSync`) to mark it in-use. A per-process in-memory
  set short-circuits repeated `ensure` calls for the same name within a session (at most
  one fs stat/touch per name per process). **[unit]**
- **R8** — Garbage collection: after a successful ensure, `pi-bridge-*.md` files in the
  styles directory whose mtime is older than 30 days are best-effort deleted. Only files
  matching the `pi-bridge-` prefix are ever touched/deleted. Combined with R7's
  touch-on-reuse, styles in active use are never collected. **[unit]**
- **R9** — Failure isolation: if the style cannot be ensured (unwritable dir, fs error)
  or `context.systemPrompt` is empty/undefined, the request degrades to exact `"append"`
  behavior (no `settings.outputStyle` passed) with a `debug()` log — the query MUST still
  run. **[unit]** **[review]**
- **R10** — Style selection is passed via SDK `Options.settings: { outputStyle: name }`
  (flag-settings layer). No other `settings` keys are sent. **[type]** **[review]**
  **[manual]**
- **R11** — In `"output-style"` mode, `effectiveSettingSources` MUST include `"user"`
  (the style file lives at user level and is resolved at a level enabled by
  `settingSources`). Default `["user","project"]` already satisfies this; if a user's
  explicit `provider.settingSources` omits `"user"`, it is unioned in with a `debug()`
  log. **[unit]**
- **R12** — Both provider call sites in `src/index.ts` apply the mode: the main provider
  path (`streamClaudeAgentSdk`) and the isolated side-query path
  (`runIsolatedSideQuery`). Each uses its own `context.systemPrompt` for that request.
  **[review]** **[int]**
- **R13** — The AskClaude path (`promptAndWait`) treats `"output-style"` as `"append"`
  (preset + skills append, no output style): AskClaude intentionally queries
  Claude-as-Claude-Code with CC's own persona, and `options.systemPrompt` there is pi's
  prompt only for skills extraction. **[review]** **[unit]** (mode-mapping helper)
- **R14** — README documents the new mode, when to use it, the file location, and the
  GC/touch behavior. **[review]**
- **R15** — `npm run test:unit` and `npm run typecheck` pass; existing tests are
  unmodified except where they enumerate mode literals. **[unit]** **[type]**

## 5. Codebase Map (anchors verified 2026-07-07, `git` clean at `7142d2f`)

### Files to modify

| Anchor | What it is | Change |
|---|---|---|
| `src/config.ts:27` | `systemPromptMode?: "append" \| "replace" \| false` in `Config.provider` | add `"output-style"` literal |
| `src/config.ts:62` | `export type SystemPromptMode = "append" \| "replace" \| false` | add `"output-style"` |
| `src/config.ts:64-71` | `resolveSystemPromptMode` | passes new literal through unchanged (deprecated `appendSystemPrompt` handling at `:67-69` untouched) |
| `src/index.ts:880-932` | `runIsolatedSideQuery` — mode read `:889`, `effectiveSettingSources` `:894-896`, `systemPrompt:` ternary `:924-926`, `settingSources` spread `:929` | wire output-style (§6.4) |
| `src/index.ts:1038` | `streamClaudeAgentSdk` (main provider path) | — |
| `src/index.ts:1200-1221` | fresh-query config: mode read `:1202`, `systemPromptContent` `:1204-1207`, `effectiveSettingSources` `:1219-1221` | wire output-style (§6.4) |
| `src/index.ts:1249-1265` | `queryOptions` — `systemPrompt:` ternary `:1255-1257`, `settingSources` spread `:1260` | wire output-style (§6.4) |
| `src/index.ts:1432` / `:1472` / `:1502-1505` | `promptAndWait` (AskClaude) — mode read `:1472`, `systemPrompt:` ternary `:1502-1504`, hardcoded `settingSources` `:1505` | R13: map `"output-style"` → `"append"` behavior here |
| `README.md` | user docs (currently does not mention `systemPromptMode`) | R14 |

### Files to create

- `src/output-style.ts` — pure + fs helpers (§6.2, §6.5). New module keeps `index.ts`
  from growing and lets tests import without activating the extension (same rationale as
  the header comments of `src/skills.ts:1-2` and `src/query-state.ts:1-7`).
- `tests/unit-output-style.mjs` — unit tests (§9.1).

### Read-only context

| Anchor | Relevance |
|---|---|
| `src/skills.ts:8` `extractSkillsBlock` | produces the skills part of `systemPromptContent` from `context.systemPrompt` |
| `src/agents-md.ts:34` `extractAgentsAppend` | produces the AGENTS.md part; also the CLAUDE.md double-injection note (§10 risk V) |
| `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1634` | `Options.settings?: string \| Settings` — "flag settings layer, highest priority", equivalent to `--settings` |
| `sdk.d.ts:3928` | `export declare interface Settings` |
| `sdk.d.ts:4988` | `Settings.outputStyle?: string` — "Controls the output style for assistant responses" |
| `sdk.d.ts:1663-1669` | `settingSources` semantics: omitted = all sources; `[]` = isolation; `'user'` = `~/.claude/...` |
| `sdk.d.ts:5391` | `type SettingSource = 'user' \| 'project' \| 'local'` |
| `node_modules/@earendil-works/pi-ai/.../types.d.ts:245` | `Context.systemPrompt?: string` (may be `undefined`) |
| `tests/unit-skills.mjs` | style/convention template for new unit tests (`node:test`, `assert/strict`, tsx import of `../src/*.js`) |
| `package.json` scripts | `test:unit` = `node --import tsx --test tests/unit-*.mjs`; `test` additionally runs `tests/int-*.sh` + `tests/int-*.mjs` (needs pi CLI, CC binary, `CLAUDE_BRIDGE_TESTING_ALT_MODEL`) |

## 6. Design

### 6.1 Config schema

```ts
// src/config.ts
provider?: {
  /** ... existing fields ... */
  /** Controls how pi's system prompt is fed to Claude Code.
   *  - "append": CC preset + AGENTS.md/skills appended (default)
   *  - "output-style": CC preset + AGENTS.md/skills appended, AND pi's full
   *    system prompt delivered as a content-addressed output style (keeps
   *    subscription-lane admission while carrying pi's real prompt)
   *  - "replace": only pi's AGENTS.md/skills, CC preset not loaded
   *  - false: no system prompt at all */
  systemPromptMode?: "append" | "replace" | "output-style" | false;
}

export type SystemPromptMode = "append" | "replace" | "output-style" | false;
```

`resolveSystemPromptMode` needs no logic change — `provider?.systemPromptMode ?? "append"`
already passes the new literal through; only the types widen. Deprecated
`appendSystemPrompt` still maps to `"append"`/`false` only.

### 6.2 New module: `src/output-style.ts`

```ts
// Output-style file management for systemPromptMode: "output-style".
//
// Delivers pi's full system prompt to Claude Code as an output style
// (~/.claude/output-styles/pi-bridge-<hash>.md). Content-addressed so identical
// content is written at most once; atomic rename for cross-process safety;
// touch-on-reuse + 30-day GC so stale styles don't accumulate.
// Extracted from index.ts so tests can import without activating the extension.

import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync,
         unlinkSync, utimesSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const OUTPUT_STYLE_PREFIX = "pi-bridge-";
const GC_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function defaultOutputStylesDir(): string {
  return join(homedir(), ".claude", "output-styles");
}

/** Content-addressed style name: pi-bridge-<sha256[0..16)>. Pure. */
export function outputStyleName(body: string): string {
  return OUTPUT_STYLE_PREFIX + createHash("sha256").update(body, "utf-8").digest("hex").slice(0, 16);
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
export function ensureOutputStyle(body: string | undefined, dir = defaultOutputStylesDir()): string | undefined {
  if (!body || body.trim().length === 0) return undefined;
  const name = outputStyleName(body);
  const cacheKey = `${dir}\u0000${name}`;
  if (ensuredNames.has(cacheKey)) return name;
  try {
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `${name}.md`);
    if (existsSync(target)) {
      const now = new Date();
      try { utimesSync(target, now, now); } catch {} // mark in-use for GC
    } else {
      const tmp = join(dir, `.${name}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
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
export function gcStaleStyles(dir = defaultOutputStylesDir(), maxAgeMs = GC_MAX_AGE_MS, now = Date.now()): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    if (!entry.startsWith(OUTPUT_STYLE_PREFIX) || !entry.endsWith(".md")) continue;
    try {
      const full = join(dir, entry);
      if (now - statSync(full).mtimeMs > maxAgeMs) unlinkSync(full);
    } catch { /* concurrent delete / perms — ignore */ }
  }
}

// Test-only: reset the process-level ensured cache.
export function resetEnsuredCache(): void { ensuredNames.clear(); }
```

Design decisions baked in:

- **User-level directory** (`~/.claude/output-styles/`), not project-level: pi runs from
  arbitrary working directories, and writing into arbitrary project `.claude/` dirs would
  litter user repos and require per-cwd management. User level needs `"user"` in
  `settingSources` (R11), which is already the bridge default
  (`src/index.ts:1221`, `:896`).
- **Content addressing** satisfies both "no regeneration of identical content" and race
  safety in one move (R4, R6, R7).
- **Touch-on-reuse + mtime GC** (R7, R8): write-once files would otherwise keep their
  creation mtime forever, so a GC based on mtime would delete a style still in use by a
  long-lived session; touching on each process's first reuse keeps live styles fresh.
  30-day TTL bounds accumulation (pi's prompt varies with cwd/date, so hashes churn
  over time).
- **Never throws** (R9): style delivery is an optimization; a broken `~/.claude` must not
  take down the provider.

### 6.3 Selecting the style: SDK `settings` option

Pass the flag-settings layer inline (no settings file needed):

```ts
...(outputStyleName ? { settings: { outputStyle: outputStyleName } } : {}),
```

`Options.settings` (`sdk.d.ts:1634`) is the highest-priority user-controlled settings
layer, equivalent to `--settings`. The bridge currently never sets `settings`, so there is
nothing to merge with. The style *name* selection travels via flag settings; the style
*file* is resolved from the user-level directory, which is why R11 requires `"user"` in
`settingSources`.

### 6.4 Wiring — `streamClaudeAgentSdk` and `runIsolatedSideQuery`

Both call sites follow the same pattern (shown for the main path,
`src/index.ts:1200-1265`; side-query path `:889-932` is identical in structure with
`persistSession: false` and `tools: []` retained as-is):

```ts
const systemPromptMode = resolveSystemPromptMode(providerSettings);
const agentsAppend = extractAgentsAppend();
const skillsAppend = extractSkillsBlock(context.systemPrompt);
const appendParts = [agentsAppend, skillsAppend].filter(...);
const systemPromptContent = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;

// NEW: output style carries pi's verbatim per-request system prompt (R3).
const outputStyleName = systemPromptMode === "output-style"
  ? ensureOutputStyle(context.systemPrompt)   // undefined => degrade to append (R9)
  : undefined;

const baseSettingSources = systemPromptMode === "replace"
  ? []
  : (providerSettings.settingSources ?? ["user", "project"]);
// NEW (R11): style lives at user level; union "user" in when output style is active.
const effectiveSettingSources = outputStyleName && !baseSettingSources.includes("user")
  ? [...baseSettingSources, "user" as SettingSource]   // + debug() log
  : baseSettingSources;

const queryOptions = {
  ...,
  // R2: append/output-style share the preset+append shape; append content unchanged.
  systemPrompt: (systemPromptMode === "append" || systemPromptMode === "output-style")
    ? { type: "preset", preset: "claude_code", append: systemPromptContent }
    : systemPromptContent ?? "",
  ...(outputStyleName ? { settings: { outputStyle: outputStyleName } } : {}),
  ...,
};
```

Extend the two existing `debug()` lines (`src/index.ts:1209`, `:913`) with
`outputStyle=<name|none>` so live troubleshooting can confirm which style was selected.

Notes:

- **Skills-block duplication is accepted.** In output-style mode the skills block appears
  both inside the style body (it is part of `context.systemPrompt`) and in the preset
  `append` (via `extractSkillsBlock`). The hard requirements pin both contents exactly
  (R2, R3), so this duplication is intentional; the append copy additionally carries the
  MCP `read`-tool rewrite (`src/skills.ts:19-24`) which the verbatim style body lacks.
  Cost is a few hundred tokens. A future optimization may drop `skillsAppend` in
  output-style mode — out of scope here.
- **Side queries** (`runIsolatedSideQuery`) are tool-less, so the recognition penalty is
  less likely to bite there, but applying the mode uniformly (a) keeps behavior
  predictable and (b) actually *improves* side queries: today `"append"` mode drops pi's
  per-request system prompt for compaction/summarization entirely. `ensureOutputStyle` is
  concurrency-safe (R6), which matters because side queries fire concurrently
  (`Promise.all` in compaction — see the comment block at `src/index.ts:864-879`).

### 6.5 Testability refactor (small, optional but recommended)

The `systemPrompt:` ternary + `settings` spread is duplicated in three places. Extract one
pure helper into `src/output-style.ts` so unit tests can assert R2/R9/R13 without spawning
the SDK:

```ts
export function buildSystemPromptOptions(
  mode: SystemPromptMode,
  appendContent: string | undefined,
  outputStyleName: string | undefined,   // pass undefined for promptAndWait (R13)
): { systemPrompt: string | { type: "preset"; preset: "claude_code"; append?: string };
     settings?: { outputStyle: string } } {
  if (mode === "append" || mode === "output-style") {
    return {
      systemPrompt: { type: "preset", preset: "claude_code", append: appendContent },
      ...(mode === "output-style" && outputStyleName
        ? { settings: { outputStyle: outputStyleName } } : {}),
    };
  }
  return { systemPrompt: appendContent ?? "" };
}
```

(`SystemPromptMode` import from `./config.js` is type-only — no cycle.) If the
implementer prefers minimal diffs, inlining at all three call sites is acceptable, but the
helper MUST then be replicated exactly and R2 verified by review at each site.

### 6.6 AskClaude (`promptAndWait`, `src/index.ts:1432,1472,1502-1505`)

`"output-style"` behaves as `"append"` here (R13): pass `outputStyleName: undefined` to
`buildSystemPromptOptions` (or keep the existing ternary but match
`mode === "append" || mode === "output-style"` for the preset branch). Rationale:
AskClaude is a deliberate "ask Claude Code" tool — CC's own persona is the product; pi's
system prompt is only consulted for skills extraction (`:1474-1475`). Its hardcoded
`settingSources: ["user","project"]` (`:1505`) is untouched.

### 6.7 Backward compatibility

- Default remains `"append"`; nothing changes for existing configs (R1).
- `"replace"` keeps its exact semantics including `effectiveSettingSources = []`. Users
  who chose `"replace"` to escape append-mode overage issues can migrate to
  `"output-style"` to regain subscription-lane admission; README should say so (R14).
- `false` and deprecated `appendSystemPrompt` untouched.
- Config files with `"output-style"` read by an *older* bridge version fall through the
  `mode === "append"` checks into the string branch → `systemPromptContent ?? ""`, i.e.
  behaves like `"replace"`. Acceptable (config forward-compat is best-effort); note in
  CHANGELOG.

## 7. Failure Modes & Degradation

| Failure | Behavior |
|---|---|
| `context.systemPrompt` empty/undefined | `ensureOutputStyle` → `undefined`; plain append behavior (R9) |
| `~/.claude/output-styles/` unwritable | same degradation, `debug()` log (R9) |
| Concurrent processes ensure same content | atomic rename, identical bytes — any winner valid (R6) |
| Style name selected but CC can't resolve the file (e.g. user set `settingSources` without `"user"` and R11 union has a bug) | CC falls back to default style; request still admitted (preset intact); prompt content silently missing → covered by manual verification §9.3 step 4 |
| GC races an in-flight session started >30 days ago on another machine/user profile | touch-on-reuse (R7) makes this require 30 days of *zero* queries from every process using that style — accepted residual risk |

## 8. Observability

- Extend existing `debug()` lines (`src/index.ts:913`, `:1209`, `:1267`) with
  `outputStyle=<name|none>`.
- `debug()` on: degradation to append (R9), settingSources union (R11), GC deletions
  (count).
- No new user-facing UI.

## 9. Testing Strategy

### 9.1 Unit tests — `tests/unit-output-style.mjs` (new; runs in `npm run test:unit`)

Follow the `tests/unit-skills.mjs` conventions (`node:test`, `assert/strict`, import
`../src/output-style.js` / `../src/config.js`). Use `fs.mkdtempSync(os.tmpdir())` dirs and
call `resetEnsuredCache()` in `beforeEach`; all fs-touching helpers accept a `dir`
parameter precisely so tests never touch the real `~/.claude`.

1. `outputStyleName`: deterministic; different bodies → different names; prefix +
   16-hex-char shape (R4).
2. `renderOutputStyle`: frontmatter has `name`, `description`,
   `keep-coding-instructions: false`; body verbatim after blank line, including bodies
   that themselves contain `---` lines (R5).
3. `ensureOutputStyle`: creates dir + file on first call; returns name (R4).
4. Write-once: second call with same content leaves file content identical and does not
   rewrite (compare content; assert mtime *was* touched per R7 — call with a stubbed old
   mtime via `utimesSync` in the test, then re-ensure after `resetEnsuredCache()` and
   assert mtime advanced).
5. Empty/whitespace body → `undefined` (R9).
6. Unwritable dir (e.g. `dir` pointing at a path whose parent is a *file*) → `undefined`,
   no throw (R9).
7. Concurrency smoke: N interleaved `ensureOutputStyle` calls (same body, fresh cache
   between) leave exactly one `pi-bridge-*.md` with valid content; no `.tmp` residue
   (R6).
8. `gcStaleStyles`: deletes only `pi-bridge-*.md` older than TTL (inject `now`); leaves
   fresh files and non-matching files (`custom-style.md`, `pi-bridge-x.txt`) alone (R8).
9. `resolveSystemPromptMode({ systemPromptMode: "output-style" })` → `"output-style"`;
   regression matrix for `"append"`/`"replace"`/`false`/undefined/`appendSystemPrompt`
   (R1).
10. `buildSystemPromptOptions` matrix: append vs output-style vs replace vs false;
    output-style + name → preset shape with **unchanged** `append` + `settings.outputStyle`;
    output-style + `undefined` name → identical to append (R2, R9, R13).
11. settingSources-union helper (if extracted; otherwise cover via
    `buildSystemPromptOptions`-adjacent pure function): `["project"]` → adds `"user"`;
    `["user","project"]` → unchanged (R11).

### 9.2 Integration (local, real CC subprocess, no premium usage)

Existing `tests/int-*.sh` drive real pi + the CC binary with
`CLAUDE_BRIDGE_TESTING_ALT_MODEL` (cheap model). Add one case to `tests/int-smoke.sh` (or
a new small `.sh` following `tests/lib/bash-setup.sh` conventions): write a project
`.pi/claude-bridge.json` with `{"provider": {"systemPromptMode": "output-style"}}` in the
test sandbox, run a trivial prompt, assert (a) non-empty response, (b) a
`pi-bridge-*.md` file exists under the test `HOME`'s `.claude/output-styles/` (the harness
already isolates `HOME`/env per `setup_test_env` — verify; if it does not isolate `HOME`,
assert on the real dir but do not delete anything). This verifies wiring end-to-end
without asserting admission behavior. Keep it out of `test:unit`.

### 9.3 Manual live-API verification (NOT automated; costs real subscription usage)

Run once per release that touches this path, with a Pro/Max OAuth account that has
overage **disabled** (so misrouting fails loudly as a 400):

1. Place the logging proxy between the SDK/CC binary and `api.anthropic.com` (same setup
   as the 2026-07-07 session; bypass LiteLLM).
2. Run real pi with `systemPromptMode: "output-style"` on `claude-sonnet-5` with the full
   MCP toolset and a prompt that triggers a tool call.
3. Assert on the proxied request/response: HTTP 200;
   `anthropic-ratelimit-unified-status: allowed`; system prompt contains the preset
   scaffolding ("...according to your Output Style..."), the style body equal to pi's
   system prompt, and the `append` content (AGENTS.md + skills) — and does NOT contain
   the preset's own ~3.3k-char SWE instructions block.
4. Negative check for silent style loss: grep the captured system prompt for a sentinel
   string that exists only in pi's system prompt (not in AGENTS.md/skills).
5. Repeat once for a compaction (side-query path) and once for AskClaude (expect NO
   output style there, R13).

## 10. Risks & Open Questions

- **(V) CLAUDE.md double-injection (pre-existing, noted per scope rule):**
  `extractAgentsAppend` (`src/agents-md.ts:34`) injects AGENTS.md as `# CLAUDE.md` into
  the append while `settingSources: ["user","project"]` may let CC load CLAUDE.md files
  into the conversation itself. Output styles do not interact with CLAUDE.md loading at
  all (ground truth #3), and this design does not change `settingSources` defaults, so
  the situation is unchanged. Out of scope; track separately.
- **(W) Anthropic behavior drift:** admission heuristics are undocumented and were
  established empirically; a future API change could re-impose limits on style size. The
  manual verification step (§9.3) is the guard. Mitigation if it regresses: mode is
  opt-in; users fall back to `"append"`.
- **(X) Frontmatter parsing of exotic names:** `name`/`description` are fixed
  bridge-controlled ASCII; body is placed after the closing `---` so needs no YAML
  escaping. Verified by unit test 2 (body containing `---`).
- **(Y) `settings` flag-layer collisions:** the bridge sends only `{ outputStyle }`; if a
  future feature also needs `Options.settings`, merge at the `queryOptions` construction
  site (single spread today).
- **(Z) Style name vs frontmatter `name` mismatch semantics:** we set both to the same
  value defensively; §9.3 step 3 confirms resolution works.

## 11. Phased Delivery Plan

Each phase is independently implementable from this spec alone (no re-exploration
needed), lands green (`npm run typecheck` && `npm run test:unit`), and is a natural
commit.

### Phase 1 — `src/output-style.ts` + unit tests (pure/fs core)

- Create `src/output-style.ts` exactly per §6.2 plus `buildSystemPromptOptions` per §6.5
  (import `type SystemPromptMode` from `./config.js`).
- Widen `SystemPromptMode` / `Config.provider.systemPromptMode` in `src/config.ts`
  (`:27`, `:62`) — needed by the §6.5 helper's type; `resolveSystemPromptMode` body
  unchanged.
- Create `tests/unit-output-style.mjs` covering §9.1 items 1–11.
- Verify: `npm run typecheck`; `npm run test:unit`.
- Satisfies: R1, R4, R5, R6, R7, R8, R9 (module level), R2/R13 (helper level), R15.

### Phase 2 — Wire provider + side-query call sites

- `src/index.ts`: import `ensureOutputStyle`, `buildSystemPromptOptions` from
  `./output-style.js`.
- Main path (`:1200-1265`): compute `outputStyleName` (only when mode is
  `"output-style"`), apply settingSources union (R11) on top of the existing
  replace-check at `:1219-1221`, replace the `systemPrompt:` ternary at `:1255-1257`
  with the helper's spread, extend debug lines `:1209`/`:1267`.
- Side-query path (`:889-932`): same transformation on `:894-896`, `:924-926`, `:913`.
- AskClaude (`:1502-1505`): switch the preset branch condition to
  `mode === "append" || mode === "output-style"` (or helper with
  `outputStyleName: undefined`); no `settings` key here (R13).
- Verify: `npm run typecheck`; `npm run test:unit`; manual grep that no call site passes
  `context.systemPrompt` into the *append* or the append content into the *style*
  (R2/R3 review).
- Satisfies: R2, R3, R10, R11, R12, R13.

### Phase 3 — Integration test + docs

- Add the §9.2 case to `tests/int-smoke.sh` (or new script wired into the `test` npm
  script alongside the existing `tests/int-*.sh` list in `package.json`).
- README (R14): document the new mode under provider config — what it does, why
  (subscription-lane admission with full pi prompt), file location
  `~/.claude/output-styles/pi-bridge-*.md`, touch/GC behavior, migration note for
  `"replace"` users, and that `"user"` is auto-added to `settingSources` when needed.
- CHANGELOG entry incl. the §6.7 older-version forward-compat note.
- Verify: `npm run typecheck`; `npm run test:unit`; `npm test` locally (requires pi CLI +
  CC binary + `CLAUDE_BRIDGE_TESTING_ALT_MODEL`).
- Satisfies: R14, R15, int-level R12.

### Phase 4 — Manual live verification (release gate, human-run)

- Execute §9.3 steps 1–5 and record results (headers, admission status, prompt capture
  excerpts) in `docs/` as a dated verification note.
- Not CI; costs real subscription usage. Blocks *release*, not merge.

## Phases (JSON)

```json
{
  "phases": [
    {
      "id": "P1",
      "title": "Output-style core module + unit tests",
      "files": ["src/output-style.ts", "src/config.ts", "tests/unit-output-style.mjs"],
      "requirements": ["R1", "R2", "R4", "R5", "R6", "R7", "R8", "R9", "R13", "R15"],
      "verify": ["npm run typecheck", "npm run test:unit"],
      "blockedBy": []
    },
    {
      "id": "P2",
      "title": "Wire streamClaudeAgentSdk, runIsolatedSideQuery, promptAndWait",
      "files": ["src/index.ts"],
      "requirements": ["R2", "R3", "R10", "R11", "R12", "R13"],
      "verify": ["npm run typecheck", "npm run test:unit"],
      "blockedBy": ["P1"]
    },
    {
      "id": "P3",
      "title": "Integration smoke case + README/CHANGELOG docs",
      "files": ["tests/int-smoke.sh", "package.json", "README.md", "CHANGELOG.md"],
      "requirements": ["R12", "R14", "R15"],
      "verify": ["npm run typecheck", "npm run test:unit", "npm test"],
      "blockedBy": ["P2"]
    },
    {
      "id": "P4",
      "title": "Manual live-API verification (release gate, human-run, not CI)",
      "files": ["docs/"],
      "requirements": ["R2", "R3", "R10", "R12", "R13"],
      "verify": ["manual proxy capture per spec section 9.3"],
      "blockedBy": ["P3"]
    }
  ]
}
```
