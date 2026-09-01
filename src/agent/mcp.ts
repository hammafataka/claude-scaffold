import { createInterface } from "node:readline";
import { apply, inspect } from "./session";
import { AgentRequest } from "./types";
import { version } from "../../package.json";

// Protocol version we implement. If the client asks for one we know, we echo it back;
// otherwise we answer with this and let the client decide whether to continue.
const PROTOCOL_VERSION = "2025-06-18";
const KNOWN_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

export interface Rpc {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const ROOT_PROP = {
  root: {
    type: "string",
    description: "Absolute path to the repository. Defaults to the server's working directory.",
  },
} as const;

const COMMON_PROPS = {
  ...ROOT_PROP,
  stack: {
    type: "string",
    description:
      "Force a stack plugin instead of auto-detecting: spring-boot, dart-flutter, node-ts, or generic.",
  },
  tools: {
    type: "array",
    items: { type: "string" },
    description:
      "Coding tools to configure: claude, agents-md, cursor, copilot, gemini, windsurf. " +
      "Defaults to the tools already configured in the repo, else claude.",
  },
} as const;

const TOOLS = [
  {
    name: "scaffold_inspect",
    description:
      "Step 1 of 2. Inspect a repository and return everything needed to configure its AI " +
      "coding-agent files: the detected stack and facts, every interview question with the " +
      "answer shape it expects, the selectable skills/commands/agents/MCP servers, and a " +
      "preview of the files that accepting all defaults would write. Nothing is written. " +
      "Read the repo yourself, then answer the questions with scaffold_apply.",
    inputSchema: { type: "object", properties: { ...COMMON_PROPS }, additionalProperties: false },
  },
  {
    name: "scaffold_apply",
    description:
      "Step 2 of 2. Run the interview with your answers and write the config files " +
      "(CLAUDE.md / AGENTS.md, skills, slash commands, agents, permissions, .mcp.json). " +
      "Call scaffold_inspect first to get the question keys. Existing instruction files are " +
      "merged, never clobbered, and existing rule/command files are skipped. " +
      "Set dryRun to preview the writes without touching disk.",
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_PROPS,
        answers: {
          type: "object",
          description:
            "Answers keyed by question key from scaffold_inspect. Match each question's " +
            "answerType: string, array of strings, or boolean. Omit a key to accept its " +
            "detected default.",
          additionalProperties: true,
        },
        select: {
          type: "object",
          description:
            "Which items to include per category. Omit a category to take its recommended set.",
          properties: {
            skills: { type: "array", items: { type: "string" } },
            commands: { type: "array", items: { type: "string" } },
            agents: { type: "array", items: { type: "string" } },
            mcp: { type: "array", items: { type: "string" } },
            pdd: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
        outputs: {
          type: "object",
          description: "Which output kinds to generate. Defaults to everything relevant except pdd.",
          properties: {
            instructions: { type: "boolean" },
            skills: { type: "boolean" },
            commands: { type: "boolean" },
            agents: { type: "boolean" },
            settings: { type: "boolean" },
            mcp: { type: "boolean" },
            pdd: { type: "boolean" },
          },
          additionalProperties: false,
        },
        dryRun: { type: "boolean", description: "Preview the writes without touching disk." },
      },
      additionalProperties: false,
    },
  },
];

export type Send = (msg: Rpc) => void;

// Tool results are text content blocks; we hand back the same JSON the CLI's --json
// mode prints, so an agent sees one contract regardless of how it reached us.
function toolResult(payload: unknown, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

async function callTool(name: string, args: AgentRequest) {
  switch (name) {
    case "scaffold_inspect":
      return toolResult(await inspect(args));
    case "scaffold_apply":
      return toolResult(await apply(args));
    default:
      return toolResult({ ok: false, error: `Unknown tool "${name}"` }, true);
  }
}

// The protocol handler, parameterised over its transport so tests (and any future
// non-stdio transport) can drive it without a child process.
export function createMcpHandler(send: Send) {
  const reply = (id: Rpc["id"], result: unknown) => send({ jsonrpc: "2.0", id, result });
  const fail = (id: Rpc["id"], code: number, message: string) =>
    send({ jsonrpc: "2.0", id, error: { code, message } });

  return async function handle(msg: Rpc): Promise<void> {
    const { id, method } = msg;
    const isNotification = id === undefined || id === null;

    switch (method) {
      case "initialize": {
        const asked = (msg.params?.protocolVersion as string) ?? "";
        reply(id, {
          protocolVersion: KNOWN_PROTOCOLS.has(asked) ? asked : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "agent-scaffold", version },
          instructions:
            "Bootstraps a repository's AI coding-agent config. Always call scaffold_inspect " +
            "first, read the repository to answer its questions concretely, then call " +
            "scaffold_apply with those answers.",
        });
        return;
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return; // notifications get no response
      case "ping":
        reply(id, {});
        return;
      case "tools/list":
        reply(id, { tools: TOOLS });
        return;
      case "tools/call": {
        const name = String(msg.params?.name ?? "");
        const args = (msg.params?.arguments ?? {}) as AgentRequest;
        try {
          reply(id, await callTool(name, args));
        } catch (e) {
          // Tool-level failures are results, not protocol errors — the agent can read
          // the message and correct its arguments.
          reply(id, toolResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true));
        }
        return;
      }
      default:
        if (!isNotification) fail(id, -32601, `Method not found: ${method}`);
    }
  };
}

export function runMcpServer(): Promise<number> {
  // stdout is the transport — nothing else may ever be written to it.
  const send: Send = (msg) => void process.stdout.write(JSON.stringify(msg) + "\n");
  const handle = createMcpHandler(send);

  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin });
    // Requests are handled in arrival order; each is short and CPU-bound, so a simple
    // serial chain keeps writes to the same repo from interleaving.
    let queue: Promise<void> = Promise.resolve();

    rl.on("line", (line) => {
      const text = line.trim();
      if (!text) return;
      let msg: Rpc | null = null;
      try {
        msg = JSON.parse(text);
      } catch {
        // Queued rather than sent inline, so responses always leave in arrival order.
        queue = queue.then(() =>
          send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }),
        );
        return;
      }
      const parsed = msg as Rpc;
      queue = queue.then(() =>
        handle(parsed).catch((e) => {
          process.stderr.write(`agent-scaffold mcp: ${e instanceof Error ? e.stack : String(e)}\n`);
        }),
      );
    });

    rl.on("close", () => queue.then(() => resolve(0)));
  });
}
