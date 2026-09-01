import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatDraft, readRequest, seedAsk } from "../src/agent/cli-modes";
import { FieldKind, FieldSpec } from "../src/plugins/types";

function tmpJson(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "scaffold-req-"));
  const path = join(dir, "answers.json");
  writeFileSync(path, content);
  return path;
}

const field = (over: Partial<FieldSpec> = {}): FieldSpec => ({
  key: "k",
  question: "Q?",
  required: false,
  kind: FieldKind.Text,
  ...over,
});

describe("readRequest", () => {
  it("reads a full request object", () => {
    const path = tmpJson(JSON.stringify({ tools: ["cursor"], answers: { overview: "x" } }));
    expect(readRequest(path)).toEqual({ tools: ["cursor"], answers: { overview: "x" } });
  });

  it("treats a bare answer map as the answers", () => {
    const path = tmpJson(JSON.stringify({ overview: "x", never: ["y"] }));
    expect(readRequest(path)).toEqual({ answers: { overview: "x", never: ["y"] } });
  });

  it("names the file when the JSON is malformed", () => {
    const path = tmpJson("{nope");
    expect(() => readRequest(path)).toThrow(new RegExp(`Could not parse ${path}`));
  });

  it("rejects a JSON array", () => {
    expect(() => readRequest(tmpJson("[1,2]"))).toThrow(/Expected a JSON object/);
  });
});

describe("seedAsk", () => {
  it("pre-fills a text prompt with the drafted answer", async () => {
    const seen: FieldSpec[] = [];
    const ask = seedAsk(async (f) => (seen.push(f), "typed"), { k: "drafted" });
    await ask(field({ detectedValue: "detected" }));
    expect(seen[0].detectedValue).toBe("drafted");
  });

  it("leaves a prompt alone when the draft has nothing for it", async () => {
    const seen: FieldSpec[] = [];
    const ask = seedAsk(async (f) => (seen.push(f), "typed"), { other: "drafted" });
    await ask(field({ detectedValue: "detected" }));
    expect(seen[0].detectedValue).toBe("detected");
  });

  it("pre-checks the checklist options the draft chose", async () => {
    const seen: FieldSpec[] = [];
    const ask = seedAsk(async (f) => (seen.push(f), ""), { k: ["b"] });
    await ask(field({ kind: FieldKind.Multiselect, options: [{ value: "a" }, { value: "b" }] }));

    const opts = seen[0].options!;
    expect(opts.find((o) => o.value === "a")!.detected).toBe(false);
    expect(opts.find((o) => o.value === "b")!.detected).toBe(true);
  });

  it("adds a drafted value that isn't on the menu as a new pre-checked option", async () => {
    const seen: FieldSpec[] = [];
    const ask = seedAsk(async (f) => (seen.push(f), ""), { k: ["a", "invented"] });
    await ask(field({ kind: FieldKind.Multiselect, options: [{ value: "a" }] }));

    const opts = seen[0].options!;
    expect(opts.map((o) => o.value)).toEqual(["a", "invented"]);
    expect(opts[1]).toMatchObject({ detected: true, hint: "drafted" });
  });
});

describe("formatDraft", () => {
  const questions = [
    { key: "overview", question: "Overview?" },
    { key: "never", question: "Never do?" },
    { key: "empty", question: "Empty?" },
  ];

  it("shows one line per answered question and skips the empty ones", () => {
    const out = formatDraft({ overview: "A service.", never: ["No X", "No Y"], empty: "" }, questions);
    expect(out).toContain("overview");
    expect(out).toContain("A service.");
    expect(out).toContain("No X; No Y"); // bullets flattened to one line
    expect(out).not.toContain("empty");
  });

  it("truncates a long answer to keep the preview scannable", () => {
    const out = formatDraft({ overview: "x".repeat(200) }, questions);
    expect(out).toContain("…");
    expect(out.split("\n")[0].length).toBeLessThan(120);
  });

  it("says so when the model returned nothing", () => {
    expect(formatDraft({}, questions)).toBe("(the model returned no answers)");
  });
});
