// Spec agent-delegation §11.1 `limit_reached`: keep using the VC; don't repeat the same call before `retry_at`.
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AgentKey } from "../src/key.js";
import { DelegationSessionAuth } from "../src/delegation-session.js";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";
import { LimitBlocks, MAX_BLOCKS, callKey, limitRefusal, mcpRefusalBody } from "../src/limit-block.js";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const call = (args: unknown, name = "log_work", id: unknown = 1) =>
  Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }));
const limit = (extra: Record<string, unknown>) =>
  ({ error: "constraint_denied", reason: "limit_reached", keys: ["maxDeploysPerDay"], ...extra });

describe("callKey", () => {
  it("is the tool and its arguments, whatever the key order", () => {
    expect(callKey(call({ a: 1, b: { c: 2, d: 3 } }))!.key).toBe(callKey(call({ b: { d: 3, c: 2 }, a: 1 }))!.key);
  });
  it("differs for other arguments or another tool", () => {
    expect(callKey(call({ hours: 1 }))!.key).not.toBe(callKey(call({ hours: 2 }))!.key);
    expect(callKey(call({ hours: 1 }))!.key).not.toBe(callKey(call({ hours: 1 }, "update_work"))!.key);
  });
  it("is null for anything but one tools/call", () => {
    expect(callKey(Buffer.from('{"method":"tools/list"}'))).toBeNull();
    expect(callKey(Buffer.from(`[${call({}).toString()}]`)), "a batch").toBeNull();
    expect(callKey(Buffer.from("not json"))).toBeNull();
  });
});

describe("limitRefusal", () => {
  const at = new Date(NOW + 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
  it("blocks only resets \"at\" with a future RFC 3339 retry_at", () => {
    expect(limitRefusal(limit({ resets: "at", retry_at: at }), NOW)?.retryAt).toBe(NOW + 3_600_000);
    expect(limitRefusal(limit({ resets: "at", retry_at: "2026-10-15T13:00:00+09:00" }), NOW), "13:00+09:00 is 04:00Z, already past").toBeNull();
    expect(limitRefusal(limit({ resets: "at", retry_at: "2026-10-15T22:00:00+09:00" }), NOW)).not.toBeNull();
  });
  it.each([
    ["no resets", limit({ retry_at: at })],
    ["per_argument", limit({ resets: "per_argument", retry_at: at })],
    ["never", limit({ resets: "never" })],
    ["at without retry_at", limit({ resets: "at" })],
    ["a date alone", limit({ resets: "at", retry_at: "2026-10-16" })],
    ["no offset (future in any zone)", limit({ resets: "at", retry_at: "2026-10-16T23:00:00" })],
    ["no seconds", limit({ resets: "at", retry_at: "2026-10-15T13:00Z" })],
    ["in the past", limit({ resets: "at", retry_at: "2026-10-15T11:00:00Z" })],
    ["another reason", { ...limit({ resets: "at", retry_at: at }), reason: "constraints_unknown_key" }],
  ])("is advisory (null) for %s", (_, body) => {
    expect(limitRefusal(body, NOW)).toBeNull();
  });
});

describe("mcpRefusalBody", () => {
  const result = (isError: boolean, text: string) => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError, content: [{ type: "text", text }] } });
  it("reads content[0].text of an isError result, as JSON or SSE", () => {
    const body = limit({ resets: "never" });
    expect(mcpRefusalBody(Buffer.from(result(true, JSON.stringify(body))), "application/json")).toEqual(body);
    const sse = `event: message\ndata: ${result(true, JSON.stringify(body))}\n\n`;
    expect(mcpRefusalBody(Buffer.from(sse), "text/event-stream")).toEqual(body);
  });
  it("joins an SSE event's data lines before parsing", () => {
    const body = limit({ resets: "never" });
    const json = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: JSON.stringify(body) }] } }, null, 1);
    const sse = `event: message\n${json.split("\n").map((l) => `data: ${l}`).join("\n")}\n\nevent: ping\ndata: {}\n\n`;
    expect(mcpRefusalBody(Buffer.from(sse), "text/event-stream")).toEqual(body);
  });

  it("is null for a result that isn't an error, or prose", () => {
    expect(mcpRefusalBody(Buffer.from(result(false, JSON.stringify(limit({})))), "application/json")).toBeNull();
    expect(mcpRefusalBody(Buffer.from(result(true, "권한 거부(hours_cap_exceeded)")), "application/json")).toBeNull();
  });
});

describe("LimitBlocks", () => {
  it("forgets a block once retry_at passes", () => {
    let now = NOW;
    const b = new LimitBlocks(() => now);
    b.record("k", { body: {}, retryAt: NOW + 1000 });
    expect(b.standing("k")).not.toBeNull();
    now = NOW + 1000;
    expect(b.standing("k"), "still blocked at retry_at").toBeNull();
  });
  it("keeps at most MAX_BLOCKS calls, dropping the oldest", () => {
    const b = new LimitBlocks(() => NOW);
    for (let i = 0; i <= MAX_BLOCKS; i++) b.record(`k${i}`, { body: {}, retryAt: NOW + 1000 });
    expect(b.standing("k0")).toBeNull();
    expect(b.standing(`k${MAX_BLOCKS}`)).not.toBeNull();
  });
});

