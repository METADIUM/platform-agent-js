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
import { pathToFileURL } from "node:url";
import { AgentKey } from "./key.js";
import { AgentClientError, BriefickAgentClient } from "./briefick.js";
import { AgentAuth } from "./agent.js";
import { startProxy } from "./proxy.js";
import { defaultKeyFile, loadStore, openStore, type AgentStore, type KeyStore } from "./keystore.js";

interface Args {
  cmd?: string;
  /** 서브커맨드 (예: credentials clear). */
  sub?: string;
  url?: string;
  code?: string;
  keyFile: string;
  keyBackend?: string;
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
    else if (a === "--key-backend") out.keyBackend = argv[++i];
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--mcp-path") out.mcpPath = argv[++i];
    else if (a === "--force") out.force = true;
    else if (a === "-h" || a === "--help") out.cmd = "help";
    else rest.push(a);
  }
  out.cmd ??= rest[0];
  out.sub = rest[1];
  out.url ??= process.env.BRIEFICK_URL;
  out.code ??= process.env.PAIRING_CODE;
  out.keyFile ||= defaultKeyFile();
  return out;
}

/** 저장소 오픈 — keychain 백엔드가 비어 있고 기존 key.json이 있으면 최초 1회 이관. */
function openAgentStore(args: Args): AgentStore {
  const store = openStore({ backend: args.keyBackend, keyFile: args.keyFile });
  if (store.backend === "keychain" && !store.load()) {
    const legacy = loadStore(args.keyFile);
    if (legacy) {
      store.save(legacy);
      console.error(
        `기존 키 파일을 키체인으로 가져왔습니다: ${args.keyFile} → ${store.location}\n` +
          `  평문 파일 삭제 권장: rm "${args.keyFile}"`,
      );
    }
  }
  return store;
}

async function keyFrom(store: AgentStore): Promise<{ key: AgentKey; data: KeyStore; created: boolean }> {
  const existing = store.load();
  if (existing?.privateJwk) {
    return { key: await AgentKey.fromPrivateJwk(existing.privateJwk), data: existing, created: false };
  }
  const key = await AgentKey.generate();
  const data: KeyStore = { privateJwk: key.exportPrivateJwk(), registrations: {} };
  store.save(data);
  return { key, data, created: true };
}

const REGISTER_GUIDE =
  "서버에서 등록이 회수됐거나 등록되지 않은 에이전트입니다 — " +
  "Briefick /publish에서 새 페어링 코드를 발급받아 `register --url <URL> --code <CODE> --force`를 실행하세요";

/** 지갑 승인·전달을 기다려 위임 VC를 회수하고 캐시에 저장한다(캐시 무시 — 항상 새로 회수). */
async function waitCredential(
  client: BriefickAgentClient,
  data: KeyStore,
  url: string,
  store: AgentStore,
  key: AgentKey,
): Promise<string> {
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
  }).catch((e) => {
    // 미등록/등록 회수 — 원인 모를 에러 대신 복구 절차 안내.
    if (e instanceof AgentClientError && (e.httpStatus === 401 || e.message.includes("등록되지 않은"))) {
      throw new AgentClientError(REGISTER_GUIDE, e.httpStatus, e.body);
    }
    throw e;
  });
  data.credentials = { ...(data.credentials ?? {}), [url]: cred };
  store.save(data);
  return cred;
}

/** 위임 VC 확보 — 저장돼 있으면 재사용, 없으면 회수(지갑 승인 대기) 후 저장. */
async function ensureCredential(
  client: BriefickAgentClient,
  data: KeyStore,
  url: string,
  store: AgentStore,
  key: AgentKey,
): Promise<string> {
  const stored = data.credentials?.[url];
  if (stored) return stored;
  return waitCredential(client, data, url, store, key);
}

/** 캐시된 위임 VC 삭제. 있었으면 true. */
function clearCredential(store: AgentStore, data: KeyStore, url: string): boolean {
  if (!data.credentials?.[url]) return false;
  delete data.credentials[url];
  store.save(data);
  return true;
}

/**
 * 서버-로컬 상태 불일치 복구 분기 — 세션/proxy 시작 실패를 사유별로 처리한다.
 * - 401(등록 회수) → 재등록 안내로 즉시 실패
 * - 세션 거부(위임 철회 등 사유 수신) → 캐시 폐기 후 재발급 승인 대기로 전환(1회 재시도용 새 VC 반환)
 * - 세션 완료 타임아웃 → 철회 가능성 안내(캐시 수동 정리 방법 포함) 후 원래 예외 전파
 */
