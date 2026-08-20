/**
 * 에이전트 키 로컬 영속 — 최초 1회 생성 후 재사용(재실행마다 새 did:jwk 방지).
 *
 * 백엔드 2종(`openStore`):
 * - `file`(기본): `~/.metapass-agent/key.json`(파일 0600, 기본 디렉터리 0700).
 *   로드 시 권한 검사 — 소유자 외 접근 가능(0600 아님)이면 ssh처럼 **거부**한다.
 * - `keychain`: OS 자격증명 저장소(macOS Keychain `security` / Linux libsecret `secret-tool`).
 *   평문 파일을 남기지 않는다. 기존 key.json이 있으면 최초 1회 자동 이관.
 *
 * 개인키는 저장소에만 있고 네트워크로 나가지 않는다.
 */
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { JWK } from "jose";

export interface KeyStore {
  /** 에이전트 개인 JWK(ES256/P-256). */
  privateJwk: JWK;
  /** URL별 등록 여부 — 재등록 스킵 판단. */
  registrations?: Record<string, boolean>;
  /** URL별 회수한 위임 VC(SD-JWT VC) — 프록시/세션 재기동 시 재회수 방지. */
  credentials?: Record<string, string>;
}

/** 기본 키 파일 경로. `METAPASS_AGENT_KEY_FILE` 우선. */
export function defaultKeyFile(): string {
  return process.env.METAPASS_AGENT_KEY_FILE || join(homedir(), ".metapass-agent", "key.json");
}

/** 소유자 외 접근 가능한 권한이면 거부(개인키 파일) — Windows는 POSIX 모드가 없어 스킵. */
function assertOwnerOnly(file: string): void {
  if (process.platform === "win32") return;
  const mode = statSync(file).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `키 파일 권한이 안전하지 않습니다: ${file} (0${mode.toString(8)}) — 소유자 외 읽기/쓰기 가능. ` +
        `'chmod 600 ${file}' 후 다시 실행하세요`,
    );
  }
}

export function loadStore(file: string): KeyStore | null {
  if (!existsSync(file)) return null;
  assertOwnerOnly(file);
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as KeyStore;
    return s.privateJwk ? s : null;
  } catch {
    return null;
  }
}

export function saveStore(file: string, store: KeyStore): void {
  // 기본 디렉터리(~/.metapass-agent)는 0700 — 사용자 지정 경로의 상위는 공용 디렉터리(/tmp 등)일 수
  // 있으므로 손대지 않는다(파일 0600으로 내용은 보호됨).
  const dir = dirname(file);
  const isDefaultDir = dir === join(homedir(), ".metapass-agent");
  mkdirSync(dir, { recursive: true, mode: isDefaultDir ? 0o700 : undefined });
  writeFileSync(file, JSON.stringify(store), { mode: 0o600 });
  if (process.platform !== "win32") {
    chmodSync(file, 0o600); // 덮어쓰기는 기존 모드를 유지하므로 항상 보정
    if (isDefaultDir) chmodSync(dir, 0o700); // 구버전(0755)으로 만들어진 기본 디렉터리 보정
  }
}

// ── OS 키체인 백엔드 (macOS security / Linux secret-tool) ──────────────────────

/** 외부 명령 실행 훅 — 테스트에서 가짜 키체인으로 대체 가능. */
export type ExecFn = (
  cmd: string,
  args: string[],
  input?: string,
) => { status: number | null; stdout: string; stderr: string };

