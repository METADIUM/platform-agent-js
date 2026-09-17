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
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentKey } from "./key.js";
import { AgentClientError, BriefickAgentClient, isRequestExpired } from "./briefick.js";
import { AgentAuth } from "./agent.js";
import { startProxy, type BearerSource } from "./proxy.js";
import { defaultKeyFile, loadStore, openStore, type AgentStore, type KeyStore } from "./keystore.js";
import {
  aliasFromUrl, configDir, ensureToken, loadConfig, mcpAddCommand, rotateToken, saveConfig,
  type DaemonConfig, type DaemonRp,
} from "./config.js";
import { startDaemon, type DaemonTarget } from "./daemon.js";
import { install as installUnit, uninstall as uninstallUnit } from "./install.js";

interface Args {
  cmd?: string;
  /** 서브커맨드 (예: credentials clear / add·remove의 URL·alias). */
  sub?: string;
  url?: string;
  code?: string;
  keyFile: string;
  keyBackend?: string;
  force: boolean;
  port?: number;
  mcpPath?: string;
  alias?: string;
  insecureNoToken: boolean;
  install: boolean;
  uninstallFlag: boolean;
}

function parse(argv: string[]): Args {
  const out: Args = { keyFile: "", force: false, insecureNoToken: false, install: false, uninstallFlag: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") out.url = argv[++i];
    else if (a === "--code") out.code = argv[++i];
    else if (a === "--key-file") out.keyFile = argv[++i];
    else if (a === "--key-backend") out.keyBackend = argv[++i];
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--mcp-path") out.mcpPath = argv[++i];
    else if (a === "--alias") out.alias = argv[++i];
    else if (a === "--insecure-no-token") out.insecureNoToken = true;
    else if (a === "--install") out.install = true;
    else if (a === "--uninstall") out.uninstallFlag = true;
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

/**
 * 401 안내 — RP가 사유(미등록/회수됨)를 내려주면 함께 표기.
 *
 * ⚠️ **이 문자열은 사용자가 그대로 복사해 실행한다**(§7-2-A ⑤ · briefick#18 실측). 그래서:
 *   ① 아는 값(`url`)은 채운다 — `<URL>` 꺾쇠를 그대로 두면 셸이 **입력 리다이렉션**으로 읽어
 *      «URL 이라는 파일이 없다»가 뜬다.
 *   ② 사람이 바꿀 자리(코드)만 남기되 **꺾쇠 없는 placeholder** 로 — 그대로 붙여넣어도 셸이
 *      안 깨지고 서버가 «잘못된 코드»로 명확히 거절한다.
 *   ③ 경로(`/publish` 등)는 **기능 설명**으로 — 하드코딩하면 RP 가 UI 를 옮길 때 낡는다
 *      (실제로 briefick 이 `/publish`→`/agents` 로 옮겨 이 문구가 404 를 가리켰다).
 * 📌 `--force` 는 남긴다 — code 가 있으면 잉여지만 «덮어쓴다»가 명시적이고 해롭지 않다.
 */
function registerGuide(e: AgentClientError, url: string): string {
  const base =
    "서버에서 등록이 회수됐거나 등록되지 않은 에이전트입니다 — " +
    "Briefick 에이전트 등록 페이지에서 새 페어링 코드를 발급받아 다음을 실행하세요(코드는 발급받은 값으로 바꾸세요):\n" +
    `  register --url ${url} --code 발급받은코드 --force`;
  const detail = e.body && typeof e.body === "object" ? (e.body as { error?: unknown }).error : undefined;
  return typeof detail === "string" && detail ? `${base}\n  (서버 사유: ${detail})` : base;
}

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
            "Briefick 에이전트 페이지에서 지문을 대조해 위임을 발급하세요",
        );
      } else if (isRequestExpired(r)) {
        // 만료된 요청을 "승인 대기"로 오표시하지 않는다 — RP status:"expired" 또는 expiresAt로 판정.
        console.error(
          `  위임 요청이 만료됐습니다(nonce ${r.lastRequest?.nonce ?? "?"}) — Briefick 에이전트 페이지에서 위임을 다시 발급하세요`,
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
      throw new AgentClientError(registerGuide(e, url), e.httpStatus, e.body);
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
    throw new AgentClientError(registerGuide(e, url), e.httpStatus, e.body);
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

/** 위임 VC(SD-JWT)의 만료 — `validUntil`(ISO) 우선, 없으면 `exp`(epoch 초). 파싱 실패 시 null. */
function delegationValidUntil(sdJwt: string): Date | null {
  try {
    const parts = sdJwt.split("~");
    const payload = JSON.parse(Buffer.from(parts[0].split(".")[1], "base64url").toString("utf8")) as {
      validUntil?: string;
      exp?: number;
    };
    if (payload.validUntil) return new Date(payload.validUntil);
    // validUntil이 선택공개(_sd)면 페이로드엔 다이제스트뿐 — disclosure([salt, 이름, 값])에서 찾는다
    for (const d of parts.slice(1)) {
      if (!d) continue;
      try {
        const disc = JSON.parse(Buffer.from(d, "base64url").toString("utf8")) as unknown[];
        if (Array.isArray(disc) && disc[1] === "validUntil" && typeof disc[2] === "string") {
          return new Date(disc[2]);
        }
      } catch {
        // KB-JWT 등 비disclosure 조각 — 무시
      }
    }
    if (typeof payload.exp === "number") return new Date(payload.exp * 1000);
    return null;
  } catch {
    return null;
  }
}

function formatLeft(ms: number): string {
  const h = Math.floor(ms / 3600_000);
  if (h >= 48) return `${Math.floor(h / 24)}d`;
  if (h >= 1) return `${h}h`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m`;
}

/**
 * 데몬 타깃 연결(백그라운드) — 저장된 위임이 있으면 즉시 bearer 갱신 루프를 시작하고,
 * 없거나 무효화됐으면 지갑 승인(회수)을 기다렸다가 자동 연결한다. 실패해도 데몬은 계속
 * 뜬 채 해당 경로만 503(delegation_pending) — 다른 RP에 영향 없음.
 */
async function connectTarget(
  target: DaemonTarget,
  client: BriefickAgentClient,
  data: KeyStore,
  rp: DaemonRp,
  store: AgentStore,
  key: AgentKey,
): Promise<void> {
  for (;;) {
    try {
      let credential = data.credentials?.[rp.url];
      if (!credential) {
        console.error(`[${rp.alias}] 위임 미보유 — 지갑 승인 대기(지문 ${key.fingerprint})`);
        credential = await waitCredential(client, data, rp.url, store, key);
      }
      const auth = new AgentAuth({
        client,
        credential,
        onRefresh: (_b, exp) => console.error(`[${rp.alias}] 세션 bearer 갱신 (만료 ${exp.toISOString()})`),
        onError: (e) => console.error(`[${rp.alias}] 세션 갱신 실패(재시도됨): ${e}`),
        // 🔴 영구 실패(등록 회수 등) — 재시도해도 같은 답이라 루프가 멈춘다. 조용히 멈추지 않게 크게 남긴다.
        onFatal: (e) => console.error(`[${rp.alias}] 세션 갱신 **영구 실패** — 재시도 중단. 재등록 필요(register --code): ${e}`),
      });
      try {
        await auth.start();
      } catch (e) {
        const fresh = await recoverSessionFailure(e, client, data, rp.url, store, key);
        if (!fresh) throw e;
        auth.stop();
        continue; // 재발급 위임으로 처음부터
      }
      target.auth = auth;
      const until = delegationValidUntil(credential);
      console.error(
        `[${rp.alias}] 연결됨 → ${target.targetMcpUrl}` +
          (until ? ` (위임 만료 ${until.toISOString()})` : ""),
      );
      return;
    } catch (e) {
      target.pendingReason = `연결 실패 — 60초 후 재시도: ${e instanceof Error ? e.message : String(e)}`;
      console.error(`[${rp.alias}] ${target.pendingReason}`);
      await new Promise((r) => setTimeout(r, 60_000));
    }
  }
}

const HELP = `platform-agent — AI 에이전트 위임 등록/세션/프록시 CLI

사용(데몬 — 권장, doc26):
  npx @metadium-did/platform-agent-js add <RP_URL> --code <PAIRING_CODE> [--alias 이름]
  npx @metadium-did/platform-agent-js up                # 등록된 전 RP를 한 데몬으로(로컬 토큰 필수)
  npx @metadium-did/platform-agent-js status            # RP별 위임 유효·만료·데몬 상태
  npx @metadium-did/platform-agent-js remove <alias>
  npx @metadium-did/platform-agent-js rotate-token      # ⚠ 회전 = 전 RP MCP 재등록 필요
  npx @metadium-did/platform-agent-js up --install      # OS 데몬 설치+시작(launchd/systemd --user+linger)
  npx @metadium-did/platform-agent-js down --uninstall  # OS 데몬 중지·제거
  npx @metadium-did/platform-agent-js upgrade           # 유닛 재설치(실행 라인 갱신)·재시작

사용(단일 RP·저수준):
  npx @metadium-did/platform-agent-js register --url <RP_URL> --code <PAIRING_CODE>
  npx @metadium-did/platform-agent-js proxy    --url <RP_URL> [--port 8787]
  npx @metadium-did/platform-agent-js did
  npx @metadium-did/platform-agent-js session  --url <RP_URL>
  npx @metadium-did/platform-agent-js credentials clear [--url <RP_URL>]

명령:
  add                RP 추가 — 페어링(register)+데몬 설정을 한 번에. 끝나면 claude mcp add 명령(로컬 토큰 포함) 출력
  up                 등록된 모든 RP를 한 프로세스로 서빙: 127.0.0.1:<port>/<alias>/mcp (RP 1개면 /mcp 호환).
                     로컬 인증 토큰 필수(GET /healthz만 무토큰 — 다운 vs 인증실패 구분용)
  status             데몬 생사 + RP별 위임 유효/만료 임박(<24h ⚠) + MCP 등록 명령
  remove             데몬 설정에서 RP 제거
  rotate-token       로컬 토큰 회전 — 즉시 전 RP의 MCP 등록이 401, 출력된 명령으로 전부 재등록
  register           페어링 코드로 에이전트 등록(최초 1회). --code가 있으면 로컬 기록과 무관하게 서버에 등록(회수 후 재등록)
  proxy              단일 RP 프록시(레거시) — 로컬 토큰 기본 적용, 무토큰은 --insecure-no-token 명시 시에만(경고)
  did                이 에이전트 did:jwk 출력
  session            위임 세션 bearer 1회 발급(stdout)
  credentials clear  캐시된 위임 VC 삭제(--url 지정 시 해당 RP만) — 위임 철회 후 재발급 대기로 전환

옵션:
  --url <URL>        Briefick 베이스 URL (또는 env BRIEFICK_URL)
  --code <CODE>      에이전트 페이지의 페어링 코드 (또는 env PAIRING_CODE) — register 최초 1회만
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
    // 모든 did:jwk는 앞자리가 같아 육안 구분 불가 — 에이전트 페이지가 표시하는 지문과 1:1 대조용.
    console.error(`지문: ${key.fingerprint} (Briefick 에이전트 페이지의 지문과 대조)`);
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
          `  서버에서 등록이 회수된 상태라면 에이전트 페이지의 새 코드로 --code를 주어 다시 실행하세요`,
      );
      return 0;
    }
    if (!args.code) return fail("--code (또는 PAIRING_CODE) 필요 — Briefick 에이전트 페이지의 페어링 코드");
    const client = new BriefickAgentClient({ baseUrl: args.url, key });
    await client.register(args.code);
    data.registrations = { ...(data.registrations ?? {}), [args.url]: true };
    store.save(data);
    console.log(
      `✅ 등록 완료.\n  DID: ${key.did}\n  지문: ${key.fingerprint} (에이전트 페이지 표시와 대조)\n  키 저장: ${store.location} — 이후 재실행 시 재사용(재등록 불필요)${
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

  // ── 데몬(doc26 P1): add / remove / up / status / rotate-token ─────────────

  if (args.cmd === "add") {
    const url = (args.sub ?? args.url)?.replace(/\/+$/, "");
    if (!url) return fail("사용: add <RP_URL> [--code <CODE>] [--alias <이름>] [--mcp-path /api/mcp]");
    const store = openAgentStore(args);
    const { key, data } = await keyFrom(store);
    const dir = configDir(args.keyFile);
    const cfg = loadConfig(dir);
    const alias = args.alias ?? aliasFromUrl(url);
    if (cfg.rps.some((r) => r.alias === alias && r.url !== url)) {
      return fail(`alias 충돌: '${alias}' — --alias 로 다른 이름을 지정하세요`);
    }
    // 페어링(register) 통합 — 이미 등록돼 있으면 code 불필요.
    // ⚠️ **단, --code 가 주어지면 로컬 플래그가 true 여도 다시 등록한다** — 서버에서 토큰이 회수된 뒤
    //    재등록하는 경로가 바로 이것이다(register 명령과 같은 규칙). 종전에는 로컬 플래그만 보고
    //    **code 를 무시한 채 ✅ 를 찍어서**, 사용자는 재등록했다고 믿지만 데몬은 여전히 401 을 돌렸다
    //    (metapass-saas 실측 · briefick#18). 「성공처럼 보이는 실패」의 CLI 판이다.
    if (!data.registrations?.[url] || args.code) {
      if (!args.code) return fail("--code 필요(최초 페어링) — RP의 에이전트 등록 화면에서 발급");
      const client = new BriefickAgentClient({ baseUrl: url, key });
      await client.register(args.code);
      data.registrations = { ...(data.registrations ?? {}), [url]: true };
      store.save(data);
    }
    if (!cfg.rps.some((r) => r.alias === alias)) {
      cfg.rps.push({ alias, url, ...(args.mcpPath ? { mcpPath: args.mcpPath } : {}) } satisfies DaemonRp);
      saveConfig(dir, cfg);
    }
    const token = ensureToken(dir);
    const port = cfg.port ?? 8787;
    console.log(`✅ RP 추가: ${alias} → ${url}\n  지문: ${key.fingerprint}`);
    console.log(`\nClaude Code 등록(복사-실행):`);
    console.log(`  ${mcpAddCommand(alias, port, token, cfg.rps.length === 1)}`);
    if (cfg.rps.length > 1) {
      console.log(`\n⚠ RP가 ${cfg.rps.length}개 — 루트 /mcp 등록이 있었다면 경로형으로 재등록하세요(status가 전체 명령 출력)`);
    }
    console.log(`\n데몬 실행: npx @metadium-did/platform-agent-js up`);
    return 0;
  }

  if (args.cmd === "remove") {
    const alias = args.sub ?? args.alias;
    if (!alias) return fail("사용: remove <alias>");
    const dir = configDir(args.keyFile);
    const cfg = loadConfig(dir);
    const before = cfg.rps.length;
    cfg.rps = cfg.rps.filter((r) => r.alias !== alias);
    if (cfg.rps.length === before) return fail(`알 수 없는 alias: ${alias}`);
    saveConfig(dir, cfg);
    console.log(`✅ 제거: ${alias} — 데몬 재시작 후 반영 (등록·위임 캐시는 유지: credentials clear --url 로 별도 정리)`);
    return 0;
  }

  if (args.cmd === "rotate-token") {
    const dir = configDir(args.keyFile);
    const token = rotateToken(dir);
    const cfg = loadConfig(dir);
    console.log("✅ 로컬 토큰 회전 완료");
    console.log("⚠ 토큰은 데몬당 1개 — 지금 즉시 **모든 RP의 Claude Code 등록이 401**입니다. 아래로 전부 재등록하세요:");
    for (const rp of cfg.rps) {
      console.log(`  claude mcp remove ${rp.alias}; ${mcpAddCommand(rp.alias, cfg.port ?? 8787, token, cfg.rps.length === 1)}`);
    }
    return 0;
  }

  if (args.cmd === "status") {
    const dir = configDir(args.keyFile);
    const cfg = loadConfig(dir);
    const store = openAgentStore(args);
    const data = store.load();
    const key = data?.privateJwk ? await AgentKey.fromPrivateJwk(data.privateJwk) : null;
    const token = ensureToken(dir);
    const port = cfg.port ?? 8787;
    let daemon = "stopped (ConnectionRefused)";
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
      daemon = r.ok ? `running (port ${port})` : `unhealthy (${r.status})`;
    } catch {
      // stopped
    }
    console.log(`agent ${key ? key.fingerprint : "(키 없음)"}  ·  daemon: ${daemon}`);
    if (cfg.rps.length === 0) {
      console.log("  등록된 RP 없음 — add <RP_URL> --code <CODE> 로 시작하세요");
      return 0;
    }
    for (const rp of cfg.rps) {
      const cred = data?.credentials?.[rp.url];
      let deleg = "위임 없음 → 지갑 승인 필요";
      if (cred) {
        const until = delegationValidUntil(cred);
        if (!until) deleg = "위임 보유(만료 정보 없음)";
        else {
          const leftMs = until.getTime() - Date.now();
          deleg = leftMs <= 0
            ? `✗ 위임 만료(${until.toISOString()}) → 지갑 재승인 필요`
            : (leftMs < 24 * 3600_000 ? "⚠ 위임 만료 임박 " : "✓ 위임 유효 ") + `(${formatLeft(leftMs)} 남음)`;
        }
      }
      console.log(`  ${rp.alias.padEnd(10)} ${deleg}`);
      console.log(`  ${"".padEnd(10)} ${mcpAddCommand(rp.alias, port, token, cfg.rps.length === 1)}`);
    }
    return 0;
  }

  if (args.cmd === "down") {
    if (!args.uninstallFlag) return fail("사용: down --uninstall — OS 데몬 유닛 중지·제거");
    for (const line of uninstallUnit()) console.log("✅ " + line);
    return 0;
  }

  if (args.cmd === "upgrade") {
    // 실행 라인(버전·경로)이 바뀌었을 수 있으므로 유닛 재설치 = 최신 실행 라인으로 재기동
    const dir0 = configDir(args.keyFile);
    const r = installUnit(join(dir0, "daemon.log"));
    console.log(`✅ 유닛 재설치·재시작(${r.kind}): ${r.unitPath}`);
    for (const n of r.notes) console.log("  " + n);
    return 0;
  }

  if (args.cmd === "up" && args.install) {
    const dir = configDir(args.keyFile);
    const cfg = loadConfig(dir);
    if (cfg.rps.length === 0) return fail("등록된 RP 없음 — 먼저 add <RP_URL> --code <CODE>");
    ensureToken(dir); // 유닛 기동 전에 토큰·권한 선검증(fail-closed를 설치 시점에 노출)
    const r = installUnit(join(dir, "daemon.log"));
    console.log(`✅ OS 데몬 설치·시작(${r.kind}): ${r.unitPath}`);
    for (const n of r.notes) console.log("  " + n);
    console.log("  상태: npx @metadium-did/platform-agent-js status");
    return 0;
  }

  if (args.cmd === "up") {
    const dir = configDir(args.keyFile);
    const cfg = loadConfig(dir);
    if (cfg.rps.length === 0) return fail("등록된 RP 없음 — 먼저 add <RP_URL> --code <CODE>");
    const store = openAgentStore(args);
    const { key, data } = await keyFrom(store);
    const token = ensureToken(dir);

    const targets: DaemonTarget[] = [];
    for (const rp of cfg.rps) {
      const client = new BriefickAgentClient({ baseUrl: rp.url, key });
      const target: DaemonTarget = {
        alias: rp.alias,
        targetMcpUrl: rp.url.replace(/\/+$/, "") + (rp.mcpPath ?? "/api/mcp"),
        auth: null,
        pendingReason: "위임 미확보 — 지갑에서 승인하면 자동 연결됩니다",
      };
      targets.push(target);
      void connectTarget(target, client, data, rp, store, key);
    }

    const daemon = await startDaemon({ targets, token, port: cfg.port });
    if (cfg.port !== daemon.port) {
      cfg.port = daemon.port; // 최초 자동 배정 포트 고정(다중 계정 서버에서 사용자별로 갈림)
      saveConfig(dir, cfg);
    }
    console.error(`✅ 에이전트 데몬 실행: 127.0.0.1:${daemon.port} (RP ${targets.length}개, 로컬 토큰 필수)`);
    console.error(`   에이전트 지문: ${key.fingerprint}`);
    console.error(`\nClaude Code 등록(복사-실행):`);
    for (const rp of cfg.rps) {
      console.error(`  ${mcpAddCommand(rp.alias, daemon.port, token, cfg.rps.length === 1)}`);
    }
    console.error("\n(Ctrl+C 로 종료 · 상태는 다른 터미널에서 `status`)");
    const stop = async () => {
      await daemon.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await new Promise<void>(() => {});
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
        onFatal: (e) => console.error(`[proxy] 세션 갱신 **영구 실패** — 재시도 중단. 재등록 필요(register --code): ${e}`),
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
    const alias = aliasFromUrl(base);
    // 로컬 인증 토큰 기본 적용(doc26 §2-5) — 무토큰은 --insecure-no-token 명시 시에만
    let proxy: { url: string; port: number; close(): Promise<void> };
    if (args.insecureNoToken) {
      console.error("⚠ --insecure-no-token: 같은 호스트의 모든 프로세스가 이 프록시(=에이전트 권한)를 호출할 수 있습니다");
      proxy = await startProxy({ auth, targetMcpUrl, port: args.port ?? 8787 });
      console.error(`\nClaude Code 등록:\n   claude mcp add --transport http ${alias} ${proxy.url}\n`);
    } else {
      const token = ensureToken(configDir(args.keyFile));
      const daemon = await startDaemon({
        targets: [{ alias, targetMcpUrl, auth }],
        token,
        port: args.port ?? 8787,
      });
      proxy = { url: daemon.urls[alias], port: daemon.port, close: daemon.close };
      console.error(`\nClaude Code 등록(복사-실행):\n   ${mcpAddCommand(alias, daemon.port, token, true)}\n`);
    }

    console.error(`✅ 로컬 MCP 프록시 실행: ${proxy.url}  →  ${targetMcpUrl}`);
    console.error(`   에이전트 DID: ${key.did}`);
    console.error(`   지문: ${key.fingerprint} (에이전트 페이지 표시와 대조)`);
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
