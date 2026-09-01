import { RepoSnapshot, StackPlugin, PlannedWrite, Facts } from "../plugins/types";
import { selectPlugin, PLUGINS } from "../plugins/registry";
import { resolveFields, AskFn } from "./field-resolver";
import { BackSignal } from "./prompter";
import { Section } from "./md-document";
import { pddSkills } from "../catalog/pdd-skills";
import { pddWorkflowSection } from "../catalog/pdd-workflow";
import { Artifacts, emptyArtifacts } from "../tools/types";
import { resolveTools, combinedCapabilities } from "../tools/registry";

export enum SelectableKind {
  Skills = "skills",
  Commands = "commands",
  Agents = "agents",
  Mcp = "MCP servers",
  Pdd = "PDD skills",
}

export interface OutputToggles {
  instructions: boolean;
  skills: boolean;
  commands: boolean;
  agents: boolean;
  settings: boolean;
  mcp: boolean;
  pdd: boolean;
}

// An item the user can include/exclude within an output (a skill, command, agent, or
// MCP server). `hint` (the spec's description) is shown next to the name in the picker.
export interface SelectableItem {
  name: string;
  label: string;
  recommended: boolean;
  hint?: string;
}

export interface PlanOptions {
  yes: boolean;
  outputs: OutputToggles;
  // Target tools (adapter ids). The artifacts are emitted once per tool, each into its
  // own file layout. Defaults to Claude Code.
  tools?: string[];
  // Forced plugin id (from --stack); must match what the CLI already showed the user.
  stackId?: string;
  ask: AskFn;
  // Fired before each enabled output is built, so the CLI can show staged progress.
  onStage?: (title: string, index: number, total: number) => void;
  // Per-item picker for skills/commands/agents/MCP servers. Returns the chosen names.
  // When omitted (or in --yes), all recommended items are included.
  chooseItems?: (kind: SelectableKind, items: SelectableItem[]) => Promise<string[]>;
}

// Outputs worth offering for a given stack + tool selection: the plugin must have
// content to emit AND at least one selected tool must be able to express it. Shared by
// the interactive CLI, the agent JSON contract, and the MCP server so all three offer
// exactly the same menu.
export function relevantOutputs(
  plugin: StackPlugin,
  facts: Facts,
  toolIds: string[],
): OutputToggles {
  const caps = combinedCapabilities(resolveTools(toolIds));
  return {
    instructions: caps.instructions && plugin.sections(facts).length > 0,
    skills: caps.skills && plugin.skills(facts).some((s) => s.condition !== false),
    commands: caps.commands && plugin.commands(facts).some((c) => c.condition !== false),
    agents: caps.agents && plugin.agents(facts).some((a) => a.condition !== false),
    settings: caps.settings && plugin.settings(facts).length > 0,
    mcp: caps.mcp && (plugin.mcpServers?.(facts) ?? []).some((m) => m.condition !== false),
    pdd: caps.pdd,
  };
}

export interface Plan {
  plugin: StackPlugin;
  facts: Facts;
  writes: PlannedWrite[];
}

// Interview every section of the instructions document. Returns the generated sections
// plus the confirmed field values (so the plugin can map them back into facts).
async function buildInstructions(
  plugin: StackPlugin,
  facts: Facts,
  opts: PlanOptions,
): Promise<{ sections: Section[]; confirmed: Record<string, string> }> {
  const specs = plugin.sections(facts);
  const generated: Section[] = [];
  const confirmed: Record<string, string> = {};
  let i = 0;
  while (i < specs.length) {
    const spec = specs[i];
    try {
      const values = await resolveFields(spec.fields, {
        yes: opts.yes,
        ask: opts.ask,
        ctx: { stage: "Instructions", section: spec.heading },
      });
      Object.assign(confirmed, values);
      generated.push({ heading: spec.heading, body: spec.render(values) });
      i++;
    } catch (e) {
      if (e instanceof BackSignal) {
        if (i === 0) throw e; // propagate to stage loop → go back one stage
        if (generated.length > 0) generated.pop();
        i--;
      } else {
        throw e;
      }
    }
  }
  return { sections: generated, confirmed };
}

// Narrow a list of named, possibly-recommended specs to the user's selection.
// In --yes mode (or with no picker) we keep every recommended item.
async function pickItems<T extends { name: string; description?: string; recommended?: boolean; condition?: boolean }>(
  kind: SelectableKind,
  specs: T[],
  opts: PlanOptions,
): Promise<T[]> {
  const available = specs.filter((s) => s.condition !== false);
  if (available.length === 0) return [];
  if (opts.yes || !opts.chooseItems) {
    return available.filter((s) => s.recommended !== false);
  }
  const chosen = new Set(
    await opts.chooseItems(
      kind,
      available.map((s) => ({
        name: s.name,
        label: s.name,
        recommended: s.recommended !== false,
        hint: s.description,
      })),
    ),
  );
  return available.filter((s) => chosen.has(s.name));
}

