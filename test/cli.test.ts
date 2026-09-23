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

  it("🟡 `--port` 에 쓸 수 없는 값은 **거부**한다 — 빈 값이 0(임의 포트)이 되던 것", async () => {
    // 🔴 `Number("")` 는 0 이고 `0 ?? 8787` 도 0 이라, `--port=` 하나로 **OS 임의 배정**
    //    포트에 리슨했다. 그 자리에선 출력이 실제 포트를 찍어 «된 것처럼» 보이고,
    //    깨지는 건 **다음 기동** 때다(briefick 리뷰).
    expect(await main(["--port=", "--version"])).toBe(1);
    expect(await main(["--port=abc", "--version"])).toBe(1);
    expect(await main(["--port=0", "--version"])).toBe(1);
    expect(await main(["--port=70000", "--version"])).toBe(1);
  });

  it("🟢 대조군 — 쓸 수 있는 포트는 통과한다", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await main(["--port=9999", "--version"])).toBe(0);
      expect(await main(["--port", "9999", "--version"])).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("🟡 모르는 옵션은 **이름만** 찍는다 — 값이 stderr 로 새지 않는다", async () => {
    // 🔴 `--cod=SECRET123` 같은 오타에서 **값이 그대로 로그에 남았다**. 페어링 코드는
    //    붙여넣는 값이라 오타가 나는 자리가 정확히 거기이고, stderr 는 CI 로그·이슈로 간다.
    //    ⚠️ 값을 찍어서 얻는 게 없다 — 사용자가 방금 친 것이고 고칠 것은 **이름**이다.
    const err: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m?: unknown) => { err.push(String(m)); });
    try {
      expect(await main(["--cod=SECRET123", "--version"])).toBe(1);
    } finally {
      spy.mockRestore();
    }
    const joined = err.join("\n");
    expect(joined).toContain("--cod");
    expect(joined).not.toContain("SECRET123");   // ← 값이 새면 여기서 잡힌다
  });
  it("⚠️ 모르는 옵션이 이기게 한다 — 아는 명령과 섞여도 실행하지 않는다", async () => {
    // 여기서 0 이 나오면 「판만 찍고 넘어갔다」는 뜻이고, 그건 조용한 무시의 재발이다.
    expect(await main(["--version", "--bogus-flag-xyz"])).toBe(1);
  });
});

/**
 * 🔴 **소스의 형태가 빌드와 맺은 계약이다.** `scripts/build-sea.mjs` 는 esbuild
 * `--define:__AGENT_VERSION__=…` 로 **맨 식별자**를 텍스트 치환한다 — `globalThis.__AGENT_VERSION__`
 * 로 바꾸면 `--define` 이 겨냥하지 못한다.
 *
 * ⚠️ 그런데 다른 검사들은 **전역 속성**(`globalThis.__AGENT_VERSION__ = …`)으로 넣어 잰다.
 *    맨 식별자가 전역 속성으로도 풀리므로 **드리프트가 나도 그 검사들은 초록**이다.
 *    실측(개악): 소스를 `globalThis.…` 로 바꾸면 **vitest 72 통과 · 번들 0건 ·
 *    바이너리 `--version` exit 1** — v0.5.1 과 같은 실패가 조용히 돌아온다(briefick 지적).
 *
 * 📌 그래서 여기서는 **소스 텍스트**를 본다. 보통은 「선언을 재는 검사」라 피해야 하지만,
 *    여기서 지켜야 할 것 자체가 **텍스트 계약**이다. 빌드가 보는 것과 같은 것을 본다.
 * 🔵 이중으로 잠근다 — `build-sea.mjs` 도 번들에 판이 박혔는지 빌드 때 단언한다.
 *    이 검사는 **빌드 없이**(`npm test`) 잡고, 그쪽은 빌드하면 잡는다.
 */
describe("판 주입은 빌드와의 텍스트 계약이다", () => {
  const src = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");

  it("맨 식별자로 읽는다 — globalThis 를 거치지 않는다", () => {
    expect(src).toContain("typeof __AGENT_VERSION__ ===");
    expect(src).not.toContain("globalThis as Record<string, unknown>).__AGENT_VERSION__");
  });

  it("빌드가 그 이름을 실제로 겨냥한다", () => {
    const build = readFileSync(new URL("../scripts/build-sea.mjs", import.meta.url), "utf8");
    expect(build).toContain("--define:__AGENT_VERSION__=");
  });
});

