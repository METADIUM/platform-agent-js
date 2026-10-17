/**
 * @metadium-did/platform-agent-js — AI 에이전트 홀더 클라이언트.
 *
 * did:jwk 키 · SD-JWT VC 제시(KB-JWT) · agent-delegation `/1` 세션 교환. v0(등록/회수/세션 bearer)는 2026-10-17 제거.
 * ES256/P-256 전용, platform-java와 와이어 호환(홀더 제시 경로).
 */
export { AgentKey, didJwkFromPublicJwk, publicJwkFromDidJwk, didFingerprint } from "./key.js";
export { exchangeSessionToken, SessionExchangeError, type SessionExchangeOptions, type SessionToken } from "./session.js";
export {
  presentVpToken,
  splitSdJwt,
  sha256Base64Url,
  verifierDidFromResponseUri,
  type PresentOptions,
} from "./present.js";
export { CONSTRAINT_REFUSALS, constraintRefusalAction, type ConstraintRefusalAction } from "./constraint-refusal.js";
export { startProxy, type ProxyOptions, type RunningProxy, type BearerSource } from "./proxy.js";
export {
  defaultKeyFile,
  loadStore,
  saveStore,
  openStore,
  loadKeychainStore,
  saveKeychainStore,
  type KeyStore,
  type AgentStore,
  type StoreBackendName,
  type OpenStoreOptions,
  type KeychainOptions,
  type ExecFn,
} from "./keystore.js";
export {
  aliasFromUrl,
  configDir,
  ensureToken,
  loadConfig,
  mcpAddCommand,
  rotateToken,
  saveConfig,
  assertOwnerOnly,
  type DaemonConfig,
  type DaemonRp,
} from "./config.js";
export { startDaemon, type DaemonOptions, type DaemonTarget, type RunningDaemon } from "./daemon.js";
