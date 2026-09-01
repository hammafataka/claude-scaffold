import { FieldSpec } from "../plugins/types";

// Where a field is being asked from. Interactive prompting ignores it; the agent-mode
// probe uses it to tell an LLM which document section its answer lands in.
export interface AskContext {
  stage: string;
  section?: string;
}

export type AskFn = (field: FieldSpec, ctx?: AskContext) => Promise<string>;

export interface ResolveOptions {
  yes: boolean;
  ask: AskFn;
  ctx?: AskContext;
}

export async function resolveFields(
  fields: FieldSpec[],
  opts: ResolveOptions,
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    if (opts.yes) {
      if (field.detectedValue !== undefined) {
        values[field.key] = field.detectedValue;
      } else if (field.required) {
        values[field.key] = await opts.ask(field, opts.ctx);
      } else {
        values[field.key] = "";
      }
    } else {
      values[field.key] = await opts.ask(field, opts.ctx);
    }
  }
  return values;
}
