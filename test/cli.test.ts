import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { AgentKey } from "../src/key.js";
import { loadStore, saveStore, type KeyStore } from "../src/keystore.js";

/** 라우트별 핸들러 스텁 — 호출 기록 포함. */
interface Stub {
  url: string;
  close: () => Promise<void>;
  hits: { path: string; body: any }[];
}
type Routes = Record<string, (body: any, hitCount: number) => { status?: number; json: any }>;

async function stub(routes: Routes): Promise<Stub> {
  const hits: Stub["hits"] = [];
  const counts = new Map<string, number>();
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      const body = b ? JSON.parse(b) : null;
      hits.push({ path, body });
      const n = (counts.get(path) ?? 0) + 1;
      counts.set(path, n);
      const handler = routes[path];
      const r = handler ? handler(body, n) : { status: 404, json: { error: "no route " + path } };
      res.writeHead(r.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())), hits };
}

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

function tmpKeyFile(): string {
  const d = mkdtempSync(join(tmpdir(), "mpa-cli-"));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return join(d, "key.json");
}

async function seededStore(file: string, extra: (url: string) => Partial<KeyStore>, url: string): Promise<AgentKey> {
  const key = await AgentKey.generate();
  saveStore(file, { privateJwk: key.exportPrivateJwk(), ...extra(url) });
  return key;
}

describe("cli — 서버-로컬 상태 불일치 복구", () => {
  it("register: 로컬 플래그가 있어도 --code가 주어지면 서버에 등록(회수 후 재등록)", async () => {
    const s = await stub({ "/api/agent/register": () => ({ json: { registered: true } }) });
    cleanup.push(s.close);
    const file = tmpKeyFile();
    await seededStore(file, (u) => ({ registrations: { [u]: true } }), s.url);
    const code = await main(["register", "--url", s.url, "--code", "NEW123", "--key-file", file]);
    expect(code).toBe(0);
    expect(s.hits.map((h) => h.path)).toContain("/api/agent/register");
  });

  it("add: 로컬 플래그가 있어도 --code가 주어지면 서버에 재등록(회수 후 복구 경로)", async () => {
    // 🔴 종전에는 add 가 로컬 플래그만 보고 code 를 **무시한 채 ✅** 를 찍었다 — 서버 토큰이
    //    회수됐어도. 사용자는 재등록했다고 믿지만 데몬은 401 을 계속 돌린다(briefick#18).
    const s = await stub({ "/api/agent/register": () => ({ json: { registered: true } }) });
    cleanup.push(s.close);
    const file = tmpKeyFile();
    await seededStore(file, (u) => ({ registrations: { [u]: true } }), s.url);
    const code = await main(["add", s.url, "--code", "NEW123", "--key-file", file]);
    expect(code).toBe(0);
    expect(s.hits.map((h) => h.path)).toContain("/api/agent/register");
  });

  it("register: --code 없이 로컬 플래그면 스킵(서버 호출 없음)", async () => {
    const s = await stub({});
    cleanup.push(s.close);
    const file = tmpKeyFile();
    await seededStore(file, (u) => ({ registrations: { [u]: true } }), s.url);
    delete process.env.PAIRING_CODE;
    const code = await main(["register", "--url", s.url, "--key-file", file]);
    expect(code).toBe(0);
    expect(s.hits.length).toBe(0);
  });

  it("session: start 401(등록 회수) → 재등록 안내로 실패", async () => {
    const s = await stub({ "/api/agent/session/start": () => ({ status: 401, json: { error: "unknown agent" } }) });
    cleanup.push(s.close);
    const file = tmpKeyFile();
    await seededStore(file, (u) => ({ credentials: { [u]: "VC1~" } }), s.url);
    await expect(main(["session", "--url", s.url, "--key-file", file])).rejects.toThrow(/새 페어링 코드/);
  });

  it("session: 세션 거부(위임 철회) → 캐시 폐기 + 재발급 회수 후 1회 재시도 성공", async () => {
    const responseUri = { v: "" };
    const s = await stub({
      "/api/agent/session/start": (_b, n) => ({
        json: { state: "st" + n, nonce: "n" + n, responseUri: responseUri.v },
      }),
      "/response": () => ({ json: {} }),
      // 1번째 세션은 rejected(철회 사유) → 2번째 세션은 issued
      "/api/agent/session/complete": (b) =>
        b.state === "st1"
          ? { json: { status: "rejected", reasons: ["Credential revoked"] } }
          : { json: { status: "issued", bearer: "B2", expiresAt: "2099-01-01T00:00:00Z", scope: ["log"] } },
      // 캐시 폐기 후 재발급 회수
      "/api/agent/delegation/retrieve": () => ({ json: { status: "delivered", credential: "VC2~" } }),
    });
    cleanup.push(s.close);
    responseUri.v = s.url + "/response";
    const file = tmpKeyFile();
    await seededStore(file, (u) => ({ credentials: { [u]: "VC1~" } }), s.url);

    const code = await main(["session", "--url", s.url, "--key-file", file]);
    expect(code).toBe(0);
    // 새 VC가 캐시에 저장되고, 두 번째 제시는 VC2 기반
    expect(loadStore(file)?.credentials?.[s.url]).toBe("VC2~");
    const presented = s.hits.filter((h) => h.path === "/response").map((h) => String(h.body.vpToken));
    expect(presented[0].startsWith("VC1~")).toBe(true);
    expect(presented[1].startsWith("VC2~")).toBe(true);
  });

  it("proxy: start 401 + 서버 사유 → 재등록 안내에 사유 포함", async () => {
    const s = await stub({
      "/api/agent/session/start": () => ({ status: 401, json: { error: "agent registration revoked" } }),
    });
    cleanup.push(s.close);
    const file = tmpKeyFile();
    await seededStore(file, (u) => ({ credentials: { [u]: "VC1~" } }), s.url);
    await expect(main(["proxy", "--url", s.url, "--key-file", file])).rejects.toThrow(
      /새 페어링 코드[\s\S]*agent registration revoked/,
    );
  });

  it("credentials clear --url: 해당 RP 캐시만 삭제", async () => {
    const file = tmpKeyFile();
    const key = await AgentKey.generate();
    saveStore(file, {
      privateJwk: key.exportPrivateJwk(),
      credentials: { "https://a": "VCa", "https://b": "VCb" },
    });
    const code = await main(["credentials", "clear", "--url", "https://a", "--key-file", file]);
    expect(code).toBe(0);
    const after = loadStore(file);
    expect(after?.credentials?.["https://a"]).toBeUndefined();
    expect(after?.credentials?.["https://b"]).toBe("VCb");
  });

  it("credentials clear(전체): 모든 캐시 삭제", async () => {
    const file = tmpKeyFile();
    const key = await AgentKey.generate();
    saveStore(file, { privateJwk: key.exportPrivateJwk(), credentials: { "https://a": "VCa" } });
    const code = await main(["credentials", "clear", "--key-file", file]);
    expect(code).toBe(0);
    expect(loadStore(file)?.credentials).toEqual({});
  });
});
