import { FieldKind, FieldSpec } from "../plugins/types";
import { SelectableItem, SelectableKind } from "../core/pipeline";
import { AskFn } from "../core/field-resolver";
import { checklistBody, parseCustom } from "../core/checklist";
import { AgentSelection, AnswerMap, AnswerValue } from "./types";

// Which selection bucket a picker stage reads from.
const BUCKETS: Record<SelectableKind, keyof AgentSelection> = {
  [SelectableKind.Skills]: "skills",
  [SelectableKind.Commands]: "commands",
  [SelectableKind.Agents]: "agents",
  [SelectableKind.Mcp]: "mcp",
  [SelectableKind.Pdd]: "pdd",
};

// Everything an answer-driven run learned along the way, reported back so the caller
// can tell a well-formed run from a lucky one.
export interface AnswerLog {
  asked: string[]; // every question key the pipeline actually reached
  unanswered: string[]; // required, unanswered, and no detected fallback
  warnings: string[];
}

function isBlank(v: AnswerValue | undefined): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

// Coerce whatever JSON arrived into the string the section renderer expects. Models are
// inconsistent about shape — an array for a text field, a comma string for a
// multiselect, "yes" for a confirm — so accept all of it rather than erroring out on a
// difference that has an obvious reading.
export function coerceAnswer(field: FieldSpec, raw: AnswerValue): string {
  if (field.kind === FieldKind.Multiselect) {
    if (Array.isArray(raw)) return checklistBody(raw.map(String).filter(Boolean));
    const s = String(raw);
    // Already a markdown bullet list — pass it through untouched.
    if (/^\s*[-*]\s+/m.test(s)) return s.trim();
    return checklistBody(parseCustom(s));
  }
  if (field.kind === FieldKind.Confirm) {
    if (typeof raw === "boolean") return raw ? "true" : "false";
    const s = String(raw).trim().toLowerCase();
    return s === "true" || s === "yes" || s === "y" || s === "1" ? "true" : "false";
  }
  if (Array.isArray(raw)) return raw.map(String).join(", ");
  return String(raw);
}

// Build the pipeline's `ask` from a static answer map. Never blocks and never touches
// the terminal, so it's safe under MCP stdio and in CI.
export function answerAsk(answers: AnswerMap, log: AnswerLog): AskFn {
  return async (field: FieldSpec) => {
    log.asked.push(field.key);
    const raw = answers[field.key];

    if (!isBlank(raw)) {
      const value = coerceAnswer(field, raw as AnswerValue);
      // A select answer outside the offered options is legal (the interactive prompt
      // has an "Add my own…" escape), but it's worth surfacing — it's usually a typo.
      if (field.kind === FieldKind.Select && field.options?.length) {
        const known = field.options.some((o) => o.value === value);
        if (!known) {
          log.warnings.push(
            `"${field.key}": "${value}" is not one of the offered options ` +
              `(${field.options.map((o) => o.value).join(", ")}) — kept as a custom value.`,
          );
        }
      }
      return value;
    }

    if (field.detectedValue !== undefined) return field.detectedValue;
    if (field.required) log.unanswered.push(field.key);
    return "";
  };
}

// Build the per-item picker from an explicit selection. A bucket the caller didn't
// mention falls back to the recommended set, so a partial request still does the
// sensible thing.
export function answerChooseItems(
  select: AgentSelection | undefined,
  log: AnswerLog,
): (kind: SelectableKind, items: SelectableItem[]) => Promise<string[]> {
  return async (kind, items) => {
    const chosen = select?.[BUCKETS[kind]];
    if (chosen === undefined) return items.filter((i) => i.recommended).map((i) => i.name);
    const available = new Set(items.map((i) => i.name));
    for (const name of chosen) {
      if (!available.has(name)) {
        log.warnings.push(
          `select.${BUCKETS[kind]}: no such ${kind} "${name}" — available: ${[...available].join(", ")}`,
        );
      }
    }
    return chosen.filter((n) => available.has(n));
  };
}

export function emptyLog(): AnswerLog {
  return { asked: [], unanswered: [], warnings: [] };
}