/**
 * 🔴 **두 레포가 같은 사실 위에 문구를 얹고 있다.**
 *
 * ```
 * 이 레포   `upgrade` 실행 출력 · --help   "판은 안 바뀐다 — install.sh 를 다시 돌려라"
 * briefick  화면 안내                       "up --install 은 유닛만 건드려 파일을 안 바꿉니다"
 * ```
 *
 * 둘 다 있어야 한다 — 하나는 **친 사람**에게, 하나는 **치기 전 사람**에게 간다. 그런데 둘은
 * **갈릴 수 있는 사본**이고, 갈리는 계기는 문구가 아니라 **동작이 바뀌는 것**이다:
 * 누가 `installUnit()` 에 바이너리 복사를 넣으면 **양쪽 문구가 동시에 거짓**이 되는데,
 * 아무도 안 본다(문구는 그대로니까).
 *
 * ⇒ 사본을 줄이는 대신 **둘이 기대는 사실 하나를 여기서 잠근다.** 이 검사가 빨개지면
 *   양쪽 문구를 같이 고쳐야 한다는 신호다.
 * 📌 오늘의 말로: 사본 둘을 「한 문장」으로 합칠 수 없을 때는, 둘이 딛고 선 **바닥**을 잠근다.
 */
describe("`upgrade` 는 유닛만 만진다 — 두 레포 문구가 딛고 선 사실", () => {
  /** 🔴 **주석을 떼고 본다.** 안 떼면 이 규칙을 `install.ts` 에 **문서화하는 순간** 빨개진다
   *  (`#5` 에서 이미 밟은 함정이 이 파일에 다시 있다 — briefick 지적). */
  const src = readFileSync(new URL("../src/install.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

  /**
   * 🔴 **개수를 세면 교환에 뚫린다** — 앞 판은 `writeFileSync` 가 둘인지만 봤다.
   *    하나를 지우고 `writeFileSync(destBin, readFileSync(srcBin))` 를 더하면 **둘 그대로**다.
   *    막으려던 바로 그것이 통과한다(briefick). 이 팀이 `#42` 에서 세운 규칙 그대로다:
   *    **수가 아니라 이름**을 본다.
   */
  it("쓰는 대상이 유닛 파일 둘뿐이다 — 이름으로 본다", () => {
    const targets = [...src.matchAll(/writeFileSync\(\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
    expect(new Set(targets)).toEqual(new Set(["plistPath", "unitPath"]));
  });

  /**
   * 🔴 **금지 목록은 내가 아는 방법만 막는다** — 처음엔 `copyFileSync` 를 막고
   *    `copyFile`(`node:fs/promises`) 은 못 막았다. 그래서 **허용 집합**으로 뒤집었는데,
   *    그 첫 판도 뚫렸다(briefick 실측, 둘 다 78 통과):
   *
   * ```ts
   * import { copyFileSync } from "fs";        // 접두 없음 — 유효하고 오히려 더 흔한 표기
   * import { copyFileSync } from "node:fs";   // 두 번째 줄 — .match 는 첫 일치만 본다
   * ```
   *
   * 📌 이름 집합은 맞았는데 **어느 이름 집합인지가 한 줄에 매여** 있었다. 개수 → 이름으로
   *    옮긴 것의 **한 칸 위**다. ⇒ `matchAll` 로 **fs 표면 전체**(`fs` · `node:fs` ·
   *    `node:fs/promises` · `fs/promises`)를 모아 합집합으로 본다.
   * 🟢 네임스페이스 임포트(`import * as fs`)·`require` 는 중괄호가 없어 **아래가 잡지 못하지만**,
   *    그때는 매치가 0건이라 첫 단언에서 멈춘다(fail-closed).
   */
  it("fs 표면 전체에서 가져오는 것이 정확히 넷이다", () => {
    const imports = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(?:node:)?fs(?:\/promises)?"/g)];
    expect(imports.length).toBeGreaterThan(0);
    const names = imports.flatMap((m) => m[1].split(",").map((x) => x.trim()).filter(Boolean));
    expect(new Set(names)).toEqual(new Set(["existsSync", "mkdirSync", "rmSync", "writeFileSync"]));
  });

  /** ⚠️ 위가 `fs/promises` 도 함께 세므로 **별도 금지 검사는 흡수됐다** — 같은 사실의 사본을
   *  둘 두지 않는다(briefick). 중괄호 없는 꼴만 따로 막는다. */
  it("네임스페이스 임포트·require 로 우회하지 않는다", () => {
    expect(src).not.toMatch(/import\s+\*\s+as\s+\w+\s+from\s*"(?:node:)?fs/);
    expect(src).not.toMatch(/require\(\s*"(?:node:)?fs/);
  });

  /**
   * ⚠️ 위 둘로도 **`execFileSync("cp", …)`** 는 안 막힌다 — `execFileSync` 는 launchctl 때문에
   *    이미 들어와 있다. 그래서 **실행하는 명령 이름**도 허용 집합으로 잠근다.
   */
  it("외부로 실행하는 명령이 셋뿐이다", () => {
    const cmds = [...src.matchAll(/(?:run|runQuiet|execFileSync)\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(cmds)).toEqual(new Set(["launchctl", "systemctl", "loginctl"]));
  });
});

/**
 * 🔴 **이 두 문구는 소비처의 판별자다 — 문면이 계약이다.**
 *
 * briefick 화면은 설치형 사용자의 판을 `--version` **하나로** 가른다(2026-09-22, 탐침 두 줄을
 * 지우고 이것으로 대체). 판별은 **오류 문구**로 한다:
 *
 * ```
 * 판을 찍는다          → 그게 답
 * 「알 수 없는 명령」   → 0.5.0 미만        (npm 10판 + 설치형 v0.4.0 = 11판 실측)
 * 「판을 읽지 못했다」  → **설치형 0.5.1**   유일 — npm 0.5.1 은 판을 찍는다
 * 어디에도 안 맞음      → 미분류. 추측하지 않고 갈아끼우게 한다
 * ```
 *
 * ⚠️ 이 문구를 바꾸면 **남의 레포 화면이 조용히 판을 못 가른다.** 그쪽 설계가 오답 대신
 * 「미분류」로 떨어지게 돼 있어 **틀린 답은 안 나오지만**, 판별 능력은 사라진다.
 * 📌 이 검사는 그 사실을 **이 레포 안에 둔다** — 바꿔야 할 이유가 생기면 여기서 걸리고,
 *    그때 briefick 에 알리면 된다. 검사가 없으면 **바뀐 줄도 모른다.**
 *
 * 🔵 사본을 합칠 수 없는 자리다(문구는 여기, 판별은 저기). 그래서 **둘이 딛고 선 바닥**을
 *    잠근다 — `#8` 에서 `install.ts` 에 한 것과 같은 수다.
 */
describe("판 판별 문구는 소비처와의 계약이다", () => {
  const src = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  const 모르는명령 = "알 수 없는 명령: ";
  const 판못읽음 = "판을 읽지 못했다 — 이 실행본 안에서 package.json 을 찾을 수 없다.";

  it("두 문구가 소스에 그대로 있다", () => {
    expect(src).toContain(모르는명령);
    expect(src).toContain(판못읽음);
  });

  /**
   * ⚠️ 한쪽이 다른 쪽을 품으면 **부분 일치로 가르는 소비처가 오분류**한다.
   * 🔴 **소스에서 뽑아 비교한다.** 앞 판은 이 파일에 적어 둔 상수 둘을 서로 비교했는데,
   *    그건 **동어반복**이라 소스를 어떻게 바꿔도 초록이었다(개악 실측: 한쪽이 다른 쪽을
   *    품게 만들어도 81 통과). 검사가 자기 자신을 재고 있었다.
   */
  it("실제로 내는 두 문구가 서로를 안 품는다", async () => {
    const err: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m?: unknown) => { err.push(String(m)); });
    await main(["아무도-모르는-명령"]);
    const 실제모르는명령 = err.join("\n").split("\n")[0];
    spy.mockRestore();

    // 「판을 읽지 못했다」 쪽은 소스에서 뽑는다 — 이 경로는 SEA 에서만 걸린다
    // ⚠️ `[^"]*` 로 뽑으면 소스의 **이스케이프(`\\n`)까지** 딸려 와 런타임 문자열과 달라진다
    //    ⇒ 포함 검사가 **영원히 false** 라 동어반복이 된다(개악으로 확인). 역슬래시에서 끊는다.
    const m = src.match(/"(판을 읽지 못했다[^"\\]*)/);
    expect(m).not.toBeNull();
    const 실제판못읽음 = m![1];

    expect(실제모르는명령).toContain("알 수 없는 명령");
    expect(실제모르는명령.includes(실제판못읽음)).toBe(false);
    expect(실제판못읽음.includes(실제모르는명령)).toBe(false);
  });

  /** 🔴 **실제로 그 문구를 내는지**까지 본다 — 소스에 있는 것과 나오는 것은 다르다. */
  it("모르는 명령이 그 문구로 죽는다", async () => {
    const err: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m?: unknown) => { err.push(String(m)); });
    const code = await main(["아무도-모르는-명령"]);
    spy.mockRestore();
    expect(code).toBe(1);
    expect(err.join("\n")).toContain(모르는명령);
  });
});

/**
 * 🔴 **출력만 잠그면 「도달 못 하는 문자열」이 남는다.**
 *
 * 배포된 `v0.5.2` 바이너리에 `@^0.4.0` 이 **1회 남아 있습니다**(metapass-saas 가 `strings` 로
 * 계수). 그 판은 판을 박아 뒀으므로 그 메시지 경로로 안 떨어지고, 실제로 `--version`·`--help`·
 * 모르는 명령 **세 경로에서 0회**입니다. ⇒ **존재하지만 도달 못 한다**이지 «없다»가 아닙니다.
 *
 * ⚠️ 그러면 출력 검사만으로는 *"고쳤는데 다음 판에도 들어 있다"* 가 됩니다 — 도달 경로가
 * 막혀 있는 동안 문자열이 조용히 따라갑니다. ⇒ **소스 리터럴도 본다.**
 *
 * 📌 주석은 뗀다 — 이 규칙의 **내력을 적는 것**까지 막으면 안 된다(`#8` 에서 같은 함정을 밟았다).
 */
describe("src/ 전체의 문자열에 범위 스펙이 없다", () => {
  /**
   * ⚠️ **처음엔 `cli.ts` 하나만 읽었다.** 그런데 describe 이름은 「사용자에게 나가는 문자열」이었다 —
   *    **이름이 범위보다 넓었다.** 사용자에게 말하는 파일은 둘이다(`cli.ts` · `daemon.ts` 의 audit 줄).
   *    개악 실측(metapass-saas): `daemon.ts` 에 범위 스펙을 넣어도 **85 통과**였다.
   * 📌 이 팀이 오늘 세운 규칙의 자기 사례다 — ***이름이 표본보다 좁아도 안 되고 넓어도 안 된다.***
   * ⇒ 「어느 파일이 사용자에게 말하는가」를 목록으로 들고 있으면 **그 목록이 새 사본**이 된다.
   *   `src/` 전수로 본다 — 파일이 늘어도 검사가 따라간다.
   */
  const 주석뗀 = (f: string) =>
    readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

  const 소스파일 = readdirSync(new URL("../src/", import.meta.url)).filter((f) => f.endsWith(".ts"));

  it("src/ 에 .ts 가 여럿이다 — 목록이 비면 이 검사는 공허하다", () => {
    expect(소스파일.length).toBeGreaterThan(1);
  });

  it.each(소스파일)("%s 의 문자열에 `@^`·`@~` 가 없다", (f) => {
    expect(주석뗀(f)).not.toMatch(/@[\^~]\d/);
  });

  it("도움말 출력에도 없다", async () => {
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => { out.push(String(m)); });
    await main(["--help"]);
    spy.mockRestore();
    expect(out.join("\n")).not.toMatch(/@[\^~]\d/);
  });
});

/**
 * 🔴 **SEA 에서는 진입 가드가 유일한 시작점이고, 그게 `argv[1]` 을 cwd 기준으로 풀었다.**
 *
 * 실측 2026-09-23 (pmvm-02 · 설치형 0.5.2 · PATH 등록됨):
 * ```
 * cd <bin> && metapass-agent --version   0.5.2
 * cd /tmp  && <전체경로>     --version   0.5.2
 * cd /tmp  && metapass-agent --version   **빈 출력 · exit 0**   ← 정상 사용법이 안 됐다
 * ```
 * ⚠️ 못 잡은 이유: 우리 측정이 전부 **전체 경로**였다(`install.sh` 출력·화면 안내·다른 세션 검증).
 *    ⇒ **재는 자리가 사용자의 자리와 달랐다.**
 *
 * 📌 이 검사는 **선언**만 잰다 — 「SEA 면 항상 돈다」가 소스에 있는가. 「실제로 도는가」는
 *    SEA 를 빌드해 **빈 디렉터리에서 이름으로** 불러야 알고, 그건 `release-binaries.yml` 의
 *    게이트가 할 일이다(아래 검사와 짝).
 */
describe("SEA 진입 가드는 argv 에 기대지 않는다", () => {
  const src = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");

  it("SEA 면 argv 와 무관하게 main 을 부른다", () => {
    expect(src).toContain("isSeaBinary()");
    // 가드가 `isSeaBinary() ||` 로 시작해야 argv 조건이 **그것을 못 막는다**
    expect(src).toMatch(/if \(isSeaBinary\(\) \|\|/);
  });

  it("node:sea 로 판정한다 — 경로 비교로 흉내 내지 않는다", () => {
    expect(src).toContain('req("node:sea")');
  });
});
