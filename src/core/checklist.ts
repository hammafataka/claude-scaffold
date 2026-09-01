// Pure helpers shared by the interactive multiselect prompt and the agent-mode answer
// coercion. Kept out of prompter.ts so agent/MCP paths don't pull in clack (which
// patches the terminal prompt classes at import time).

// Parse a comma-separated "add my own" answer into trimmed, non-empty items.
export function parseCustom(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Build a checklist section body from the chosen option values plus any custom
// additions. Empty selection → empty string.
export function checklistBody(selected: string[], customRaw = ""): string {
  return [...selected, ...parseCustom(customRaw)].map((v) => `- ${v}`).join("\n");
}
