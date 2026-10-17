import { describe, it, expect, afterEach } from "vitest";
import { hostname } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, registerLabel, LABEL_MAX } from "../src/cli.js";
import { AgentKey } from "../src/key.js";
import { saveStore } from "../src/keystore.js";
import { fakeVerifier } from "./fake-verifier.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

const RP = "https://briefick.example.com";

/** `add --verifier --code` against a fake verifier and RP; returns the pairing body the RP received. */
async function pairWith(...extra: string[]): Promise<Record<string, unknown>> {
  const d = mkdtempSync(join(tmpdir(), "mpa-label-"));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  const keyFile = join(d, "key.json");
  const key = await AgentKey.generate();
  saveStore(keyFile, { privateJwk: key.exportPrivateJwk() });
  const v = await fakeVerifier("briefick", RP, () => Response.json({ paired: true, agent_fingerprint: key.fingerprint }));
  cleanup.push(v.restore);
  expect(await main(["add", RP, "--verifier", "https://sso.example.com", "--code", "C1", "--key-file", keyFile, ...extra])).toBe(0);
  expect(v.pairs, "pairing 호출 자체가 없다").toHaveLength(1);
  return v.pairs[0];
}

describe("페어링 요청에 표시 이름이 실린다", () => {
  it("기본값은 이 머신의 호스트 이름 — 전선에 실제로 실린다", async () => {
    const body = await pairWith();
    // 값을 «이름»으로 확인한다 — 호스트 이름은 기계마다 달라 리터럴로 못 박는다.
    expect(body.label).toBe(hostname().trim().slice(0, LABEL_MAX));
    expect(body.label, "빈 이름을 보내면 서버 기본 표시보다 나빠진다").toBeTruthy();
  });

  it("--label 이 호스트 이름을 이긴다", async () => {
    const body = await pairWith("--label", "출입리더기-3층");
    expect(body.label).toBe("출입리더기-3층");
    expect(body.label).not.toBe(hostname());
  });

  it("--label= 등호형도 같은 옵션이다", async () => {
    expect((await pairWith("--label=등호형")).label).toBe("등호형");
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
