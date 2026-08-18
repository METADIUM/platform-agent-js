import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { AgentKey } from "../src/key.js";
import { defaultKeyFile, loadStore, saveStore } from "../src/keystore.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mpa-ks-"));
  dirs.push(d);
  return join(d, "key.json");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.METAPASS_AGENT_KEY_FILE;
});

describe("keystore (키 영속)", () => {
  it("save→load 라운드트립 + 같은 did:jwk 복원", async () => {
    const file = tmp();
    const key = await AgentKey.generate();
    saveStore(file, { privateJwk: key.exportPrivateJwk(), registrations: { "https://a": true } });

    const loaded = loadStore(file);
    expect(loaded?.registrations?.["https://a"]).toBe(true);
    const back = await AgentKey.fromPrivateJwk(loaded!.privateJwk);
    expect(back.did).toBe(key.did); // 재실행 시 같은 에이전트
  });

  it("파일 권한 0600(개인키 보호)", async () => {
    const file = tmp();
    const key = await AgentKey.generate();
    saveStore(file, { privateJwk: key.exportPrivateJwk() });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("없는 파일 → null", () => {
    expect(loadStore(tmp())).toBeNull();
  });

  it("defaultKeyFile — env 우선, 기본은 ~/.metapass-agent/key.json", () => {
    expect(defaultKeyFile()).toBe(join(homedir(), ".metapass-agent", "key.json"));
    process.env.METAPASS_AGENT_KEY_FILE = "/tmp/x/y.json";
    expect(defaultKeyFile()).toBe("/tmp/x/y.json");
  });
});
