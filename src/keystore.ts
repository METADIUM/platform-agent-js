/**
 * 에이전트 키 로컬 영속 — 최초 1회 생성 후 재사용(재실행마다 새 did:jwk 방지).
 * 기본 경로 `~/.metapass-agent/key.json`(권한 0600). `--key-file` 또는 `METAPASS_AGENT_KEY_FILE`로 재정의.
 * 개인키는 이 파일에만 있고 네트워크로 나가지 않는다.
 */
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { JWK } from "jose";

export interface KeyStore {
  /** 에이전트 개인 JWK(ES256/P-256). */
  privateJwk: JWK;
  /** URL별 등록 여부 — 재등록 스킵 판단. */
  registrations?: Record<string, boolean>;
}

/** 기본 키 파일 경로. `METAPASS_AGENT_KEY_FILE` 우선. */
export function defaultKeyFile(): string {
  return process.env.METAPASS_AGENT_KEY_FILE || join(homedir(), ".metapass-agent", "key.json");
}

export function loadStore(file: string): KeyStore | null {
  if (!existsSync(file)) return null;
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as KeyStore;
    return s.privateJwk ? s : null;
  } catch {
    return null;
  }
}

export function saveStore(file: string, store: KeyStore): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(store), { mode: 0o600 });
}
