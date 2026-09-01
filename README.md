# agent-scaffold

Bootstrap a repo's AI coding-agent config — instructions files, skills/rules, slash commands, agents, permissions, MCP servers, and a development methodology — for **Claude Code, Cursor, GitHub Copilot, Gemini CLI, Windsurf, and every AGENTS.md-reading tool**, by reading the project and asking you only the few things it can't detect.

Setting up a coding agent well is mostly retyping the same instructions file you've written ten times: the build command, the test command, the migration convention, the "never touch prod config" rule — and then doing it *again* in a different format for the next tool. `agent-scaffold` detects what it can from the repo — stack, version, modules, migration style, run/test commands, and which agent tools are already in use — interviews you once for the rest, and writes each selected tool's config in its native layout.

A human can walk the interview. So can a coding agent — `agent-scaffold` exposes the same
interview as JSON and as an MCP server, and can fill it in itself with `--ai`. See
[Letting an agent run it](#letting-an-agent-run-it).

> Formerly published as `@mfataka/claude-scaffold`. The old command name still works.

## Quickstart

Run it inside any repo:

```bash
npx @mfataka/agent-scaffold
```

It detects the stack, shows you what it found, asks which tools to configure (tools with existing config come pre-checked), and asks what to generate. Walk through the prompts — press `←` at any point to go back — and it writes the files. Re-run it any time: it **merges** into existing instruction files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`) instead of clobbering your edits, and skips rule/command files that already exist.

Non-interactive (CI, scripted setup): `--yes` accepts every detected default and prompts only for genuinely-required fields it can't know. `--dry-run` previews the writes without touching disk.

```bash
npx @mfataka/agent-scaffold --yes --dry-run
```

`--yes` needs a terminal for those required fields; in a non-TTY environment the tool exits with a clear message rather than writing blank sections.

Other flags: `--tools <list>` picks the target tools without the prompt (`claude,cursor,copilot,gemini,agents-md,windsurf`); `--stack <id>` skips detection and forces a stack plugin (`spring-boot`, `dart-flutter`, `node-ts`, `generic`) — useful in polyglot repos; `--root <dir>` operates on a repo other than the current directory; `--help` / `--version` do what you expect.

## Letting an agent run it

The interview is the bottleneck: it asks about intent — what the project *is*, what agents
must never touch — that no detector can infer. A coding agent already has the repository in
context, so it can answer those questions better than a form can guess, and faster than a
human can type. Three ways to let it, all driving the exact same pipeline as the interactive
prompts.

### 1. As an MCP server (Claude Code, Cursor, any MCP client)

Add it once, then just ask your agent to set the repo up:

```json
{
  "mcpServers": {
    "agent-scaffold": { "command": "npx", "args": ["-y", "@mfataka/agent-scaffold", "mcp"] }
  }
}
```

Two tools, meant to be called in order:

- **`scaffold_inspect`** — returns the detected stack and facts, every interview question with
  the answer shape it expects, the selectable skills/commands/agents/MCP servers, and a preview
  of what accepting the defaults would write. Writes nothing. Pass your `answers` back to it to
  see the preview and item lists those answers produce.
- **`scaffold_apply`** — runs the interview with the agent's answers and writes the files.
  `dryRun: true` previews instead.

### 2. As a JSON contract on the CLI

Same thing without MCP — useful in CI, scripts, or any agent that can run a shell command:

```bash
agent-scaffold plan  > plan.json                # questions + detected facts + write preview
agent-scaffold apply --answers answers.json     # writes the config (--dry-run to preview)
agent-scaffold apply --answers -                # or pipe answers in on stdin
```

`plan` emits one JSON object. Each question carries the key to answer it under and an
`answerType` telling you the shape:

```jsonc
{
  "stack": { "id": "node-ts", "detected": ["TypeScript · Node 20 · Next.js · npm", "ORM: prisma"] },
  "questions": [
    { "key": "overview", "answerType": "string", "required": true, "section": "## Overview",
      "question": "One line: what does this project do?" },
    { "key": "never", "answerType": "string[]", "required": true, "section": "## Never do",
      "options": [{ "value": "Never edit generated files by hand" }] }
  ],
  "selectables": { "skills": [{ "name": "run", "recommended": true }] }
}
```

Answers are a flat map keyed by `key`. `string[]` questions take an array (one bullet per
entry), `boolean` questions take `true`/`false`, and `options` are suggestions rather than a
closed set — a value outside them is kept as a custom answer, with a warning. Omit a key to
accept its detected value:

```json
{
  "tools": ["claude", "agents-md"],
  "answers": {
    "overview": "HTTP API for order intake and fulfilment, backed by Postgres via Prisma.",
    "architecture": ["Fastify routes in src/routes/, one file per resource"],
    "never": ["Never edit prisma/migrations/* by hand", "Never commit .env"]
  },
  "select": { "mcp": ["context7", "postgres"] }
}
```

`apply` answers with what it did, plus what it couldn't: `unanswered` lists required questions
that had no answer and no detected fallback (their sections are dropped), `ignored` lists answer
keys no question asked for — usually a typo or a stale plan — and `warnings` explains anything
it had to interpret. Both commands print JSON on stdout and exit non-zero with
`{"ok": false, "error": ...}` on failure, so nothing has to parse prose.

Two things worth knowing:

- `outputs.default` is what `apply` writes if you say nothing — everything in
  `outputs.available` except the **PDD methodology**, which is opt-in exactly as it is under
  `--yes`. Ask for it with `"outputs": { "pdd": true }`.
- A few answers feed back into detection — a Spring repo's migration tool, a Flutter app's
  state management — and can add or remove skills and commands. `plan` computes
  `selectables` and `preview` from the answers you send it, so if you answered one of those and
  intend to hand-pick items, run `plan` once more with your answers first. The interactive
  pickers see the same corrected list, because both go through the same pipeline.

### 3. Let it fill itself in — `--ai`

For a human who'd rather review than type. `agent-scaffold --ai` reads the repo, asks Claude to
draft every answer, and shows you the draft before anything is written:

```bash
agent-scaffold --ai                              # draft, review, write
agent-scaffold --ai --guidance "we deploy with ArgoCD; never mention Docker"
agent-scaffold --ai --yes --dry-run              # unattended preview
```

Accepting the draft replaces the *typing*, not the rest of the CLI: you still get the
"what should I set up?" picker and the per-item pickers for skills, commands, agents, and MCP
servers, with the drafted wording already filled in behind them. Decline instead and you drop
into the full interview with every prompt **pre-filled with the draft** — checklists
pre-checked, text fields pre-written — so you're editing rather than starting from a blank page.
`--ai --yes` is the unattended path that skips both.

`--ai` uses `claude-opus-5` by default (`--model` to change it) and needs credentials, either
`ANTHROPIC_API_KEY` or a profile from `ant auth login`. The Anthropic SDK it needs is an
**optional** dependency: installed by default, so `npx` works out of the box, and skippable with
`npm install --omit=optional` if you only ever use the interactive flow.

### Same interview, whichever route

All four routes drive one pipeline, so none of them is a reduced version of the others. That's
enforced by tests rather than by intent: for every stack fixture, `test/agent-parity.test.ts`
asserts the agent contract asks **the same questions in the same order** as the interactive
interview, runs **the same stages** with none skipped, offers **the same items** in each picker,
and — given the same answers — produces **byte-for-byte identical files**. It also asserts that
`plan`'s preview matches what `apply` then writes, and that the MCP tools return exactly what
the CLI does.

Existing instruction files are still merged rather than clobbered, and existing rule/command
files are still skipped. An agent re-running this is as safe as you re-running it.

## Supported tools

One interview, emitted per tool in its native layout:

| Tool | Instructions | Skills / rules | Commands | Agents | Permissions | MCP |
|---|---|---|---|---|---|---|
| **Claude Code** | `CLAUDE.md` | `.claude/skills/` | `.claude/commands/` | `.claude/agents/` | `.claude/settings.json` + guard hooks | `.mcp.json` |
| **AGENTS.md** (Codex, OpenCode, Zed, Jules, Amp…) | `AGENTS.md` | — | — | — | — | — |
| **Cursor** | `.cursor/rules/*.mdc` | `.cursor/rules/*.mdc` | `.cursor/commands/` | — | — | `.cursor/mcp.json` |
| **GitHub Copilot** | `.github/copilot-instructions.md` | `.github/instructions/` | `.github/prompts/` | `.github/chatmodes/` | — | `.vscode/mcp.json` |
| **Gemini CLI** | `GEMINI.md` | — | `.gemini/commands/*.toml` | — | — | `.gemini/settings.json` |
| **Windsurf** | `.windsurf/rules/` | `.windsurf/rules/` | `.windsurf/workflows/` | — | — | — |

Adapters skip what a tool can't express; a pipeline stage only runs when at least one selected tool can use its output. MCP configs use `${ENV_VAR}` placeholders (rewritten to `${env:VAR}` for VS Code) so no credentials ever land in the repo.

## What it generates

Pick any subset — "Everything", or hand-choose each output:

- **Instructions file** — interview-built. Sections come pre-filled with what detection found (project description from the README/manifest, stack summary, modules, build/run commands, migration style); you confirm or correct each. Optional sections left blank are dropped rather than left as empty headings.
- **Skills / rules** — task knowledge wired to your project: `run`, `test`, `verify`, a migration-aware `add-migration`, plus stack pattern guides (JPA patterns, react-patterns, effective-dart, …).
- **Slash commands / prompts / workflows** — `/build`, `/verify`, and stack-specific extras like `/codegen`.
- **Agents / chat modes** — review/build/security subagents for the stack.
- **Permissions & guardrails** (Claude Code) — a permission allow-list for your build wrapper, plus `PreToolUse` guard hooks (`protected-paths`, `secret-scan`) shipped as tunable scripts under `.claude/hooks/guards/`. Merged at the JSON level — existing entries are kept.
- **MCP servers** — curated per stack: docs lookup (Context7) everywhere, browser automation (Playwright) for frontends, plus opt-in Jira/Confluence, GitHub, and Postgres entries. Existing entries are never overwritten.
- **PDD methodology** (Claude Code) — the `walk-and-talk` → `write-prd` → `tdd` → `to-tickets` skills installed under `.claude/skills/pdd/`, tied together by an `## Implementation workflow` section in `CLAUDE.md`.

## Stacks

Detection is plugin-based. Today:

- **Spring Boot** (Maven or Gradle, single- or multi-module) — version, Java toolchain, starters, modules (including nested `settings.gradle` / `pom.xml` declarations), migration tool (Flyway / Liquibase / manual SQL), active profile, and run/build/test commands.
- **Dart / Flutter** (apps, packages, plugins, Dart CLIs, and `dart_frog`/`shelf`/`serverpod` servers — single package or a melos monorepo) — framework and SDK versions, project type, state management (Riverpod / Bloc / Provider / GetX / MobX / …), routing, `build_runner` codegen (freezed / json_serializable / …), lint ruleset, target platforms, melos packages, plus run/build/test/analyze commands and dedicated **State management**, **Code generation**, and **Linting & analysis** sections.
- **Node.js / TypeScript** (frontend apps, servers, CLIs, and libraries — single package or a workspaces/turborepo/nx monorepo) — framework (Next.js / Nuxt / Remix / SvelteKit / Astro / Vite / NestJS / Fastify / Hono / Express / …), package manager (npm / pnpm / yarn / bun, from the lockfile or `packageManager` field), TypeScript vs JS, test runner (vitest / jest / …) and E2E tooling, linter/formatter (eslint / biome / prettier), ORM and migration command (Prisma / Drizzle / TypeORM / …), workspace packages, plus dev/build/test/lint/typecheck commands from your scripts and dedicated **Database & migrations** and **Linting & formatting** sections.
- **Generic** — the fallback for everything else: the same interview flow, you fill the details in (with the README's first paragraph pre-filling the overview).

Detection ignores embedded sample projects (`fixtures/`, `testdata/`, `vendor/`, …) so a repo carrying test fixtures for another stack still detects as itself.

Adding a stack is a new plugin under `src/plugins/`; adding a tool is a new adapter under `src/tools/` — see [CONTRIBUTING](./CONTRIBUTING.md).

## Install

`npx @mfataka/agent-scaffold` needs no install. To keep it on your PATH:

```bash
npm install -g @mfataka/agent-scaffold
agent-scaffold           # the installed command is unscoped (claude-scaffold still works too)
```

### Local install (development or a private fork)

To hack on it, or keep your own edits to the catalog and have them take effect immediately:

```bash
git clone git@github.com:hammafataka/claude-scaffold.git
cd claude-scaffold
npm install
npm run build
npm link          # puts `agent-scaffold` on your PATH, pointing at this checkout
```

Iterate with `npm run dev` (runs the CLI from source via `tsx`) and `npm test`. Authored content lives under `src/catalog/` as plain markdown and is bundled by `scripts/build-content.mjs` — edit the markdown, re-run `npm run build`.

## Releasing

Maintainers: publish from the GitHub **Actions → Publish → Run workflow** button — pick `patch`/`minor`/`major` and it bumps, tags, and publishes to npm. PRs and pushes run typecheck/test/build via CI. See [PUBLISHING.md](./PUBLISHING.md).

## License

[MIT](./LICENSE).
