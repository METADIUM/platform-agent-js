import { readFileSync, readdirSync } from "node:fs";
import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
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


import { hostname } from "node:os";
import { main, registerLabel, LABEL_MAX } from "../src/cli.js";

describe("등록 요청에 표시 이름이 실린다", () => {
  it("기본값은 이 머신의 호스트 이름 — 전선에 실제로 실린다", async () => {
    const s = await stub({ "/api/agent/register": () => ({ json: { registered: true } }) });
    cleanup.push(s.close);
    const file = tmpKeyFile();
    const code = await main(["register", "--url", s.url, "--code", "C1", "--key-file", file]);
    expect(code).toBe(0);
    const hit = s.hits.find((h) => h.path === "/api/agent/register");
    expect(hit, "register 호출 자체가 없다").toBeTruthy();
    // 값을 «이름»으로 확인한다 — 호스트 이름은 기계마다 달라 리터럴로 못 박는다.
    expect(hit!.body.label).toBe(hostname().trim().slice(0, LABEL_MAX));
    expect(hit!.body.label, "빈 이름을 보내면 서버 기본 표시보다 나빠진다").toBeTruthy();
  });

  it("--label 이 호스트 이름을 이긴다", async () => {
    const s = await stub({ "/api/agent/register": () => ({ json: { registered: true } }) });
    cleanup.push(s.close);
    const file = tmpKeyFile();
    await main(["register", "--url", s.url, "--code", "C1", "--key-file", file, "--label", "출입리더기-3층"]);
    const hit = s.hits.find((h) => h.path === "/api/agent/register")!;
    expect(hit.body.label).toBe("출입리더기-3층");
    expect(hit.body.label).not.toBe(hostname());
  });

  it("add 경로도 같은 값을 싣는다 — 두 호출부가 갈리지 않는다", async () => {
    const s = await stub({ "/api/agent/register": () => ({ json: { registered: true } }) });
    cleanup.push(s.close);
    const file = tmpKeyFile();
    await main(["add", s.url, "--code", "C1", "--key-file", file, "--label", "같은값"]);
    const hit = s.hits.find((h) => h.path === "/api/agent/register")!;
    expect(hit.body.label).toBe("같은값");
  });

  it("--label= 등호형도 같은 옵션이다", async () => {
    const s = await stub({ "/api/agent/register": () => ({ json: { registered: true } }) });
    cleanup.push(s.close);
    const file = tmpKeyFile();
    await main(["register", "--url", s.url, "--code", "C1", "--key-file", file, "--label=등호형"]);
    expect(s.hits.find((h) => h.path === "/api/agent/register")!.body.label).toBe("등호형");
  });
});

describe("registerLabel — 빈 이름을 만들지 않는다", () => {
  it("공백뿐인 --label 은 호스트 이름으로 떨어진다", () => {
    expect(registerLabel({ label: "   " })).toBe(hostname().trim().slice(0, LABEL_MAX));
  });

  it("LABEL_MAX 로 자른다", () => {
    const long = "가".repeat(LABEL_MAX + 20);
    expect(registerLabel({ label: long })).toHaveLength(LABEL_MAX);
  });

  it("⚠️ 「못 알아냈다」는 「빈 이름」이 아니다 — hostname 이 던지면 아무것도 안 보낸다", () => {
    expect(registerLabel({}, () => {
      throw new Error("EPERM");
    })).toBeUndefined();
  });

  it("hostname 이 빈 문자열이어도 아무것도 안 보낸다", () => {
    expect(registerLabel({}, () => "   ")).toBeUndefined();
  });
});
