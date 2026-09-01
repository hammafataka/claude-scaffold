import { RepoSnapshot } from "../plugins/types";
import { AgentQuestion, AnswerMap, InspectResult } from "./types";

// Default model for --ai. Overridable with --model for a cheaper or pinned run.
export const DEFAULT_MODEL = "claude-opus-5";

// Context budget. These are deliberate summaries, not silent truncation: every clipped
// input is marked in the prompt so the model knows it is seeing an excerpt.
const MAX_TREE_ENTRIES = 400;
const MAX_README_CHARS = 6000;
const MAX_MANIFEST_CHARS = 4000;
const MAX_EXISTING_CHARS = 4000;

const MANIFESTS = [
  "package.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "pubspec.yaml",
  "melos.yaml",
  "tsconfig.json",
  "docker-compose.yml",
  "Makefile",
];

const EXISTING_INSTRUCTIONS = ["CLAUDE.md", "AGENTS.md", "GEMINI.md", ".github/copilot-instructions.md"];

export interface AutofillOptions {
  model?: string;
  // Extra steer from the human, e.g. "we deploy with ArgoCD, never mention Docker".
  guidance?: string;
}

export interface AutofillResult {
  answers: AnswerMap;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

function clip(text: string, max: number, label: string): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated: ${label} is ${text.length} chars, showing the first ${max}]`;
}

// A compact view of the repository for the model to answer from: the tree, the README,
// the build manifests, and any instructions file that already exists (so the draft
// agrees with it instead of contradicting it).
export function buildRepoContext(repo: RepoSnapshot): string {
  const parts: string[] = [];

  const tree = repo.files.slice(0, MAX_TREE_ENTRIES);
  parts.push(
    `## File tree (${repo.files.length} files${
      repo.files.length > MAX_TREE_ENTRIES ? `, showing the first ${MAX_TREE_ENTRIES}` : ""
    })\n${tree.join("\n")}`,
  );

  const readme = repo.files.find((f) => /^readme\.md$/i.test(f));
  if (readme) {
    const text = repo.readFile(readme);
    if (text) parts.push(`## ${readme}\n${clip(text, MAX_README_CHARS, readme)}`);
  }

  for (const name of MANIFESTS) {
    if (!repo.exists(name)) continue;
    const text = repo.readFile(name);
    if (text) parts.push(`## ${name}\n${clip(text, MAX_MANIFEST_CHARS, name)}`);
  }

  for (const name of EXISTING_INSTRUCTIONS) {
    if (!repo.exists(name)) continue;
    const text = repo.readFile(name);
    if (text) {
      parts.push(
        `## ${name} (already exists — stay consistent with it; it will be merged, not replaced)\n` +
          clip(text, MAX_EXISTING_CHARS, name),
      );
    }
  }

  return parts.join("\n\n");
}

// Turn the interview into a JSON schema the model must fill. Every question is required
// so nothing is quietly skipped; an empty string or array is the way to say "not
// applicable", and the answer coercion treats that as "fall back to the detected value".
export function answersSchema(questions: AgentQuestion[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const q of questions) {
    const description = [
      q.question,
      q.section ? `Rendered under "${q.section}" in the instructions file.` : "",
      q.options?.length
        ? `Suggested values (you may use others): ${q.options.map((o) => o.value).join(" | ")}`
        : "",
      q.detected ? `Detected default (reuse it verbatim unless the repo says otherwise): ${q.detected}` : "",
      q.required ? "Required — an empty answer drops this section." : "Optional.",
    ]
      .filter(Boolean)
      .join(" ");

    properties[q.key] =
      q.answerType === "string[]"
        ? { type: "array", items: { type: "string" }, description }
        : q.answerType === "boolean"
          ? { type: "boolean", description }
          : { type: "string", description };
  }

  return {
    type: "object",
    properties,
    required: questions.map((q) => q.key),
    additionalProperties: false,
  };
}

