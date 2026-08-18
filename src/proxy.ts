/**
 * 로컬 MCP 프록시(방식 b) — Claude Code(MCP 클라이언트)는 **고정 Authorization 헤더**만 지원하는데
 * 위임 세션 bearer는 짧은 TTL로 갱신된다. 이 프록시를 localhost에 띄우면:
 *
 *   Claude Code ──(고정 헤더, localhost)──▶ 이 프록시 ──(최신 bearer 주입)──▶ RP /api/mcp
 *
 * Claude Code는 이 프록시를 MCP로 등록만 하면 헤더 갱신을 신경 쓸 필요가 없다. 프록시는 **투명 포워딩**
 * (메서드·경로·본문·헤더·응답 스트림 그대로 — SSE 포함)하되, `Authorization`만 현재 bearer로 덮어쓴다.
 * 위임 만료/철회 시 RP가 401/거부를 내면 프록시는 그대로 전달한다(자체 판단 안 함).
 *
 * 보안: 기본 `127.0.0.1` 바인딩(로컬 전용). bearer를 주입하는 프록시를 네트워크에 노출하지 않는다.
 */
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

/** bearer()만 제공하면 됨 — AgentAuth를 그대로 넘기거나 테스트용 스텁 가능. */
export interface BearerSource {
  bearer(): string;
}

export interface ProxyOptions {
  auth: BearerSource;
  /** 포워딩 대상 MCP URL (예: https://briefick.cplabs.io/api/mcp). */
  targetMcpUrl: string;
  port?: number;
  host?: string;
}

export interface RunningProxy {
  /** Claude Code에 등록할 URL (예: http://127.0.0.1:8787/mcp). */
  url: string;
  port: number;
  close(): Promise<void>;
}

const HOP_BY_HOP = new Set(["host", "connection", "authorization", "keep-alive", "proxy-authorization"]);

export function startProxy(opts: ProxyOptions): Promise<RunningProxy> {
  const target = new URL(opts.targetMcpUrl);
  const upstream = target.protocol === "https:" ? https : http;
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 8787;

  const server = http.createServer((creq, cres) => {
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(creq.headers)) {
      if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
    }
    headers["host"] = target.host;
    headers["authorization"] = `Bearer ${opts.auth.bearer()}`; // 최신 bearer 주입

    const preq = upstream.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        method: creq.method,
        headers,
      },
      (pres) => {
        cres.writeHead(pres.statusCode ?? 502, pres.headers);
        pres.pipe(cres); // 응답 스트림 그대로(JSON·SSE 모두)
      },
    );
    preq.on("error", (e) => {
      if (!cres.headersSent) cres.writeHead(502, { "content-type": "application/json" });
      cres.end(JSON.stringify({ error: "proxy_upstream_error", message: String(e) }));
    });
    creq.pipe(preq); // 요청 본문 그대로
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = addr && typeof addr === "object" ? addr.port : port;
      resolve({
        url: `http://${host}:${actualPort}/mcp`,
        port: actualPort,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