async function recoverSessionFailure(
  e: unknown,
  client: BriefickAgentClient,
  data: KeyStore,
  url: string,
  store: AgentStore,
  key: AgentKey,
): Promise<string | null> {
  if (!(e instanceof AgentClientError)) return null;
  if (e.httpStatus === 401) {
    throw new AgentClientError(REGISTER_GUIDE, e.httpStatus, e.body);
  }
  if (e.message.includes("세션 거부")) {
    console.error(`위임이 무효화됐습니다(${e.message}) — 캐시를 비우고 지갑 재발급 승인 대기로 전환합니다`);
    clearCredential(store, data, url);
    return waitCredential(client, data, url, store, key);
  }
  if (e.message.includes("세션 완료 타임아웃")) {
    console.error(
      "세션이 pending인 채 타임아웃됐습니다 — 위임이 철회됐거나 검증자가 결과를 전이하지 못했을 수 있습니다.\n" +
        `  캐시를 비우고 재시도: credentials clear --url ${url}`,
    );
  }
  return null;
}

const HELP = `platform-agent — AI 에이전트 위임 등록/세션/프록시 CLI

사용:
  npx @metadium-did/platform-agent-js register --url <BRIEFICK_URL> --code <PAIRING_CODE>
  npx @metadium-did/platform-agent-js proxy    --url <BRIEFICK_URL> [--port 8787]
  npx @metadium-did/platform-agent-js did
  npx @metadium-did/platform-agent-js session  --url <BRIEFICK_URL>
  npx @metadium-did/platform-agent-js credentials clear [--url <BRIEFICK_URL>]

명령:
  register           페어링 코드로 에이전트 등록(최초 1회). --code가 있으면 로컬 기록과 무관하게 서버에 등록(회수 후 재등록)
  proxy              로컬 MCP 프록시 실행(고정 헤더 → 최신 bearer 주입). Claude Code는 이 프록시를 MCP로 등록.
  did                이 에이전트 did:jwk 출력
  session            위임 세션 bearer 1회 발급(stdout)
  credentials clear  캐시된 위임 VC 삭제(--url 지정 시 해당 RP만) — 위임 철회 후 재발급 대기로 전환

옵션:
  --url <URL>        Briefick 베이스 URL (또는 env BRIEFICK_URL)
  --code <CODE>      /publish 페어링 코드 (또는 env PAIRING_CODE) — register 최초 1회만
  --port <N>         proxy 리슨 포트 (기본 8787, 127.0.0.1 전용)
  --mcp-path <PATH>  RP MCP 경로 (기본 /api/mcp)
  --key-file <PATH>  키 파일 경로 (기본 ~/.metapass-agent/key.json, env METAPASS_AGENT_KEY_FILE)
  --key-backend <B>  키 저장 백엔드: file(기본) | keychain (env METAPASS_AGENT_KEY_BACKEND)
                     keychain = macOS Keychain(security) / Linux libsecret(secret-tool) — 평문 파일 없음.
                     기존 key.json이 있으면 최초 1회 자동 이관(이관 후 파일 삭제 권장)
  --force            이미 등록됐어도 재등록`;

