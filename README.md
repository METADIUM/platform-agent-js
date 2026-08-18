# @metadium/platform-agent-js

AI 에이전트(예: Claude Code)가 **위임 VC로 서비스에 인증**하기 위한 Node/TypeScript **홀더 클라이언트 + CLI**.
정적 API 키를 **스코프드·기한부·철회가능 위임**으로 대체한다([[samples/docs/22]] 시나리오 #8).

- **did:jwk 키**(ES256/P-256) 생성·보관
- **PoP JWT**(소유 증명) — 등록/회수/세션 교환
- **SD-JWT VC 제시 + KB-JWT**(홀더 바인딩) — 위임 VP 생성
- **Briefick 위임 인증 계약**(등록 → 회수 → 세션 교환) 클라이언트
- **bearer 자동 갱신** — 짧은 TTL 세션 토큰을 만료 전 재교환(MCP 고정 헤더 대응)

> **왜 Node에 암호가 있나**: 에이전트는 위임 VC의 **홀더**라 자기 개인키로 KB-JWT/PoP를 **로컬 서명**해야
> 한다(원격 위임 시 홀더 바인딩이 깨짐). 검증자(RP)와 달리 홀더 암호는 오프로드할 수 없어, 에이전트가 도는
> 런타임(Node/MCP)에 있어야 한다. **홀더 제시 경로만·ES256 전용**으로 표면을 최소화했고, 와이어 포맷은
> `platform-java`와 크로스검증된다(아래).

## CLI (레포 clone 없이 npx 한 줄)

```bash
# 등록 (최초 1회 — Briefick /publish 페어링 코드)
npx @metadium/platform-agent-js register --url <BRIEFICK_URL> --code <PAIRING_CODE>

npx @metadium/platform-agent-js did                        # 이 에이전트 did:jwk 출력
npx @metadium/platform-agent-js session --url <BRIEFICK_URL>   # 위임 세션 bearer 1회 발급(stdout)
```

`--url`/`--code`는 환경변수 `BRIEFICK_URL`/`PAIRING_CODE`로도 대체 가능.

**키 영속(최초 1회만 등록, 이후 재사용)** — 키는 `~/.metapass-agent/key.json`(권한 0600)에 저장된다.
재실행 시 같은 did:jwk를 재사용하므로 **매번 새 에이전트로 등록되지 않는다.** `register`는 이미 등록된 URL이면
**자동으로 재등록을 건너뛴다**(다시 하려면 `--force`). 경로 변경: `--key-file <PATH>` 또는 `METAPASS_AGENT_KEY_FILE`.
개인키는 이 파일에만 있고 네트워크로 나가지 않는다.

## 설치 (라이브러리)

```bash
npm install @metadium/platform-agent-js
```

## 빠른 시작

```ts
import { AgentKey, BriefickAgentClient, AgentAuth } from "@metadium/platform-agent-js";

// 1) 에이전트 키(최초 1회 생성 후 파일로 영속 — 같은 did:jwk 유지)
const key = await AgentKey.generate();
console.log("이 에이전트 DID:", key.did);        // did:jwk:...  (Briefick UI에 등록)
// fs.writeFileSync("agent-key.json", JSON.stringify(key.exportPrivateJwk()));
// const key = await AgentKey.fromPrivateJwk(JSON.parse(fs.readFileSync("agent-key.json","utf8")));

const client = new BriefickAgentClient({ baseUrl: process.env.BRIEFICK_URL!, key });

// 2) 등록 — 사용자가 Briefick /publish 에서 발급한 페어링 코드로 바인딩(PoP)
await client.register(process.env.PAIRING_CODE!);

// 3) 사용자가 지갑에서 위임을 승인하면, 위임 VC를 회수(폴링)
const credential = await client.waitForDelegation();

// 4) 세션 bearer 교환 + 만료 전 자동 갱신
const auth = new AgentAuth({
  client,
  credential,
  onRefresh: (bearer) => console.log("새 세션 bearer:", bearer), // MCP 고정 헤더에 반영
});
await auth.start();

// 5) 이후 MCP 호출은 항상 유효한 bearer로
await fetch(process.env.BRIEFICK_URL + "/api/mcp", { headers: auth.authHeader() });
```

## 흐름 (Briefick 계약)

```text
등록   POST /api/agent/register          {didJwk, code, pop(aud=briefick-agent-register)}
회수   POST /api/agent/delegation/retrieve {didJwk, pop(aud=briefick-agent-retrieve)}  → {credential}
세션   POST /api/agent/session/start      {didJwk, pop(aud=briefick-agent-session)}    → {state, nonce, responseUri}
       (위임 VP를 sso responseUri에 제시)  POST {vpToken}
       POST /api/agent/session/complete   {state, didJwk, pop}                          → {bearer, expiresAt, scope}
```

PoP는 등록할 **did:jwk 개인키로 서명한 ES256 JWT**(aud 스코핑 + iat). 세션 bearer는 짧은 TTL이라
`AgentAuth`가 만료 전 재교환한다. MCP 클라이언트는 고정 헤더 하나만 두고, `onRefresh`로 값만 갱신.

## 배포 측 값 (Briefick env)

- `METAPASS_DELEGATION_VCT` = `https://sso.cplabs.io/creds/delegation/worklog/v1` (등록된 위임 vct)
- `METAPASS_DELEGATION_ADMIN_KEY` = sso.cplabs.io 배포 시 설정한 `PLATFORM_SECURITY_API_KEY`
  (New-Platform이 "발급"하는 값이 아니라 그 검증자 인스턴스의 env 비밀).

## 와이어 포맷 패리티

did:jwk(정준 JWK 순서), SD-JWT VC 제시(`core = issuerJwt~disc~…~`, `sd_hash = base64url(SHA-256(ASCII(core)))`),
KB-JWT(`typ=kb+jwt`, `{iat,aud,nonce,sd_hash}`)는 **`platform-java`와 바이트 일치**해야 한다.

- 자체 검증: `npm test`
- 크로스검증: `platform-java` `AgentJsParityTest` — Java가 발급한 위임 VC를 이 클라이언트가 제시하고
  `VerifierCore.verify`가 수락함을 확인(홀더 제시 경로 3-런타임 불변식). `node` 설치 시 자동 실행.

## 범위

ES256/P-256, 홀더 **제시** 경로 전용(발급·검증은 플랫폼 몫). 다른 곡선·발급 로직은 미지원.
