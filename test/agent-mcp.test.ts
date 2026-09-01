import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { createMcpHandler, Rpc } from "../src/agent/mcp";

const nextjs = join(__dirname, "fixtures", "nextjs-app");

// Drive the protocol handler directly over an in-memory transport.
function server() {
  const sent: Rpc[] = [];
  const handle = createMcpHandler((m) => void sent.push(m));
  return { sent, handle };
}

function payload(msg: Rpc): Record<string, unknown> {
  const result = msg.result as { content: { text: string }[] };
  return JSON.parse(result.content[0].text);
}

describe("MCP server", () => {
  it("completes the initialize handshake, echoing a protocol version it knows", async () => {
    const { sent, handle } = server();
    await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });

    const r = sent[0].result as Record<string, any>;
    expect(r.protocolVersion).toBe("2024-11-05");
    expect(r.serverInfo.name).toBe("agent-scaffold");
    expect(r.capabilities.tools).toBeDefined();
    expect(r.instructions).toMatch(/scaffold_inspect/);
  });

  it("falls back to its own protocol version for an unknown one", async () => {
    const { sent, handle } = server();
    await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect((sent[0].result as any).protocolVersion).toBe("2025-06-18");
  });

  it("answers notifications with nothing at all", async () => {
    const { sent, handle } = server();
    await handle({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(sent).toEqual([]);
  });

  it("advertises both tools with input schemas", async () => {
    const { sent, handle } = server();
    await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    const tools = (sent[0].result as any).tools;
    expect(tools.map((t: any) => t.name)).toEqual(["scaffold_inspect", "scaffold_apply"]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.description.length).toBeGreaterThan(40);
    }
    expect(tools[1].inputSchema.properties.answers).toBeDefined();
  });

  it("runs scaffold_inspect and returns the contract as JSON text", async () => {
    const { sent, handle } = server();
    await handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "scaffold_inspect", arguments: { root: nextjs } },
    });

    expect((sent[0].result as any).isError).toBe(false);
    const p = payload(sent[0]) as any;
    expect(p.stack.id).toBe("node-ts");
    expect(p.questions.length).toBeGreaterThan(0);
  });

  it("runs scaffold_apply, honouring dryRun", async () => {
    const { sent, handle } = server();
    await handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "scaffold_apply",
        arguments: { root: nextjs, dryRun: true, answers: { overview: "Dashboard." } },
      },
    });

    const p = payload(sent[0]) as any;
    expect(p.ok).toBe(true);
    expect(p.dryRun).toBe(true);
    expect(p.counts.create).toBeGreaterThan(0);
  });

  it("reports a bad argument as a tool error, not a protocol error", async () => {
    const { sent, handle } = server();
    await handle({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "scaffold_inspect", arguments: { root: nextjs, tools: ["emacs"] } },
    });

    expect(sent[0].error).toBeUndefined();
    expect((sent[0].result as any).isError).toBe(true);
    expect((payload(sent[0]) as any).error).toMatch(/Unknown tool "emacs"/);
  });

  it("reports an unknown tool name as a tool error", async () => {
    const { sent, handle } = server();
    await handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } });
    expect((sent[0].result as any).isError).toBe(true);
  });

  it("returns method-not-found for an unknown method, but stays quiet for a notification", async () => {
    const { sent, handle } = server();
    await handle({ jsonrpc: "2.0", id: 7, method: "totally/unknown" });
    expect(sent[0].error!.code).toBe(-32601);

    sent.length = 0;
    await handle({ jsonrpc: "2.0", method: "totally/unknown" });
    expect(sent).toEqual([]);
  });
});
