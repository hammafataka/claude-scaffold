import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
  // Keep clack out of the bundle so the runtime loads a single @clack/core instance
  // from node_modules. Bundling it duplicates the core classes, which breaks our
  // Prompt.onKeypress patch (the patched class isn't the one clack instantiates).
  // The Anthropic SDK is an optional dependency used only by --ai, and it's loaded with
  // a dynamic import so its absence is a friendly message rather than a startup crash.
  // Bundling it would both bloat the CLI and turn that miss into a build-time failure.
  external: ["@clack/prompts", "@clack/core", "@anthropic-ai/sdk"],
});
