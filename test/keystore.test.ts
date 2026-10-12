import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync, chmodSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { AgentKey } from "../src/key.js";
import {
  defaultKeyFile,
  loadStore,
  saveStore,
  openStore,
  loadKeychainStore,
  saveKeychainStore,
  type ExecFn,
  type KeyStore,
} from "../src/keystore.js";

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

  it("느슨한 권한(0644)이면 로드 거부 — chmod 안내", async () => {
    const file = tmp();
    const key = await AgentKey.generate();
    saveStore(file, { privateJwk: key.exportPrivateJwk() });
    chmodSync(file, 0o644);
    expect(() => loadStore(file)).toThrow(/chmod 600/);
  });

  it("덮어쓰기 시에도 0600 보정(기존 모드 유지 방지)", async () => {
    const file = tmp();
    const key = await AgentKey.generate();
    saveStore(file, { privateJwk: key.exportPrivateJwk() });
    chmodSync(file, 0o644);
    saveStore(file, { privateJwk: key.exportPrivateJwk() });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

/** 가짜 키체인 — security/secret-tool 계약(인자·stdin·종료코드)을 흉내낸다. */
function fakeKeychain(): { exec: ExecFn; secrets: Map<string, string> } {
  const secrets = new Map<string, string>();
  const exec: ExecFn = (cmd, args, input) => {
    if (cmd === "security") {
      if (args[0] === "add-generic-password") {
        secrets.set("metapass-agent", args[args.indexOf("-w") + 1]);
        return { status: 0, stdout: "", stderr: "" };
      }
      const v = secrets.get("metapass-agent");
      return v ? { status: 0, stdout: v + "\n", stderr: "" } : { status: 44, stdout: "", stderr: "not found" };
    }
    if (cmd === "secret-tool") {
      if (args[0] === "store") {
        secrets.set("metapass-agent", input ?? "");
        return { status: 0, stdout: "", stderr: "" };
      }
      const v = secrets.get("metapass-agent");
      return v ? { status: 0, stdout: v, stderr: "" } : { status: 1, stdout: "", stderr: "" };
    }
    return { status: null, stdout: "", stderr: "" };
  };
  return { exec, secrets };
}

describe("keychain 백엔드", () => {
  it("darwin(security) save→load 라운드트립, 미존재는 null", async () => {
    const { exec } = fakeKeychain();
    const key = await AgentKey.generate();
    const opts = { exec, platform: "darwin" as const };
    expect(loadKeychainStore(opts)).toBeNull();
    saveKeychainStore({ privateJwk: key.exportPrivateJwk(), registrations: { "https://a": true } }, opts);
    const loaded = loadKeychainStore(opts);
    expect(loaded?.registrations?.["https://a"]).toBe(true);
    expect((await AgentKey.fromPrivateJwk(loaded!.privateJwk)).did).toBe(key.did);
  });

  it("linux(secret-tool) — 비밀값은 stdin으로 전달", async () => {
    const { exec, secrets } = fakeKeychain();
    const key = await AgentKey.generate();
    const opts = { exec, platform: "linux" as const };
    const data: KeyStore = { privateJwk: key.exportPrivateJwk() };
    saveKeychainStore(data, opts);
    expect(secrets.get("metapass-agent")).toBe(JSON.stringify(data));
    expect(loadKeychainStore(opts)?.privateJwk.x).toBe(key.publicJwk.x);
  });

  it("도구 미설치(status null) → 안내 예외", () => {
    const exec: ExecFn = () => ({ status: null, stdout: "", stderr: "" });
    expect(() => loadKeychainStore({ exec, platform: "darwin" })).toThrow(/찾을 수 없습니다/);
  });

  it("openStore — 미지원 플랫폼 keychain 조기 거부, file 기본", () => {
    expect(() => openStore({ backend: "keychain", platform: "win32" })).toThrow(/미지원 플랫폼/);
    const s = openStore({ keyFile: tmp() });
    expect(s.backend).toBe("file");
    expect(s.load()).toBeNull();
  });
});

/** A store that exists but can't be read must never be answered with a new key (that replaces the agent's identity). */
describe("an unreadable key store is refused, never regenerated (metapass-saas F3, #44)", () => {
  const broken: [string, string][] = [
    ["a half-written file", '{"privateJwk":{"kty":"EC","crv":"P-256","x":"ab'],
    ["an empty file", ""],
    ["JSON without a key", '{"credentials":{}}'],
  ];

  it.each(broken)("file backend: %s — `did` fails and the file is left as it was", async (_name, content) => {
    const file = tmp();
    writeFileSync(file, content, { mode: 0o600 });
    const { main } = await import("../src/cli.js");
    await expect(main(["did", "--key-file", file])).rejects.toThrow(/새 키를 만들지 않습니다/);
    expect(readFileSync(file, "utf8"), "the unreadable file was overwritten").toBe(content);
  });

  it("keychain backend: an unparsable item is refused, not read as «no key»", () => {
    const exec: ExecFn = () => ({ status: 0, stdout: "not json", stderr: "" });
    expect(() => loadKeychainStore({ exec, platform: "darwin" })).toThrow(/새 키를 만들지 않습니다/);
  });

  it("a missing store is still «no key yet»", () => {
    expect(loadStore(tmp())).toBeNull();
  });

  it("save replaces the file whole and leaves no temp file behind", async () => {
    const file = tmp();
    const key = await AgentKey.generate();
    saveStore(file, { privateJwk: key.exportPrivateJwk() });
    saveStore(file, { privateJwk: key.exportPrivateJwk(), credentials: { a: "b" } });
    expect(loadStore(file)?.credentials).toEqual({ a: "b" });
    expect(readdirSync(join(file, "..")), "a temp file was left beside the key").toEqual(["key.json"]);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