export async function buildPlan(repo: RepoSnapshot, opts: PlanOptions): Promise<Plan> {
  const { plugin, detection } = selectPlugin(repo, PLUGINS, opts.stackId);
  const facts = detection.facts;
  const tools = resolveTools(opts.tools ?? ["claude"]);
  const caps = combinedCapabilities(tools);

  // Resolve plugin-level fields (e.g. sqlDir/sqlPrefix for manual-sql) before any stage
  // so that sections, skills, and commands all see the confirmed values.
  if (plugin.fields) {
    const pluginFields = plugin.fields(facts);
    if (pluginFields.length > 0) {
      const confirmed = await resolveFields(pluginFields, {
        yes: opts.yes,
        ask: opts.ask,
        ctx: { stage: "Stack details" },
      });
      for (const [k, v] of Object.entries(confirmed)) {
        if (v !== undefined && v !== "") facts[k] = v;
      }
    }
  }

  // Each stage interviews/selects one kind of artifact and stores it on `artifacts`.
  // Stages are idempotent (they replace their own slice), so back-navigation simply
  // steps the index back and re-runs.
  const artifacts: Artifacts = emptyArtifacts();
  type Stage = { title: string; run(): Promise<void> };
  const stages: Stage[] = [];

  if (opts.outputs.instructions && caps.instructions) {
    stages.push({
      title: "Instructions",
      run: async () => {
        const { sections, confirmed } = await buildInstructions(plugin, facts, opts);
        artifacts.instructions = { displayName: plugin.displayName, sections };
        // Let the plugin map confirmed choices back into facts so subsequent stages
        // (skills, commands) see the user-corrected values (e.g. chosen migration tool).
        if (plugin.mapConfirmedFacts) Object.assign(facts, plugin.mapConfirmedFacts(confirmed));
      },
    });
  }
  if (opts.outputs.skills && caps.skills) {
    stages.push({
      title: "Skills",
      run: async () => {
        artifacts.skills = await pickItems(SelectableKind.Skills, plugin.skills(facts), opts);
      },
    });
  }
  if (opts.outputs.commands && caps.commands) {
    stages.push({
      title: "Slash commands",
      run: async () => {
        artifacts.commands = await pickItems(SelectableKind.Commands, plugin.commands(facts), opts);
      },
    });
  }
  if (opts.outputs.agents && caps.agents) {
    stages.push({
      title: "Agents",
      run: async () => {
        artifacts.agents = await pickItems(SelectableKind.Agents, plugin.agents(facts), opts);
      },
    });
  }
  if (opts.outputs.settings && caps.settings) {
    stages.push({
      title: "Settings",
      run: async () => {
        artifacts.permissions = plugin.settings(facts);
      },
    });
  }
  if (opts.outputs.mcp && caps.mcp && plugin.mcpServers) {
    stages.push({
      title: "MCP servers",
      run: async () => {
        artifacts.mcpServers = await pickItems(SelectableKind.Mcp, plugin.mcpServers!(facts), opts);
      },
    });
  }
  if (opts.outputs.pdd && caps.pdd) {
    stages.push({
      title: "PDD methodology",
      run: async () => {
        artifacts.pddSkills = await pickItems(SelectableKind.Pdd, pddSkills(), opts);
        const wf = pddWorkflowSection();
        artifacts.pddWorkflow = { heading: wf.heading, body: wf.body };
      },
    });
  }

  // Run stages in order. On BackSignal: re-throw at stage 0 (caller re-shows output
  // selector), otherwise step back one stage and re-run it.
  let i = 0;
  while (i < stages.length) {
    opts.onStage?.(stages[i].title, i + 1, stages.length);
    try {
      await stages[i].run();
      i++;
    } catch (e) {
      if (e instanceof BackSignal) {
        if (i === 0) throw e; // propagate → cli re-shows output selector
        i--;
      } else {
        throw e;
      }
    }
  }

  // Emit once per selected tool. Paths are disjoint across adapters, so a plain concat
  // is safe; dedupe defensively anyway (first tool wins).
  const writes: PlannedWrite[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    for (const w of tool.plan(artifacts, repo)) {
      if (seen.has(w.path)) continue;
      seen.add(w.path);
      writes.push(w);
    }
  }
  return { plugin, facts, writes };
}
