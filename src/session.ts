/**
 * Session exchange (spec agent-delegation §9): the delegation VC for a short-lived `delegation-session+jwt`.
 * `POST /agent/nonce` → present the VC with a KB-JWT bound to that nonce → `POST /agent/token` with a §11 request
 * proof over the exact body bytes.
 */
import { AgentKey } from "./key.js";
import { presentVpToken, verifierDidFromResponseUri } from "./present.js";

export interface SessionExchangeOptions {
  /** The verifier's public base URL; must equal its configured external URL, since `htu` is built from it. */
  verifierUrl: string;
  /** The verifier did:web (KB-JWT `aud`). Derived from `verifierUrl` when omitted. */
  verifierDid?: string;
  /** The delegation VC (SD-JWT VC) as issued. */
  vc: string;
  /** The RP alias in the verifier's registry. */
  rp: string;
  key: AgentKey;
  fetchImpl?: typeof fetch;
  /** Per request, default 10 s. */
  timeoutMs?: number;
}

export interface SessionToken {
  accessToken: string;
  expiresIn: number;
  expiresAt: Date;
}

/** A refused exchange. Only `invalid_delegation` means the VC is unusable; every other error keeps it. */
export class SessionExchangeError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly reasons: string[],
  ) {
    super(`${status} ${error}${reasons.length ? ": " + reasons.join("; ") : ""}`);
  }

  /** Drop the VC and wait for a new delegation (spec §9: terminal). */
  get dropVc(): boolean {
    return this.error === "invalid_delegation";
  }
}

export async function exchangeSessionToken(o: SessionExchangeOptions): Promise<SessionToken> {
  const f = o.fetchImpl ?? fetch;
  const base = o.verifierUrl.replace(/\/+$/, "");
  const verifierDid = o.verifierDid ?? verifierDidFromResponseUri(base + "/");

  // No redirects: htu is bound to the URL we call, and the verifier never needs to send us elsewhere.
  const opts = () => ({ redirect: "error" as const, signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) });
  const nonceRes = await f(base + "/agent/nonce", { method: "POST", ...opts() });
  if (!nonceRes.ok) throw await refusal(nonceRes);
  const { c_nonce: nonce } = (await nonceRes.json()) as { c_nonce: string };

  const vpToken = await presentVpToken(o.vc, o.key, { audience: verifierDid, nonce });
  const body = Buffer.from(JSON.stringify({ vp_token: vpToken, rp: o.rp }), "utf8");
  const htu = base + "/agent/token";
  const proof = await o.key.requestProof("POST", htu, { body });

  const res = await f(htu, {
    method: "POST",
    headers: { "content-type": "application/json", "agent-proof": proof },
    body,
    ...opts(),
  });
  if (!res.ok) throw await refusal(res);
  const t = (await res.json()) as { access_token: string; expires_in: number };
  return { accessToken: t.access_token, expiresIn: t.expires_in, expiresAt: new Date(Date.now() + t.expires_in * 1000) };
}

async function refusal(res: Response): Promise<SessionExchangeError> {
  let error = "http_" + res.status;
  let reasons: string[] = [];
  try {
    const b = (await res.json()) as { error?: string; reasons?: string[] };
    if (b.error) error = b.error;
    if (Array.isArray(b.reasons)) reasons = b.reasons;
  } catch {
    // not JSON: keep the status
  }
  return new SessionExchangeError(res.status, error, reasons);
}
