import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import { scanRepo } from "./core/repo-scanner";
import { buildPlan, OutputToggles, Plan, relevantOutputs } from "./core/pipeline";
import { askField, chooseOutputs, chooseItems, chooseTools, BackSignal } from "./core/prompter";
import { applyWrites, summarize } from "./core/writer";
import { selectPlugin, pluginIds, PLUGINS } from "./plugins/registry";
import { TOOLS, toolIds, detectTools, resolveTools } from "./tools/registry";
import { StackPlugin, Facts, WriteAction } from "./plugins/types";
import { inspect, apply as agentApply } from "./agent/session";
import { runMcpServer } from "./agent/mcp";
import { draftAnswers, DEFAULT_MODEL } from "./agent/autofill";
import { formatDraft, readRequest, seedAsk } from "./agent/cli-modes";
import { answerAsk, emptyLog } from "./agent/answers";
import { AnswerMap } from "./agent/types";
import { version } from "../package.json";

// Agent-facing subcommands. Anything else on the command line is a flag; with no
// subcommand at all the CLI behaves exactly as it always has (interactive interview).
export const COMMANDS = ["plan", "apply", "mcp"] as const;
export type Command = (typeof COMMANDS)[number];

export interface CliArgs {
  command?: Command;
  dryRun: boolean;
  yes: boolean;
  help: boolean;
  version: boolean;
  ai: boolean;
  stack?: string;
  tools?: string[];
  root?: string;
  answers?: string;
  model?: string;
  guidance?: string;
  errors: string[]; // unknown flags / missing values — non-empty means "print help, exit 1"
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, yes: false, help: false, version: false, ai: false, errors: [] };

  // Options that take a value, mapped to the field they fill.
  const valued: Record<string, keyof CliArgs> = {
    "--stack": "stack",
    "--root": "root",
    "--answers": "answers",
    "--model": "model",
    "--guidance": "guidance",
  };
  const hints: Record<string, string> = {
    "--stack": "a value (e.g. --stack node-ts)",
    "--root": "a directory path (e.g. --root .)",
    "--answers": "a JSON file path, or - for stdin",
    "--model": "a model id (e.g. --model claude-sonnet-5)",
    "--guidance": "a string of extra instructions",
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a in valued) {
      const next = argv[i + 1];
      // "-" is a legitimate --answers value (stdin), so only treat a leading dash as a
      // missing value when it's longer than one character.
      if (next === undefined || (next.startsWith("-") && next.length > 1)) {
        args.errors.push(`${a} requires ${hints[a]}`);
      } else {
        (args as unknown as Record<string, unknown>)[valued[a]] = next;
        i++;
      }
      continue;
    }

    switch (a) {
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--yes":
      case "-y":
        args.yes = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--version":
      case "-v":
        args.version = true;
        break;
      case "--ai":
        args.ai = true;
        break;
      case "--tools": {
        const next = argv[i + 1];
        if (!next || next.startsWith("-")) {
          args.errors.push("--tools requires a comma-separated list (e.g. --tools claude,cursor)");
        } else {
          args.tools = next.split(",").map((t) => t.trim()).filter(Boolean);
          i++;
        }
        break;
      }
      default:
        if (a.startsWith("-")) {
          args.errors.push(`Unknown option: ${a}`);
        } else if (args.command) {
          args.errors.push(`Unexpected argument: ${a}`);
        } else if ((COMMANDS as readonly string[]).includes(a)) {
          args.command = a as Command;
        } else {
          args.errors.push(`Unknown command: ${a}. Expected one of: ${COMMANDS.join(", ")}`);
        }
    }
  }
  return args;
}

export function helpText(): string {
  return [
    `agent-scaffold ${version} — bootstrap a repo's AI coding-agent config`,
    "",
    "Usage: agent-scaffold [command] [options]",
    "",
    "Detects the stack AND the coding tools already in use, interviews you for what it",
    "can't detect, and writes each tool's config in its native layout — Claude Code",
    "(CLAUDE.md, .claude/, .mcp.json), AGENTS.md, Cursor (.cursor/), GitHub Copilot",
    "(.github/), Gemini CLI (GEMINI.md, .gemini/), Windsurf (.windsurf/). Re-running",
    "merges into existing files instead of clobbering them.",
    "",
    "Commands:",
    "  (none)              Interactive interview (default)",
    "  plan                Print the interview as JSON: detected facts, every question",
    "                      with its answer shape, selectable items, and a write preview",
    "  apply               Run the interview from a JSON answer file and write the config",
    "  mcp                 Serve scaffold_inspect / scaffold_apply over stdio MCP, so a",
    "                      coding agent can drive the whole thing as a tool",
    "",
    "Options:",
    "  -y, --yes           Accept detected defaults; prompt only for required unknowns",
    "      --dry-run       Preview the writes without touching disk",
    "      --ai            Let Claude draft the answers from the repo, then review them",
    `                      (default model: ${DEFAULT_MODEL}; needs @anthropic-ai/sdk)`,
    "      --model <id>    Model for --ai",
    "      --guidance <s>  Extra instructions for --ai (e.g. house rules it can't detect)",
    "      --answers <f>   JSON answers for `apply` (- reads stdin)",
    "      --root <dir>    Repository to operate on (default: current directory)",
    "      --stack <id>    Skip stack detection and use a specific plugin",
    `                      (${pluginIds().join(", ")})`,
    "      --tools <list>  Comma-separated target tools (default: detected, else claude)",
    `                      (${toolIds().join(", ")})`,
    "  -h, --help          Show this help",
    "  -v, --version       Show the version",
    "",
    "Agent workflow:",
    "  agent-scaffold plan --root . > plan.json     # questions + detected facts",
    "  agent-scaffold apply --answers answers.json  # writes the config",
  ].join("\n");
}

