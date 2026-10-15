import { createHash } from "node:crypto";

/**
 * Spec agent-delegation §11.1 `limit_reached`: the agent keeps using the VC, and does not repeat the same call
 * before `retry_at`. Only a `resets: "at"` answer with a valid `retry_at` blocks; anything else is advisory.
 */

/** RFC 3339 with seconds and an offset, never a date alone (§11.1). */
const RETRY_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Calls remembered per delegation; the oldest goes first. */
export const MAX_BLOCKS = 256;

/** A `retry_at` further out than this is not honoured: the call is forwarded again then, and the RP refuses again. */
export const MAX_BLOCK_MS = 48 * 3600 * 1000;

export interface LimitRefusal {
  /** The §10 body to answer with while the block stands. */
  body: Record<string, unknown>;
  retryAt: number;
  /** How the RP refused: `403` is answered as a 403, anything else in the MCP `isError` form (§10). */
  status?: number;
}

/** JSON with object keys sorted at every level, so equal arguments give one key whatever their order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * The same call is the same tool with the same arguments; anything but one JSON-RPC `tools/call` has no key. The key
 * is a SHA-256, so a block costs the same whatever the call's size (metapass-saas).
 */
export function callKey(body: Buffer): { key: string; id: unknown; name: string } | null {
  try {
    const rpc = JSON.parse(body.toString("utf8")) as { method?: unknown; id?: unknown; params?: { name?: unknown; arguments?: unknown } };
    if (rpc?.method !== "tools/call" || typeof rpc.params?.name !== "string") return null;
    const key = createHash("sha256").update(`${rpc.params.name}\n${canonical(rpc.params.arguments ?? {})}`).digest("base64url");
    return { key, id: rpc.id, name: rpc.params.name };
  } catch {
    return null;
  }
}

/** The written calendar date exists: Date.parse rolls 2099-02-30 over to March 2 instead of refusing it. */
function realDate(rfc3339: string): boolean {
  const [y, m, d] = rfc3339.slice(0, 10).split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** A §10 body that blocks the same call, or null (another refusal, or `limit_reached` that is only advisory). */
export function limitRefusal(body: unknown, now: number): LimitRefusal | null {
  const b = body as Record<string, unknown> | null;
  if (!b || b.error !== "constraint_denied" || b.reason !== "limit_reached") return null;
  // An inconsistent answer is read as no resets and no retry_at: advisory, never a block (§11.1).
  if (b.resets !== "at" || typeof b.retry_at !== "string" || !RETRY_AT.test(b.retry_at)) return null;
  const retryAt = Date.parse(b.retry_at);
  // A rolled-over date (2099-02-30 parses as March 2) or a far future is advisory, not a block of years.
  if (!Number.isFinite(retryAt) || retryAt <= now || retryAt > now + MAX_BLOCK_MS) return null;
  if (!realDate(b.retry_at)) return null;
  return { body: b, retryAt };
}

/**
 * The §10 body inside an MCP tool result: `content[0]` is a text item holding its JSON (§10). The response is
 * JSON or an SSE stream of JSON-RPC messages; the one carrying `result` is read.
 */
export function mcpRefusalBody(raw: Buffer, contentType: string | undefined): unknown {
  const text = raw.toString("utf8");
  // SSE: one event per blank-line-separated block; its `data:` lines join with "\n" (one leading space dropped).
  const messages = /text\/event-stream/i.test(contentType ?? "")
    ? text.split(/\r?\n\r?\n/).map((event) => event.split(/\r?\n/).filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, "")).join("\n")).filter((m) => m !== "")
    : [text];
  for (const m of messages) {
    try {
      const rpc = JSON.parse(m) as { result?: { isError?: unknown; content?: Array<{ type?: unknown; text?: unknown }> } };
      const first = rpc?.result?.isError === true ? rpc.result.content?.[0] : undefined;
      if (first?.type === "text" && typeof first.text === "string") return JSON.parse(first.text);
    } catch {
      // not this message
    }
  }
  return null;
}

/** One delegation's blocked calls. */
export class LimitBlocks {
  private readonly blocks = new Map<string, LimitRefusal>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The refusal standing for this call, if any; an expired one is forgotten. */
  standing(key: string): LimitRefusal | null {
    const b = this.blocks.get(key);
    if (!b) return null;
    if (b.retryAt <= this.now()) {
      this.blocks.delete(key);
      return null;
    }
    return b;
  }

  record(key: string, refusal: LimitRefusal): void {
    this.blocks.delete(key);
    this.blocks.set(key, refusal);
    while (this.blocks.size > MAX_BLOCKS) this.blocks.delete(this.blocks.keys().next().value!);
  }
}

/** The local answer for a blocked call, as the RP gave it: a 403 with its body, or §10's `isError` result. */
export function blockedAnswer(id: unknown, refusal: LimitRefusal): { status: number; body: string } {
  if (refusal.status === 403) return { status: 403, body: JSON.stringify(refusal.body) };
  if (id === undefined) return { status: 202, body: "" };   // a notification gets no result
  const text = JSON.stringify(refusal.body);
  return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text }] } }) };
}
