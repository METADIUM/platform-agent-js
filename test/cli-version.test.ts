import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * 🔴 **`--version` 이 침묵할 수 있었다**(briefick PR #5 리뷰).
 *
 * 초안은 `package.json` 을 못 읽으면 `"unknown"` 을 찍고 **exit 0** 이었다:
 * ```
 * $ metapass-agent --version
 * unknown          ← exit 0
 * ```
 * ⚠️ 이 변경의 전제가 «침묵이 위험하다» 인데 **그 침묵을 없애러 만든 명령이 침묵**했다.
 * 「0.4.0 이상 필요」를 읽고 확인하러 온 사람이 `unknown` + 성공 종료를 받으면 **확인했다고
 * 믿는다.** 스크립트도 그 값을 받는다.
 *
 * 📌 그리고 그 분기가 **실제로 걸릴 자리**가 있다 — SEA 단일 바이너리에서 `import.meta.url`
 * 기준 상대경로가 안 설 수 있고, 그게 하필 **`--version` 이 가장 필요한 경로**다
 * (npx 사용자는 명령에 박힌 핀으로 판을 이미 안다).
 *
 * ⚠️ 이 파일이 별도인 이유: `node:fs` 를 모킹해야 하는데 `vi.mock` 은 **모듈 단위**라
 * 다른 검사들과 같은 파일에 둘 수 없다.
 */
vi.mock("node:fs", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readFileSync: vi.fn(),
}));

import { readFileSync } from "node:fs";
import { main } from "../src/cli.js";

const mockRead = vi.mocked(readFileSync);

/**
 * 🔴 **빌드 때 박은 판이 파일보다 먼저다** — SEA 단일 바이너리에는 읽을 `package.json` 이
 *    없어서 `v0.5.1` 바이너리가 `--version` 에 exit 1 을 냈다(New-Platform 실측).
 *    그 자리가 하필 `--version` 이 가장 필요한 곳이다: npx 사용자는 명령의 핀으로 알지만
 *    **설치형 사용자는 재설치 말고 확인할 방법이 없었다.**
 *
 * ⚠️ 이 검사는 «파일을 못 읽는 상태»에서 돈다(`node:fs` 모킹). 그런데도 판을 말해야 한다 —
 *    그게 SEA 의 조건이다. 박은 값이 무시되면 여기서 빨개진다.
 * 📌 다만 이건 **선언 경로**만 잰다(전역이 있으면 쓰는가). 「빌드가 실제로 박는가」는
 *    여기서 못 잰다 — 그건 `release-binaries.yml` 의 게이트가 바이너리를 **돌려서** 잰다.
 */
describe("빌드 때 박은 판", () => {
  let out: string[];
  beforeEach(() => {
    vi.clearAllMocks();
    out = [];
    vi.spyOn(console, "log").mockImplementation((m?: unknown) => { out.push(String(m)); });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as Record<string, unknown>).__AGENT_VERSION__;
  });

  it("파일을 못 읽어도 박은 판을 말한다", async () => {
    mockRead.mockImplementation(() => { throw new Error("SEA: no package.json"); });
    (globalThis as Record<string, unknown>).__AGENT_VERSION__ = "9.9.9";
    const code = await main(["--version"]);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("9.9.9");
  });

  it("빈 문자열은 박힌 것으로 치지 않는다 — 파일로 내려간다", async () => {
    mockRead.mockImplementation(() => { throw new Error("SEA: no package.json"); });
    (globalThis as Record<string, unknown>).__AGENT_VERSION__ = "";
    const code = await main(["--version"]);
    expect(code).toBe(1);   // 박힌 것도 없고 파일도 못 읽으면 «못 읽었다»가 맞다
  });
});

describe("--version 은 못 읽으면 못 읽었다고 말한다", () => {
  let out: string[];
  let err: string[];
  beforeEach(() => {
    vi.clearAllMocks();
    out = []; err = [];
    vi.spyOn(console, "log").mockImplementation((m?: unknown) => { out.push(String(m)); });
    vi.spyOn(console, "error").mockImplementation((m?: unknown) => { err.push(String(m)); });
  });
  afterEach(() => vi.restoreAllMocks());

  it("🔴 package.json 을 못 읽으면 **실패**한다 — `unknown` + exit 0 이 아니다", async () => {
    mockRead.mockImplementation(() => { throw new Error("ENOENT"); });
    const code = await main(["--version"]);
    expect(code).toBe(1);                       // ← 종전 초안은 0 이었다
    expect(out).toEqual([]);                    // 판을 찍지 않는다
    expect(err.join("\n")).toMatch(/판을 읽지 못했다/);
  });

  it("🔴 version 필드가 없어도 **실패**한다 — 빈 값을 판으로 내놓지 않는다", async () => {
    mockRead.mockReturnValue(JSON.stringify({ name: "x" }) as never);
    expect(await main(["--version"])).toBe(1);
    expect(out).toEqual([]);
  });

  it("🟢 대조군 — 읽히면 그 값을 찍고 0", async () => {
    mockRead.mockReturnValue(JSON.stringify({ version: "9.9.9" }) as never);
    expect(await main(["--version"])).toBe(0);
    expect(out).toEqual(["9.9.9"]);
  });
});