const SYSTEM = [
  "You are filling in an AI coding-agent configuration interview for a repository, on behalf of its maintainer.",
  "",
  "The answers you give become that repo's CLAUDE.md / AGENTS.md and its skills, commands, and rules — the",
  "instructions every future coding agent on this repo will read. Write them for that audience.",
  "",
  "Rules:",
  "- Ground every answer in the repository you were shown. Real commands, real paths, real module names.",
  "- Where a detected default is offered and the repo agrees with it, reuse it verbatim.",
  "- Prefer specific, checkable statements over generic best-practice filler. 'Run `pnpm test -- --run`'",
  "  beats 'write good tests'. If you have nothing specific to say for an optional question, return an",
  "  empty string or empty array rather than padding it.",
  "- For array answers, each element is one bullet. Keep each under ~110 characters.",
  "- Never invent commands, scripts, env vars, or directories you did not see evidence for.",
].join("\n");

// The SDK's auth and rate-limit errors are accurate but say nothing about what to do
// next, and this is a CLI — so name the way out.
function describeApiFailure(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const status = (e as { status?: number } | null)?.status;

  if (/authentication method|api[_ -]?key|401/i.test(raw) || status === 401) {
    return (
      `--ai could not authenticate with the Anthropic API (${raw})\n` +
      "  Set a key:  export ANTHROPIC_API_KEY=sk-ant-...\n" +
      "  Or log in once with the Anthropic CLI:  ant auth login\n" +
      "  (or run without --ai and answer the interview yourself)"
    );
  }
  if (status === 429) {
    return `--ai was rate limited by the Anthropic API (${raw}). Retry shortly, or run without --ai.`;
  }
  if (status === 404 || /model/i.test(raw)) {
    return `--ai could not use that model (${raw}). Pass a different one with --model.`;
  }
  return `--ai could not reach the Anthropic API (${raw}). Run without --ai to fill the interview yourself.`;
}

// Ask Claude to draft the whole interview in one structured call.
//
// The SDK is an optional peer dependency: only --ai needs it, so it is imported lazily
// and its absence is reported as an install hint rather than a crash at startup.
export async function draftAnswers(
  repo: RepoSnapshot,
  plan: InspectResult,
  opts: AutofillOptions = {},
): Promise<AutofillResult> {
  let Anthropic: typeof import("@anthropic-ai/sdk").default;
  try {
    Anthropic = (await import("@anthropic-ai/sdk")).default;
  } catch {
    throw new Error(
      "--ai needs the Anthropic SDK, which is an optional dependency.\n" +
        "  Install it alongside agent-scaffold:  npm i -D @anthropic-ai/sdk\n" +
        "  (or run without --ai and answer the interview yourself)",
    );
  }

  // Zero-arg client: resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an
  // `ant auth login` profile — we don't second-guess which one the user has.
  const client = new Anthropic();
  const model = opts.model ?? DEFAULT_MODEL;

  const user = [
    `# Repository: ${plan.root}`,
    "",
    `Detected stack: ${plan.stack.displayName}`,
    plan.stack.detected.length ? plan.stack.detected.map((l) => `- ${l}`).join("\n") : "",
    "",
    "# Repository contents",
    "",
    buildRepoContext(repo),
    "",
    opts.guidance ? `# Maintainer guidance (overrides anything you infer)\n\n${opts.guidance}\n` : "",
    "# Your task",
    "",
    "Answer every question below. Each property in the output schema is one question and",
    "its description carries the wording, the suggested values, and the detected default.",
  ]
    .filter(Boolean)
    .join("\n");

  // Streaming: the repo context can be large and the answer set is long, and streaming
  // keeps a slow request from tripping the SDK's HTTP timeout.
  let message;
  try {
    const stream = client.messages.stream({
      model,
      max_tokens: 16000,
      system: SYSTEM,
      thinking: { type: "adaptive" },
      output_config: { format: { type: "json_schema", schema: answersSchema(plan.questions) } },
      messages: [{ role: "user", content: user }],
    });
    message = await stream.finalMessage();
  } catch (e) {
    throw new Error(describeApiFailure(e));
  }

  if (message.stop_reason === "refusal") {
    throw new Error(
      `The model declined to answer${
        message.stop_details?.explanation ? `: ${message.stop_details.explanation}` : "."
      } Run without --ai and fill the interview in yourself.`,
    );
  }

  const text = message.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");

  let answers: AnswerMap;
  try {
    answers = JSON.parse(text) as AnswerMap;
  } catch {
    throw new Error(
      `Could not parse the model's answers as JSON (stop_reason: ${message.stop_reason}). ` +
        `Re-run with --ai, or answer the interview interactively.`,
    );
  }

  return {
    answers,
    model,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
}