// A readable, grouped summary of what detection found. Each plugin describes its own
// facts; the fallback covers plugins without a describe() (e.g. generic).
function formatDetected(plugin: StackPlugin, facts: Facts): string {
  const lines = plugin.describe?.(facts) ?? [];
  return lines.length ? lines.join("\n") : "No specific facts — you'll fill the details in.";
}

function emit(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

// `plan` / `apply`: a single JSON object on stdout, errors as JSON on stdout too (with a
// non-zero exit), so a calling agent never has to parse prose.
async function runPlan(args: CliArgs): Promise<number> {
  emit(await inspect({ root: args.root, stack: args.stack, tools: args.tools }));
  return 0;
}

async function runApply(args: CliArgs): Promise<number> {
  const request = args.answers ? readRequest(args.answers) : {};
  const result = await agentApply({
    ...request,
    root: args.root ?? request.root,
    stack: args.stack ?? request.stack,
    tools: args.tools ?? request.tools,
    dryRun: args.dryRun || request.dryRun === true,
  });
  emit(result);
  return 0;
}

// Draft the interview with Claude and hand the result to the human. --yes writes it
// straight through; otherwise the draft is shown for approval, and declining drops into
// the normal interview with every prompt pre-filled with the draft.
async function runAi(args: CliArgs, root: string): Promise<AnswerMap | null> {
  const repo = scanRepo(root);
  const plan = await inspect({ root, stack: args.stack, tools: args.tools });

  const spin = p.spinner();
  spin.start(`Asking ${args.model ?? DEFAULT_MODEL} to draft ${plan.questions.length} answers from the repo`);
  let draft;
  try {
    draft = await draftAnswers(repo, plan, { model: args.model, guidance: args.guidance });
  } catch (e) {
    spin.stop("Draft failed", 1);
    throw e;
  }
  spin.stop(`Drafted by ${draft.model} (${draft.inputTokens} in / ${draft.outputTokens} out)`);

  p.note(formatDraft(draft.answers, plan.questions), "Drafted answers");
  if (args.yes) return draft.answers;

  const ok = await p.confirm({ message: "Use these answers? (No opens the interview pre-filled with them)" });
  if (p.isCancel(ok)) {
    p.cancel("Cancelled — nothing was written.");
    process.exit(0);
  }
  return ok ? draft.answers : null; // null → interactive, seeded
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.errors.length > 0) {
    for (const e of args.errors) console.error(e);
    console.error("");
    console.error(helpText());
    return 1;
  }
  if (args.help) {
    console.log(helpText());
    return 0;
  }
  if (args.version) {
    console.log(version);
    return 0;
  }

  // Machine-facing modes: no clack UI, no prompts, JSON in and JSON out.
  if (args.command === "mcp") return runMcpServer();
  if (args.command === "plan" || args.command === "apply") {
    try {
      return args.command === "plan" ? await runPlan(args) : await runApply(args);
    } catch (e) {
      emit({ schemaVersion: 1, ok: false, error: e instanceof Error ? e.message : String(e) });
      return 1;
    }
  }

  const root = args.root ?? process.cwd();
  const repo = scanRepo(root);

  p.intro(`agent-scaffold ${version}`);

  let selected;
  try {
    selected = selectPlugin(repo, PLUGINS, args.stack);
    if (args.tools) resolveTools(args.tools); // validate ids up front
  } catch (e) {
    p.log.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
  const { plugin, detection } = selected;
  p.note(
    formatDetected(plugin, detection.facts),
    args.stack ? `Stack (via --stack): ${plugin.displayName}` : `Detected: ${plugin.displayName}`,
  );

  // Target tools: --tools wins; otherwise detected configs pre-check the picker
  // (--yes and --ai take the detected set, defaulting to Claude Code).
  const detectedTools = detectTools(repo);
  let tools: string[];
  if (args.tools) {
    tools = args.tools;
  } else if (args.yes || args.ai) {
    tools = detectedTools.length > 0 ? detectedTools : ["claude"];
  } else {
    tools = await chooseTools(
      TOOLS.map((t) => ({ id: t.id, displayName: t.displayName, hint: t.hint })),
      detectedTools,
    );
  }

  // --ai drafts the answers up front. Accepting them replaces the typing, not the rest
  // of the CLI: the output picker and the per-item pickers below still run, so no stage
  // is skipped. Declining seeds those same prompts with the draft instead.
  // Only --ai --yes takes the fully unattended path.
  let drafted: AnswerMap | null = null;
  let draftAccepted = false;
  if (args.ai) {
    try {
      drafted = await runAi(args, root);
    } catch (e) {
      p.log.error(e instanceof Error ? e.message : String(e));
      return 1;
    }
    draftAccepted = drafted !== null;

    if (draftAccepted && args.yes) {
      const result = await agentApply({
        root,
        stack: args.stack,
        tools,
        answers: drafted!,
        dryRun: args.dryRun,
      });
      for (const w of result.writes) {
        p.log.message(`${args.dryRun ? `[dry-run ${w.action}]` : `[${w.action}]`} ${w.path}${w.note ? ` (${w.note})` : ""}`);
      }
      for (const w of result.warnings) p.log.warn(w);
      p.outro(
        args.dryRun
          ? `Dry run — nothing written. Would create ${result.counts[WriteAction.Create]}, update ${result.counts[WriteAction.Update]}, skip ${result.counts[WriteAction.Skip]}.`
          : `Done. Created ${result.counts[WriteAction.Create]}, updated ${result.counts[WriteAction.Update]}, skipped ${result.counts[WriteAction.Skip]}.`,
      );
      return 0;
    }
  }

  const relevant = relevantOutputs(plugin, detection.facts, tools);
  let outputs = args.yes ? { ...relevant, pdd: false } : await chooseOutputs(relevant);

  // In --yes mode, resolveFields uses detected values and prompts ONLY for required
  // fields with no detected value (e.g. Overview, Architecture, Never do). --yes skips
  // prompts for detectable fields, not for genuinely-unknown required ones.
  const onStage = (title: string, index: number, count: number) =>
    p.log.step(`Stage ${index}/${count} — ${title}`);

  // Three ways to answer a field:
  //   accepted draft  → answer from it silently (the human already approved the wording)
  //   declined draft  → prompt, pre-filled with the draft so they edit rather than retype
  //   no --ai         → prompt as always
  // The pickers that follow are interactive in all three cases.
  const draftLog = emptyLog();
  const ask = draftAccepted
    ? answerAsk(drafted!, draftLog)
    : args.ai
      ? seedAsk(askField, (drafted ?? {}) as AnswerMap)
      : askField;

  // Re-show the output selector whenever BackSignal escapes the pipeline (user pressed
  // Escape at the very first prompt of the first stage).
  let plan!: Plan;
  while (true) {
    try {
      plan = await buildPlan(repo, {
        yes: args.yes,
        outputs,
        tools,
        stackId: args.stack,
        ask,
        onStage,
        chooseItems,
      });
      break;
    } catch (e) {
      if (e instanceof BackSignal && !args.yes) {
        outputs = await chooseOutputs(relevant);
      } else {
        throw e;
      }
    }
  }

  for (const w of draftLog.warnings) p.log.warn(w);
  if (draftLog.unanswered.length > 0) {
    p.log.warn(
      `The draft left these required questions blank, so their sections were dropped: ${draftLog.unanswered.join(", ")}.`,
    );
  }

  for (const w of plan.writes) {
    const tag = args.dryRun ? `[dry-run ${w.action}]` : `[${w.action}]`;
    p.log.message(`${tag} ${w.path}${w.note ? ` (${w.note})` : ""}`);
  }

  await applyWrites(plan.writes, { root, dryRun: args.dryRun });

  const counts = summarize(plan.writes);
  p.outro(
    args.dryRun
      ? `Dry run — nothing written. Would create ${counts[WriteAction.Create]}, update ${counts[WriteAction.Update]}, skip ${counts[WriteAction.Skip]}.`
      : `Done. Created ${counts[WriteAction.Create]}, updated ${counts[WriteAction.Update]}, skipped ${counts[WriteAction.Skip]}.`,
  );
  return 0;
}

// True when this file is the process entry point. We compare realpaths rather than
// matching the filename: when installed as a bin, the process is launched through a
// `node_modules/.bin/claude-scaffold` symlink, so process.argv[1] ends in the bin
// name, not "cli.js". Resolving the symlink and comparing to this module's own path
// works for `tsx src/cli.ts` (dev), the built bin (npx / global install), and avoids
// firing main() when tests import parseArgs from this module.
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      p.log.error(String(err?.stack ?? err));
      process.exit(1);
    },
  );
}
