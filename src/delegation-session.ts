/**
 * The `/1` call path (spec agent-delegation §9.1, §10, §11): a session token from the verifier, kept fresh, and a
 * request proof on every forwarded call. The daemon uses it for a target whose RP serves `/1`; v0 targets keep their
 * bearer.
 */
import type { AgentKey } from "./key.js";
import type { SessionExchangeError, SessionToken } from "./session.js";

/** Headers for one call (§10): `Authorization: Delegation <token>` and `Agent-Proof`. */
export interface CallAuth {
  callHeaders(method: string, htu: string, body: Uint8Array): Promise<Record<string, string>>;
  /** §11 `use_fresh_time`: the RP's clock minus ours, in seconds. */
  setClockOffset(seconds: number): void;
  state(): SessionState;
}

export type SessionState =
  | { status: "starting" }
  | { status: "active"; expiresAt: string }
  | { status: "retrying"; expiresAt?: string; lastError: string }
  | { status: "dropped"; error: string };

/** No usable token: the daemon answers the MCP client locally (§9.1). */
export class SessionUnavailable extends Error {
  constructor(
    readonly error: "verifier_unreachable" | "delegation_dropped" | "session_starting",
    message: string,
  ) {
    super(message);
  }
}

export const REFRESH_AHEAD_MS = 60_000;
export const BACKOFF_MAX_MS = 30_000;

export interface DelegationSessionOptions {
  key: AgentKey;
  /** One exchange (§9); throws `SessionExchangeError` on a refusal. */
  exchange: () => Promise<SessionToken>;
  /** Named in the message after `exp` (§9.1). */
  verifier: string;
  now?: () => number;
  /** Schedules the next attempt; returns a cancel function. */
  schedule?: (ms: number, fn: () => void) => () => void;
}

export class DelegationSessionAuth implements CallAuth {
  private token?: SessionToken;
  private offset = 0;
  private current: SessionState = { status: "starting" };
  private backoff = 1_000;
  private cancel?: () => void;
  private stopped = false;
  private readonly now: () => number;
  private readonly schedule: (ms: number, fn: () => void) => () => void;

  constructor(private readonly o: DelegationSessionOptions) {
    this.now = o.now ?? Date.now;
    this.schedule =
      o.schedule ??
      ((ms, fn) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return () => clearTimeout(t);
      });
  }

  /** The first exchange; later ones schedule themselves. */
  start(): Promise<void> {
    return this.refresh();
  }

  stop(): void {
    this.stopped = true;
    this.cancel?.();
  }

  state(): SessionState {
    return this.current;
  }

  setClockOffset(seconds: number): void {
    this.offset = seconds;
  }

  async callHeaders(method: string, htu: string, body: Uint8Array): Promise<Record<string, string>> {
    const t = this.token;
    if (this.current.status === "dropped") {
      throw new SessionUnavailable("delegation_dropped", `the delegation was refused: ${this.current.error}`);
    }
    // Never past exp, and never extended here (§9.1).
    if (!t || this.now() >= t.expiresAt.getTime()) {
      throw new SessionUnavailable(
        t ? "verifier_unreachable" : "session_starting",
        `no valid session token from the verifier ${this.o.verifier}; retrying`,
      );
    }
    const proof = await this.o.key.requestProof(method, htu, {
      sessionToken: t.accessToken,
      // §11: bh on every request that has a body.
      body: body.length > 0 ? body : undefined,
      iat: Math.floor(this.now() / 1000) + this.offset,
    });
    return { authorization: `Delegation ${t.accessToken}`, "agent-proof": proof };
  }

  private async refresh(): Promise<void> {
    if (this.stopped) return;
    try {
      const t = await this.o.exchange();
      this.token = t;
      this.backoff = 1_000;
      this.current = { status: "active", expiresAt: t.expiresAt.toISOString() };
      this.next(Math.max(0, t.expiresAt.getTime() - REFRESH_AHEAD_MS - this.now()));
    } catch (e) {
      const err = e as Partial<SessionExchangeError>;
      if (err.dropVc) {
        this.current = { status: "dropped", error: String(err.message ?? e) };
        return;
      }
      this.current = { status: "retrying", expiresAt: this.token?.expiresAt.toISOString(), lastError: String(err.message ?? e) };
      this.next(this.backoff);
      this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    }
  }

  private next(ms: number): void {
    if (this.stopped) return;
    this.cancel = this.schedule(ms, () => void this.refresh());
  }
}

export function isCallAuth(a: unknown): a is CallAuth {
  return typeof (a as CallAuth | null)?.callHeaders === "function";
}
