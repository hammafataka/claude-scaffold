import * as p from "@clack/prompts";
import {
  Prompt,
  TextPrompt,
  SelectPrompt,
  MultiSelectPrompt,
  GroupMultiSelectPrompt,
  ConfirmPrompt,
  PasswordPrompt,
  SelectKeyPrompt,
} from "@clack/core";
import { FieldSpec, ChoiceOption, FieldKind } from "../plugins/types";
import { OutputToggles, SelectableKind } from "./pipeline";
import { checklistBody, parseCustom } from "./checklist";

// Re-exported: these used to live here, and both tests and callers import them from
// prompter. They now sit in ./checklist so non-terminal callers can reuse them.
export { checklistBody, parseCustom };

// Sentinels for the synthetic menu entries; namespaced so they can't collide with
// a real option value.
const OTHER = "__other__";
const SKIP = "__skip__";

// Thrown when the user presses the back key (Left arrow, or Escape) during any field
// prompt, causing the section loop in buildClaudeMd to re-ask the previous section
// (or, at the first section, the pipeline to step back a stage).
export class BackSignal extends Error {
  constructor() {
    super("back");
  }
}

// Flag set by the Prompt monkey-patch when the back key triggers a cancel. Each
// prompt's cancel handler consumes it to distinguish "go back" from "quit".
let _escapeBack = false;
function consumeEscapeBack(): boolean {
  const was = _escapeBack;
  _escapeBack = false;
  return was;
}

// Patch the clack Prompt base class so the Left arrow (or Escape) acts as a single
// dedicated "go back" key in every prompt: it cancels the current prompt and flags a
// back-navigation, which each handler below turns into a BackSignal. In list prompts
// Left is redundant with Up (navigation still works via Up/Down); in text prompts we
// repurpose Left as the back key. Must run before any Prompt instance is created (the
// constructor binds onKeypress).
{
  type Ctor = { prototype: { onKeypress: (u: string, key: unknown) => void } } | undefined;
  // The real base handler, captured once before patching.
  const real = (Prompt as unknown as { prototype: { onKeypress: (u: string, key: unknown) => void } })
    .prototype.onKeypress;
  function patched(this: unknown, u: string, key: unknown) {
    const k = key as { name?: string } | undefined;
    if (k?.name === "left" || k?.name === "escape") {
      _escapeBack = true;
      return real.call(this, "\x03", k); // simulate cancel; handlers throw BackSignal
    }
    return real.call(this, u, key);
  }
  // Install the same wrapper on the base AND every concrete prompt class. Bundlers can
  // leave instances extending a different copy of the base than the one re-exported as
  // `Prompt`, so installing it as an own method on each concrete class guarantees the
  // constructor's `this.onKeypress.bind(this)` picks ours up regardless.
  const classes: Ctor[] = [
    Prompt,
    TextPrompt,
    SelectPrompt,
    MultiSelectPrompt,
    GroupMultiSelectPrompt,
    ConfirmPrompt,
    PasswordPrompt,
    SelectKeyPrompt,
  ] as unknown as Ctor[];
  for (const C of classes) {
    if (C?.prototype) C.prototype.onKeypress = patched;
  }
}

export function bail(): never {
  p.cancel("Cancelled — nothing was written.");
  process.exit(0);
}

// Required fields with no detected value must be answered interactively. When there's
// no TTY (CI, piped stdin), we can't prompt — fail with guidance instead of a crash.
function requireTty(field: FieldSpec): void {
  if (!process.stdin.isTTY) {
    p.cancel(
      `"${field.question}" needs an answer but stdin is not a terminal. ` +
        `Run claude-scaffold in an interactive terminal to fill required fields. Nothing was written.`,
    );
    process.exit(1);
  }
}

export async function askField(field: FieldSpec): Promise<string> {
  requireTty(field);
  switch (field.kind) {
    case FieldKind.Confirm:
      return askConfirm(field);
    case FieldKind.Select:
      return askSelect(field);
    case FieldKind.Multiselect:
      return askMultiselect(field);
    default:
      return askText(field);
  }
}

