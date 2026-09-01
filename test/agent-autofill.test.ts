import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import { scanRepo } from "../src/core/repo-scanner";
import { inspect } from "../src/agent/session";
import { answersSchema, buildRepoContext, draftAnswers, DEFAULT_MODEL } from "../src/agent/autofill";
import { AgentQuestion } from "../src/agent/types";
import { FieldKind } from "../src/plugins/types";

const nextjs = join(__dirname, "fixtures", "nextjs-app");

const q = (over: Partial<AgentQuestion>): AgentQuestion => ({
  key: "k",
  stage: "Instructions",
  question: "Q?",
  kind: FieldKind.Text,
  answerType: "string",
  required: true,
  ...over,
});

// Captures the request the SDK was called with, and replies with whatever we stage.
const calls: any[] = [];
let reply: any;

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      stream: (req: unknown) => {
        calls.push(req);
        return { finalMessage: () => Promise.resolve(reply) };
      },
    };
  },
}));

function message(text: string, over: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50 },
    ...over,
  };
}

beforeEach(() => {
  calls.length = 0;
  reply = message("{}");
});

describe("answersSchema", () => {
  it("maps each answer shape to its JSON type", () => {
    const schema = answersSchema([
      q({ key: "overview" }),
      q({ key: "never", answerType: "string[]" }),
      q({ key: "flag", answerType: "boolean" }),
    ]) as any;

    expect(schema.properties.overview.type).toBe("string");
    expect(schema.properties.never).toEqual(
      expect.objectContaining({ type: "array", items: { type: "string" } }),
    );
    expect(schema.properties.flag.type).toBe("boolean");
    expect(schema.additionalProperties).toBe(false);
  });

  it("requires every question, so nothing is silently skipped", () => {
    const schema = answersSchema([q({ key: "a" }), q({ key: "b", required: false })]) as any;
    expect(schema.required).toEqual(["a", "b"]);
  });

  it("puts the section, options, and detected default in the description", () => {
    const schema = answersSchema([
      q({ key: "db", section: "## Database", options: [{ value: "flyway" }, { value: "liquibase" }], detected: "flyway" }),
    ]) as any;

    const d = schema.properties.db.description;
    expect(d).toContain("## Database");
    expect(d).toContain("flyway | liquibase");
    expect(d).toContain("Detected default");
  });
});

describe("buildRepoContext", () => {
  it("includes the file tree and the README", () => {
    const ctx = buildRepoContext(scanRepo(nextjs));
    expect(ctx).toContain("## File tree");
    expect(ctx).toContain("package.json");
  });

  it("marks a clipped file as an excerpt instead of truncating it silently", () => {
    const big = "x".repeat(20000);
    const repo = {
      ...scanRepo(nextjs),
      files: ["README.md"],
      exists: (r: string) => r === "README.md",
      readFile: (r: string) => (r === "README.md" ? big : null),
    };
    const ctx = buildRepoContext(repo);
    expect(ctx).toMatch(/\[truncated: README\.md is 20000 chars, showing the first \d+\]/);
  });

  it("shows an existing instructions file so the draft stays consistent with it", () => {
    const repo = {
      ...scanRepo(nextjs),
      exists: (r: string) => r === "CLAUDE.md",
      readFile: (r: string) => (r === "CLAUDE.md" ? "# Existing\n\n## Overview\nKeep me.\n" : null),
    };
    expect(buildRepoContext(repo)).toContain("merged, not replaced");
  });
});

describe("draftAnswers", () => {
  it("asks the default model for structured answers over the repo", async () => {
    reply = message(JSON.stringify({ overview: "A dashboard.", never: ["Never commit .env"] }));
    const repo = scanRepo(nextjs);
    const plan = await inspect({ root: nextjs });

    const result = await draftAnswers(repo, plan);

    expect(result.answers.overview).toBe("A dashboard.");
    expect(result.answers.never).toEqual(["Never commit .env"]);
    expect(result.model).toBe(DEFAULT_MODEL);
    expect(result.inputTokens).toBe(100);

    const req = calls[0];
    expect(req.model).toBe(DEFAULT_MODEL);
    expect(req.thinking).toEqual({ type: "adaptive" });
    expect(req.output_config.format.type).toBe("json_schema");
    // Every question the interview asks is in the schema it must fill.
    expect(Object.keys(req.output_config.format.schema.properties).sort()).toEqual(
      plan.questions.map((x) => x.key).sort(),
    );
  });

  it("honours an explicit model and passes maintainer guidance to the model", async () => {
    reply = message("{}");
    const plan = await inspect({ root: nextjs });
    const result = await draftAnswers(scanRepo(nextjs), plan, {
      model: "claude-sonnet-5",
      guidance: "We deploy with ArgoCD.",
    });

    expect(result.model).toBe("claude-sonnet-5");
    expect(calls[0].model).toBe("claude-sonnet-5");
    expect(calls[0].messages[0].content).toContain("We deploy with ArgoCD.");
  });

  it("explains a refusal instead of writing a broken config", async () => {
    reply = message("", { stop_reason: "refusal", stop_details: { explanation: "nope" } });
    const plan = await inspect({ root: nextjs });
    await expect(draftAnswers(scanRepo(nextjs), plan)).rejects.toThrow(/declined to answer: nope/);
  });

  it("turns an auth failure into instructions for getting credentials", async () => {
    reply = Promise.reject(
      Object.assign(new Error("Could not resolve authentication method."), { status: 401 }),
    );
    const plan = await inspect({ root: nextjs });
    await expect(draftAnswers(scanRepo(nextjs), plan)).rejects.toThrow(
      /could not authenticate[\s\S]*ANTHROPIC_API_KEY[\s\S]*ant auth login/,
    );
  });

  it("points at --model when the model is rejected", async () => {
    reply = Promise.reject(Object.assign(new Error("model not found"), { status: 404 }));
    const plan = await inspect({ root: nextjs });
    await expect(draftAnswers(scanRepo(nextjs), plan)).rejects.toThrow(/Pass a different one with --model/);
  });

  it("says to retry when rate limited", async () => {
    reply = Promise.reject(Object.assign(new Error("slow down"), { status: 429 }));
    const plan = await inspect({ root: nextjs });
    await expect(draftAnswers(scanRepo(nextjs), plan)).rejects.toThrow(/rate limited/);
  });

  it("reports unparseable output rather than throwing a raw JSON error", async () => {
    reply = message("I'm afraid I can't do that");
    const plan = await inspect({ root: nextjs });
    await expect(draftAnswers(scanRepo(nextjs), plan)).rejects.toThrow(/Could not parse the model's answers/);
  });
});
