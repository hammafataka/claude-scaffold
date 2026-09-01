import { RepoSnapshot } from "../plugins/types";
import { OutputToggles, SelectableKind, buildPlan } from "../core/pipeline";
import { AgentQuestion, AgentSelectable, AgentSelectables, AnswerMap, answerTypeFor } from "./types";
import { answerAsk, emptyLog } from "./answers";

// Kind → the selectables bucket it fills.
const BUCKETS: Record<SelectableKind, keyof AgentSelectables> = {
  [SelectableKind.Skills]: "skills",
  [SelectableKind.Commands]: "commands",
  [SelectableKind.Agents]: "agents",
  [SelectableKind.Mcp]: "mcp",
  [SelectableKind.Pdd]: "pdd",
};

export interface Probe {
  questions: AgentQuestion[];
  selectables: AgentSelectables;
}

// Enumerate the whole interview without asking anyone anything.
//
// Rather than re-deriving the question list from the plugin (which would drift from
// what the interview actually asks), we run the real pipeline with a recording `ask`
// that answers every field with its detected value — exactly what --yes would use. The
// walk is pure: buildPlan only reads the repo snapshot, so this is safe to call
// repeatedly and the resulting keys are guaranteed to be the ones `apply` consumes.
export async function probeInterview(
  repo: RepoSnapshot,
  opts: { outputs: OutputToggles; tools: string[]; stackId?: string; answers?: AnswerMap },
): Promise<Probe> {
  const questions: AgentQuestion[] = [];
  const seen = new Set<string>();
  const selectables: AgentSelectables = { skills: [], commands: [], agents: [], mcp: [], pdd: [] };

  // A few answers feed back into the facts (a Spring repo's migration tool, a Flutter
  // app's state management), and those facts decide which skills and commands exist at
  // all. Walking with the caller's answers in hand therefore reports the item lists they
  // will actually get; with no answers it walks on the detected values, as --yes would.
  const answer = answerAsk(opts.answers ?? {}, emptyLog());

  await buildPlan(repo, {
    yes: false, // ask every field, not just the required-and-undetected ones
    outputs: opts.outputs,
    tools: opts.tools,
    stackId: opts.stackId,
    ask: async (field, ctx) => {
      // Two sections asking the same key would share one answer slot; keep the first
      // (they render identically) so the contract stays a flat map.
      if (!seen.has(field.key)) {
        seen.add(field.key);
        questions.push({
          key: field.key,
          stage: ctx?.stage ?? "Instructions",
          section: ctx?.section,
          question: field.question,
          kind: field.kind,
          answerType: answerTypeFor(field.kind),
          required: field.required,
          detected: field.detectedValue,
          options: field.options?.map((o) => ({
            value: o.value,
            label: o.label,
            hint: o.hint,
            detected: o.detected,
          })),
        });
      }
      return answer(field);
    },
    chooseItems: async (kind, items) => {
      const bucket = selectables[BUCKETS[kind]];
      for (const i of items) {
        if (!bucket.some((b) => b.name === i.name)) {
          bucket.push({ name: i.name, description: i.hint, recommended: i.recommended });
        }
      }
      return items.filter((i) => i.recommended).map((i) => i.name);
    },
  });

  return { questions, selectables };
}

export function recommended(items: AgentSelectable[]): string[] {
  return items.filter((i) => i.recommended).map((i) => i.name);
}
