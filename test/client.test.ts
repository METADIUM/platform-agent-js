import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { decodeProtectedHeader, decodeJwt } from "jose";
import { AgentKey } from "../src/key.js";
import { AgentClient, BriefickAgentClient, DEFAULT_SERVICE } from "../src/briefick.js";

interface Stub {
  url: string;
  close: () => Promise<void>;
  hits: { path: string; body: any }[];
}
async function stub(): Promise<Stub> {
  const hits: Stub["hits"] = [];
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      hits.push({ path: req.url ?? "", body: b ? JSON.parse(b) : null });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ registered: true, id: "x" }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())), hits };
}

const stubs: Stub[] = [];
afterEach(async () => {
  for (const s of stubs.splice(0)) await s.close();
});

describe("AgentClient 서비스 중립", () => {
  it("기본 = Briefick 계약 경로·aud", async () => {
    const s = await stub();
    stubs.push(s);
    const key = await AgentKey.generate();
    const c = new AgentClient({ baseUrl: s.url, key });
    await c.register("CODE1234");
    expect(s.hits[0].path).toBe(DEFAULT_SERVICE.registerPath); // /api/agent/register
    const aud = decodeJwt(s.hits[0].body.pop).aud;
    expect(aud).toBe("briefick-agent-register");
    expect(s.hits[0].body.didJwk).toBe(key.did);
  });

  it("service 설정으로 경로·aud 오버라이드(다른 RP)", async () => {
    const s = await stub();
    stubs.push(s);
    const key = await AgentKey.generate();
    const c = new AgentClient({
      baseUrl: s.url,
      key,
      service: {
        registerPath: "/v2/agents/enroll",
        popAudience: { register: "acme-enroll", retrieve: "acme-retrieve", session: "acme-session" },
      },
    });
    await c.register("CODE1234");
    expect(s.hits[0].path).toBe("/v2/agents/enroll");
    expect(decodeJwt(s.hits[0].body.pop).aud).toBe("acme-enroll");
  });

  it("BriefickAgentClient 별칭 = AgentClient", () => {
    expect(BriefickAgentClient).toBe(AgentClient);
  });
});

/** 응답 시퀀스를 순서대로 돌려주는 스텁(회수 폴링 검증용). */
async function seqStub(responses: any[]): Promise<Stub> {
  const hits: Stub["hits"] = [];
  let i = 0;
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      hits.push({ path: req.url ?? "", body: b ? JSON.parse(b) : null });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responses[Math.min(i++, responses.length - 1)]));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())), hits };
}

describe("waitForDelegation — retrieve 세분화 신호(0.2.2)", () => {
  it("no_request → pending(lastRequest) → delivered 전이가 onStatus로 전달", async () => {
    const lastRequest = {
      nonce: "n-1",
      status: "pending",
      createdAt: "2026-08-20T00:00:00Z",
      expiresAt: "2026-08-20T00:10:00Z",
    };
    const s = await seqStub([
      { status: "no_request" },
      { status: "pending", lastRequest },
      { status: "delivered", credential: "VC~" },
    ]);
    stubs.push(s);
    const key = await AgentKey.generate();
    const c = new AgentClient({ baseUrl: s.url, key });
    const seen: string[] = [];
    const cred = await c.waitForDelegation({
      pollMs: 10,
      onStatus: (r) => seen.push(r.status + (r.lastRequest ? ":" + r.lastRequest.nonce : "")),
    });
    expect(cred).toBe("VC~");
    expect(seen).toEqual(["no_request", "pending:n-1", "delivered"]);
  });

  it("타임아웃 메시지 — no_request는 미발급 안내", async () => {
    const s = await seqStub([{ status: "no_request" }]);
    stubs.push(s);
    const key = await AgentKey.generate();
    const c = new AgentClient({ baseUrl: s.url, key });
    await expect(c.waitForDelegation({ pollMs: 10, timeoutMs: 30 })).rejects.toThrow(/발급된 위임 요청이 없습니다/);
  });

  it("타임아웃 메시지 — pending+lastRequest(미만료)는 지갑 전달 실패 의심 안내(nonce 포함)", async () => {
    const s = await seqStub([
      { status: "pending", lastRequest: { nonce: "n-9", status: "pending", expiresAt: "2099-01-01T00:00:00Z" } },
    ]);
    stubs.push(s);
    const key = await AgentKey.generate();
    const c = new AgentClient({ baseUrl: s.url, key });
    await expect(c.waitForDelegation({ pollMs: 10, timeoutMs: 30 })).rejects.toThrow(
      /n-9[\s\S]*전달 실패|전달 실패[\s\S]*n-9/,
    );
  });

  it("대기 중 같은 요청이 만료로 전환되면(status·nonce 불변) onStatus 재통지 + 만료 타임아웃 문구", async () => {
    const lr = (expiresAt: string) => ({ nonce: "n-1", status: "pending", expiresAt });
    const s = await seqStub([
      { status: "pending", lastRequest: lr("2099-01-01T00:00:00Z") },
      { status: "pending", lastRequest: lr("2020-01-01T00:00:00Z") }, // 만료로 전환
    ]);
    stubs.push(s);
    const key = await AgentKey.generate();
    const c = new AgentClient({ baseUrl: s.url, key });
    const seen: boolean[] = [];
    const { isRequestExpired } = await import("../src/briefick.js");
    await expect(
      c.waitForDelegation({ pollMs: 10, timeoutMs: 60, onStatus: (r) => seen.push(isRequestExpired(r)) }),
    ).rejects.toThrow(/만료됐습니다[\s\S]*다시 발급/);
    expect(seen).toEqual([false, true]); // 만료 전환 순간 재통지
  });

  it("RP 명시적 status:\"expired\" — 재발급 안내 타임아웃(신규 신호 우선)", async () => {
    const s = await seqStub([{ status: "expired", lastRequest: { nonce: "n-2" } }]);
    stubs.push(s);
    const key = await AgentKey.generate();
    const c = new AgentClient({ baseUrl: s.url, key });
    await expect(c.waitForDelegation({ pollMs: 10, timeoutMs: 30 })).rejects.toThrow(/n-2[\s\S]*다시 발급/);
  });

  it("구 RP(pending만, lastRequest 없음) — 기존 타임아웃 문구 유지(하위호환)", async () => {
    const s = await seqStub([{ status: "pending" }]);
    stubs.push(s);
    const key = await AgentKey.generate();
    const c = new AgentClient({ baseUrl: s.url, key });
    await expect(c.waitForDelegation({ pollMs: 10, timeoutMs: 30 })).rejects.toThrow(
      "위임 VC 회수 타임아웃(승인 대기)",
    );
  });
});
