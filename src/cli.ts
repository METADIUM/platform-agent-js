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
import { defaultKeyFile, loadStore, saveStore, type KeyStore } from "./keystore.js";

interface Args {
  cmd?: string;
  url?: string;
  code?: string;
  keyFile: string;
  force: boolean;
}

function parse(argv: string[]): Args {
  const out: Args = { keyFile: "", force: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") out.url = argv[++i];
    else if (a === "--code") out.code = argv[++i];
    else if (a === "--key-file") out.keyFile = argv[++i];
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

const HELP = `platform-agent — AI 에이전트 위임 등록/세션 CLI

사용:
  npx @metadium-did/platform-agent-js register --url <BRIEFICK_URL> --code <PAIRING_CODE>
  npx @metadium-did/platform-agent-js did
  npx @metadium-did/platform-agent-js session --url <BRIEFICK_URL>

옵션:
  --url <URL>        Briefick 베이스 URL (또는 env BRIEFICK_URL)
  --code <CODE>      /publish 페어링 코드 (또는 env PAIRING_CODE) — register 최초 1회만
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
    if (created) console.error(`(신규 키 생성·저장: ${args.keyFile})`);
    return 0;
  }

  if (args.cmd === "register") {
    if (!args.url) return fail("--url (또는 BRIEFICK_URL) 필요");
    const { key, store, created } = await keyFrom(args.keyFile);
    if (store.registrations?.[args.url] && !args.force) {
      console.log(`이미 등록됨 — 재사용합니다 (재등록 불필요).\n  DID: ${key.did}\n  키: ${args.keyFile}`);
      return 0;
    }
    if (!args.code) return fail("--code (또는 PAIRING_CODE) 필요 — Briefick /publish 페어링 코드");
    const client = new BriefickAgentClient({ baseUrl: args.url, key });
    await client.register(args.code);
    store.registrations = { ...(store.registrations ?? {}), [args.url]: true };
    saveStore(args.keyFile, store);
    console.log(
      `✅ 등록 완료.\n  DID: ${key.did}\n  키 저장: ${args.keyFile} — 이후 재실행 시 재사용(재등록 불필요)${
        created ? "" : "\n  (기존 키 재사용)"
      }`,
    );
    return 0;
  }

  if (args.cmd === "session") {
    if (!args.url) return fail("--url (또는 BRIEFICK_URL) 필요");
    const { key } = await keyFrom(args.keyFile);
    const client = new BriefickAgentClient({ baseUrl: args.url, key });
    console.error("위임 VC 회수 대기(지갑 승인 필요)…");
    const cred = await client.waitForDelegation({ timeoutMs: 180_000 });
    const r = await client.exchange(cred);
    if (r.status !== "issued" || !r.bearer) return fail(`세션 발급 실패: ${r.status}`);
    console.log(r.bearer); // stdout=bearer (파이프 가능), 안내는 stderr
    console.error(`(만료 ${r.expiresAt}, scope ${JSON.stringify(r.scope)})`);
    return 0;
  }

  return fail(`알 수 없는 명령: ${args.cmd}\n\n${HELP}`);
}

function fail(msg: string): number {
  console.error("오류: " + msg);
  return 1;
}
