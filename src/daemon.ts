/**
 * 멀티 RP 데몬(doc26 §2-1·§2-5) — 한 프로세스·한 포트에서 RP별 경로 라우팅:
 *
 *   Claude Code ──▶ 127.0.0.1:<port>/<alias>/mcp ──▶ RP MCP (해당 RP bearer 주입)
 *
 * - **로컬 인증 토큰 필수**: `GET /healthz`("다운 vs 인증 실패" 구분용, `{"status":"up"}`뿐)를
 *   제외한 모든 요청이 `Authorization: Bearer <proxy-token>` 필요(상수시간 비교, 불일치 401).
 * - **RP 간 교차사용 불가**: alias별 bearer(=RP별 세션, PoP/KB-JWT aud가 RP 바인딩)를 주입 —
 *   briefick용 자격이 minipaas 경로로 새지 않는다.
 * - RP가 1개뿐이면 루트 `/mcp`도 그 RP로 라우팅(기존 등록 하위호환). 2개 이상이면 루트는 410.
 * - 감사 로그: 시각·alias·JSON-RPC 메서드 — 로컬에서도 "누가 언제 무엇을" 추적(토큰 도용 대조).
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { timingSafeEqual } from "node:crypto";
import { URL } from "node:url";
import type { BearerSource } from "./proxy.js";

export interface DaemonTarget {
  alias: string;
  /** 포워딩 대상 MCP URL (예: https://briefick.cplabs.io/api/mcp). */
  targetMcpUrl: string;
  /** null = 위임 미확보(대기 중) — 해당 경로는 503 + 안내. */
  auth: BearerSource | null;
  /** auth가 null일 때 503 본문에 실을 사유. */
  pendingReason?: string;
}

export interface DaemonOptions {
  targets: DaemonTarget[];
  /** 로컬 인증 토큰(필수) — proxy-token 파일 값. */
  token: string;
  /** 미지정 시 8787부터 빈 포트 자동 배정. */
  port?: number;
  host?: string;
  /** 감사 로그 싱크(기본 stderr). */
  audit?: (line: string) => void;
}

export interface RunningDaemon {
  port: number;
  /** alias → Claude Code 등록 URL. */
  urls: Record<string, string>;
  close(): Promise<void>;
}

const HOP_BY_HOP = new Set(["host", "connection", "authorization", "keep-alive", "proxy-authorization"]);
const MAX_BODY = 2 * 1024 * 1024; // MCP 요청은 JSON — 감사(메서드 추출)를 위해 버퍼링

function tokenOk(expected: string, header: string | undefined): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const got = Buffer.from(header.slice(7));
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** 요청 본문을 읽기 전에 조기 응답(401/503 등)할 때 클라이언트가 본문 전송 중 리셋을 겪지 않게 드레인. */
function drainAnd(creq: http.IncomingMessage, respond: () => void): void {
  creq.resume();
  respond();
}

