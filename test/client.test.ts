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