const defaultExec: ExecFn = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { input, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

const KEYCHAIN_SERVICE = "metapass-agent";
const KEYCHAIN_ACCOUNT = "default";

export interface KeychainOptions {
  exec?: ExecFn;
  /** 대상 플랫폼(기본 process.platform) — 테스트용. */
  platform?: NodeJS.Platform;
}

function keychainCommands(platform: NodeJS.Platform): {
  load: [string, string[]];
  save: (json: string) => [string, string[], string?];
} {
  if (platform === "darwin") {
    return {
      load: ["security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"]],
      // -U: 있으면 갱신. 비밀값이 argv로 잠깐 노출되는 것은 security CLI의 한계(단일 사용자 머신 전제).
      save: (json) => [
        "security",
        ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", json],
      ],
    };
  }
  if (platform === "linux") {
    return {
      load: ["secret-tool", ["lookup", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT]],
      save: (json) => [
        "secret-tool",
        ["store", `--label=${KEYCHAIN_SERVICE}`, "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT],
        json,
      ],
    };
  }
  throw new Error(`keychain 백엔드 미지원 플랫폼: ${platform} — file 백엔드를 사용하세요`);
}

export function loadKeychainStore(opts: KeychainOptions = {}): KeyStore | null {
  const exec = opts.exec ?? defaultExec;
  const [cmd, args] = keychainCommands(opts.platform ?? process.platform).load;
  const r = exec(cmd, args);
  if (r.status === null) {
    throw new Error(`키체인 도구(${cmd})를 찾을 수 없습니다 — file 백엔드를 사용하거나 도구를 설치하세요`);
  }
  if (r.status !== 0 || !r.stdout.trim()) return null; // 미존재(macOS 44 / secret-tool 1)
  try {
    const s = JSON.parse(r.stdout.trim()) as KeyStore;
    return s.privateJwk ? s : null;
  } catch {
    return null;
  }
}

export function saveKeychainStore(store: KeyStore, opts: KeychainOptions = {}): void {
  const exec = opts.exec ?? defaultExec;
  const [cmd, args, input] = keychainCommands(opts.platform ?? process.platform).save(JSON.stringify(store));
  const r = exec(cmd, args, input);
  if (r.status === null) {
    throw new Error(`키체인 도구(${cmd})를 찾을 수 없습니다 — file 백엔드를 사용하거나 도구를 설치하세요`);
  }
  if (r.status !== 0) {
    throw new Error(`키체인 저장 실패(${cmd} exit ${r.status}): ${r.stderr.trim()}`);
  }
}

// ── 통합 저장소 (CLI가 사용) ─────────────────────────────────────────────────

export type StoreBackendName = "file" | "keychain";

/** 백엔드 중립 저장소 — CLI/라이브러리는 load/save만 호출한다. */
export interface AgentStore {
  backend: StoreBackendName;
  /** 사람이 읽는 위치 표시(안내 메시지용). */
  location: string;
  load(): KeyStore | null;
  save(store: KeyStore): void;
}

export interface OpenStoreOptions {
  /** 미지정 시 env `METAPASS_AGENT_KEY_BACKEND`, 그다음 "file". */
  backend?: string;
  /** file 백엔드 경로(기본 defaultKeyFile()). */
  keyFile?: string;
  exec?: ExecFn;
  platform?: NodeJS.Platform;
}

export function openStore(opts: OpenStoreOptions = {}): AgentStore {
  const name = (opts.backend || process.env.METAPASS_AGENT_KEY_BACKEND || "file") as StoreBackendName;
  if (name === "keychain") {
    const platform = opts.platform ?? process.platform;
    keychainCommands(platform); // 미지원 플랫폼 조기 거부
    const kc: KeychainOptions = { exec: opts.exec, platform };
    return {
      backend: "keychain",
      location:
        platform === "darwin"
          ? `macOS Keychain(${KEYCHAIN_SERVICE})`
          : `libsecret(${KEYCHAIN_SERVICE})`,
      load: () => loadKeychainStore(kc),
      save: (s) => saveKeychainStore(s, kc),
    };
  }
  if (name !== "file") {
    throw new Error(`알 수 없는 키 백엔드: ${name} (file | keychain)`);
  }
  const file = opts.keyFile || defaultKeyFile();
  return {
    backend: "file",
    location: file,
    load: () => loadStore(file),
    save: (s) => saveStore(file, s),
  };
}
