import { describe, it, expect } from "vitest";
import { invocation, helpText } from "../src/cli.js";

const NPX = "npx @metadium-did/platform-agent-js";
const BIN = "/Users/someone/.metapass-agent/bin/metapass-agent";

describe("도움말은 «방금 친 그 호출 형태»로 자기를 부른다", () => {
  it("🔴 설치형(SEA)에서는 npx 를 한 번도 안 말한다 — Node 가 없어서 설치형을 쓰는 사람이다", () => {
    const h = helpText(invocation(true, BIN));
    expect(h).not.toContain("npx");
    expect(h).toContain(`${BIN} up --install`);
    expect(h).toContain(`${BIN} status`);
  });

  it("npx 실행에서는 그대로 npx 를 안내한다", () => {
    const h = helpText(invocation(false, BIN));
    expect(h).toContain(`${NPX} up --install`);
    expect(h).not.toContain(BIN);
  });

  it("두 형태가 «명령 부분»은 글자 그대로 같다 — 접두어만 갈린다", () => {
    const strip = (h: string, inv: string) => h.split("\n").map((l) => l.replace(inv, "«INV»")).join("\n");
    expect(strip(helpText(invocation(true, BIN)), BIN))
      .toBe(strip(helpText(invocation(false, BIN)), NPX));
  });

  it("대조군 — 도움말이 실제로 호출 형태를 여러 번 쓴다(0-기반 공허 단언 방지)", () => {
    const h = helpText(invocation(true, BIN));
    expect(h.split(BIN).length - 1).toBeGreaterThan(5);
  });

  it("invocation: SEA 면 execPath, 아니면 npx", () => {
    expect(invocation(true, BIN)).toBe(BIN);
    expect(invocation(false, BIN)).toBe(NPX);
  });
});
