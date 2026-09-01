import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { inspect, apply } from "../src/agent/session";
import { SCHEMA_VERSION } from "../src/agent/types";

const nextjs = join(__dirname, "fixtures", "nextjs-app");
const gradle = join(__dirname, "fixtures", "gradle-app");

describe("inspect", () => {
  it("returns the detected stack, every question, and a write preview", async () => {
    const r = await inspect({ root: nextjs });

    expect(r.schemaVersion).toBe(SCHEMA_VERSION);
    expect(r.stack.id).toBe("node-ts");
    expect(r.stack.forced).toBe(false);
    expect(r.stack.detected.length).toBeGreaterThan(0);
    expect(r.tools.selected).toEqual(["claude"]);

    // Preview never writes; it just shows what the defaults would produce.
    expect(r.preview.writes.some((w) => w.path === "CLAUDE.md")).toBe(true);
    expect(r.preview.counts.create).toBeGreaterThan(0);
    expect(existsSync(join(nextjs, "CLAUDE.md"))).toBe(false);
  });

  it("gives every question an answer shape and a home in the document", async () => {
    const { questions } = await inspect({ root: nextjs });
    const overview = questions.find((q) => q.key === "overview")!;

    expect(overview.answerType).toBe("string");
    expect(overview.required).toBe(true);
    expect(overview.detected).toBeUndefined(); // genuinely unknown — must be answered
    expect(overview.section).toMatch(/^##/);
    expect(overview.stage).toBe("Instructions");

    // Checklist sections expect an array, and offer (but don't require) options.
    const never = questions.find((q) => q.key === "never")!;
    expect(never.answerType).toBe("string[]");
    expect(never.options!.length).toBeGreaterThan(0);

    // Keys are unique, so answers can be a flat map.
    const keys = questions.map((q) => q.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("enumerates the selectable items, flagging the recommended ones", async () => {
    const { selectables } = await inspect({ root: nextjs });
    expect(selectables.skills.map((s) => s.name)).toContain("run");
    expect(selectables.mcp.map((s) => s.name)).toContain("context7");
    expect(selectables.pdd.map((s) => s.name)).toContain("tdd");
    expect(selectables.mcp.find((m) => m.name === "github")!.recommended).toBe(false);
  });

  it("honours a forced stack and an explicit tool list", async () => {
    const r = await inspect({ root: nextjs, stack: "generic", tools: ["cursor", "gemini"] });
    expect(r.stack.id).toBe("generic");
    expect(r.stack.forced).toBe(true);
    expect(r.tools.selected).toEqual(["cursor", "gemini"]);
    // Cursor and Gemini can't express settings or agents, so those aren't offered.
    expect(r.outputs.available.settings).toBe(false);
    expect(r.outputs.available.agents).toBe(false);
  });

  it("rejects an unknown tool id with the available list", async () => {
    await expect(inspect({ root: nextjs, tools: ["emacs"] })).rejects.toThrow(/Unknown tool "emacs"/);
  });
});

describe("apply", () => {
  it("writes nothing on a dry run and reports what it would do", async () => {
    const r = await apply({ root: gradle, dryRun: true, answers: { overview: "Order service." } });
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.counts.create).toBeGreaterThan(0);
    expect(existsSync(join(gradle, "CLAUDE.md"))).toBe(false);
  });

  it("writes the answered interview to disk", async () => {
    const root = mkdtempSync(join(tmpdir(), "scaffold-apply-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "svc",
        scripts: { dev: "tsx watch src/index.ts", test: "vitest run" },
        dependencies: { fastify: "^4" },
        devDependencies: { vitest: "^1" },
      }),
    );
    writeFileSync(join(root, "tsconfig.json"), "{}");

    const r = await apply({
      root,
      answers: {
        overview: "Order intake API.",
        architecture: ["Routes in src/routes", "Prisma only"],
        never: ["Never commit .env"],
      },
      select: { skills: ["run"], commands: [], agents: [], mcp: [] },
    });

    expect(r.ok).toBe(true);
    const claude = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(claude).toContain("Order intake API.");
    expect(claude).toContain("- Routes in src/routes"); // array → bullets
    expect(claude).toContain("- Never commit .env");

    // Only the selected items are written.
    expect(existsSync(join(root, ".claude/skills/run/SKILL.md"))).toBe(true);
    expect(existsSync(join(root, ".claude/skills/test/SKILL.md"))).toBe(false);
    expect(existsSync(join(root, ".mcp.json"))).toBe(false);
  });

  it("merges into an existing instructions file instead of clobbering it", async () => {
    const root = mkdtempSync(join(tmpdir(), "scaffold-merge-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "svc" }));
    writeFileSync(join(root, "CLAUDE.md"), "# Svc\n\n## Overview\nHand-written overview.\n");

    const r = await apply({
      root,
      outputs: { instructions: true, skills: false, commands: false, agents: false, settings: false, mcp: false, pdd: false },
      answers: { overview: "Generated overview." },
    });

    const claude = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(claude).toContain("Hand-written overview.");
    expect(claude).not.toContain("Generated overview.");
    expect(r.writes.find((w) => w.path === "CLAUDE.md")!.action).toBe("update");
  });

  it("reports required questions it could not answer, and keys nothing asked for", async () => {
    const r = await apply({ root: gradle, dryRun: true, answers: { overview: "x", notAKey: "y" } });
    expect(r.unanswered).toContain("architecture"); // required, no detected fallback
    expect(r.unanswered).not.toContain("overview");
    expect(r.ignored).toEqual(["notAKey"]);
    expect(r.warnings.join(" ")).toMatch(/notAKey/);
  });

  it("keeps a select answer outside the offered options, but says so", async () => {
    const r = await apply({
      root: gradle,
      dryRun: true,
      answers: { overview: "x", dependencies: "Ask me first." },
    });
    expect(r.writes.find((w) => w.path === "CLAUDE.md")).toBeDefined();
    expect(r.warnings.join(" ")).toMatch(/not one of the offered options/);
  });

  it("warns about a selected item that does not exist", async () => {
    const r = await apply({ root: gradle, dryRun: true, select: { skills: ["run", "nope"] } });
    expect(r.warnings.join(" ")).toMatch(/no such skills "nope"/);
  });

  it("emits one file layout per selected tool", async () => {
    const root = mkdtempSync(join(tmpdir(), "scaffold-tools-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "svc" }));

    const r = await apply({
      root,
      tools: ["claude", "agents-md", "cursor"],
      answers: { overview: "Svc." },
      select: { skills: [], commands: [], agents: [], mcp: [] },
    });

    const paths = r.writes.map((w) => w.path);
    expect(paths).toContain("CLAUDE.md");
    expect(paths).toContain("AGENTS.md");
    expect(paths.some((p) => p.startsWith(".cursor/"))).toBe(true);
  });
});
