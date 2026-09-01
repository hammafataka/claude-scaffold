import { WriteAction, PlannedWrite, Facts } from "../plugins/types";
import { scanRepo } from "../core/repo-scanner";
import { OutputToggles, buildPlan, relevantOutputs } from "../core/pipeline";
import { applyWrites, summarize } from "../core/writer";
import { selectPlugin, PLUGINS, pluginIds } from "../plugins/registry";
import { TOOLS, detectTools, resolveTools, toolIds } from "../tools/registry";
import { answerAsk, answerChooseItems, emptyLog } from "./answers";
import { probeInterview } from "./probe";
import { AgentRequest, AgentWrite, ApplyResult, InspectResult, SCHEMA_VERSION } from "./types";
import { version } from "../../package.json";

const HOW_TO_ANSWER = [
  "Answer every question in `questions` using what you can see in the repository.",
  "Reply with a JSON object shaped { answers: { <key>: <value> }, select?: {...}, outputs?: {...} }.",
  "Use each question's `answerType`: \"string\" → a string, \"string[]\" → an array of strings,",
  "\"boolean\" → true/false. For a `string[]` question each array entry becomes one bullet.",
  "`options` are suggestions, not a closed set — a value outside them is kept as-is.",
  "Omit a key to accept its `detected` value; omitting a required key with no `detected`",
  "value drops that section from the generated file.",
  "Prefer concrete, repo-specific answers (real commands, real paths) over generic advice.",
  "",
  "Two things worth knowing about this payload:",
  "- `outputs.default` is what apply writes if you say nothing. It is `outputs.available`",
  "  minus the PDD methodology, which is opt-in: set outputs.pdd = true to include it.",
  "- `selectables` and `preview` are computed from the answers you sent (none, the first",
  "  time). A handful of answers feed back into detection — a Spring repo's migration tool,",
  "  a Flutter app's state management — and can add or remove items. If you answered one of",
  "  those, call inspect again with your answers to see the final lists before selecting.",
].join("\n");

function toAgentWrites(writes: PlannedWrite[]): AgentWrite[] {
  return writes.map((w) => ({
    path: w.path,
    action: w.action,
    note: w.note,
    bytes: Buffer.byteLength(w.content, "utf8"),
  }));
}

function plainFacts(facts: Facts): Record<string, string | number | boolean | undefined> {
  return { ...facts };
}

// Resolve the tool selection the same way the interactive CLI does: an explicit list
// wins, otherwise the tools already configured in the repo, otherwise Claude Code.
function pickTools(explicit: string[] | undefined, detected: string[]): string[] {
  if (explicit && explicit.length > 0) {
    resolveTools(explicit); // validate ids — throws with the available list
    return explicit;
  }
  return detected.length > 0 ? detected : ["claude"];
}

// Everything an agent needs to answer the interview in one shot: what was detected,
// every question with its answer shape, the pickable items, and a preview of the writes
// that accepting all the defaults would produce.
export async function inspect(req: AgentRequest = {}): Promise<InspectResult> {
  const root = req.root ?? process.cwd();
  const repo = scanRepo(root);
  const { plugin, detection } = selectPlugin(repo, PLUGINS, req.stack);

  const detected = detectTools(repo);
  const tools = pickTools(req.tools, detected);

  const available = relevantOutputs(plugin, detection.facts, tools);
  // PDD is opt-in in the interactive flow; keep that default, but still enumerate its
  // questions and skills so an agent knows the option exists.
  const defaults: OutputToggles = { ...available, pdd: false };

  const probe = await probeInterview(repo, {
    outputs: available,
    tools,
    stackId: req.stack,
    answers: req.answers,
  });

  // Preview what the defaults alone would write, so the agent can see the shape of the
  // change before answering anything. Never touches disk.
  const log = emptyLog();
  const preview = await buildPlan(repo, {
    yes: false,
    outputs: { ...defaults, ...req.outputs },
    tools,
    stackId: req.stack,
    ask: answerAsk(req.answers ?? {}, log),
    chooseItems: answerChooseItems(req.select, log),
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    version,
    root,
    stack: {
      id: plugin.id,
      displayName: plugin.displayName,
      confidence: detection.confidence,
      forced: req.stack !== undefined,
      available: pluginIds(),
      detected: plugin.describe?.(detection.facts) ?? [],
    },
    facts: plainFacts(detection.facts),
    tools: {
      available: TOOLS.map((t) => ({ id: t.id, displayName: t.displayName, hint: t.hint })),
      detected,
      selected: tools,
    },
    outputs: { available, default: defaults },
    questions: probe.questions,
    selectables: probe.selectables,
    preview: { writes: toAgentWrites(preview.writes), counts: summarize(preview.writes) },
    howToAnswer: HOW_TO_ANSWER,
  };
}

// Run the interview from a static answer map and write the result. This is the only
// path that touches disk, and only when dryRun is false.
export async function apply(req: AgentRequest = {}): Promise<ApplyResult> {
  const root = req.root ?? process.cwd();
  const repo = scanRepo(root);
  const { plugin, detection } = selectPlugin(repo, PLUGINS, req.stack);

  const tools = pickTools(req.tools, detectTools(repo));
  const available = relevantOutputs(plugin, detection.facts, tools);
  const outputs: OutputToggles = { ...available, pdd: false, ...req.outputs };

  const log = emptyLog();
  const answers = req.answers ?? {};
  const plan = await buildPlan(repo, {
    yes: false,
    outputs,
    tools,
    stackId: req.stack,
    ask: answerAsk(answers, log),
    chooseItems: answerChooseItems(req.select, log),
  });

  const dryRun = req.dryRun === true;
  await applyWrites(plan.writes, { root, dryRun });

  const asked = new Set(log.asked);
  const ignored = Object.keys(answers).filter((k) => !asked.has(k));
  if (ignored.length > 0) {
    log.warnings.push(
      `Ignored ${ignored.length} answer key(s) that no question asked for: ${ignored.join(", ")}. ` +
        `Re-run inspect if the plan is stale.`,
    );
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    ok: true,
    root,
    dryRun,
    stack: plan.plugin.id,
    tools,
    writes: toAgentWrites(plan.writes),
    counts: summarize(plan.writes),
    unanswered: log.unanswered,
    ignored,
    warnings: log.warnings,
  };
}

export { WriteAction, toolIds };