export async function main(argv: string[]): Promise<number> {
  const args = parse(argv);

  if (!args.cmd || args.cmd === "help") {
    console.log(HELP);
    return args.cmd ? 0 : 1;
  }

  if (args.cmd === "did") {
    const store = openAgentStore(args);
    const { key, created } = await keyFrom(store);
    console.log(key.did);
    // 모든 did:jwk는 앞자리가 같아 육안 구분 불가 — /publish가 표시하는 지문과 1:1 대조용.
    console.error(`지문: ${key.fingerprint} (Briefick /publish의 에이전트 지문과 대조)`);
    if (created) console.error(`(신규 키 생성·저장: ${store.location})`);
    return 0;
  }

  if (args.cmd === "register") {
    if (!args.url) return fail("--url (또는 BRIEFICK_URL) 필요");
    const store = openAgentStore(args);
    const { key, data, created } = await keyFrom(store);
    // 로컬 플래그만 믿고 스킵하면 서버에서 등록이 회수된 경우 새 코드가 미사용 만료된다 —
    // 코드가 주어졌으면 사용자가 재등록을 의도한 것이므로 항상 서버에 등록한다.
    if (data.registrations?.[args.url] && !args.force && !args.code) {
      console.log(
        `이미 등록됨(로컬 기록) — 재사용합니다.\n  DID: ${key.did}\n  지문: ${key.fingerprint}\n  키: ${store.location}\n` +
          `  서버에서 등록이 회수된 상태라면 /publish의 새 코드로 --code를 주어 다시 실행하세요`,
      );
      return 0;
    }
    if (!args.code) return fail("--code (또는 PAIRING_CODE) 필요 — Briefick /publish 페어링 코드");
    const client = new BriefickAgentClient({ baseUrl: args.url, key });
    await client.register(args.code);
    data.registrations = { ...(data.registrations ?? {}), [args.url]: true };
    store.save(data);
    console.log(
      `✅ 등록 완료.\n  DID: ${key.did}\n  지문: ${key.fingerprint} (/publish 표시와 대조)\n  키 저장: ${store.location} — 이후 재실행 시 재사용(재등록 불필요)${
        created ? "" : "\n  (기존 키 재사용)"
      }`,
    );
    return 0;
  }

  if (args.cmd === "session") {
    if (!args.url) return fail("--url (또는 BRIEFICK_URL) 필요");
    const store = openAgentStore(args);
    const { key, data } = await keyFrom(store);
    const client = new BriefickAgentClient({ baseUrl: args.url, key });
    const cred = await ensureCredential(client, data, args.url, store, key);
    let r;
    try {
      r = await client.exchange(cred);
    } catch (e) {
      const fresh = await recoverSessionFailure(e, client, data, args.url, store, key);
      if (!fresh) throw e;
      r = await client.exchange(fresh); // 재발급 위임으로 1회 재시도
    }
    if (r.status !== "issued" || !r.bearer) return fail(`세션 발급 실패: ${r.status}`);
    console.log(r.bearer); // stdout=bearer (파이프 가능), 안내는 stderr
    console.error(`(만료 ${r.expiresAt}, scope ${JSON.stringify(r.scope)})`);
    return 0;
  }

  if (args.cmd === "credentials") {
    if (args.sub !== "clear") return fail("사용: credentials clear [--url <RP>] — 캐시된 위임 VC 삭제");
    const store = openAgentStore(args);
    const data = store.load();
    if (!data?.credentials || Object.keys(data.credentials).length === 0) {
      console.log("캐시된 위임 VC 없음");
      return 0;
    }
    if (args.url) {
      if (!clearCredential(store, data, args.url)) {
        console.log(`캐시 없음: ${args.url}`);
        return 0;
      }
      console.log(`✅ 캐시 삭제: ${args.url} — 다음 실행 시 지갑 재발급 승인을 대기합니다`);
    } else {
      const urls = Object.keys(data.credentials);
      data.credentials = {};
      store.save(data);
      console.log(`✅ 캐시 전체 삭제(${urls.length}건): ${urls.join(", ")}`);
    }
    return 0;
  }

  if (args.cmd === "proxy") {
    if (!args.url) return fail("--url (또는 BRIEFICK_URL) 필요");
    const store = openAgentStore(args);
    const { key, data } = await keyFrom(store);
    const client = new BriefickAgentClient({ baseUrl: args.url, key });
    let credential = await ensureCredential(client, data, args.url, store, key);
    let auth: AgentAuth;
    for (let attempt = 0; ; attempt++) {
      auth = new AgentAuth({
        client,
        credential,
        onRefresh: (_b, exp) => console.error(`[proxy] 세션 bearer 갱신 (만료 ${exp.toISOString()})`),
        onError: (e) => console.error(`[proxy] 세션 갱신 실패(재시도됨): ${e}`),
      });
      try {
        await auth.start();
        break;
      } catch (e) {
        const fresh = attempt === 0 ? await recoverSessionFailure(e, client, data, args.url, store, key) : null;
        if (!fresh) throw e;
        credential = fresh; // 재발급 위임으로 1회 재시도
      }
    }

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

// `node dist/cli.js` 직접 실행 지원(bin/cli.mjs와 동일 동작) — 이전엔 무동작 exit 0이라 디버깅에 혼란.
const directEntry = process.argv[1];
if (directEntry && import.meta.url === pathToFileURL(directEntry).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code ?? 0))
    .catch((e) => {
      console.error("오류: " + (e instanceof Error ? e.message : String(e)));
      process.exit(1);
    });
}
