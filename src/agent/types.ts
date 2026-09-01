import { FieldKind } from "../plugins/types";
import { OutputToggles } from "../core/pipeline";

// Bumped when the shape of an inspect/apply payload changes incompatibly. Agents can
// pin against it; a mismatch means "re-read the contract before answering".
export const SCHEMA_VERSION = 1;

// What shape an answer must take. Derived from FieldKind so a model doesn't have to
// know our internal enum: multiselect wants an array, confirm wants a boolean, the
// rest want a plain string.
export type AnswerType = "string" | "string[]" | "boolean";

export function answerTypeFor(kind: FieldKind): AnswerType {
  if (kind === FieldKind.Multiselect) return "string[]";
  if (kind === FieldKind.Confirm) return "boolean";
  return "string";
}

export interface AgentChoice {
  value: string;
  label?: string;
  hint?: string;
  detected?: boolean;
}

// One interview question, flattened out of the stage/section pipeline so an agent can
// answer the whole thing in a single pass. `key` is the answer-map key.
export interface AgentQuestion {
  key: string;
  stage: string; // "Stack details" | "Instructions"
  section?: string; // heading the answer lands under, e.g. "## Build & run"
  question: string;
  kind: FieldKind;
  answerType: AnswerType;
  required: boolean;
  detected?: string; // pre-filled default; absent = truly unknown
  // For select/multiselect. Not exhaustive — a free-text value is always accepted.
  options?: AgentChoice[];
}

// A skill/command/agent/MCP-server the caller can include or drop.
export interface AgentSelectable {
  name: string;
  description?: string;
  recommended: boolean;
}

export interface AgentSelectables {
  skills: AgentSelectable[];
  commands: AgentSelectable[];
  agents: AgentSelectable[];
  mcp: AgentSelectable[];
  pdd: AgentSelectable[];
}

export interface AgentWrite {
  path: string;
  action: string; // create | update | skip
  note?: string;
  bytes: number;
}

// Answers are keyed by question key. Values are coerced from whatever JSON the agent
// sent (string / string[] / boolean / number) to the string the renderer expects.
export type AnswerValue = string | string[] | boolean | number | null;
export type AnswerMap = Record<string, AnswerValue>;

export interface AgentSelection {
  skills?: string[];
  commands?: string[];
  agents?: string[];
  mcp?: string[];
  pdd?: string[];
}

// The request body shared by `apply --answers`, the MCP `scaffold_apply` tool, and the
// --ai path. Everything is optional: omitted answers fall back to detected values.
export interface AgentRequest {
  root?: string;
  stack?: string;
  tools?: string[];
  outputs?: Partial<OutputToggles>;
  answers?: AnswerMap;
  select?: AgentSelection;
  dryRun?: boolean;
}

export interface InspectResult {
  schemaVersion: number;
  version: string;
  root: string;
  stack: {
    id: string;
    displayName: string;
    confidence: number;
    forced: boolean;
    available: string[];
    detected: string[]; // human-readable summary lines
  };
  facts: Record<string, string | number | boolean | undefined>;
  tools: { available: { id: string; displayName: string; hint: string }[]; detected: string[]; selected: string[] };
  outputs: { available: OutputToggles; default: OutputToggles };
  questions: AgentQuestion[];
  selectables: AgentSelectables;
  preview: { writes: AgentWrite[]; counts: Record<string, number> };
  howToAnswer: string;
}

export interface ApplyResult {
  schemaVersion: number;
  ok: boolean;
  root: string;
  dryRun: boolean;
  stack: string;
  tools: string[];
  writes: AgentWrite[];
  counts: Record<string, number>;
  // Required questions the caller left unanswered with no detected fallback. The run
  // still succeeds (the section is dropped), but the agent should know.
  unanswered: string[];
  // Answer keys that matched no question — usually a typo or a stale plan.
  ignored: string[];
  warnings: string[];
}