describe("daemon: the same call is not repeated before retry_at", () => {
  let daemon: RunningDaemon | undefined;
  const closers: Array<() => void> = [];
  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    for (const f of closers.splice(0)) f();
  });

  const retryAt = () => new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
  type Answer = { status: number; type?: string; body: string };

  function rp(answer: (n: number) => Answer) {
    const seen: string[] = [];
    return new Promise<{ url: string; seen: string[] }>((resolve) => {
      const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          seen.push(Buffer.concat(chunks).toString("utf8"));
          const a = answer(seen.length);
          res.writeHead(a.status, { "content-type": a.type ?? "application/json" });
          res.end(a.body);
        });
      });
      server.listen(0, "127.0.0.1", () => {
        closers.push(() => server.close());
        resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/mcp`, seen });
      });
    });
  }

  async function session() {
    const s = new DelegationSessionAuth({
      key: await AgentKey.generate(), verifier: "v",
      exchange: async () => ({ accessToken: "a.b.c", expiresIn: 300, expiresAt: new Date(Date.now() + 300_000) }),
    });
    await s.start();
    closers.push(() => s.stop());
    return s;
  }

  async function send(body: Buffer) {
    const r = await fetch(`http://127.0.0.1:${daemon!.port}/mcp`, {
      method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body,
    });
    return { status: r.status, text: await r.text() };
  }

  const isError = (body: Record<string, unknown>, id = 1) =>
    JSON.stringify({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: JSON.stringify(body) }] } });

  it("answers a repeat of an MCP isError limit_reached locally, keeps the VC, and forwards other arguments", async () => {
    const refusal = limit({ resets: "at", retry_at: retryAt() });
    const up = await rp((n) => (n === 1 ? { status: 200, body: isError(refusal) } : { status: 200, body: '{"jsonrpc":"2.0","id":3,"result":{}}' }));
    const s = await session();
    daemon = await startDaemon({ targets: [{ alias: "a", targetMcpUrl: up.url, auth: s }], token: "t", port: 0 });

    await send(call({ app: "x" }));
    const again = await send(call({ app: "x" }, "log_work", 2));
    expect(up.seen.length, "the same call reached the RP again before retry_at").toBe(1);
    expect(again.status).toBe(200);
    const answer = JSON.parse(again.text);
    expect(answer.id, "the local answer must carry the repeat's own id").toBe(2);
    expect(JSON.parse(answer.result.content[0].text)).toEqual(refusal);
    expect(answer.result.isError).toBe(true);

    await send(call({ app: "y" }, "log_work", 3));
    expect(up.seen.length, "a call with other arguments was blocked too").toBe(2);
    expect(s.state().status, "limit_reached must neither drop nor hold the VC").not.toMatch(/dropped|held/);
  });

  it("starts a new delegation on the same route with no blocks", async () => {
    const up = await rp(() => ({ status: 200, body: isError(limit({ resets: "at", retry_at: retryAt() })) }));
    const target = { alias: "a", targetMcpUrl: up.url, auth: await session() as DelegationSessionAuth | null };
    daemon = await startDaemon({ targets: [target], token: "t", port: 0 });
    await send(call({}));
    await send(call({}));
    expect(up.seen.length).toBe(1);
    target.auth = await session();   // what connectRoute does when pickup brings a newer VC for this route
    await send(call({}));
    expect(up.seen.length, "a new delegation, which resets the quota, was still blocked by the old one").toBe(2);
  });

  it("does the same for a 403 limit_reached", async () => {
    const up = await rp(() => ({ status: 403, body: JSON.stringify(limit({ resets: "at", retry_at: retryAt() })) }));
    daemon = await startDaemon({ targets: [{ alias: "a", targetMcpUrl: up.url, auth: await session() }], token: "t", port: 0 });
    expect((await send(call({ n: 1 }))).status).toBe(403);
    await send(call({ n: 1 }));
    expect(up.seen.length).toBe(1);
  });

  it("reads an SSE response", async () => {
    const refusal = limit({ resets: "at", retry_at: retryAt() });
    const up = await rp(() => ({ status: 200, type: "text/event-stream", body: `event: message\ndata: ${isError(refusal)}\n\n` }));
    daemon = await startDaemon({ targets: [{ alias: "a", targetMcpUrl: up.url, auth: await session() }], token: "t", port: 0 });
    await send(call({}));
    await send(call({}));
    expect(up.seen.length).toBe(1);
  });

  it.each([
    ["per_argument", { resets: "per_argument" }],
    ["never", { resets: "never" }],
    ["no resets", {}],
  ])("forwards the same call again when the refusal is advisory (%s)", async (_, extra) => {
    const up = await rp(() => ({ status: 200, body: isError(limit(extra)) }));
    daemon = await startDaemon({ targets: [{ alias: "a", targetMcpUrl: up.url, auth: await session() }], token: "t", port: 0 });
    await send(call({}));
    await send(call({}));
    expect(up.seen.length).toBe(2);
  });
});
