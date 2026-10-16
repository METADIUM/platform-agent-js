/**
 * Pickup (spec agent-delegation §8): the agent collects its delegations from the RP with a request proof and no
 * token. Repeatable; keyed to the proof's key; every live delegation.
 */
import type { AgentKey } from "./key.js";

export const DEFAULT_PICKUP_PATH = "/api/agent/pickup";
/** §8: the client never polls faster than the registry's `pollInterval` (default 60 s). */
export const DEFAULT_POLL_INTERVAL_S = 60;

export interface PickedDelegation {
  delegationId: string;
  credential: string;
  scope: string[];
  exp: number | null;
}

export interface PickupRefusal {
  error: "authorization_pending" | "slow_down" | "expired_token" | "access_denied" | "unknown_agent" | string;
  interval?: number;
  lastRequest?: { nonce?: string; status?: string; createdAt?: string; expiresAt?: string };
}

export type PickupResult = { ok: true; delegations: PickedDelegation[] } | ({ ok: false } & PickupRefusal);

export interface PickupOptions {
  /** The RP's origin, e.g. https://minipaas.metadium.club. `htu` is this plus `path`. */
  url: string;
  path?: string;
  key: AgentKey;
  version?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function pickup(o: PickupOptions): Promise<PickupResult> {
  const f = o.fetchImpl ?? fetch;
  const htu = o.url.replace(/\/+$/, "") + (o.path ?? DEFAULT_PICKUP_PATH);
  const body = Buffer.from(JSON.stringify(o.version ? { version: o.version } : {}), "utf8");
  const proof = await o.key.requestProof("POST", htu, { body });
  const res = await f(htu, {
    method: "POST",
    headers: { "content-type": "application/json", "agent-proof": proof },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
  });
  // No §8 endpoint at this path: not a refusal to retry, a capability the RP lacks (or a wrong stored path).
  if (res.status === 404) return { ok: false, error: "no_pickup" };
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.ok && json && Array.isArray(json.delegations)) {
    const delegations = json.delegations.filter(
      (d): d is PickedDelegation => !!d && typeof (d as PickedDelegation).credential === "string",
    );
    return { ok: true, delegations };
  }
  if (json && typeof json.error === "string") return { ok: false, ...(json as unknown as PickupRefusal) };
  throw new Error(`pickup ${res.status}${json ? ": " + JSON.stringify(json).slice(0, 200) : ""}`);
}

/** A VC's `iat` (epoch s), or null when it has none. */
export function vcIat(vc: string): number | null {
  try {
    const iat = (JSON.parse(Buffer.from(vc.split(".")[1] ?? "", "base64url").toString("utf8")) as { iat?: unknown }).iat;
    return typeof iat === "number" && Number.isFinite(iat) ? iat : null;
  } catch {
    return null;
  }
}

/**
 * Whether `a` is newer than `b`: issued later (`iat`), else, when either lacks one, ends later (`exp`). A tie is not
 * newer. A deliberate narrower or shorter delegation is the user's latest intent, so issuance wins (Briefick, #54).
 */
export function isNewer(a: { credential: string; exp: number | null }, b: { credential: string; exp: number | null }): boolean {
  const ai = vcIat(a.credential);
  const bi = vcIat(b.credential);
  if (ai !== null && bi !== null) return ai > bi;
  return (a.exp ?? 0) > (b.exp ?? 0);
}

/** The newest of several live delegations ({@link isNewer}); on a tie, the first. */
export function latest(delegations: PickedDelegation[]): PickedDelegation | null {
  return delegations.reduce<PickedDelegation | null>((best, d) => (!best || isNewer(d, best) ? d : best), null);
}

/** What to tell the user for a refusal (§8: a different text for each). */
export function pickupMessage(r: PickupRefusal, rpUrl: string): string {
  switch (r.error) {
    case "authorization_pending":
      return r.lastRequest?.status === "awaiting_link"
        ? "지갑 연결 확인 대기 — 서비스 페이지에서 지갑 지문을 확인하고 연결하세요"
        : "위임 대기 — 지갑에서 승인하면 자동으로 받습니다";
    case "slow_down":
      return `조회 간격을 ${r.interval ?? DEFAULT_POLL_INTERVAL_S}초로 늘립니다`;
    case "expired_token":
      return r.lastRequest?.status === "delivery_expired"
        ? "승인된 위임을 받을 기한이 지났습니다 — 위임을 다시 요청하세요"
        : "위임 요청이 만료됐습니다 — 다시 요청하세요";
    case "access_denied":
      return "위임이 거절되거나 철회됐습니다 — 다시 요청하세요";
    case "unknown_agent":
      return `이 에이전트는 페어링되지 않았습니다 — add ${rpUrl} --verifier … --code <코드>`;
    default:
      return `회수 실패: ${r.error}`;
  }
}
