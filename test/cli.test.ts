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

  it("🔴 재등록 안내가 그대로 붙여넣어 실행되는가 (§7-2-A ⑤ · briefick#18)", async () => {
    // 그대로 복사해 실행하는 문자열이라: 아는 값(url)은 채우고, 꺾쇠 placeholder 는 없어야 하고,
    // 낡은 경로(/publish)를 가리키면 안 된다. 셸이 <URL> 을 입력 리다이렉션으로 읽어 깨진 그 자리.
    const s = await stub({ "/api/agent/session/start": () => ({ status: 401, json: { error: "unknown agent" } }) });
    cleanup.push(s.close);
    const file = tmpKeyFile();
    await seededStore(file, (u) => ({ credentials: { [u]: "VC1~" } }), s.url);
    const msg = await main(["session", "--url", s.url, "--key-file", file]).then(
      () => "예외가 나야 한다",
      (e) => String(e instanceof Error ? e.message : e),
    );
    // ① 아는 값(url)이 채워져 있다 — <URL> 꺾쇠가 아니라 실제 URL
    expect(msg).toContain(`--url ${s.url}`);
    // ② 셸을 깨는 꺾쇠 placeholder 가 없다 (입력 리다이렉션으로 읽히는 자리)
    expect(msg).not.toContain("<URL>");
    expect(msg).not.toContain("<CODE>");
    // ③ 낡은 경로를 가리키지 않는다 (briefick 이 /publish→/agents 로 옮김)
    expect(msg).not.toContain("/publish");
    // 명령 자체는 있어야 한다 (안내가 무엇을 하라는지)
    expect(msg).toContain("register --url");
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

/**
 * 🔴 **모르는 플래그가 조용히 무시되던 것** — metapass-saas 실측(배포본 0.3.0·0.4.1 을 깔고 실행).
 *
 * 파서가 인식 못 한 인자를 `rest` 로 흘려보냈고, `rest` 는 **두 자리**로 갈렸다:
 * ```
 * out.cmd ??= rest[0];   // --version 단독 → 명령 자리 → 「알 수 없는 명령」 → 시끄럽게 죽음
 * out.sub  = rest[1];    // status --bogus → 하위명령 자리 → status 는 안 본다 → **침묵**
 * ```
 * ⚠️ 위험한 쪽은 **침묵**이다. `up --install` 을 `--install` 이 없던 판(0.3.0)에서 돌리면
 * 그냥 `up` 이 되어 프록시는 뜨고 **상주 등록만 빠진다** — 드러나는 시점이 **재부팅 뒤**라
 * 원인과 증상이 가장 멀다.
 *
 * 📌 그래서 **두 자리를 다 덮는다.**
 */
describe("모르는 옵션은 거부한다 · --version", () => {
  it("🔴 하위명령 자리의 모르는 플래그 — 종전엔 **조용히 무시**됐다", async () => {
    const code = await main(["status", "--bogus-flag-xyz"]);
    expect(code).toBe(1);
  });

  it("🔴 명령 자리의 모르는 플래그", async () => {
    const code = await main(["--bogus-flag-xyz"]);
    expect(code).toBe(1);
  });

  it("🔴 실제로 문 자리였던 것 — 옛 판에 없던 플래그", async () => {
    // `--install` 은 이 판엔 **있다**. 없던 판을 흉내내는 대신 «모르는 것» 의 대표로 하나 더 본다.
    expect(await main(["up", "--not-a-real-flag"])).toBe(1);
  });

  it("🟢 대조군 — 아는 플래그는 거부되지 않는다", async () => {
    // `--version` 은 아는 플래그다. 거부(1)가 아니라 판 출력(0)이어야 한다.
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await main(["--version"])).toBe(0);
      expect(await main(["-v"])).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("🟢 --version 이 **실제 판**을 찍는다 — package.json 과 같아야 한다", async () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => { lines.push(String(m)); });
    try {
      await main(["--version"]);
    } finally {
      spy.mockRestore();
    }
    // ⚠️ 「무언가 찍는다」가 아니라 **그 값**을 본다 — 상수를 따로 적으면 갈린다.
    expect(lines).toEqual([pkg.version]);
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });


  it("🟡 `--flag=value` 도 **아는 옵션**이다 — 거부되지 않는다", async () => {
    // 🔴 종전엔 통째로 비교해 「알 수 없는 옵션: --port=8787」이라 말했고, 사용자는
    //    **있는 이름을 오타로 의심**하러 갔다(briefick 리뷰). 0.4.1 에서는 아예 조용히
    //    무시됐다 — 이 변경이 없애려는 침묵 중 하나다.
    // ⚠️ `--version` 을 붙여 **일찍 끝나게** 한다(거부되면 1, 인식되면 0).
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await main(["--port=8787", "--version"])).toBe(0);
      expect(await main(["--key-backend=file", "--version"])).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("🟢 대조군 — 등호형이라도 **모르는 이름**이면 거부한다", async () => {
    expect(await main(["--porrt=8787", "--version"])).toBe(1);
  });
  it("⚠️ 모르는 옵션이 이기게 한다 — 아는 명령과 섞여도 실행하지 않는다", async () => {
    // 여기서 0 이 나오면 「판만 찍고 넘어갔다」는 뜻이고, 그건 조용한 무시의 재발이다.
    expect(await main(["--version", "--bogus-flag-xyz"])).toBe(1);
  });
});
