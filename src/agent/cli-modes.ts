import { readFileSync } from "node:fs";
import { ChoiceOption, FieldKind, FieldSpec } from "../plugins/types";
import { AskContext } from "../core/field-resolver";
import { AgentRequest, AnswerMap } from "./types";
import { coerceAnswer } from "./answers";
import { parseCustom } from "../core/checklist";

// Read an agent request from a file, or from stdin when the path is "-".
//
// Two shapes are accepted: a full request ({ answers, select, outputs, … }) or a bare
// answer map. Models produce both, and the difference is unambiguous.
export function readRequest(path: string): AgentRequest {
  const raw = path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Could not parse ${path === "-" ? "stdin" : path} as JSON: ${e instanceof Error ? e.message : e}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected a JSON object in ${path === "-" ? "stdin" : path}.`);
  }
  const obj = parsed as Record<string, unknown>;
  const looksLikeRequest =
    "answers" in obj || "select" in obj || "outputs" in obj || "tools" in obj || "stack" in obj;
  return looksLikeRequest ? (obj as AgentRequest) : { answers: obj as AnswerMap };
}

// Wrap an interactive ask so each prompt arrives pre-filled with a drafted answer,
// leaving the human to confirm or correct rather than type from scratch.
//
// Text/select/confirm prompts take the draft as their detected value. Multiselect
// prompts don't read detectedValue at all — they pre-check options flagged `detected` —
// so the draft is mapped onto the option list instead, and anything the draft invented
// beyond the offered options is appended as a new (pre-checked) choice.
export function seedAsk(
  ask: (field: FieldSpec, ctx?: AskContext) => Promise<string>,
  answers: AnswerMap,
): (field: FieldSpec, ctx?: AskContext) => Promise<string> {
  return (field, ctx) => {
    const raw = answers[field.key];
    if (raw === undefined || raw === null || raw === "") return ask(field, ctx);

    const drafted = coerceAnswer(field, raw);
    if (!drafted.trim()) return ask(field, ctx);

    if (field.kind !== FieldKind.Multiselect) {
      return ask({ ...field, detectedValue: drafted }, ctx);
    }

    // Drafted bullets → option values, preserving the order the model gave them.
    const picked = drafted
      .split("\n")
      .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
      .filter(Boolean);
    const pickedSet = new Set(picked);
    const existing = field.options ?? [];
    const extras: ChoiceOption[] = picked
      .filter((v) => !existing.some((o) => o.value === v))
      .map((value) => ({ value, hint: "drafted", detected: true }));
    const options: ChoiceOption[] = [
      ...existing.map((o) => ({ ...o, detected: pickedSet.has(o.value) })),
      ...extras,
    ];
    return ask({ ...field, options }, ctx);
  };
}

// One-line-per-answer preview of a drafted interview, for the human to eyeball before
// anything is written.
export function formatDraft(answers: AnswerMap, questions: { key: string; question: string }[]): string {
  const lines: string[] = [];
  for (const q of questions) {
    const raw = answers[q.key];
    if (raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && raw.length === 0)) {
      continue;
    }
    const value = Array.isArray(raw)
      ? raw.map(String).join("; ")
      : String(raw).split("\n").map((l) => l.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean).join("; ");
    const oneLine = value.length > 96 ? `${value.slice(0, 95)}…` : value;
    lines.push(`${q.key.padEnd(14)} ${oneLine}`);
  }
  return lines.join("\n") || "(the model returned no answers)";
}

export { parseCustom };
