import { describe, it, expect, vi } from "vitest";
import { resolveFields, AskContext } from "../src/core/field-resolver";
import { FieldSpec, FieldKind } from "../src/plugins/types";

const fields: FieldSpec[] = [
  { key: "detected", question: "Q1", detectedValue: "auto", required: true, kind: FieldKind.Text },
  { key: "needed", question: "Q2", required: true, kind: FieldKind.Text },
  { key: "optional", question: "Q3", required: false, kind: FieldKind.Text },
];

describe("resolveFields", () => {
  it("--yes: uses detected, prompts only required-unknown, blanks optional-unknown", async () => {
    const ask = vi.fn(async (_f: FieldSpec, _ctx?: AskContext) => "answered");
    const values = await resolveFields(fields, { yes: true, ask });
    expect(values).toEqual({ detected: "auto", needed: "answered", optional: "" });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toEqual(fields[1]);
  });

  it("passes the asking context through to the prompt", async () => {
    const ask = vi.fn(async (_f: FieldSpec, _ctx?: AskContext) => "answered");
    const ctx = { stage: "Instructions", section: "## Build & run" };
    await resolveFields(fields, { yes: true, ask, ctx });
    expect(ask.mock.calls[0][1]).toEqual(ctx);
  });

  it("interactive: asks every field (ask returns user input, default-aware)", async () => {
    const ask = vi.fn(async (f: FieldSpec) => `${f.key}-val`);
    const values = await resolveFields(fields, { yes: false, ask });
    expect(values).toEqual({ detected: "detected-val", needed: "needed-val", optional: "optional-val" });
    expect(ask).toHaveBeenCalledTimes(3);
  });
});
