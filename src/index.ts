/**
 * @metadium-did/platform-agent-js — AI 에이전트 홀더 클라이언트.
 *
 * did:jwk 키 · PoP JWT · SD-JWT VC 제시(KB-JWT) · Briefick 위임 인증(등록/회수/세션) · bearer 자동갱신.
 * ES256/P-256 전용, platform-java와 와이어 호환(홀더 제시 경로).
 */
export { AgentKey, didJwkFromPublicJwk, publicJwkFromDidJwk } from "./key.js";
export {
  presentVpToken,
  splitSdJwt,
  sha256Base64Url,
  verifierDidFromResponseUri,
  type PresentOptions,
} from "./present.js";
export {
  BriefickAgentClient,
  BriefickAgentError,
  POP_AUDIENCE,
  type BriefickClientOptions,
  type DelegationRetrieval,
  type SessionStart,
  type SessionResult,
} from "./briefick.js";
export { AgentAuth, type AgentAuthOptions } from "./agent.js";
export { startProxy, type ProxyOptions, type RunningProxy, type BearerSource } from "./proxy.js";