export function startDaemon(opts: DaemonOptions): Promise<RunningDaemon> {
  const host = opts.host ?? "127.0.0.1";
  const audit = opts.audit ?? ((line: string) => console.error(line));
  const byAlias = new Map(opts.targets.map((t) => [t.alias, t]));

  const server = http.createServer((creq, cres) => {
    const path = (creq.url ?? "/").split("?")[0];
    if (creq.method === "GET" && path === "/healthz") {
      // 무토큰 — "데몬 다운(ConnectionRefused)" vs "인증 실패(401)" 구분용. 정보 없음.
      return json(cres, 200, { status: "up" });
    }
    if (!tokenOk(opts.token, creq.headers.authorization)) {
      return drainAnd(creq, () => json(cres, 401, { error: "unauthorized", hint: "proxy-token 필요 — `status`가 등록 명령을 출력합니다" }));
    }

    // 라우팅: /<alias>/mcp… 또는 (RP 1개일 때) /mcp…
    let target: DaemonTarget | undefined;
    let rest = "";
    const m = path.match(/^\/([^/]+)\/mcp(\/.*)?$/);
    if (m && byAlias.has(m[1])) {
      target = byAlias.get(m[1]);
      rest = m[2] ?? "";
    } else if (/^\/mcp(\/.*)?$/.test(path)) {
      if (opts.targets.length === 1) {
        target = opts.targets[0];
        rest = path.slice("/mcp".length);
      } else {
        return drainAnd(creq, () => json(cres, 410, {
          error: "ambiguous_root",
          message: "RP가 여러 개입니다 — /<alias>/mcp 경로로 재등록하세요 (`status`가 명령을 출력)",
          aliases: opts.targets.map((t) => t.alias),
        }));
      }
    }
    if (!target) {
      return drainAnd(creq, () => json(cres, 404, { error: "unknown_path", aliases: opts.targets.map((t) => t.alias) }));
    }
    if (!target.auth) {
      return drainAnd(creq, () => json(cres, 503, {
        error: "delegation_pending",
        alias: target.alias,
        message: target.pendingReason ?? "위임 미확보 — 지갑에서 승인 필요(`status` 참고)",
      }));
    }

    // 요청 본문 버퍼링(작은 JSON) — 감사 로그에 JSON-RPC 메서드 기록 후 포워딩
    const chunks: Buffer[] = [];
    let size = 0;
    creq.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        creq.destroy();
        return json(cres, 413, { error: "payload_too_large" });
      }
      chunks.push(c);
    });
    creq.on("end", () => {
      const body = Buffer.concat(chunks);
      let method = creq.method ?? "?";
      try {
        const rpc = JSON.parse(body.toString("utf8")) as { method?: string };
        if (typeof rpc.method === "string") method = rpc.method;
      } catch {
        // 비JSON(GET 등) — HTTP 메서드로 기록
      }
      audit(`[audit] ${new Date().toISOString()} ${target.alias} ${method}`);
      forward(target, rest, creq, cres, body);
    });
  });

  return new Promise((resolve, reject) => {
    const candidates = opts.port !== undefined ? [opts.port] : Array.from({ length: 100 }, (_, i) => 8787 + i);
    let idx = 0;
    const tryListen = async () => {
      if (idx >= candidates.length) return reject(new Error("빈 포트를 찾지 못했습니다(8787~8886)"));
      const port = candidates[idx];
      // 바인드 전 프로브 — macOS에서 기존 리스너가 있어도 listen이 성공으로 보고되고
      // 연결은 기존 프로세스로 가는 함정이 있어(EADDRINUSE 미발생) 실제 연결로 점유를 확인한다.
      if (await portInUse(host, port)) {
        if (opts.port !== undefined) return reject(new Error(`포트 사용 중: ${host}:${port}`));
        idx++;
        return void tryListen();
      }
      server.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE" && opts.port === undefined && ++idx < candidates.length) return void tryListen();
        reject(e);
      });
      server.listen(port, host, () => {
        server.removeAllListeners("error");
        const single = opts.targets.length === 1;
        const urls: Record<string, string> = {};
        for (const t of opts.targets) {
          urls[t.alias] = `http://${host}:${port}${single ? "/mcp" : `/${t.alias}/mcp`}`;
        }
        resolve({ port, urls, close: () => new Promise<void>((r) => server.close(() => r())) });
      });
    };
    void tryListen();
  });
}

/** 포트 점유 프로브 — 연결이 수락되면 점유. 거부/타임아웃이면 빈 포트로 간주. */
function portInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port, timeout: 300 });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
    sock.once("timeout", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

/** 대상 RP로 투명 포워딩 — Authorization만 해당 RP의 최신 bearer로 교체(SSE 응답 스트림 유지). */
function forward(
  target: DaemonTarget,
  restPath: string,
  creq: http.IncomingMessage,
  cres: http.ServerResponse,
  body: Buffer,
): void {
  const url = new URL(target.targetMcpUrl);
  const upstream = url.protocol === "https:" ? https : http;
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(creq.headers)) {
    if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
  }
  headers["host"] = url.host;
  headers["content-length"] = String(body.length);
  try {
    headers["authorization"] = `Bearer ${target.auth!.bearer()}`;
  } catch (e) {
    return json(cres, 503, { error: "bearer_unavailable", alias: target.alias, message: String(e) });
  }

  const preq = upstream.request(
    {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + restPath + url.search,
      method: creq.method,
      headers,
    },
    (pres) => {
      cres.writeHead(pres.statusCode ?? 502, pres.headers);
      pres.pipe(cres);
    },
  );
  preq.on("error", (e) => {
    if (!cres.headersSent) json(cres, 502, { error: "proxy_upstream_error", alias: target.alias, message: String(e) });
  });
  preq.end(body);
}
