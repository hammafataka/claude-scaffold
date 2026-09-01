import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { scanRepo } from "../src/core/repo-scanner";
import { buildPlan, relevantOutputs, SelectableItem, SelectableKind } from "../src/core/pipeline";
import { selectPlugin, PLUGINS } from "../src/plugins/registry";
import { inspect, apply } from "../src/agent/session";
import { createMcpHandler, Rpc } from "../src/agent/mcp";
import { answersSchema } from "../src/agent/autofill";
import { AnswerMap } from "../src/agent/types";
import { FieldKind, FieldSpec } from "../src/plugins/types";
import { answerAsk, answerChooseItems, emptyLog } from "../src/agent/answers";

// One repo per stack plugin, plus a second of two of them, so parity is checked against
// every interview the tool can produce rather than a single happy path.
const FIXTURES = ["nextjs-app", "express-api", "gradle-app", "maven-app", "flutter-app", "dart-cli"];
const fixture = (name: string) => join(__dirname, "fixtures", name);

// What the interactive CLI does, minus the terminal: walk the real pipeline, recording
// every question it asks and every stage it enters. `answer` stands in for the human.
async function interactiveWalk(
  root: string,
  answer: (f: FieldSpec) => string,
  opts: { pdd?: boolean } = {},
) {
  const repo = scanRepo(root);
  const { plugin, detection } = selectPlugin(repo, PLUGINS, undefined);
  const relevant = relevantOutputs(plugin, detection.facts, ["claude"]);

  const asked: string[] = [];
  const stages: string[] = [];
  const offered: Record<string, string[]> = {};

  const plan = await buildPlan(repo, {
    // chooseOutputs("Everything") hands back exactly `relevant`; PDD is the one output
    // the agent contract defaults off, so let the caller match either behaviour.
    yes: false,
    outputs: { ...relevant, pdd: opts.pdd ?? false },
    tools: ["claude"],
    ask: async (f) => {
      asked.push(f.key);
      return answer(f);
    },
    onStage: (t) => void stages.push(t),
    chooseItems: async (kind: SelectableKind, items: SelectableItem[]) => {
      offered[kind] = items.map((i) => i.name);
      return items.filter((i) => i.recommended).map((i) => i.name);
    },
  });

  return { asked, stages, offered, plan };
}

const takeDetected = (f: FieldSpec) => f.detectedValue ?? "";

describe.each(FIXTURES)("interview parity — %s", (name) => {
  const root = fixture(name);

  it("asks the agent exactly the questions the interactive interview asks, in order", async () => {
    const { asked } = await interactiveWalk(root, takeDetected, { pdd: true });
    const { questions } = await inspect({ root });

    expect(questions.map((q) => q.key)).toEqual(asked);
  });

  it("runs the same stages, and skips none of them", async () => {
    const { stages } = await interactiveWalk(root, takeDetected, { pdd: true });
    expect(stages).toEqual([
      "Instructions",
      "Skills",
      "Slash commands",
      "Agents",
      "Settings",
      "MCP servers",
      "PDD methodology",
    ]);

    // Every stage that produces pickable items is represented in the contract.
    const { selectables, outputs } = await inspect({ root });
    expect(selectables.skills.length).toBeGreaterThan(0);
    expect(selectables.commands.length).toBeGreaterThan(0);
    expect(selectables.agents.length).toBeGreaterThan(0);
    expect(selectables.pdd.length).toBeGreaterThan(0);
    expect(outputs.available.settings).toBe(true);
  });

  it("offers the agent the same items the interactive pickers offer", async () => {
    const { offered } = await interactiveWalk(root, takeDetected, { pdd: true });
    const { selectables } = await inspect({ root });

    expect(selectables.skills.map((s) => s.name)).toEqual(offered[SelectableKind.Skills]);
    expect(selectables.commands.map((s) => s.name)).toEqual(offered[SelectableKind.Commands]);
    expect(selectables.agents.map((s) => s.name)).toEqual(offered[SelectableKind.Agents]);
    expect(selectables.mcp.map((s) => s.name)).toEqual(offered[SelectableKind.Mcp]);
    expect(selectables.pdd.map((s) => s.name)).toEqual(offered[SelectableKind.Pdd]);
  });

  it("produces byte-identical files for the same answers", async () => {
    // An answer for every question, in the shape each one expects.
    const { questions } = await inspect({ root });
    const answers: AnswerMap = {};
    for (const q of questions) {
      answers[q.key] =
        q.answerType === "string[]"
          ? [`${q.key}-one`, `${q.key}-two`]
          : q.answerType === "boolean"
            ? true
            : `${q.key}-answer`;
    }

    const human = (f: FieldSpec) => {
      const raw = answers[f.key];
      if (f.kind === FieldKind.Multiselect) return (raw as string[]).map((v) => `- ${v}`).join("\n");
      if (f.kind === FieldKind.Confirm) return "true";
      return String(raw);
    };

    const { plan } = await interactiveWalk(root, human);
    const agent = await apply({ root, dryRun: true, answers });

    expect(agent.writes.map((w) => w.path)).toEqual(plan.writes.map((w) => w.path));
    expect(agent.unanswered).toEqual([]);

    // Same paths and sizes through the reported contract...
    for (const w of plan.writes) {
      const mirror = agent.writes.find((x) => x.path === w.path)!;
      expect(mirror.action).toBe(w.action);
      expect(mirror.bytes).toBe(Buffer.byteLength(w.content, "utf8"));
    }

    // ...and byte-for-byte identical content, checked against the same planner the
    // agent path runs, so a difference in wording could not slip through equal sizes.
    const repo = scanRepo(root);
    const { plugin, detection } = selectPlugin(repo, PLUGINS, undefined);
    const agentPlan = await buildPlan(repo, {
      yes: false,
      outputs: { ...relevantOutputs(plugin, detection.facts, ["claude"]), pdd: false },
      tools: ["claude"],
      ask: answerAsk(answers, emptyLog()),
      chooseItems: answerChooseItems(undefined, emptyLog()),
    });
    expect(agentPlan.writes.map((w) => [w.path, w.content])).toEqual(
      plan.writes.map((w) => [w.path, w.content]),
    );
  });

  it("previews exactly what apply then does", async () => {
    // An agent reads `preview` to decide whether to go ahead; if it can drift from
    // apply's real output, the contract lies. Same request through both.
    const request = { root, answers: { overview: "Svc." } };
    const { preview } = await inspect(request);
    const applied = await apply({ ...request, dryRun: true });

    expect(preview.writes).toEqual(applied.writes);
    expect(preview.counts).toEqual(applied.counts);
  });

  it("writes, by default, every output the interactive run writes bar the opt-in PDD", async () => {
    const { plan } = await interactiveWalk(root, takeDetected, { pdd: false });
    const applied = await apply({ root, dryRun: true });

    expect(applied.writes.map((w) => w.path)).toEqual(plan.writes.map((w) => w.path));
  });

  it("covers every question in the schema --ai must fill", async () => {
    const { questions } = await inspect({ root });
    const schema = answersSchema(questions) as { properties: Record<string, unknown>; required: string[] };

    expect(Object.keys(schema.properties)).toEqual(questions.map((q) => q.key));
    expect(schema.required).toEqual(questions.map((q) => q.key));
  });
});

