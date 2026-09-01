import { describe, it, expect } from "vitest";
import { FieldKind, FieldSpec } from "../src/plugins/types";
import { answerAsk, answerChooseItems, coerceAnswer, emptyLog } from "../src/agent/answers";
import { SelectableKind } from "../src/core/pipeline";

const field = (over: Partial<FieldSpec> = {}): FieldSpec => ({
  key: "k",
  question: "Q?",
  required: false,
  kind: FieldKind.Text,
  ...over,
});

describe("coerceAnswer", () => {
  it("renders an array answer as a markdown bullet list", () => {
    const f = field({ kind: FieldKind.Multiselect });
    expect(coerceAnswer(f, ["one", "two"])).toBe("- one\n- two");
  });

  it("accepts a comma string for a checklist question", () => {
    const f = field({ kind: FieldKind.Multiselect });
    expect(coerceAnswer(f, "one, two")).toBe("- one\n- two");
  });

  it("passes an already-bulleted string through untouched", () => {
    const f = field({ kind: FieldKind.Multiselect });
    expect(coerceAnswer(f, "- one\n- two")).toBe("- one\n- two");
  });

  it("reads the usual spellings of yes and no for a confirm question", () => {
    const f = field({ kind: FieldKind.Confirm });
    expect(coerceAnswer(f, true)).toBe("true");
    expect(coerceAnswer(f, "yes")).toBe("true");
    expect(coerceAnswer(f, "TRUE")).toBe("true");
    expect(coerceAnswer(f, false)).toBe("false");
    expect(coerceAnswer(f, "nope")).toBe("false");
  });

  it("joins an array sent for a plain text question", () => {
    expect(coerceAnswer(field(), ["a", "b"])).toBe("a, b");
  });
});

describe("answerAsk", () => {
  it("prefers the answer, falls back to the detected value", async () => {
    const log = emptyLog();
    const ask = answerAsk({ k: "given" }, log);
    expect(await ask(field({ detectedValue: "auto" }))).toBe("given");
    expect(await ask(field({ key: "other", detectedValue: "auto" }))).toBe("auto");
    expect(log.unanswered).toEqual([]);
  });

  it("treats blank and null as unanswered", async () => {
    const log = emptyLog();
    const ask = answerAsk({ a: "", b: null }, log);
    expect(await ask(field({ key: "a", detectedValue: "auto" }))).toBe("auto");
    expect(await ask(field({ key: "b", required: true }))).toBe("");
    expect(log.unanswered).toEqual(["b"]);
  });

  it("records every key it was asked for, so callers can spot stale answers", async () => {
    const log = emptyLog();
    const ask = answerAsk({}, log);
    await ask(field({ key: "one" }));
    await ask(field({ key: "two" }));
    expect(log.asked).toEqual(["one", "two"]);
  });

  it("keeps an off-menu select value but warns", async () => {
    const log = emptyLog();
    const ask = answerAsk({ k: "gradle-but-custom" }, log);
    const f = field({ kind: FieldKind.Select, options: [{ value: "maven" }, { value: "gradle" }] });
    expect(await ask(f)).toBe("gradle-but-custom");
    expect(log.warnings.join(" ")).toMatch(/not one of the offered options/);
  });

  it("does not warn when the select value is on the menu", async () => {
    const log = emptyLog();
    const ask = answerAsk({ k: "maven" }, log);
    await ask(field({ kind: FieldKind.Select, options: [{ value: "maven" }] }));
    expect(log.warnings).toEqual([]);
  });
});

describe("answerChooseItems", () => {
  const items = [
    { name: "run", label: "run", recommended: true },
    { name: "extra", label: "extra", recommended: false },
  ];

  it("falls back to the recommended set for a category the caller omitted", async () => {
    const log = emptyLog();
    const choose = answerChooseItems({ commands: [] }, log);
    expect(await choose(SelectableKind.Skills, items)).toEqual(["run"]);
    expect(await choose(SelectableKind.Commands, items)).toEqual([]);
  });

  it("takes an explicit selection, including non-recommended items", async () => {
    const log = emptyLog();
    const choose = answerChooseItems({ skills: ["extra"] }, log);
    expect(await choose(SelectableKind.Skills, items)).toEqual(["extra"]);
  });

  it("drops an unknown item and warns with the available names", async () => {
    const log = emptyLog();
    const choose = answerChooseItems({ skills: ["run", "ghost"] }, log);
    expect(await choose(SelectableKind.Skills, items)).toEqual(["run"]);
    expect(log.warnings.join(" ")).toMatch(/no such skills "ghost".*run, extra/);
  });
});
