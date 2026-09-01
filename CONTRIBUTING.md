# Contributing

Thanks for helping improve `agent-scaffold`. This is a small, plugin-based TypeScript CLI — most contributions are a **new stack plugin** (detection + interview for a language/framework), a **new tool adapter** (emitting config for another coding agent), a tweak to the **authored content** (the wording that lands in generated files), or a fix to the **core pipeline**.

## Getting set up

```bash
npm install
npm run dev        # run the CLI from source (tsx) inside the current repo
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run build      # bundle content + tsup → dist/cli.js
```

Node 20+ is required.

## How it fits together

```
src/
  cli.ts                 entry: interactive run, plus the plan/apply/mcp subcommands
  core/
    repo-scanner.ts      read-only snapshot of the target repo
    pipeline.ts          interview stages collect Artifacts; tool adapters emit them
    prompter.ts          @clack prompts + ← back-navigation
    field-resolver.ts    detected-value vs. ask logic (honours --yes)
    checklist.ts         pure bullet-list helpers (shared by prompts and agent answers)
    readme.ts            README first-paragraph summary (Overview prefill)
    md-document.ts        / md-merger.ts   parse & merge markdown instruction files
    writer.ts            apply planned writes (create / update / skip)
  agent/                 AGENT MODE — the same interview, driven by a machine
    types.ts             the JSON contract (questions, answers, results) + SCHEMA_VERSION
    probe.ts             enumerate the interview by walking it with a recording `ask`
    answers.ts           answer-map-driven `ask` / item picker, with coercion + warnings
    session.ts           inspect() and apply() — the core all three agent routes share
    mcp.ts               stdio JSON-RPC MCP server (scaffold_inspect / scaffold_apply)
    autofill.ts          --ai: ask Claude to draft the answers from the repo
    cli-modes.ts         answer-file reading, draft preview, draft-seeded prompts
  plugins/               STACKS — what the repo is (detection + interview content)
    types.ts             StackPlugin + all the spec interfaces
    registry.ts          the list of real plugins + the detection threshold
    spring-boot/         detect.ts, sections.ts, settings.ts, index.ts
    dart-flutter/        same layout, for Dart / Flutter
    node-ts/             same layout, for Node.js / TypeScript
    generic/             the fallback plugin
  tools/                 TOOLS — where the config lands (one adapter per coding agent)
    types.ts             ToolAdapter + Artifacts (the canonical pipeline output)
    registry.ts          adapter list, tool detection, capability union
    shared.ts            merge/frontmatter/MCP-JSON helpers shared by adapters
    claude.ts cursor.ts copilot.ts gemini.ts agents-md.ts windsurf.ts
  catalog/               ALL curated wording lives here (see below)
  generators/            Claude-layout emitters (skills, commands, agents, settings, mcp)
scripts/build-content.mjs  bundles authored markdown → *-content.json
test/                    vitest specs + fixtures/ (sample repos)
```

The golden rule: **engine code carries no project wording, and catalog content carries no logic.** If you're tuning what a generated file *says*, you almost certainly want `src/catalog/`, not a plugin. Stack plugins never know about tools; tool adapters never know about stacks — they meet at `Artifacts`.

`src/agent/` adds no second pipeline: `probe.ts` enumerates the questions by running the real
`buildPlan` with an `ask` that records each field and returns its detected value, and `apply()`
runs that same `buildPlan` with an `ask` backed by the caller's answer map. That's deliberate —
a hand-maintained question list would drift from the interview it describes. A new plugin field
shows up in `plan`, in the MCP tool, and in the `--ai` schema with no extra work; the one thing
to keep true is that field `key`s stay unique within a plugin, since answers are a flat map.

## Editing authored content

Curated prose lives as plain markdown and structured option lists under `src/catalog/`:

- `section-options.ts` / `dart-section-options.ts` / `node-section-options.ts` — checklist/menu options for each `CLAUDE.md` section (`SPRING_GIT_WORKFLOW`, `springConfigOptions`, `nodeTestOptions`, …).
- `java/skills/<name>/SKILL.md` (+ `references/`) and `java/agents/<name>.md` — the Spring Boot skills and agents, authored as markdown.
- `dart/skills/<name>/SKILL.md` (+ `references/`) and `dart/agents/<name>.md` — the Dart / Flutter skills and agents.
- `node/skills/<name>/SKILL.md` and `node/agents/<name>.md` — the Node.js / TypeScript skills and agents.
- `pdd/skills/<name>/SKILL.md` — the PDD methodology skills.
- `pdd-workflow.ts` — the ordered `## Implementation workflow` section that references the PDD skills.
- `mcp-servers.ts` — the curated MCP servers plugins can offer for `.mcp.json` (credentials only ever as `${ENV_VAR}` placeholders).