async function askConfirm(field: FieldSpec): Promise<string> {
  const v = await p.confirm({ message: `${field.question}  (← to go back)`, initialValue: field.detectedValue === "true" });
  if (p.isCancel(v)) {
    if (consumeEscapeBack()) throw new BackSignal();
    bail();
  }
  return v ? "true" : "false";
}

async function askText(field: FieldSpec, message = field.question): Promise<string> {
  const v = await p.text({
    message: `${message}  (← to go back)`,
    placeholder: field.detectedValue ?? (field.required ? "(required)" : "(optional, Enter to skip)"),
    initialValue: field.detectedValue ?? "",
    validate: (val) =>
      field.required && !val.trim() && !field.detectedValue ? "This field is required" : undefined,
  });
  if (p.isCancel(v)) {
    if (consumeEscapeBack()) throw new BackSignal();
    bail();
  }
  return (v as string) || field.detectedValue || "";
}

function toClackOptions(options: ChoiceOption[]): { value: string; label: string; hint?: string }[] {
  return options.map((o) => ({
    value: o.value,
    label: o.label ?? o.value,
    hint: o.detected ? "detected" : o.hint,
  }));
}

// Single-choice menu: the curated options, plus "Add my own…" and (when optional)
// "Skip". Press Left (or Escape) to go back to the previous section.
async function askSelect(field: FieldSpec): Promise<string> {
  const options = toClackOptions(field.options ?? []);
  options.push({ value: OTHER, label: "✎ Add my own…" });
  if (!field.required) options.push({ value: SKIP, label: "Skip this section" });

  const detected = field.options?.find((o) => o.detected)?.value;
  const choice = await p.select({ message: `${field.question}  (← to go back)`, options, initialValue: detected });
  if (p.isCancel(choice)) {
    if (consumeEscapeBack()) throw new BackSignal();
    bail();
  }
  if (choice === SKIP) return "";
  if (choice === OTHER) {
    const v = await p.text({
      message: `${field.question} (type your own)`,
      placeholder: "(required)",
      validate: (val) => (!val.trim() ? "Please enter a value" : undefined),
    });
    if (p.isCancel(v)) {
      if (consumeEscapeBack()) throw new BackSignal();
      bail();
    }
    return v as string;
  }
  return String(choice);
}


// Multi-choice checklist: detected options pre-checked, "Add my own…" appends free text.
// Result is rendered as a markdown bullet list. Space toggles, Enter confirms — the hint
// makes that explicit, and required sections won't accept an empty submission.
// Press Left (or Escape) to go back to the previous section.
async function askMultiselect(field: FieldSpec): Promise<string> {
  const options = toClackOptions(field.options ?? []);
  options.push({ value: OTHER, label: "✎ Add my own…" });
  const initialValues = (field.options ?? []).filter((o) => o.detected).map((o) => o.value);

  const picked = await p.multiselect({
    message: `${field.question}  (Space to select · Enter to confirm · ← to go back)`,
    options,
    initialValues,
    required: field.required,
  });
  if (p.isCancel(picked)) {
    if (consumeEscapeBack()) throw new BackSignal();
    bail();
  }

  const chosen = picked as string[];
  const selected = chosen.filter((v) => v !== OTHER);
  let customRaw = "";
  if (chosen.includes(OTHER)) {
    const custom = await p.text({
      message: "Add your own — separate multiple with commas:",
      placeholder: "e.g. Use record DTOs, Keep controllers thin",
      validate: (val) => (!val.trim() ? "Please enter at least one value" : undefined),
    });
    if (p.isCancel(custom)) {
      if (consumeEscapeBack()) throw new BackSignal();
      bail();
    }
    customRaw = String(custom);
  }
  return checklistBody(selected, customRaw);
}

