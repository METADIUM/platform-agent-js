/**
 * platform-agent CLI — 레포 clone 없이 `npx`로 에이전트 등록/세션.
 *
 *   npx @metadium-did/platform-agent-js register --url <BRIEFICK_URL> --code <PAIRING_CODE>
 *   npx @metadium-did/platform-agent-js did          # 이 에이전트 did:jwk 출력
 *   npx @metadium-did/platform-agent-js session --url <BRIEFICK_URL>   # 위임 세션 bearer 1회 발급
 *
 * 키는 `~/.metapass-agent/key.json`에 영속 → **최초 1회만 등록, 이후 재사용**. `--url`/`--code`는
 * 환경변수 `BRIEFICK_URL`/`PAIRING_CODE`로도 대체 가능.
 */
import { AgentKey } from "./key.js";
import { BriefickAgentClient } from "./briefick.js";
import { AgentAuth } from "./agent.js";
import { startProxy } from "./proxy.js";
import { defaultKeyFile, loadStore, saveStore, type KeyStore } from "./keystore.js";

interface Args {
  cmd?: string;
  url?: string;
  code?: string;
  keyFile: string;
  force: boolean;
  port?: number;
  mcpPath?: string;
}

function parse(argv: string[]): Args {
  const out: Args = { keyFile: "", force: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") out.url = argv[++i];
    else if (a === "--code") out.code = argv[++i];
    else if (a === "--key-file") out.keyFile = argv[++i];
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--mcp-path") out.mcpPath = argv[++i];
    else if (a === "--force") out.force = true;
    else if (a === "-h" || a === "--help") out.cmd = "help";
    else rest.push(a);
  }
  out.cmd ??= rest[0];
  out.url ??= process.env.BRIEFICK_URL;
  out.code ??= process.env.PAIRING_CODE;
  out.keyFile ||= defaultKeyFile();
  return out;
}

async function keyFrom(file: string): Promise<{ key: AgentKey; store: KeyStore; created: boolean }> {
  const existing = loadStore(file);
  if (existing?.privateJwk) {
    return { key: await AgentKey.fromPrivateJwk(existing.privateJwk), store: existing, created: false };
  }
  const key = await AgentKey.generate();
  const store: KeyStore = { privateJwk: key.exportPrivateJwk(), registrations: {} };
  saveStore(file, store);
  return { key, store, created: true };
}

/** 위임 VC 확보 — 저장돼 있으면 재사용, 없으면 회수(지갑 승인 대기) 후 저장. */
async function ensureCredential(
  client: BriefickAgentClient,
  store: KeyStore,
  url: string,
  keyFile: string,
  key: AgentKey,
): Promise<string> {
  const stored = store.credentials?.[url];
  if (stored) return stored;
  console.error("위임 VC 회수 대기(지갑에서 승인 필요)…");
  // RP retrieve의 세분화 신호(no_request / pending+lastRequest)로 안내를 분기 — 무음 pending 조기 감지.
  const cred = await client.waitForDelegation({
    timeoutMs: 180_000,
    onStatus: (r) => {
      if (r.status === "no_request") {
        console.error(
          `  아직 이 에이전트(지문 ${key.fingerprint}) 대상 위임 요청이 없습니다 — ` +
            "Briefick /publish에서 지문을 대조해 위임을 발급하세요",
        );
      } else if (r.status === "pending" && r.lastRequest) {
        console.error(
          `  위임 요청 확인(nonce ${r.lastRequest.nonce ?? "?"}, 만료 ${r.lastRequest.expiresAt ?? "?"}) — 지갑 승인·전달 대기…`,
        );
      }
    },
  });
  store.credentials = { ...(store.credentials ?? {}), [url]: cred };
  saveStore(keyFile, store);
  return cred;
}

const HELP = `platform-agent — AI 에이전트 위임 등록/세션/프록시 CLI

사용:
  npx @metadium-did/platform-agent-js register --url <BRIEFICK_URL> --code <PAIRING_CODE>
  npx @metadium-did/platform-agent-js proxy    --url <BRIEFICK_URL> [--port 8787]
  npx @metadium-did/platform-agent-js did
  npx @metadium-did/platform-agent-js session  --url <BRIEFICK_URL>

명령:
  register   페어링 코드로 에이전트 등록(최초 1회)
  proxy      로컬 MCP 프록시 실행(고정 헤더 → 최신 bearer 주입). Claude Code는 이 프록시를 MCP로 등록.
  did        이 에이전트 did:jwk 출력
  session    위임 세션 bearer 1회 발급(stdout)

옵션:
  --url <URL>        Briefick 베이스 URL (또는 env BRIEFICK_URL)
  --code <CODE>      /publish 페어링 코드 (또는 env PAIRING_CODE) — register 최초 1회만
  --port <N>         proxy 리슨 포트 (기본 8787, 127.0.0.1 전용)
  --mcp-path <PATH>  RP MCP 경로 (기본 /api/mcp)
  --key-file <PATH>  키 파일 경로 (기본 ~/.metapass-agent/key.json, env METAPASS_AGENT_KEY_FILE)
  --force            이미 등록됐어도 재등록`;