The markdown under `java/`, `dart/`, `node/`, and `pdd/` is **bundled into JSON at build time** by `scripts/build-content.mjs`. After editing any of it, run `npm run gen:content` (or `npm run build`) so `java-content.json` / `dart-content.json` / `node-content.json` / `pdd-content.json` are regenerated — otherwise your changes won't show up. This is the most common gotcha.

## Adding a stack plugin

1. Implement the `StackPlugin` interface (`src/plugins/types.ts`) under `src/plugins/<stack>/`:
   - `detect(repo)` → `{ confidence, facts }`. Confidence ≥ `THRESHOLD` (0.5) wins; otherwise the generic fallback handles the repo.
   - `sections(facts)` → the `CLAUDE.md` sections (use the helpers and pull option lists from `catalog/section-options.ts`).
   - `skills` / `commands` / `agents` / `settings` builders, and the optional hooks: `fields` / `mapConfirmedFacts` for values the user confirms mid-run, `describe(facts)` for the CLI's "Detected" panel, and `mcpServers(facts)` to offer entries for `.mcp.json` (reuse `catalog/mcp-servers.ts`).
2. Register it in `src/plugins/registry.ts` (`PLUGINS`).
3. Add a fixture repo under `test/fixtures/<name>/` and a `test/<stack>-detect.test.ts`.

No engine changes are needed — the pipeline is plugin-agnostic.

## Adding a tool adapter

1. Implement the `ToolAdapter` interface (`src/tools/types.ts`) under `src/tools/<tool>.ts`:
   - `detect(repo)` → does this tool's config already exist (pre-checks it in the picker)?
   - `capabilities` → which artifact kinds the tool can express (a stage only runs when some selected tool supports it).
   - `plan(artifacts, repo)` → translate the canonical `Artifacts` into the tool's file layout. Reuse `shared.ts`: `planInstructionsWrite` (markdown merge), `planMcpJsonWrite` (JSON merge, never overwrites existing entries), `writeOnce` (skip-if-exists), `frontmatter`.
2. Register it in `src/tools/registry.ts` (`TOOLS`).
3. Add cases to `test/tools.test.ts`.

Never inline credentials in generated config — MCP entries use `${ENV_VAR}` placeholders (see `catalog/mcp-servers.ts`).

## Tests

- `vitest`, one spec per area under `test/`. Detection tests run against sample repos in `test/fixtures/`.
- Cover new behavior, and keep the suite green: `npm test` must pass, and `npm run typecheck` must be clean, before you open a PR.
- Prefer testing through the public surface (a plugin's `detect`/`sections`, the pipeline's `buildPlan`, `agent/session`'s `inspect`/`apply`) rather than internals.
- Agent mode has its own specs: `agent-contract` (inspect/apply end to end, including writes to a
  temp dir), `agent-answers` (coercion), `agent-mcp` (the protocol handler, driven over an
  in-memory transport), `agent-autofill` (schema + prompt building, with the Anthropic SDK
  mocked — no test ever calls the real API), and `agent-cli-modes`.
- **`agent-parity.test.ts` is the one to keep green when you touch the pipeline.** For every
  stack fixture it walks the real interview and the agent contract side by side and asserts they
  ask the same questions in the same order, run the same stages, offer the same items, and emit
  byte-identical files for the same answers — plus that `plan`'s preview matches `apply`, and
  that the MCP tools return what the CLI returns. If you add a stage, a picker, or a plugin
  field, add its fixture here; the suite is written so that a route quietly falling behind fails
  rather than passes.

## Pull requests

- Keep diffs focused; match the surrounding style (the code is heavily commented with *why*, not *what* — follow suit).
- Run `npm run build && npm test` before pushing.
- Describe the user-visible change and how you verified it.

By contributing you agree your work is licensed under the project's [MIT License](./LICENSE).
