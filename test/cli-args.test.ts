import { describe, it, expect } from "vitest";
import { parseArgs, helpText } from "../src/cli";

describe("parseArgs", () => {
  it("defaults to interactive, write mode", () => {
    const a = parseArgs([]);
    expect(a.command).toBeUndefined();
    expect(a.ai).toBe(false);
    expect(a.dryRun).toBe(false);
    expect(a.yes).toBe(false);
    expect(a.help).toBe(false);
    expect(a.version).toBe(false);
    expect(a.stack).toBeUndefined();
    expect(a.errors).toEqual([]);
  });

  it("parses --dry-run and --yes", () => {
    const a = parseArgs(["--dry-run", "--yes"]);
    expect(a.dryRun).toBe(true);
    expect(a.yes).toBe(true);
    expect(a.errors).toEqual([]);
  });

  it("parses -h / -v shorthands", () => {
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
  });

  it("parses --stack with a value", () => {
    expect(parseArgs(["--stack", "node-ts"]).stack).toBe("node-ts");
  });

  it("errors on --stack without a value", () => {
    expect(parseArgs(["--stack"]).errors).toHaveLength(1);
    expect(parseArgs(["--stack", "--yes"]).errors).toHaveLength(1);
  });

  it("errors on unknown flags", () => {
    const a = parseArgs(["--nope"]);
    expect(a.errors).toEqual(["Unknown option: --nope"]);
  });

  it("parses --tools as a comma-separated list", () => {
    expect(parseArgs(["--tools", "claude,cursor,copilot"]).tools).toEqual(["claude", "cursor", "copilot"]);
  });

  it("errors on --tools without a value", () => {
    expect(parseArgs(["--tools"]).errors).toHaveLength(1);
    expect(parseArgs(["--tools", "--yes"]).errors).toHaveLength(1);
  });
});

describe("parseArgs — agent modes", () => {
  it("parses the agent subcommands", () => {
    expect(parseArgs(["plan"]).command).toBe("plan");
    expect(parseArgs(["apply"]).command).toBe("apply");
    expect(parseArgs(["mcp"]).command).toBe("mcp");
  });

  it("errors on an unknown command, listing the real ones", () => {
    const a = parseArgs(["scaffold"]);
    expect(a.errors[0]).toMatch(/Unknown command: scaffold.*plan, apply, mcp/);
  });

  it("errors on a second positional argument", () => {
    expect(parseArgs(["plan", "apply"]).errors).toEqual(["Unexpected argument: apply"]);
  });

  it("parses a subcommand alongside its flags, in either order", () => {
    const a = parseArgs(["apply", "--answers", "a.json", "--root", "/repo", "--dry-run"]);
    expect(a).toMatchObject({ command: "apply", answers: "a.json", root: "/repo", dryRun: true });
    expect(parseArgs(["--root", "/repo", "plan"]).command).toBe("plan");
  });

  it("accepts - as the answers path, meaning stdin", () => {
    const a = parseArgs(["apply", "--answers", "-"]);
    expect(a.answers).toBe("-");
    expect(a.errors).toEqual([]);
  });

  it("parses the --ai flags", () => {
    const a = parseArgs(["--ai", "--model", "claude-sonnet-5", "--guidance", "no docker"]);
    expect(a).toMatchObject({ ai: true, model: "claude-sonnet-5", guidance: "no docker" });
  });

  it("errors on a valued flag with no value", () => {
    for (const flag of ["--root", "--answers", "--model", "--guidance"]) {
      expect(parseArgs([flag]).errors).toHaveLength(1);
      expect(parseArgs([flag, "--yes"]).errors).toHaveLength(1);
    }
  });
});

describe("helpText", () => {
  it("lists the flags, available stacks, and available tools", () => {
    const h = helpText();
    expect(h).toContain("--dry-run");
    expect(h).toContain("--stack");
    expect(h).toContain("--tools");
    expect(h).toContain("node-ts");
    expect(h).toContain("spring-boot");
    expect(h).toContain("dart-flutter");
    expect(h).toContain("generic");
    expect(h).toContain("cursor");
    expect(h).toContain("copilot");
    expect(h).toContain("agents-md");
  });

  it("documents the agent-facing commands and the worked workflow", () => {
    const h = helpText();
    expect(h).toContain("plan");
    expect(h).toContain("apply");
    expect(h).toContain("mcp");
    expect(h).toContain("--ai");
    expect(h).toContain("--answers");
    expect(h).toContain("agent-scaffold apply --answers answers.json");
  });
});
