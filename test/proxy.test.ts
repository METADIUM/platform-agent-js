import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { startProxy, type RunningProxy } from "../src/proxy.js";

interface Stub {
  url: string;
  close: () => Promise<void>;
  last: { auth?: string; method?: string; body?: string; path?: string };
}

async function stubUpstream(status = 200, resBody = '{"ok":true}'): Promise<Stub> {
  const last: Stub["last"] = {};
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      last.auth = req.headers.authorization;
      last.method = req.method;
      last.body = b;
      last.path = req.url;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(resBody);
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/api/mcp`, close: () => new Promise<void>((r) => srv.close(() => r())), last };
}

const running: RunningProxy[] = [];
const stubs: Stub[] = [];
afterEach(async () => {
  for (const p of running.splice(0)) await p.close();
  for (const s of stubs.splice(0)) await s.close();
});

describe("로컬 MCP 프록시", () => {
  it("최신 bearer 주입 + 메서드·본문·응답 투명 포워딩", async () => {
    const up = await stubUpstream(200, '{"tools":[]}');
    stubs.push(up);
    let token = "tok-1";
    const proxy = await startProxy({ auth: { bearer: () => token }, targetMcpUrl: up.url, port: 0 });
    running.push(proxy);

    const res = await fetch(proxy.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer CLIENT_FIXED" },
      body: '{"jsonrpc":"2.0","method":"tools/list"}',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"tools":[]}');
    expect(up.last.auth).toBe("Bearer tok-1"); // 클라 고정헤더 대신 최신 bearer 주입
    expect(up.last.method).toBe("POST");
    expect(up.last.body).toBe('{"jsonrpc":"2.0","method":"tools/list"}');
  });

  it("bearer 갱신이 다음 요청에 즉시 반영", async () => {
    const up = await stubUpstream();
    stubs.push(up);
    let token = "old";
    const proxy = await startProxy({ auth: { bearer: () => token }, targetMcpUrl: up.url, port: 0 });
    running.push(proxy);

    await fetch(proxy.url, { method: "POST", body: "a" });
    expect(up.last.auth).toBe("Bearer old");
    token = "new"; // 갱신
    await fetch(proxy.url, { method: "POST", body: "b" });
    expect(up.last.auth).toBe("Bearer new");
  });

  it("업스트림 401(만료/철회)을 그대로 전달", async () => {
    const up = await stubUpstream(401, '{"error":"unauthorized"}');
    stubs.push(up);
    const proxy = await startProxy({ auth: { bearer: () => "x" }, targetMcpUrl: up.url, port: 0 });
    running.push(proxy);
    const res = await fetch(proxy.url, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('{"error":"unauthorized"}');
  });
});
