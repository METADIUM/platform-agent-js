/**
 * E2E 데모 — 실 에이전트로 Briefick 위임 인증 전 과정을 돌린다.
 *   BRIEFICK_URL=https://briefick.example \
 *   PAIRING_CODE=ABCD2345 \
 *   AGENT_KEY_FILE=./agent-key.json \
 *   npm run demo
 * PAIRING_CODE는 Briefick /publish 에서 발급한 코드. 에이전트 키는 파일로 영속(없으면 생성).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { AgentKey, BriefickAgentClient, AgentAuth } from "../src/index.js";

const BRIEFICK_URL = required("BRIEFICK_URL");
const KEY_FILE = process.env.AGENT_KEY_FILE ?? "agent-key.json";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`env ${name} 필요`);
  return v;
}

async function loadOrCreateKey(): Promise<AgentKey> {
  if (existsSync(KEY_FILE)) {
    return AgentKey.fromPrivateJwk(JSON.parse(readFileSync(KEY_FILE, "utf8")));
  }
  const key = await AgentKey.generate();
  writeFileSync(KEY_FILE, JSON.stringify(key.exportPrivateJwk()));
  return key;
}

async function main() {
  const key = await loadOrCreateKey();
  console.log("에이전트 DID:", key.did);
  const client = new BriefickAgentClient({ baseUrl: BRIEFICK_URL, key });

  if (process.env.PAIRING_CODE) {
    const reg = await client.register(process.env.PAIRING_CODE);
    console.log("등록:", reg);
  } else {
    console.log("(PAIRING_CODE 미지정 — 이미 등록됐다고 가정)");
  }

  console.log("위임 VC 회수 대기(지갑 승인 필요)…");
  const credential = await client.waitForDelegation({ timeoutMs: 180_000 });
  console.log("위임 VC 회수 완료(길이 %d)", credential.length);

  const auth = new AgentAuth({
    client,
    credential,
    onRefresh: (bearer, exp) => console.log("세션 bearer 갱신:", bearer.slice(0, 16) + "…", "exp", exp.toISOString()),
  });
  await auth.start();

  const res = await fetch(BRIEFICK_URL + "/api/mcp", {
    method: "POST",
    headers: { ...auth.authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  console.log("MCP tools/list →", res.status);
  console.log(await res.text());
  auth.stop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