export async function main(argv: string[]): Promise<number> {
  const args = parse(argv);

  if (!args.cmd || args.cmd === "help") {
    console.log(HELP);
    return args.cmd ? 0 : 1;
  }

  if (args.cmd === "did") {
    const { key, created } = await keyFrom(args.keyFile);
    console.log(key.did);
    // 모든 did:jwk는 앞자리가 같아 육안 구분 불가 — /publish가 표시하는 지문과 1:1 대조용.
    console.error(`지문: ${key.fingerprint} (Briefick /publish의 에이전트 지문과 대조)`);
    if (created) console.error(`(신규 키 생성·저장: ${args.keyFile})`);
    return 0;
  }

  if (args.cmd === "register") {
    if (!args.url) return fail("--url (또는 BRIEFICK_URL) 필요");
    const { key, store, created } = await keyFrom(args.keyFile);
    if (store.registrations?.[args.url] && !args.force) {
      console.log(
        `이미 등록됨 — 재사용합니다 (재등록 불필요).\n  DID: ${key.did}\n  지문: ${key.fingerprint}\n  키: ${args.keyFile}`,
      );
      return 0;
    }
    if (!args.code) return fail("--code (또는 PAIRING_CODE) 필요 — Briefick /publish 페어링 코드");
    const client = new BriefickAgentClient({ baseUrl: args.url, key });
    await client.register(args.code);
    store.registrations = { ...(store.registrations ?? {}), [args.url]: true };
    saveStore(args.keyFile, store);
    console.log(
      `✅ 등록 완료.\n  DID: ${key.did}\n  지문: ${key.fingerprint} (/publish 표시와 대조)\n  키 저장: ${args.keyFile} — 이후 재실행 시 재사용(재등록 불필요)${
        created ? "" : "\n  (기존 키 재사용)"
      }`,
    );
    return 0;
  }

  if (args.cmd === "session") {
    if (!args.url) return fail("--url (또는 BRIEFICK_URL) 필요");
    const { key, store } = await keyFrom(args.keyFile);
    const client = new BriefickAgentClient({ baseUrl: args.url, key });
    const cred = await ensureCredential(client, store, args.url, args.keyFile, key);
    const r = await client.exchange(cred);
    if (r.status !== "issued" || !r.bearer) return fail(`세션 발급 실패: ${r.status}`);
    console.log(r.bearer); // stdout=bearer (파이프 가능), 안내는 stderr
    console.error(`(만료 ${r.expiresAt}, scope ${JSON.stringify(r.scope)})`);
    return 0;
  }

  if (args.cmd === "proxy") {
    if (!args.url) return fail("--url (또는 BRIEFICK_URL) 필요");
    const { key, store } = await keyFrom(args.keyFile);
    const client = new BriefickAgentClient({ baseUrl: args.url, key });
    const credential = await ensureCredential(client, store, args.url, args.keyFile, key);
    const auth = new AgentAuth({
      client,
      credential,
      onRefresh: (_b, exp) => console.error(`[proxy] 세션 bearer 갱신 (만료 ${exp.toISOString()})`),
      onError: (e) => console.error(`[proxy] 세션 갱신 실패(재시도됨): ${e}`),
    });
    await auth.start();

    const base = args.url.replace(/\/+$/, "");
    const targetMcpUrl = base + (args.mcpPath ?? "/api/mcp");
    const proxy = await startProxy({ auth, targetMcpUrl, port: args.port ?? 8787 });

    console.error(`✅ 로컬 MCP 프록시 실행: ${proxy.url}  →  ${targetMcpUrl}`);
    console.error(`   에이전트 DID: ${key.did}`);
    console.error(`   지문: ${key.fingerprint} (/publish 표시와 대조)`);
    console.error(`\nClaude Code 등록(다른 터미널에서):`);
    console.error(`   claude mcp add --transport http briefick ${proxy.url}\n`);
    console.error("(Ctrl+C 로 종료)");

    const stop = async () => {
      auth.stop();
      await proxy.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await new Promise<void>(() => {}); // 포그라운드 유지(프록시가 이벤트루프를 잡음)
    return 0;
  }

  return fail(`알 수 없는 명령: ${args.cmd}\n\n${HELP}`);
}

function fail(msg: string): number {
  console.error("오류: " + msg);
  return 1;
}
