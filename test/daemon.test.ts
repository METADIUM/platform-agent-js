/**
 * 데몬(doc26 P1) — 로컬 토큰 강제·/healthz 무토큰·alias 라우팅·RP별 bearer 분리·
 * 루트 경로 호환(1개)/410(복수)·위임 미확보 503. 설정·토큰 파일 동작 포함.
 */
import http from "node:http";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";
import { aliasFromUrl, ensureToken, loadConfig, mcpAddCommand, rotateToken, saveConfig } from "../src/config.js";

function upstream(label: string): Promise<{ url: string; seen: { auth?: string; path?: string }; close(): void }> {
  const seen: { auth?: string; path?: string } = {};
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      seen.auth = req.headers.authorization;
      seen.path = req.url ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ from: label }));
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}/api/mcp`, seen, close: () => server.close() });
    });
  });
}

const TOKEN = "test-local-token";
const auth = (bearer: string) => ({ bearer: () => bearer });

describe("daemon", () => {
  let daemon: RunningDaemon | undefined;
  const closers: Array<() => void> = [];
  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    for (const c of closers.splice(0)) c();
  });

  async function call(path: string, token?: string, body?: unknown) {
    const r = await fetch(`http://127.0.0.1:${daemon!.port}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  }

  it("healthz는 무토큰·정보 없음, 그 외 전부 토큰 강제(401)", async () => {
    const up = await upstream("a");
    closers.push(up.close);
    daemon = await startDaemon({ targets: [{ alias: "a", targetMcpUrl: up.url, auth: auth("A") }], token: TOKEN });

    expect((await call("/healthz")).body).toEqual({ status: "up" });
    expect((await call("/mcp", undefined, { method: "x" })).status).toBe(401);
    expect((await call("/mcp", "wrong-token", { method: "x" })).status).toBe(401);
    expect((await call("/mcp", TOKEN, { method: "tools/list" })).body).toEqual({ from: "a" });
  });

  it("/status needs the token and reports each RP's session, so `status` can't say «valid» while refreshing stopped", async () => {
    const up = await upstream("A");
    closers.push(up.close);
    const stopped = { bearer: () => { throw new Error("세션 만료 — 갱신 중지"); },
      state: () => ({ stopped: true, failures: 1, lastError: "401: PoP" }) };
    daemon = await startDaemon({ targets: [
      { alias: "a", targetMcpUrl: up.url, auth: stopped },
      { alias: "b", targetMcpUrl: up.url, auth: null, pendingReason: "위임 대기" },
    ], token: TOKEN });
    expect((await call("/status")).status).toBe(401);
    const r = await call("/status", TOKEN);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ targets: [
      { alias: "a", connected: true, session: { stopped: true, failures: 1, lastError: "401: PoP" } },
      { alias: "b", connected: false, pendingReason: "위임 대기" },
    ] });
    // and an MCP call through the stopped RP gets a 503 naming why, not the RP's 401 for a dead token
    const m = await call("/a/mcp", TOKEN, { method: "tools/list" });
    expect(m.status).toBe(503);
    expect(String((m.body as { message?: string }).message)).toContain("갱신 중지");
  });

  it("alias 라우팅 — RP별 bearer 분리(교차 주입 없음)", async () => {
    const upA = await upstream("briefick");
    const upB = await upstream("minipaas");
    closers.push(upA.close, upB.close);
    daemon = await startDaemon({
      targets: [
        { alias: "briefick", targetMcpUrl: upA.url, auth: auth("BEARER-A") },
        { alias: "minipaas", targetMcpUrl: upB.url, auth: auth("BEARER-B") },
      ],
      token: TOKEN,
      audit: () => {},
    });

    expect((await call("/briefick/mcp", TOKEN, { method: "x" })).body).toEqual({ from: "briefick" });
    expect(upA.seen.auth).toBe("Bearer BEARER-A");
    expect((await call("/minipaas/mcp", TOKEN, { method: "x" })).body).toEqual({ from: "minipaas" });
    expect(upB.seen.auth).toBe("Bearer BEARER-B");
    // 복수 RP에서 루트는 모호 — 410 + 안내
    expect((await call("/mcp", TOKEN, { method: "x" })).status).toBe(410);
    expect((await call("/unknown/mcp", TOKEN, { method: "x" })).status).toBe(404);
  });

  it("위임 미확보 RP는 503(delegation_pending) — 다른 RP는 정상", async () => {
    const up = await upstream("ok");
    closers.push(up.close);
    daemon = await startDaemon({
      targets: [
        { alias: "ok", targetMcpUrl: up.url, auth: auth("A") },
        { alias: "wait", targetMcpUrl: up.url, auth: null, pendingReason: "지갑 승인 대기" },
      ],
      token: TOKEN,
      audit: () => {},
    });
    expect((await call("/wait/mcp", TOKEN, { method: "x" })).status).toBe(503);
    expect((await call("/ok/mcp", TOKEN, { method: "x" })).body).toEqual({ from: "ok" });
  });

  it("포트 자동 배정 — 점유 시 다음 포트로", async () => {
    const up = await upstream("a");
    closers.push(up.close);
    const first = await startDaemon({ targets: [{ alias: "a", targetMcpUrl: up.url, auth: auth("A") }], token: TOKEN });
    const second = await startDaemon({ targets: [{ alias: "a", targetMcpUrl: up.url, auth: auth("A") }], token: TOKEN });
    expect(second.port).toBeGreaterThan(first.port);
    await first.close();
    daemon = second;
  });
});

describe("config/token", () => {
  it("토큰 생성 0600·재사용·회전, 설정 저장/로드, alias 도출", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentd-"));
    const t1 = ensureToken(dir);
    expect(statSync(join(dir, "proxy-token")).mode & 0o077).toBe(0);
    expect(ensureToken(dir)).toBe(t1); // 재사용
    const t2 = rotateToken(dir);
    expect(t2).not.toBe(t1);
    expect(readFileSync(join(dir, "proxy-token"), "utf8").trim()).toBe(t2);

    saveConfig(dir, { port: 8790, rps: [{ alias: "briefick", url: "https://briefick.cplabs.io" }] });
    expect(loadConfig(dir)).toEqual({ port: 8790, rps: [{ alias: "briefick", url: "https://briefick.cplabs.io" }] });

    expect(aliasFromUrl("https://briefick.cplabs.io")).toBe("briefick");
    expect(aliasFromUrl("https://minipaas.metadium.club/x")).toBe("minipaas");
    expect(mcpAddCommand("minipaas", 8787, "tok", false)).toContain("/minipaas/mcp");
    expect(mcpAddCommand("briefick", 8787, "tok", true)).toContain(":8787/mcp");
  });
});
