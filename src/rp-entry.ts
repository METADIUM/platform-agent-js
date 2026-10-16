/**
 * Spec §17 discovery and §7 pairing for a `/1` RP.
 *
 * The verifier signs the RP's registry entry (`GET <verifier>/rp/<alias>`, `#v1`); the agent trusts the RP's paths
 * because the verifier signed them, and only if the entry's `resource` is the URL the user typed. A leg's URL is
 * `resource` + path, concatenated: `new URL(path, resource)` would drop a resource path such as `/api` (minipaas).
 * ⚠️ The verifier's did.json is read over TLS only: §17.1 key transparency is not checked here yet (v0 tracker).
 */
import { compactVerify, decodeProtectedHeader, importJWK, type JWK } from "jose";
import type { AgentKey } from "./key.js";
import { verifierDidFromResponseUri } from "./present.js";

export const RP_ENTRY_TYP = "delegation-rp-entry+jwt";
export const V1_PROTOCOL = "agent-delegation/1";
/** Clock skew allowed on the entry's `iat`. */
const SKEW_S = 60;

export interface RpEntry {
  alias: string;
  resource: string;
  protocol?: string;
  pairing?: string;
  pickup?: string;
  mcp?: string;
  requireBodyHash: boolean;
}

export class RpEntryError extends Error {}

const trimSlash = (u: string) => u.replace(/\/+$/, "");

/** A leg's URL: `resource` + `path`, never URL resolution. */
export function legUrl(resource: string, path: string): string {
  return trimSlash(resource) + path;
}

function didJsonUrl(did: string): string {
  const parts = did.slice("did:web:".length).split(":").map(decodeURIComponent);
  return parts.length === 1 ? `https://${parts[0]}/.well-known/did.json` : `https://${parts.join("/")}/did.json`;
}

const isPath = (v: unknown): v is string =>
  typeof v === "string" && /^\/[A-Za-z0-9._~/-]{0,255}$/.test(v) && !v.includes("//")
  && !v.split("/").some((s) => s === "." || s === "..");

export interface FetchRpEntryOptions {
  verifierUrl: string;
  alias: string;
  /** The RP URL the user typed. The signed `resource` must equal it. */
  rpUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export async function fetchRpEntry(o: FetchRpEntryOptions): Promise<RpEntry> {
  const f = o.fetchImpl ?? fetch;
  const now = o.now ? o.now() : Math.floor(Date.now() / 1000);
  const base = trimSlash(o.verifierUrl);
  const verifierDid = verifierDidFromResponseUri(base + "/");
  const opts = { redirect: "error" as const, signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) };

  const res = await f(`${base}/rp/${encodeURIComponent(o.alias)}`, opts);
  if (res.status === 404) throw new RpEntryError(`'${o.alias}' is not a registered RP at ${base}`);
  if (!res.ok) throw new RpEntryError(`registry entry: HTTP ${res.status}`);
  const jws = (await res.text()).trim();

  const header = decodeProtectedHeader(jws);
  if (header.typ !== RP_ENTRY_TYP) throw new RpEntryError(`registry entry typ ${String(header.typ)}`);
  if (header.alg !== "ES256") throw new RpEntryError(`registry entry alg ${String(header.alg)}`);
  const kid = typeof header.kid === "string" ? header.kid : "";
  if (!kid.startsWith(verifierDid + "#")) throw new RpEntryError(`registry entry kid ${kid} is not the verifier's`);

  const docRes = await f(didJsonUrl(verifierDid), opts);
  if (!docRes.ok) throw new RpEntryError(`verifier did.json: HTTP ${docRes.status}`);
  const doc = (await docRes.json()) as { verificationMethod?: Array<{ id?: string; publicKeyJwk?: JWK }> };
  const vm = (doc.verificationMethod ?? []).find((m) => m.id === kid || (m.id?.startsWith("#") && verifierDid + m.id === kid));
  if (!vm?.publicKeyJwk) throw new RpEntryError(`verifier did.json has no key ${kid}`);

  let p: Record<string, unknown>;
  try {
    const { payload } = await compactVerify(jws, await importJWK(vm.publicKeyJwk, "ES256"));
    p = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
  } catch (e) {
    throw new RpEntryError(`registry entry signature: ${(e as Error).message}`);
  }
  if (p.iss !== verifierDid) throw new RpEntryError(`registry entry iss ${String(p.iss)}`);
  if (p.alias !== o.alias) throw new RpEntryError(`registry entry is for '${String(p.alias)}', not '${o.alias}'`);
  if (typeof p.exp !== "number" || p.exp <= now) throw new RpEntryError("registry entry expired");
  if (typeof p.iat !== "number" || p.iat > now + SKEW_S) throw new RpEntryError("registry entry issued in the future");
  if (typeof p.resource !== "string" || trimSlash(p.resource) !== trimSlash(o.rpUrl)) {
    throw new RpEntryError(`the verifier registers '${o.alias}' at ${String(p.resource)}, not ${o.rpUrl}`);
  }
  for (const k of ["pairing", "pickup", "mcp"] as const) {
    if (p[k] !== undefined && !isPath(p[k])) throw new RpEntryError(`registry entry ${k} is not a path: ${String(p[k])}`);
  }
  return {
    alias: o.alias,
    resource: trimSlash(p.resource),
    ...(typeof p.protocol === "string" ? { protocol: p.protocol } : {}),
    ...(typeof p.pairing === "string" ? { pairing: p.pairing } : {}),
    ...(typeof p.pickup === "string" ? { pickup: p.pickup } : {}),
    ...(typeof p.mcp === "string" ? { mcp: p.mcp } : {}),
    requireBodyHash: p.requireBodyHash === true,
  };
}

/** A `/1` RP must name its pairing and pickup; a missing one is a misconfigured RP, never a default path (Briefick). */
export function requireV1(e: RpEntry): RpEntry & { pairing: string; pickup: string } {
  if (e.protocol !== V1_PROTOCOL) throw new RpEntryError(`'${e.alias}' does not advertise ${V1_PROTOCOL} at the verifier`);
  if (!e.pairing || !e.pickup) {
    throw new RpEntryError(`'${e.alias}' advertises ${V1_PROTOCOL} without ${!e.pairing ? "pairing" : "pickup"}: the RP is misconfigured`);
  }
  return e as RpEntry & { pairing: string; pickup: string };
}

export interface PairOptions {
  resource: string;
  path: string;
  key: AgentKey;
  code: string;
  label?: string;
  version?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** §7: `POST <pairing>` with `Agent-Proof`; the RP's fingerprint must be this key's (the user compares it on screen). */
export async function pairV1(o: PairOptions): Promise<{ fingerprint: string }> {
  const f = o.fetchImpl ?? fetch;
  const htu = legUrl(o.resource, o.path);
  const body = Buffer.from(JSON.stringify({ code: o.code, ...(o.label ? { label: o.label } : {}), ...(o.version ? { version: o.version } : {}) }), "utf8");
  const proof = await o.key.requestProof("POST", htu, { body });
  const res = await f(htu, {
    method: "POST",
    headers: { "content-type": "application/json", "agent-proof": proof },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || json?.paired !== true) {
    const why = json && typeof json.error === "string" ? `${json.error}${json.error_description ? ": " + String(json.error_description) : ""}` : `HTTP ${res.status}`;
    throw new RpEntryError(`pairing refused (${why})`);
  }
  if (json.agent_fingerprint !== o.key.fingerprint) {
    throw new RpEntryError(`the RP paired fingerprint ${String(json.agent_fingerprint)}, but this agent is ${o.key.fingerprint}`);
  }
  return { fingerprint: o.key.fingerprint };
}