const OUTPUT_LABELS: Record<keyof OutputToggles, string> = {
  instructions: "Instructions file (CLAUDE.md / AGENTS.md / rules)",
  skills: "Skills / rules",
  commands: "Slash commands / prompts / workflows",
  agents: "Agents / chat modes",
  settings: "Permissions & guardrails (.claude/settings.json)",
  mcp: "MCP servers",
  pdd: "PDD methodology",
};

// Top-level gate: generate everything in one go, or hand-pick. Returns the toggles
// either way. "Everything" means every output relevant to the selected tools and stack.
// Loops when the user goes back (Left/Escape) from the "Let me choose" picker.
export async function chooseOutputs(relevant: OutputToggles): Promise<OutputToggles> {
  while (true) {
    const summary =
      (Object.keys(relevant) as (keyof OutputToggles)[])
        .filter((k) => relevant[k])
        .map((k) => OUTPUT_LABELS[k])
        .join(", ") || "nothing detected";
    const mode = await p.select({
      message: "What should I set up?",
      options: [
        { value: "all", label: "Everything", hint: summary },
        { value: "choose", label: "Let me choose…" },
      ],
      initialValue: "all",
    });
    if (p.isCancel(mode)) { consumeEscapeBack(); bail(); }
    if (mode === "all") return { ...relevant };
    try {
      return await selectOutputs(relevant);
    } catch (e) {
      if (e instanceof BackSignal) continue; // user went back from the picker — re-show this selector
      throw e;
    }
  }
}

export async function selectOutputs(relevant: OutputToggles): Promise<OutputToggles> {
  const keys = Object.keys(OUTPUT_LABELS) as (keyof OutputToggles)[];
  const options = keys.map((k) => ({ value: k as string, label: OUTPUT_LABELS[k] }));
  const initial = keys.filter((k) => relevant[k]).map((k) => k as string);
  const picked = await p.multiselect({
    message: "Which outputs should I generate?  (Space to select · Enter to confirm · ← to go back)",
    options,
    initialValues: initial,
    required: false,
  });
  if (p.isCancel(picked)) {
    if (consumeEscapeBack()) throw new BackSignal(); // Left/Escape → back to Everything/Choose selector
    bail();
  }
  const set = new Set(picked as string[]);
  return {
    instructions: set.has("instructions"),
    skills: set.has("skills"),
    commands: set.has("commands"),
    agents: set.has("agents"),
    settings: set.has("settings"),
    mcp: set.has("mcp"),
    pdd: set.has("pdd"),
  };
}

// Target-tool picker: which coding agents should receive config. Tools whose config
// already exists in the repo come pre-checked; with nothing detected, Claude Code is
// the default. Left/Escape at this first prompt quits (there's nothing earlier).
export async function chooseTools(
  tools: { id: string; displayName: string; hint: string }[],
  detected: string[],
): Promise<string[]> {
  const initial = detected.length > 0 ? detected : ["claude"];
  const picked = await p.multiselect({
    message: "Which coding tools should I configure?  (Space to select · Enter to confirm)",
    options: tools.map((t) => ({
      value: t.id,
      label: t.displayName,
      hint: detected.includes(t.id) ? `detected — ${t.hint}` : t.hint,
    })),
    initialValues: initial,
    required: true,
  });
  if (p.isCancel(picked)) {
    consumeEscapeBack();
    bail();
  }
  return picked as string[];
}

// Per-item picker for skills/commands/agents. Recommended items are pre-checked.
// Left (or Escape) throws BackSignal so the stage loop steps back to the previous stage.
export async function chooseItems(
  kind: SelectableKind,
  items: { name: string; label: string; recommended: boolean; hint?: string }[],
): Promise<string[]> {
  const picked = await p.multiselect({
    message: `Which ${kind} should I include?  (Space to select · Enter to confirm · ← to go back)`,
    options: items.map((i) => ({ value: i.name, label: i.label, hint: i.hint })),
    initialValues: items.filter((i) => i.recommended).map((i) => i.name),
    required: false,
  });
  if (p.isCancel(picked)) {
    if (consumeEscapeBack()) throw new BackSignal(); // Left/Escape → back to previous stage
    bail();
  }
  return picked as string[];
}
