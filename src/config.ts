/**
 * 데몬 설정(agent.json)과 로컬 인증 토큰(proxy-token) — doc26 §2-2·§2-5.
 *
 * - `agent.json` — 비밀 아님: `{port?, rps:[{alias,url,mcpPath?}]}`. port는 최초 `up`이
 *   자동 배정(8787부터 빈 포트) 후 고정 — 다중 계정 서버에서 사용자별 포트가 자연히 갈린다.
 * - `proxy-token` — 비밀(0600): 데몬의 모든 요청이 요구하는 로컬 Bearer. 같은 호스트의
 *   다른 계정/프로세스가 에이전트 권한(위임)을 도용하는 경로를 차단한다.
 *   **비밀은 argv·유닛 env에 싣지 않는다** — 항상 이 파일에서 런타임에 읽는다.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface DaemonRp {
  alias: string;
  url: string;
  /** RP MCP 경로 (기본 /api/mcp). */
  mcpPath?: string;
}

export interface DaemonConfig {
  /** 최초 up이 배정한 리슨 포트(이후 고정). */
  port?: number;
  rps: DaemonRp[];
}

/** 설정 디렉터리 = 키 파일과 같은 곳 (기본 ~/.metapass-agent). */
export function configDir(keyFile: string): string {
  return dirname(keyFile);
}

function configFile(dir: string): string {
  return join(dir, "agent.json");
}

function tokenFile(dir: string): string {
  return join(dir, "proxy-token");
}

export function loadConfig(dir: string): DaemonConfig {
  const path = configFile(dir);
  if (!existsSync(path)) return { rps: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as DaemonConfig;
  return { port: parsed.port, rps: Array.isArray(parsed.rps) ? parsed.rps : [] };
}

export function saveConfig(dir: string, cfg: DaemonConfig): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(configFile(dir), JSON.stringify(cfg, null, 2) + "\n");
}

/** URL 호스트 첫 라벨 → alias (`briefick.cplabs.io` → `briefick`). */
export function aliasFromUrl(url: string): string {
  const host = new URL(url).hostname;
  return host.split(".")[0].toLowerCase().replace(/[^a-z0-9-]/g, "");
}

/**
 * 로컬 토큰 확보 — 없으면 32B 생성(0600). POSIX에서 그룹/기타 읽기 권한이 열려 있으면
 * **기동 거부(fail-closed)** — 토큰이 방어 수단이므로 권한이 전제다(doc26 §2-5).
 */
export function ensureToken(dir: string): string {
  const path = tokenFile(dir);
  if (existsSync(path)) {
    assertOwnerOnly(path);
    return readFileSync(path, "utf8").trim();
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  writeFileSync(path, token + "\n", { mode: 0o600 });
  return token;
}

/** 토큰 회전 — 새 토큰 저장 후 반환. ⚠ 데몬당 1개라 회전 즉시 전 RP의 MCP 등록이 401. */
export function rotateToken(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  writeFileSync(tokenFile(dir), token + "\n", { mode: 0o600 });
  chmodSync(tokenFile(dir), 0o600);
  return token;
}

/** POSIX 소유자 전용 권한 강제 — 비POSIX(Windows)는 통과. */
export function assertOwnerOnly(path: string): void {
  if (process.platform === "win32") return;
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `권한 거부(fail-closed): ${path} 가 소유자 전용이 아닙니다(현재 ${mode.toString(8)}) — ` +
        `chmod 600 "${path}" 후 다시 실행하세요`,
    );
  }
}

/** 설치된 MCP 등록 명령 안내(토큰 포함) — 사용자는 복사-실행만. */
export function mcpAddCommand(alias: string, port: number, token: string, single: boolean): string {
  const path = single ? "/mcp" : `/${alias}/mcp`;
  return `claude mcp add --transport http ${alias} http://127.0.0.1:${port}${path} --header "Authorization: Bearer ${token}"`;
}