describe("interview parity — questions that change the interview", () => {
  // Spring's migration answer feeds back into the facts, which decides whether the
  // add-migration skill exists at all. The interactive picker sees the corrected list
  // because it runs after the instructions stage; the contract has to offer the same.
  const root = fixture("gradle-programmatic");

  it("enumerates the plugin's own pre-stage questions, not just the document ones", async () => {
    const { questions } = await inspect({ root });
    const stages = [...new Set(questions.map((q) => q.stage))];
    expect(stages).toContain("Instructions");
    // Every question says which stage asked it and which section it lands in.
    for (const q of questions) {
      expect(q.stage).toBeTruthy();
      if (q.stage === "Instructions") expect(q.section).toMatch(/^##/);
    }
  });

  it("reflects a fact-changing answer when inspect is given that answer", async () => {
    const before = await inspect({ root });
    const after = await inspect({ root, answers: { dbMigration: "Flyway" } });

    const named = (r: typeof before) => r.selectables.skills.map((s) => s.name);
    // Whatever the fixture detects, a second pass must agree with what apply writes.
    const applied = await apply({ root, dryRun: true, answers: { dbMigration: "Flyway" } });
    const written = applied.writes
      .filter((w) => w.path.startsWith(".claude/skills/"))
      .map((w) => w.path.split("/")[2]);

    for (const skill of new Set(written)) expect(named(after)).toContain(skill);
    expect(named(after).length).toBeGreaterThanOrEqual(named(before).length);
  });

  it("previews the writes the given answers and selection would produce", async () => {
    const r = await inspect({
      root,
      answers: { overview: "Svc." },
      select: { skills: [], commands: [], agents: [], mcp: [] },
      outputs: { instructions: true, skills: false, commands: false, agents: false, settings: false, mcp: false, pdd: false },
    });
    expect(r.preview.writes.map((w) => w.path)).toEqual(["CLAUDE.md"]);
  });
});

describe("route parity — CLI apply vs MCP scaffold_apply", () => {
  const root = fixture("nextjs-app");
  const request = {
    root,
    dryRun: true,
    answers: { overview: "A dashboard.", never: ["Never commit .env"] },
    select: { skills: ["run", "test"], mcp: ["context7"] },
  };

  it("returns the same result through both transports", async () => {
    const direct = await apply(request);

    const sent: Rpc[] = [];
    const handle = createMcpHandler((m) => void sent.push(m));
    await handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "scaffold_apply", arguments: request },
    });
    const viaMcp = JSON.parse((sent[0].result as { content: { text: string }[] }).content[0].text);

    expect(viaMcp).toEqual(direct);
  });

  it("returns the same contract through inspect and scaffold_inspect", async () => {
    const direct = await inspect({ root });

    const sent: Rpc[] = [];
    const handle = createMcpHandler((m) => void sent.push(m));
    await handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "scaffold_inspect", arguments: { root } },
    });
    const viaMcp = JSON.parse((sent[0].result as { content: { text: string }[] }).content[0].text);

    expect(viaMcp).toEqual(direct);
  });
});

describe("route parity — the PDD opt-in", () => {
  const root = fixture("nextjs-app");

  it("offers PDD but leaves it off by default, exactly as --yes does", async () => {
    const r = await inspect({ root });
    expect(r.outputs.available.pdd).toBe(true);
    expect(r.outputs.default.pdd).toBe(false);
    expect(r.howToAnswer).toMatch(/outputs\.pdd = true/);

    const off = await apply({ root, dryRun: true });
    expect(off.writes.some((w) => w.path.includes("/skills/pdd/"))).toBe(false);
  });

  it("writes the PDD skills when the caller asks for them", async () => {
    const on = await apply({ root, dryRun: true, outputs: { pdd: true } });
    expect(on.writes.some((w) => w.path.includes("/skills/pdd/"))).toBe(true);
  });
});
